"""CPU contract tests for the retained Klein native-edit experiment.

Covers only the retained local-only pure-noise profile klein4-native-v1
(variant B) plus the frozen production profiles. Rejected variants A/C/D/E/F
(grown generation mask, whole-frame reference, prompt policy, reference
order) were removed; these tests pin that cleaned contract.
"""
import base64
from contextlib import ExitStack
import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import AsyncMock

from fastapi.testclient import TestClient
from PIL import Image

from rapidraw_connector import app as service
from rapidraw_connector.config import Profile, Settings, load_catalog, select_profile
from rapidraw_connector.geometry import geometry
from rapidraw_connector.workflows import build_workflow

ROOT = Path(__file__).resolve().parents[1]
PRODUCTION = ('klein4-v1', 'klein4-tight2mp', 'klein9-kv', 'boogu-turbo4-context')
RETAINED = 'klein4-native-v1'
REMOVED_PROFILES = ('klein4-genmask-v1', 'klein4-native-global-v1',
                    'klein4-native-global-promptv1', 'klein4-native-global-local-last-v1',
                    'klein4-native-promptv1')
REMOVED_FIELDS = ('generation_mask_grow', 'generation_mask_feather',
                  'global_reference_megapixels', 'prompt_policy', 'reference_order')


def png(image):
    stream = io.BytesIO()
    image.save(stream, format='PNG')
    return stream.getvalue()


def fixture_arguments(profile_name):
    fixtures = json.loads((ROOT/'tests/fixtures/profile-graphs.json').read_text())
    return next(item for item in fixtures if item['profile'] == profile_name)


class ProductionRegression(unittest.TestCase):
    def test_production_configs_have_no_experimental_settings(self):
        with tempfile.TemporaryDirectory() as directory:
            settings = Settings(Path(directory), ROOT/'profiles', Path(directory)/'state')
            listing = load_catalog(settings)
            self.assertEqual(listing['default_profile'], 'klein4-v1')
            for name in PRODUCTION:
                config = listing['profiles'][name]['config']
                for key in ('pure_noise_output', *REMOVED_FIELDS):
                    self.assertNotIn(key, config, (name, key))

    def test_production_graphs_have_no_experiment_marker(self):
        with tempfile.TemporaryDirectory() as directory:
            settings = Settings(Path(directory), ROOT/'profiles', Path(directory)/'state')
            listing = load_catalog(settings)
            for name in PRODUCTION:
                _, config = select_profile(listing, name, None)
                arguments = fixture_arguments(name)['arguments']
                self.assertNotIn('experiment', build_workflow(*arguments[:-1], config))

    def test_klein_profiles_remain_separate_from_qwen(self):
        with tempfile.TemporaryDirectory() as directory:
            settings = Settings(Path(directory), ROOT/'profiles', Path(directory)/'state')
            listing = load_catalog(settings)
            self.assertIn('qwen21-v1', listing['profiles'])
            for name, item in listing['profiles'].items():
                if name == 'qwen21-v1':
                    continue
                for key in ('model', 'text_encoder', 'vae'):
                    self.assertNotIn('qwen-image', item['config'][key].lower(), (name, key))

    def test_workflow_catalog_hashes_still_match(self):
        catalog = json.loads((ROOT/'workflows/catalog.json').read_text())
        checked = 0
        for entry in catalog['workflows']:
            target = (ROOT/'workflows'/entry['file']).resolve()
            if ROOT/'workflows' not in target.parents or not target.is_file():
                continue
            digest = hashlib.sha256(target.read_bytes()).hexdigest()
            self.assertEqual(digest, entry['sha256'], entry['id'])
            checked += 1
        self.assertGreaterEqual(checked, 4)


