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
from rapidraw_connector.app import create_app
from rapidraw_connector.workflows import REMOVE_PROMPT, build_workflow
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

    @staticmethod
    def _png(image):
        stream=io.BytesIO(); image.save(stream,format='PNG'); return stream.getvalue()
