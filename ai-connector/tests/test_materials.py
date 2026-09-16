import asyncio
import base64
import io
import json
from pathlib import Path
import struct
import tempfile
import unittest
from unittest.mock import AsyncMock, patch
import zlib

import httpx
from fastapi.testclient import TestClient
from PIL import Image

from rapidraw_connector.app import create_app
from rapidraw_connector.config import Settings
from rapidraw_connector.materials import material_png

ROOT = Path(__file__).resolve().parents[1]


def png(image):
    stream = io.BytesIO()
    image.save(stream, format='PNG')
    return stream.getvalue()


def rgb16():
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))
    pixels = (b'\0' + struct.pack('>HHH', 12345, 32768, 65432) * 64) * 64
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 64, 64, 16, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(pixels)) + chunk(b'IEND', b'')


class MaterialRoutes(unittest.TestCase):
    def test_disabled_or_broken_optional_setup_preserves_generation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            baseline = TestClient(create_app(Settings(root, ROOT/'profiles', root/'state'))).get('/capabilities').json()
            for config in (None, root/'missing.json'):
                app = create_app(Settings(root, ROOT/'profiles', root/'state', materials_config=config))
                with TestClient(app) as client:
                    self.assertEqual(client.get('/capabilities').json(), baseline)
                    self.assertEqual(client.get('/materials/capabilities').status_code, 404 if config is None else 503)

    def test_precise_cache_is_separate_by_task_and_survives_offline(self):
        with tempfile.TemporaryDirectory() as directory, patch('rapidraw_connector.workflow_switch.WorkflowSwitch.activate', new_callable=AsyncMock):
            root = Path(directory)
            config = root/'materials.json'
            config.write_text(json.dumps(dict(models_dir=str(root), state_dir=str(root/'maps'))))
            app = create_app(Settings(root, ROOT/'profiles', root/'state', materials_config=config))
            app.state.material_ready = AsyncMock()
            app.state.execute = AsyncMock(return_value=(rgb16(), 'prompt-1', {}))
            upload = dict(file=('source.png', png(Image.new('RGB', (96, 64), 'red')), 'image/png'))
            with TestClient(app) as client:
                first = client.post('/materials/normals', files=upload)
                self.assertEqual(first.status_code, 200, first.text)
                self.assertEqual(base64.b64decode(first.json()['map_png_base64']), rgb16())
                app.state.material_ready = AsyncMock(side_effect=RuntimeError('/private/model is offline'))
                cached = client.post('/materials/normals', files=upload).json()
                self.assertTrue(cached['cached'])
                self.assertEqual(cached['metadata'], first.json()['metadata'])
                other = client.post('/materials/albedo', files=upload)
                self.assertEqual(other.status_code, 503)
                self.assertNotIn('/private/model', other.text)
                self.assertEqual(app.state.execute.await_count, 1)
                # A damaged receipt must fail safely instead of serving wrong pixels.
                next((root/'maps').glob('*.json')).write_text('{broken')
                self.assertEqual(client.post('/materials/normals', files=upload).status_code, 503)
                self.assertEqual(client.post('/materials/unknown', files=upload).status_code, 404)
                self.assertEqual(client.post('/materials/normals', files={'file': ('bad.png', b'bad')}).status_code, 400)

    def test_rgb16_contract_rejects_grayscale_and_8bit(self):
        self.assertEqual(material_png(rgb16()), (64, 64))
        for im in (Image.new('RGB', (64, 64)), Image.new('I;16', (64, 64))):
            with self.assertRaises(ValueError):
                material_png(png(im))

    def test_invalid_material_config_does_not_add_switching_to_generation(self):
        with tempfile.TemporaryDirectory() as directory, patch('rapidraw_connector.workflow_switch.WorkflowSwitch.activate', new_callable=AsyncMock) as switch:
            root = Path(directory)
            config = root/'broken.json'; config.write_text('{}')
            app = create_app(Settings(root, ROOT/'profiles', root/'state', materials_config=config))
            async def execute(settings, graph, node, on_event):
                size = (graph['51']['inputs']['width'], graph['51']['inputs']['height'])
                return png(Image.new('RGB', size)), 'prompt', {}
            app.state.execute = execute
            with TestClient(app) as client:
                source = png(Image.new('RGB', (128, 96), 'red'))
                self.assertEqual(client.post('/upload_source', data={'source_id': 'b'*64}, files={'file': ('source.png', source)}).status_code, 200)
                payload = dict(source_id='b'*64, prompt='Change colour', seed=7,
                               mask_image_base64=base64.b64encode(png(Image.new('RGBA', (128, 96), 'white'))).decode())
                response = client.post('/inpaint', json=payload)
                self.assertEqual(response.status_code, 200, response.text)
                switch.assert_not_awaited()

    def test_generation_depth_and_materials_share_one_queue(self):
        with tempfile.TemporaryDirectory() as directory, patch('rapidraw_connector.workflow_switch.WorkflowSwitch.activate', new_callable=AsyncMock) as switch:
            root = Path(directory)
            for kind in ('depth', 'materials'):
                (root/(kind+'.json')).write_text(json.dumps(dict(models_dir=str(root), state_dir=str(root/kind))))
            app = create_app(Settings(root, ROOT/'profiles', root/'state', depth_config=root/'depth.json', materials_config=root/'materials.json'))
            app.state.depth_ready = AsyncMock(return_value=dict(models={}))
            app.state.material_ready = AsyncMock()
            active, peak = 0, 0
            async def execute(settings, graph, node, on_event):
                nonlocal active, peak
                active += 1
                peak = max(peak, active)
                await asyncio.sleep(.02)
                active -= 1
                if node == '99':
                    data = png(Image.new('RGB', (graph['51']['inputs']['width'], graph['51']['inputs']['height'])))
                elif graph['14']['inputs']['prediction'] == 'depth':
                    data = png(Image.new('I;16', (64, 64), 12345))
                else:
                    data = rgb16()
                return data, 'prompt', {}
            app.state.execute = execute
            async def run():
                source = png(Image.new('RGB', (128, 96), 'red'))
                mask = png(Image.new('RGBA', (128, 96), 'white'))
                async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
                    response = await client.post('/upload_source', data={'source_id': 'a'*64}, files={'file': ('source.png', source)})
                    self.assertEqual(response.status_code, 200, response.text)
                    payload = dict(source_id='a'*64, prompt='Change colour', mask_image_base64=base64.b64encode(mask).decode(), seed=7)
                    responses = await asyncio.gather(client.post('/materials/normals', files={'file': ('source.png', source)}),
                                                     client.post('/depth', files={'file': ('source.png', source)}),
                                                     client.post('/inpaint', json=payload))
                    self.assertEqual([r.status_code for r in responses], [200, 200, 200], [r.text[:200] for r in responses])
            asyncio.run(run())
            self.assertEqual(peak, 1)
            self.assertEqual({call.args[1] for call in switch.await_args_list}, {'materials:normals', 'depth', 'generation'})
