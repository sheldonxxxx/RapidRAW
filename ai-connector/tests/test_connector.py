import base64
from contextlib import ExitStack
import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient
from PIL import Image

from rapidraw_connector import app as service
from rapidraw_connector.config import Settings, load_catalog, select_profile
from rapidraw_connector.geometry import geometry, pack
from rapidraw_connector.workflows import build_workflow

ROOT = Path(__file__).resolve().parents[1]


def png(image):
    stream = io.BytesIO()
    image.save(stream, format='PNG')
    return stream.getvalue()


class GraphContract(unittest.TestCase):
    def test_four_profile_graphs_and_geometry_match_fixtures(self):
        fixtures = json.loads((ROOT/'tests/fixtures/profile-graphs.json').read_text())
        self.assertEqual(len(fixtures), 4)
        with tempfile.TemporaryDirectory() as directory:
            settings = Settings(Path(directory), ROOT/'profiles', Path(directory)/'state')
            listing = load_catalog(settings)
            for fixture in fixtures:
                with self.subTest(profile=fixture['profile']):
                    _, config = select_profile(listing, fixture['profile'], None)
                    arguments = fixture['arguments']
                    self.assertEqual(config, arguments[-1])
                    mask = Image.new('L', tuple(fixture['source_size']))
                    mask.paste(128, fixture['soft_bounds'])
                    mask.paste(255, fixture['core_bounds'])
                    self.assertEqual(geometry(mask.size, mask, config), arguments[-2])
                    actual = build_workflow(*arguments[:-1], config)
                    self.assertEqual(actual, fixture['expected'])
                    self.assertEqual(actual['workflow']['7']['inputs'].get('text', actual['workflow']['7']['inputs'].get('prompt')), arguments[2])

    def test_native_alpha_is_returned_once_and_preserves_unselected_pixels(self):
        source = Image.new('RGB', (200, 160), (20, 70, 120))
        mask = Image.new('L', source.size)
        mask.paste(128, (80, 60, 100, 90))
        mask.paste(255, (84, 64, 96, 86))
        g = dict(x=40, y=20, width=120, height=110)
        response = pack(Image.new('RGB', (120, 110), (180, 30, 90)), mask, g)
        color = Image.open(io.BytesIO(base64.b64decode(response['color'])))
        returned_mask = Image.open(io.BytesIO(base64.b64decode(response['mask'])))
        self.assertEqual((response['x'], response['y']), (64, 44))
        self.assertEqual(color.getpixel((16, 16)), (180, 30, 90))
        self.assertEqual(returned_mask.getpixel((16, 16)), 128)
        native_color = source.copy()
        native_color.paste(color, (response['x'], response['y']))
        final = Image.composite(native_color, source, mask)
        self.assertEqual(final.getpixel((80, 60)), (100, 50, 105))
        self.assertEqual(final.getpixel((90, 70)), (180, 30, 90))
        for before, after, alpha in zip(source.get_flattened_data(), final.get_flattened_data(), mask.get_flattened_data()):
            if not alpha:
                self.assertEqual(before, after)

    def test_settings_require_explicit_paths(self):
        with patch.dict('os.environ', {}, clear=True):
            with self.assertRaisesRegex(ValueError, 'COMFY_ROOT is required'):
                Settings.from_env()


