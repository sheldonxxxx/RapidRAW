import base64
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient
from PIL import Image

from rapidraw_connector.app import create_app
from rapidraw_connector.config import Settings
from rapidraw_connector.depth import ASSETS, PROFILE, create_depth_app, depth_png

ROOT = Path(__file__).resolve().parents[1]


def png(image):
    stream = io.BytesIO()
    image.save(stream, format='PNG')
    return stream.getvalue()


class DepthService(unittest.TestCase):
    def test_disabled_and_broken_optional_setup_preserve_generation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for config in (None, root/'missing.json'):
                app = create_app(Settings(root, ROOT/'profiles', root/'state', depth_config=config))
                with TestClient(app) as client:
                    capabilities = client.get('/capabilities').json()
                    self.assertEqual(capabilities['protocol_version'], 2)
                    self.assertEqual(len(capabilities['generation']['profiles']), 4)
                    self.assertEqual(client.get('/depth/capabilities').status_code, 404 if config is None else 503)

    def test_map_keeps_precision_and_cache_survives_offline_backend(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = dict(comfy_root=str(root), models_dir=str(root), state_dir=str(root/'state'), comfy_url='http://127.0.0.1:8188')
            app = create_depth_app(config)
            app.state.depth_ready = AsyncMock(return_value=dict(models=ASSETS))
            depth = png(Image.new('I;16', (64, 64), 12345))
            app.state.execute = AsyncMock(return_value=(depth, 'prompt-1', {}))
            source = png(Image.new('RGB', (128, 96), 'red'))
            with TestClient(app) as client:
                first = client.post('/depth', files={'file': ('source.png', source, 'image/png')})
                self.assertEqual(first.status_code, 200, first.text)
                data = first.json()
                self.assertEqual(base64.b64decode(data['depth_png_base64']), depth)
                self.assertEqual(data['metadata']['map_sha256'], hashlib.sha256(depth).hexdigest())
                app.state.depth_ready = AsyncMock(side_effect=RuntimeError('Offline'))
                second = client.post('/depth', files={'file': ('source.png', source, 'image/png')}).json()
                self.assertTrue(second['cached'])
                self.assertEqual(second['metadata'], data['metadata'])
                self.assertEqual(app.state.execute.await_count, 1)
                changed = png(Image.new('RGB', (128, 96), 'blue'))
                self.assertEqual(client.post('/depth', files={'file': ('source.png', changed)}).status_code, 503)

    def test_reject_8bit_or_oversized_map_and_source(self):
        with self.assertRaises(ValueError):
            depth_png(png(Image.new('L', (64, 64))))
        with self.assertRaises(ValueError):
            depth_png(png(Image.new('I;16', (1025, 1024))))

    def test_workflow_is_single_step_full_frame_and_uses_scoped_sampler(self):
        graph = json.loads((ROOT/'rapidraw_connector/depth_profiles/marigold-v2-q4.json').read_text())
        self.assertEqual(graph['12']['class_type'], 'RapidRAWMarigoldSampler')
        self.assertEqual(graph['4']['inputs']['sampling'], 'img_to_img_velocity')
        self.assertEqual(graph['10']['inputs']['sigmas'], '0.5, 0')
        self.assertEqual(graph['18']['class_type'], 'ImageScaleToTotalPixels')
        self.assertEqual(graph['16']['inputs']['format.bit_depth'], '16-bit')


class ScopedSampler(unittest.TestCase):
    def test_budget_applies_only_inside_sampler_and_restores_after_error(self):
        normal = 400*1024**2
        memory = SimpleNamespace(extra_reserved_memory=lambda: normal, get_total_memory=lambda _: 16*1024**3, get_torch_device=lambda: 'cuda')
        seen = []
        def run(*_):
            seen.append(memory.extra_reserved_memory())
            return SimpleNamespace(result=('sample', 'denoised'))
        standard = SimpleNamespace(execute=run)
        modules = {'comfy': SimpleNamespace(model_management=memory), 'comfy.model_management': memory,
                   'comfy_extras': SimpleNamespace(), 'comfy_extras.nodes_custom_sampler': SimpleNamespace(SamplerCustomAdvanced=standard)}
        with patch.dict(sys.modules, modules):
            spec = importlib.util.spec_from_file_location('test_marigold_node', ROOT/'comfy-nodes/rapidraw_marigold/__init__.py')
            node = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(node)
            latent = {'samples': SimpleNamespace(shape=(1, 4, 128, 128))}
            self.assertEqual(memory.extra_reserved_memory(), normal)
            self.assertEqual(node.RapidRAWMarigoldSampler().sample(None, None, None, None, latent), ('sample', 'denoised'))
            self.assertEqual(seen, [9*1024**3])
            self.assertEqual(memory.extra_reserved_memory(), normal)
            def fail(*_):
                self.assertEqual(memory.extra_reserved_memory(), 9*1024**3)
                raise RuntimeError('cancelled')
            standard.execute = fail
            with self.assertRaises(RuntimeError):
                node.RapidRAWMarigoldSampler().sample(None, None, None, None, latent)
            self.assertEqual(memory.extra_reserved_memory(), normal)
