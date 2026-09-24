"""Qwen Image 2.1 profile discovery and native editing graph contract."""
import json
import base64
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import AsyncMock
from fastapi.testclient import TestClient
from rapidraw_connector.config import Settings, load_catalog, select_profile
from rapidraw_connector.app import create_app, parse_pe_prompt
from rapidraw_connector.workflows import REMOVE_PROMPT, build_pe_workflow, build_workflow
from rapidraw_connector.geometry import geometry
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]

class Qwen21Tests(unittest.TestCase):
    def test_catalog_and_native_conditioning(self):
        with tempfile.TemporaryDirectory() as directory:
            listing = load_catalog(Settings(Path(directory), ROOT/'profiles', Path(directory)/'state'))
        self.assertEqual(listing['default_profile'], 'klein4-v1')
        self.assertEqual(listing['profiles']['qwen21-v1']['label'], 'Qwen Image 2.1')
        for mp in (1, 2):
            _, config = select_profile(listing, 'qwen21-v1', mp)
            g = geometry((320,240), Image.new('L',(320,240),255), config)
            self.assertEqual(g['gen_width'] % 32, 0)
            self.assertEqual(g['gen_height'] % 32, 0)
            graph = build_workflow('source.png', 'mask.png', 'Remove the object.', 104729,
                                  dict(x=10,y=20,width=800,height=640,gen_width=1024,gen_height=832), config)['workflow']
            self.assertEqual(graph['7']['class_type'], 'TextEncodeQwenImage21')
            self.assertEqual(graph['7']['inputs']['resolution'], 0)
            self.assertEqual(graph['7']['inputs']['images.image_1'], ['51',0])
            self.assertNotIn('images.image_2', graph['7']['inputs'])
            self.assertEqual(graph['63']['inputs']['latent_image'], ['7',2])
            self.assertEqual(graph['63']['inputs']['positive'], ['7',0])
            self.assertEqual(graph['63']['inputs']['negative'], ['7',1])
            self.assertEqual(graph['63']['inputs']['steps'], 30)
            self.assertEqual(graph['63']['inputs']['cfg'], 1)
            self.assertEqual(graph['5']['class_type'], 'QwenImage21Cache')
            self.assertFalse(any(n['class_type']=='SetLatentNoiseMask' for n in graph.values()))

    def test_prompt_free_remove_profile_does_not_rewrite_edit_prompts(self):
        with tempfile.TemporaryDirectory() as directory:
            listing = load_catalog(Settings(Path(directory), ROOT/'profiles', Path(directory)/'state'))
        self.assertEqual(listing['profiles']['qwen21-remove-v1']['label'], 'Qwen Image 2.1 · Remove')
        _, remove = select_profile(listing, 'qwen21-remove-v1', 1)
        _, edit = select_profile(listing, 'qwen21-v1', 1)
        self.assertEqual(remove['task'], 'remove')
        self.assertEqual(edit.get('task'), None)
        g = dict(x=0,y=0,width=320,height=320,gen_width=320,gen_height=320)
        self.assertEqual(build_workflow('source.png','mask.png','',42,g,remove)['workflow']['7']['inputs']['prompt'], REMOVE_PROMPT)
        self.assertEqual(build_workflow('source.png','mask.png','remove the bird',42,g,edit)['workflow']['7']['inputs']['prompt'], 'remove the bird')

    def test_remove_accepts_missing_prompt_and_records_model_instruction(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            app=create_app(Settings(root,ROOT/'profiles',root/'state'))
            async def generate(settings, graph, output_node, on_event):
                width=graph['51']['inputs']['width']
                height=graph['51']['inputs']['height']
                return self._png(Image.new('RGB',(width,height),(60,80,100))), 'id',{}
            app.state.execute=AsyncMock(side_effect=generate)
            with TestClient(app) as client:
                caps=client.get('/capabilities').json()['generation']['profiles']
                self.assertFalse(next(p for p in caps if p['id']=='qwen21-remove-v1')['requires_prompt'])
                self.assertTrue(next(p for p in caps if p['id']=='qwen21-v1')['requires_prompt'])
                source_id='a'*64
                source=io.BytesIO();Image.new('RGB',(320,320),(60,80,100)).save(source,format='JPEG')
                self.assertEqual(client.post('/upload_source',data={'source_id':source_id},files={'file':('source.jpg',source.getvalue(),'image/jpeg')}).status_code,200)
                payload={'source_id':source_id,'profile':'qwen21-remove-v1','mask_image_base64':base64.b64encode(self._png(Image.new('L',(320,320),255))).decode(),'seed':42}
                self.assertEqual(client.post('/inpaint',json={**payload,'prompt':'replace with bird'}).status_code,400)
                self.assertEqual(client.post('/inpaint',json={**payload,'profile':'qwen21-v1'}).status_code,400)
                response=client.post('/inpaint',json=payload)
                self.assertEqual(response.status_code,200,response.text[:300])
                receipt=json.loads((root/'state/receipts'/response.json()['generation']['request_id']/'receipt.json').read_text())
                self.assertEqual(receipt['prompt'],'')
                self.assertEqual(receipt['effective_prompt'],REMOVE_PROMPT)
                self.assertEqual(receipt['config']['task'],'remove')

    def test_multi_reference_request_reaches_qwen_and_receipts(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            app = create_app(Settings(root, ROOT/'profiles', root/'state'))
            async def generate(settings, graph, output_node, on_event):
                self.assertEqual(graph['7']['inputs']['images.image_1'], ['51', 0])
                self.assertEqual(graph['7']['inputs']['images.image_2'], ['70', 0])
                self.assertEqual(graph['7']['inputs']['images.image_3'], ['71', 0])
                return self._png(Image.new('RGB', (graph['51']['inputs']['width'], graph['51']['inputs']['height']), (60,80,100))), 'id', {}
            app.state.execute = AsyncMock(side_effect=generate)
            with TestClient(app) as client:
                profiles = client.get('/capabilities').json()['generation']['profiles']
                self.assertTrue(next(p for p in profiles if p['id'] == 'qwen21-v1')['reference_image'])
                source = io.BytesIO()
                Image.new('RGB', (320,320), (60,80,100)).save(source, format='JPEG')
                source_id = 'b'*64
                client.post('/upload_source', data={'source_id':source_id}, files={'file':('source.jpg',source.getvalue(),'image/jpeg')})
                references = [base64.b64encode(self._png(Image.new('RGB', (64,64), color))).decode() for color in ('red','blue')]
                payload = dict(source_id=source_id, profile='qwen21-v1', prompt='Use both references', seed=42,
                               mask_image_base64=base64.b64encode(self._png(Image.new('L',(320,320),255))).decode(), reference_images_base64=references)
                self.assertEqual(client.post('/inpaint', json={**payload, 'reference_images_base64':references*3}).status_code, 422)
                self.assertEqual(client.post('/inpaint', json={**payload, 'reference_images_base64':['']}).status_code, 422)
                response = client.post('/inpaint', json=payload)
                self.assertEqual(response.status_code, 200, response.text[:300])
                evidence = root/'state/receipts'/response.json()['generation']['request_id']
                receipt = json.loads((evidence/'receipt.json').read_text())
                self.assertEqual(receipt['prompt'], 'Use both references')
                self.assertTrue(receipt['effective_prompt'].startswith('Edit image 1'))
                self.assertTrue(receipt['effective_prompt'].endswith(receipt['prompt']))
                self.assertEqual(len(receipt['reference_sha256']), 2)
                self.assertTrue((evidence/'reference-1.png').is_file())
                self.assertTrue((evidence/'reference-2.png').is_file())

    def test_pe_remove_preserves_pe_prompt_without_mask_in_qwen(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            listing = load_catalog(Settings(root, ROOT/'profiles', root/'state'))
            self.assertEqual(listing['profiles']['qwen21-remove-pe-v1']['label'], 'Qwen remove PE')
            _, config = select_profile(listing, 'qwen21-remove-pe-v1', 1)
            g = dict(x=0, y=0, width=320, height=320, gen_width=320, gen_height=320)
            pe = build_pe_workflow('source.jpg', 'mask.png', 'Remove the birds', g, config)['workflow']
            self.assertEqual(pe['7']['inputs']['image2'], ['54', 0])
            self.assertIn('must not mention a mask', pe['2']['inputs']['prompt'])
            self.assertFalse(any(n['class_type'] == 'SaveText' for n in pe.values()))
            rewritten = 'Remove the distant birds and restore natural snow behind the foreground cranes.'
            app = create_app(Settings(root, ROOT/'profiles', root/'state'))
            async def enhance(settings, graph, node, on_event):
                self.assertEqual(graph['2']['class_type'], 'TextGenerate')
                await on_event(dict(kind='submitted', prompt_id='pe-id'))
                return rewritten, 'pe-id'
            async def generate(settings, graph, node, on_event):
                self.assertEqual(graph['7']['inputs']['prompt'], rewritten)
                self.assertEqual(graph['7']['inputs']['images.image_1'], ['51', 0])
                self.assertNotIn('images.image_2', graph['7']['inputs'])
                self.assertFalse(any(n['class_type'] in ('InvertMask', 'MaskToImage') for n in graph.values()))
                self.assertFalse(any(n['class_type'] == 'SetLatentNoiseMask' for n in graph.values()))
                return self._png(Image.new('RGB', (graph['51']['inputs']['width'], graph['51']['inputs']['height']), (60, 80, 100))), 'gen-id', {}
            app.state.execute_pe = AsyncMock(side_effect=enhance)
            app.state.execute = AsyncMock(side_effect=generate)
            with TestClient(app) as client:
                caps = client.get('/capabilities').json()['generation']['profiles']
                selected = next(p for p in caps if p['id'] == 'qwen21-remove-pe-v1')
                self.assertTrue(selected['requires_prompt'])
                self.assertFalse(selected['reference_image'])
                source = io.BytesIO()
                Image.new('RGB', (320, 320), (60, 80, 100)).save(source, format='JPEG')
                source_id = 'c'*64
                client.post('/upload_source', data={'source_id': source_id}, files={'file': ('source.jpg', source.getvalue(), 'image/jpeg')})
                payload = dict(source_id=source_id, profile='qwen21-remove-pe-v1', prompt='Remove the birds', seed=42,
                               mask_image_base64=base64.b64encode(self._png(Image.new('L', (320, 320), 255))).decode())
                self.assertEqual(client.post('/inpaint', json={**payload, 'prompt': ''}).status_code, 400)
                response = client.post('/inpaint', json=payload)
                self.assertEqual(response.status_code, 200, response.text[:300])
                evidence = root/'state/receipts'/response.json()['generation']['request_id']
                receipt = json.loads((evidence/'receipt.json').read_text())
                self.assertEqual(receipt['effective_prompt'], rewritten)
                self.assertEqual(receipt['pe_prompt_id'], 'pe-id')
                self.assertEqual(receipt['prompt_id'], 'gen-id')
                self.assertTrue((evidence/'pe-workflow.json').is_file())
                self.assertEqual(json.loads((evidence/'workflow.json').read_text())['7']['inputs']['prompt'], rewritten)

    def test_pe_prompt_parser_keeps_only_final_answer(self):
        self.assertEqual(parse_pe_prompt('<think>private reasoning</think>\n{"rewritten_prompt":"Restore natural snow.","wh_ratio":"","ratio_follow":"<image1>"}'), 'Restore natural snow.')
        self.assertEqual(parse_pe_prompt('{"rewritten_prompt":"  Restore natural snow.  "}'), '  Restore natural snow.  ')
        with self.assertRaises(ValueError):
            parse_pe_prompt('{"rewritten_prompt":"Use the mask to remove birds."}')

    @staticmethod
    def _png(image):
        stream=io.BytesIO(); image.save(stream,format='PNG'); return stream.getvalue()