class HTTPContract(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.root = Path(self.stack.enter_context(tempfile.TemporaryDirectory()))
        profiles = self.root/'profiles'
        profiles.mkdir()
        self.config = dict(id='fast', family='klein', model='fixture.safetensors', text_encoder='encoder.safetensors', vae='vae.safetensors', steps=4, cfg=1, mode='masked', megapixels=.0625, margin_fraction=.1)
        (profiles/'fast.json').write_text(json.dumps(self.config))
        listing = dict(default_profile='fast', profiles={'fast': dict(label='Fast', config='fast.json', megapixels=[.0625, .125])})
        (profiles/'profiles.json').write_text(json.dumps(listing))
        self.settings = Settings(self.root, profiles, self.root/'state')
        self.app = service.create_app(self.settings)
        self.execute = AsyncMock(side_effect=self.success)
        self.app.state.execute = self.execute
        self.client = self.stack.enter_context(TestClient(self.app))
        stream = io.BytesIO()
        Image.new('RGB', (320, 240), (60, 70, 80)).save(stream, format='JPEG', quality=95)
        self.source_bytes = stream.getvalue()
        mask = Image.new('RGBA', (320, 240), (0, 0, 0, 255))
        mask.paste((128, 128, 128, 255), (80, 60, 100, 90))
        mask.paste((255, 255, 255, 255), (84, 64, 96, 86))
        self.mask_bytes = png(mask)
        self.payload = dict(source_id='a'*64, prompt='Repair the road', negative_prompt='blur, low quality, distortion, watermark', mask_image_base64=base64.b64encode(self.mask_bytes).decode(), seed=104729, profile='fast', megapixels=.0625)

    def upload(self, data=None):
        return self.client.post('/upload_source', data={'source_id': self.payload['source_id']}, files={'file': ('source.jpg', data or self.source_bytes, 'image/jpeg')})

    def receipts(self):
        return list(self.settings.receipt_dir.glob('*/receipt.json'))

    async def success(self, settings, graph, output_node, on_event):
        self.assertEqual(settings, self.settings)
        self.assertEqual(output_node, '99')
        files = self.receipts()
        self.assertEqual(len(files), 1)
        receipt = json.loads(files[0].read_text())
        self.assertEqual(receipt['status'], 'prepared')
        self.assertEqual(receipt['seed'], self.payload['seed'])
        self.assertEqual(receipt['source_sha256'], hashlib.sha256(self.source_bytes).hexdigest())
        self.assertEqual(Path(receipt['source_path']).read_bytes(), self.source_bytes)
        self.assertEqual(Path(receipt['mask_path']).read_bytes(), self.mask_bytes)
        self.assertEqual(receipt['prompt'], self.payload['prompt'])
        self.assertEqual(json.loads(files[0].with_name('workflow.json').read_text()), graph)
        with Image.open(Path(receipt['inference_mask_path'])) as alpha:
            self.assertEqual(alpha.getpixel((80, 60)), (0, 0, 0, 128))
        await on_event(dict(kind='submitted', prompt_id='fixture-prompt'))
        self.assertEqual(json.loads(files[0].read_text())['prompt_id'], 'fixture-prompt')
        size = (graph['51']['inputs']['width'], graph['51']['inputs']['height'])
        history = {'status': {'status_str': 'success'}, 'outputs': {}}
        await on_event(dict(kind='history', prompt_id='fixture-prompt', history=history))
        return png(Image.new('RGB', size, (180, 30, 90))), 'fixture-prompt', history

    def test_native_upload_retry_capabilities_and_success(self):
        cap = self.client.get('/capabilities').json()
        self.assertEqual(cap['protocol_version'], 2)
        self.assertEqual(cap['generation']['profiles'][0]['megapixels'], [.0625, .125])
        self.assertEqual(self.client.post('/inpaint', json=self.payload).status_code, 404)
        self.execute.assert_not_called()
        self.assertEqual(self.upload().status_code, 200)
        response = self.client.post('/inpaint', json=self.payload)
        self.assertEqual(response.status_code, 200, response.text)
        data = response.json()
        color = Image.open(io.BytesIO(base64.b64decode(data['color'])))
        mask = Image.open(io.BytesIO(base64.b64decode(data['mask'])))
        self.assertEqual(color.getpixel((80-data['x'], 60-data['y'])), (180, 30, 90))
        self.assertEqual(mask.getpixel((80-data['x'], 60-data['y'])), 128)
        self.assertEqual(set(data['generation']), {'request_id', 'seed', 'profile', 'source_size', 'generated_size', 'context', 'seconds'})
        self.assertNotIn(str(self.root), response.text)
        self.assertNotIn(self.payload['prompt'], response.text)
        receipt = json.loads(self.receipts()[0].read_text())
        self.assertEqual(receipt['status'], 'completed')
        self.assertTrue(self.receipts()[0].with_name('generated.png').exists())
        self.execute.assert_awaited_once()

    def test_source_cache_is_idempotent_and_rejects_changed_bytes(self):
        self.assertEqual(self.upload().status_code, 200)
        self.assertEqual(self.upload().status_code, 200)
        changed = png(Image.new('RGB', (320, 240), (200, 30, 10)))
        self.assertEqual(self.upload(changed).status_code, 409)
        path = self.settings.cache_dir/(self.payload['source_id']+'.jpg')
        self.assertEqual(path.read_bytes(), self.source_bytes)
        self.execute.assert_not_called()

    def test_failure_keeps_private_receipt_and_never_replays(self):
        self.upload()
        async def fail(settings, graph, output_node, on_event):
            await on_event(dict(kind='submitted', prompt_id='failed-prompt'))
            await on_event(dict(kind='history', prompt_id='failed-prompt', history={'status': {'status_str': 'error'}}))
            raise RuntimeError('/private/model/path ' + 'secret'*3000)
        self.execute.side_effect = fail
        response = self.client.post('/inpaint', json=self.payload)
        self.assertEqual(response.status_code, 502)
        self.assertNotIn('/private/model/path', response.text)
        self.assertNotIn('secret', response.text)
        receipt = json.loads(self.receipts()[0].read_text())
        self.assertEqual(receipt['status'], 'failed')
        self.assertEqual(receipt['prompt_id'], 'failed-prompt')
        self.assertEqual(len(receipt['error']), service.MAX_ERROR_CHARS)
        self.assertEqual(Path(receipt['mask_path']).read_bytes(), self.mask_bytes)
        self.execute.assert_awaited_once()

    def test_ambiguous_submission_keeps_resolved_seed(self):
        self.upload()
        async def fail(settings, graph, output_node, on_event):
            await on_event(dict(kind='submission_started'))
            raise ConnectionError('Connection lost before acknowledgement')
        self.execute.side_effect = fail
        with patch.object(service.secrets, 'randbelow', return_value=9876):
            response = self.client.post('/inpaint', json=dict(self.payload, seed=0))
        self.assertEqual(response.status_code, 502)
        receipt = json.loads(self.receipts()[0].read_text())
        self.assertEqual(receipt['status'], 'submission_unknown')
        self.assertEqual(receipt['seed'], 9877)
        self.assertNotIn('prompt_id', receipt)
        self.execute.assert_awaited_once()

    def test_wrong_output_dimensions_keep_raw_result(self):
        self.upload()
        async def wrong(settings, graph, output_node, on_event):
            await on_event(dict(kind='submitted', prompt_id='wrong-size'))
            return png(Image.new('RGB', (8, 8))), 'wrong-size', {}
        self.execute.side_effect = wrong
        self.assertEqual(self.client.post('/inpaint', json=self.payload).status_code, 502)
        receipt = json.loads(self.receipts()[0].read_text())
        self.assertEqual(receipt['status'], 'failed')
        with Image.open(self.receipts()[0].with_name('generated.png')) as image:
            self.assertEqual(image.size, (8, 8))

    def test_invalid_inputs_never_enqueue_or_echo_payload(self):
        self.upload()
        for image in (Image.new('L', (319, 240), 255), Image.new('L', (320, 240))):
            payload = dict(self.payload, mask_image_base64=base64.b64encode(png(image)).decode())
            self.assertEqual(self.client.post('/inpaint', json=payload).status_code, 400)
        for change in (dict(seed=-1), dict(seed=1.5), dict(seed=True), dict(seed=9007199254740992), dict(source_id='../outside'), dict(extra='private prompt')):
            response = self.client.post('/inpaint', json=dict(self.payload, **change))
            self.assertEqual(response.status_code, 422, response.text)
            self.assertNotIn('Repair the road', response.text)
            self.assertNotIn(self.payload['mask_image_base64'], response.text)
        for change in (dict(profile='unknown'), dict(megapixels=2), dict(mask_image_base64='bad data')):
            self.assertEqual(self.client.post('/inpaint', json=dict(self.payload, **change)).status_code, 400)
        self.execute.assert_not_called()
        self.assertEqual(self.receipts(), [])

    def test_config_rejects_hidden_prompt_rewrites_and_unknown_families(self):
        path = self.settings.profile_dir/'fast.json'
        for change in (dict(prompt_map={'Repair the road': 'Different prompt'}), dict(family='lama'), dict(model='../model.safetensors')):
            path.write_text(json.dumps(dict(self.config, **change)))
            with self.assertRaises(ValueError):
                load_catalog(self.settings)

    def test_cpu_preparation_does_not_block_capabilities(self):
        from concurrent.futures import ThreadPoolExecutor
        from threading import Event
        self.upload()
        entered, release = Event(), Event()
        original = service.read_request_images
        def slow(*args):
            entered.set()
            release.wait(5)
            return original(*args)
        with patch.object(service, 'read_request_images', side_effect=slow), ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(self.client.post, '/inpaint', json=self.payload)
            self.assertTrue(entered.wait(3))
            try:
                self.assertEqual(self.client.get('/capabilities').status_code, 200)
                self.assertFalse(pending.done())
            finally:
                release.set()
            self.assertEqual(pending.result(timeout=5).status_code, 200)

    def test_real_http_transport_with_fake_comfy_never_retries_submission(self):
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
        from threading import Thread
        from urllib.parse import urlparse
        self.upload()
        state = dict(posts=0, behavior='success')

        class FakeComfy(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def reply(self, value, status=200, mime='application/json'):
                body = json.dumps(value).encode() if mime == 'application/json' else value
                self.send_response(status)
                self.send_header('Content-Type', mime)
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_POST(self):
                state['posts'] += 1
                state['graph'] = json.loads(self.rfile.read(int(self.headers['Content-Length'])))['prompt']
                if state['behavior'] == 'reject':
                    self.reply({'error': 'private rejection detail'}, status=400)
                else:
                    self.reply({'prompt_id': 'transport-prompt'})

            def do_GET(self):
                path = urlparse(self.path).path
                if path == '/system_stats':
                    self.reply({'system': {}})
                elif path == '/history/transport-prompt':
                    status = {'status_str': 'success'}
                    if state['behavior'] == 'fail':
                        status = {'status_str': 'error', 'messages': [['execution_error', {'exception_message': 'private model failure'}]]}
                    self.reply({'transport-prompt': {'status': status, 'outputs': {'99': {'images': [{'filename': 'result.png', 'subfolder': '', 'type': 'temp'}]}}}})
                elif path == '/view':
                    inputs = state['graph']['51']['inputs']
                    self.reply(png(Image.new('RGB', (inputs['width'], inputs['height']), (180, 30, 90))), mime='image/png')
                else:
                    self.reply({}, status=404)

        server = ThreadingHTTPServer(('127.0.0.1', 0), FakeComfy)
        worker = Thread(target=server.serve_forever, daemon=True)
        worker.start()
        settings = Settings(self.settings.comfy_root, self.settings.profile_dir, self.settings.state_dir,
                            comfy_url=f'http://127.0.0.1:{server.server_port}')
        try:
            with TestClient(service.create_app(settings)) as client:
                self.assertEqual(client.get('/health').json()['connected'], True)
                for behavior, expected_status in [('success', 200), ('reject', 502), ('fail', 502)]:
                    with self.subTest(behavior=behavior):
                        state['behavior'] = behavior
                        before = state['posts']
                        response = client.post('/inpaint', json=self.payload)
                        self.assertEqual(response.status_code, expected_status, response.text)
                        self.assertEqual(state['posts'], before+1)
                        value = response.json()['generation' if expected_status == 200 else 'detail']
                        receipt = json.loads((settings.receipt_dir/value['request_id']/'receipt.json').read_text())
                        kinds = [event['kind'] for event in receipt['execution_events']]
                        self.assertEqual(kinds[0], 'submission_started')
                        self.assertEqual(receipt['status'], 'completed' if behavior == 'success' else 'failed')
                        self.assertIn('rejected' if behavior == 'reject' else 'submitted', kinds)
                        self.assertNotIn('private model failure', response.text)
                        self.assertNotIn('private rejection detail', response.text)
        finally:
            server.shutdown()
            server.server_close()
            worker.join(timeout=2)

    def test_concurrent_source_upload_cannot_replace_first_content(self):
        from concurrent.futures import ThreadPoolExecutor
        from threading import Barrier
        barrier = Barrier(2)
        first, second = self.source_bytes, png(Image.new('RGB', (320, 240), (190, 30, 10)))
        def write(data):
            barrier.wait(timeout=3)
            try:
                service.store_source(self.settings.cache_dir, self.payload['source_id'], data)
                return 'stored', data
            except service.SourceConflict:
                return 'conflict', data
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(write, [first, second]))
        self.assertEqual(sorted(result[0] for result in results), ['conflict', 'stored'])
        winner = next(data for status, data in results if status == 'stored')
        self.assertEqual((self.settings.cache_dir/(self.payload['source_id']+'.jpg')).read_bytes(), winner)


if __name__ == '__main__':
    unittest.main()