class RetainedNativeProfile(unittest.TestCase):
    def setUp(self):
        with tempfile.TemporaryDirectory() as directory:
            self.listing = load_catalog(Settings(Path(directory), ROOT/'profiles', Path(directory)/'state'))
        self.base = fixture_arguments('klein4-v1')['arguments']
        self.source_name, self.mask_name, self.prompt, self.seed, self.g = self.base[:5]

    def config(self, name):
        _, config = select_profile(self.listing, name, None)
        return config

    def classes(self, graph):
        return sorted({node['class_type'] for node in graph['workflow'].values()})

    def test_retained_native_config_is_unchanged(self):
        config = self.config(RETAINED)
        self.assertTrue(config['pure_noise_output'])
        self.assertEqual(config['family'], 'klein')
        for key in REMOVED_FIELDS:
            self.assertNotIn(key, config, key)

    def test_native_uses_pure_noise_and_local_reference_only(self):
        result = build_workflow(self.source_name, self.mask_name, self.prompt, self.seed, self.g,
                                self.config(RETAINED))
        workflow = result['workflow']
        classes = self.classes(result)
        self.assertIn('EmptyFlux2LatentImage', classes)
        self.assertNotIn('SetLatentNoiseMask', classes)
        for removed in ('InvertMask', 'MaskToImage', 'ImageToMask'):
            self.assertNotIn(removed, classes)
        latent = workflow['57']['inputs']
        self.assertEqual((latent['width'], latent['height'], latent['batch_size']),
                         (self.g['gen_width'], self.g['gen_height'], 1))
        sampler_latent = workflow['63']['inputs']['latent_image']
        self.assertEqual(sampler_latent, ['57', 0])
        references = [node for node in workflow.values() if node['class_type'] == 'ReferenceLatent']
        self.assertEqual(len(references), 2)
        self.assertEqual(workflow['58']['inputs']['latent'], ['56', 0])
        self.assertEqual(workflow['59']['inputs']['latent'], ['56', 0])
        # Raw user prompt is preserved verbatim; local generation dimensions kept.
        self.assertEqual(workflow['7']['inputs']['text'], self.prompt)
        self.assertEqual((workflow['57']['inputs']['width'], workflow['57']['inputs']['height']),
                         (self.g['gen_width'], self.g['gen_height']))
        self.assertTrue(result['experiment']['pure_noise_output'])

    def test_pure_noise_rejected_for_non_klein_family(self):
        _, klein = select_profile(self.listing, 'klein4-v1', None)
        _, boogu = select_profile(self.listing, 'boogu-turbo4-context', None)
        for bad in (dict(klein, pure_noise_output=True, family='boogu'),
                    dict(boogu, pure_noise_output=True)):
            with self.subTest(bad=bad):
                with self.assertRaises(ValueError):
                    build_workflow(self.source_name, self.mask_name, self.prompt, self.seed, self.g, bad)

    def test_profile_model_rejects_non_klein_pure_noise(self):
        base = dict(id='probe', family='klein', model='m.safetensors',
                    text_encoder='e.safetensors', vae='v.safetensors',
                    steps=4, cfg=1, megapixels=1)
        with self.assertRaises(ValueError):
            Profile.model_validate(dict(base, pure_noise_output=True, family='boogu'))

    def test_removed_fields_fail_closed(self):
        base = dict(id='probe', family='klein', model='m.safetensors',
                    text_encoder='e.safetensors', vae='v.safetensors',
                    steps=4, cfg=1, megapixels=1)
        for key, value in (('generation_mask_grow', 4), ('generation_mask_feather', 4),
                           ('global_reference_megapixels', 0.75), ('prompt_policy', 'v1'),
                           ('reference_order', 'global_then_local'),
                           ('prompt_policy', 'v9'), ('reference_order', 'sideways')):
            with self.subTest(field=key, value=value):
                with self.assertRaises(ValueError):
                    Profile.model_validate(dict(base, **{key: value}))

    def test_removed_profile_ids_are_not_selectable(self):
        for name in REMOVED_PROFILES:
            with self.subTest(profile=name):
                self.assertNotIn(name, self.listing['profiles'])
                with self.assertRaises(ValueError):
                    select_profile(self.listing, name, None)

    def test_capabilities_expose_production_retained_native_and_qwen(self):
        with tempfile.TemporaryDirectory() as directory:
            settings = Settings(Path(directory), ROOT/'profiles', Path(directory)/'state')
            labels = {name: item['label'] for name, item in load_catalog(settings)['profiles'].items()}
            with TestClient(service.create_app(settings)) as client:
                profiles = {item['id']: item for item in client.get('/capabilities').json()['generation']['profiles']}
                self.assertEqual(set(profiles), {*PRODUCTION, RETAINED, 'qwen21-v1', 'qwen21-remove-v1', 'qwen21-remove-pe-v1'})
            for name in REMOVED_PROFILES:
                self.assertNotIn(name, profiles)
            self.assertEqual(profiles[RETAINED]['megapixels'], [1, 2])
            self.assertIn('Experimental', labels[RETAINED])


class NativeReceipt(unittest.TestCase):
    def make_client(self, profile_id, profile_config):
        root = Path(self.stack.enter_context(tempfile.TemporaryDirectory()))
        profiles = root/'profiles'
        profiles.mkdir()
        (profiles/(profile_id+'.json')).write_text(json.dumps(profile_config))
        (profiles/'profiles.json').write_text(json.dumps(dict(
            default_profile=profile_id,
            profiles={profile_id: dict(label='Probe', config=profile_id+'.json', megapixels=[.0625])})))
        settings = Settings(root, profiles, root/'state')
        app = service.create_app(settings)
        app.state.execute = AsyncMock(side_effect=self.success)
        return self.stack.enter_context(TestClient(app)), settings

    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.native = dict(id='probe-native', family='klein', model='m.safetensors',
                           text_encoder='e.safetensors', vae='v.safetensors',
                           steps=4, cfg=1, mode='masked', megapixels=.0625,
                           margin_fraction=.1, pure_noise_output=True)
        self.client, self.settings = self.make_client('probe-native', self.native)
        stream = io.BytesIO()
        Image.new('RGB', (320, 240), (60, 70, 80)).save(stream, format='JPEG', quality=95)
        self.source_bytes = stream.getvalue()
        mask = Image.new('RGBA', (320, 240), (0, 0, 0, 255))
        mask.paste((255, 255, 255, 255), (80, 60, 100, 90))
        self.mask_bytes = png(mask)
        self.mask_alpha = Image.open(io.BytesIO(self.mask_bytes)).convert('L')
        self.payload = dict(source_id='b'*64, prompt='Remove the parked car.',
                            mask_image_base64=base64.b64encode(self.mask_bytes).decode(),
                            seed=104729, profile='probe-native', megapixels=.0625)

    def receipts(self):
        return list(self.settings.receipt_dir.glob('*/receipt.json'))

    async def success(self, settings, graph, output_node, on_event):
        await on_event(dict(kind='submitted', prompt_id='probe-prompt'))
        size = (graph['51']['inputs']['width'], graph['51']['inputs']['height'])
        history = {'status': {'status_str': 'success'}, 'outputs': {}}
        await on_event(dict(kind='history', prompt_id='probe-prompt', history=history))
        return png(Image.new('RGB', size, (180, 30, 90))), 'probe-prompt', history

    def test_native_pure_noise_receipt_keeps_original_mask_and_private_marker(self):
        self.assertEqual(self.client.post('/upload_source', data={'source_id': self.payload['source_id']},
                                          files={'file': ('source.jpg', self.source_bytes, 'image/jpeg')}).status_code, 200)
        response = self.client.post('/inpaint', json=self.payload)
        self.assertEqual(response.status_code, 200, response.text)
        data = response.json()
        receipt = json.loads(self.receipts()[0].read_text())
        experiment = receipt['experiment']
        self.assertTrue(experiment['pure_noise_output'])
        # The inference file carries the original request mask alpha.
        inference = Image.open(Path(receipt['inference_mask_path'])).getchannel('A')
        self.assertEqual(list(inference.get_flattened_data()),
                         list(self.mask_alpha.get_flattened_data()))
        self.assertEqual(Path(receipt['mask_path']).read_bytes(), self.mask_bytes)
        # The returned response mask is still the original selection.
        returned = Image.open(io.BytesIO(base64.b64decode(data['mask']))).convert('L')
        original_crop = self.mask_alpha.crop((data['x'], data['y'], data['x']+data['width'], data['y']+data['height']))
        self.assertEqual(list(returned.get_flattened_data()), list(original_crop.get_flattened_data()))
        self.assertEqual(returned.getbbox(), (16, 16, 36, 46))
        # Public generation metadata stays bounded and prompt-free.
        self.assertEqual(set(data['generation']), {'request_id', 'seed', 'profile', 'source_size',
                                                   'generated_size', 'context', 'seconds'})
        self.assertNotIn(self.payload['prompt'], response.text)


if __name__ == '__main__':
    unittest.main()
