import base64
import io
import unittest

from PIL import Image

from rapidraw_connector.app import read_reference
from rapidraw_connector.workflows import build_workflow, supports_reference, qwen_reference_prompt


class ReferenceImages(unittest.TestCase):
    def test_reference_decode_strips_metadata_and_bounds_resolution(self):
        buffer = io.BytesIO()
        Image.new('RGB', (1800, 900), 'red').save(buffer, format='JPEG')
        decoded = read_reference(base64.b64encode(buffer.getvalue()).decode())
        with Image.open(io.BytesIO(decoded)) as image:
            self.assertEqual(image.size, (1536, 768))
            self.assertEqual(image.format, 'PNG')

    def test_invalid_and_oversized_references_are_rejected(self):
        for value in ('not base64!', base64.b64encode(b'not an image').decode()):
            with self.assertRaises(Exception):
                read_reference(value)
        buffer = io.BytesIO()
        Image.new('L', (4001, 4000)).save(buffer, format='PNG')
        with self.assertRaises(ValueError):
            read_reference(base64.b64encode(buffer.getvalue()).decode())

    def test_only_supported_edit_workflows_accept_a_reference(self):
        config = dict(family='klein', model='model', text_encoder='encoder', vae='vae', steps=4, cfg=1)
        geometry = dict(x=0, y=0, width=512, height=512, gen_width=512, gen_height=512)
        self.assertTrue(supports_reference(config))
        for unsupported in ({**config, 'task': 'remove'}, {**config, 'family': 'boogu'}):
            self.assertFalse(supports_reference(unsupported))
            with self.assertRaises(ValueError):
                build_workflow('source.png', 'mask.png', 'edit', 7, geometry, unsupported, ['reference.png'])
        graph = build_workflow('source.png', 'mask.png', 'edit', 7, geometry, config, ['reference.png'])['workflow']
        self.assertEqual(graph['70']['inputs']['image'], 'reference.png')
        self.assertEqual(graph['72']['inputs']['conditioning'], ['58', 0])
        self.assertEqual(graph['73']['inputs']['conditioning'], ['59', 0])
        self.assertEqual(graph['60']['inputs']['positive'], ['72', 0])
        self.assertEqual(graph['60']['inputs']['negative'], ['73', 0])
        plain = build_workflow('source.png', 'mask.png', 'edit', 7, geometry, config)['workflow']
        self.assertNotIn('70', plain)

    def test_qwen_orders_source_before_multiple_references(self):
        config = dict(family='qwen21', model='model', text_encoder='encoder', vae='vae', steps=4, cfg=1)
        geometry = dict(x=0, y=0, width=512, height=512, gen_width=512, gen_height=512)
        graph = build_workflow('source.png', 'mask.png', 'edit', 7, geometry, config, ['a.png', 'b.png'])['workflow']
        self.assertTrue(supports_reference(config))
        self.assertTrue(graph['7']['inputs']['prompt'].startswith('Edit image 1'))
        self.assertTrue(graph['7']['inputs']['prompt'].endswith('edit'))
        self.assertEqual(graph['7']['inputs']['images.image_1'], ['51', 0])
        self.assertEqual(graph['7']['inputs']['images.image_2'], ['70', 0])
        self.assertEqual(graph['7']['inputs']['images.image_3'], ['71', 0])
        self.assertEqual(graph['70']['inputs']['image'], 'a.png')
        self.assertEqual(graph['71']['inputs']['image'], 'b.png')
        with self.assertRaises(ValueError):
            build_workflow('source.png', 'mask.png', 'edit', 7, geometry, config, ['a.png'] * 5)

    def test_klein_chains_multiple_references(self):
        config = dict(family='klein', model='model', text_encoder='encoder', vae='vae', steps=4, cfg=1)
        geometry = dict(x=0, y=0, width=512, height=512, gen_width=512, gen_height=512)
        graph = build_workflow('source.png', 'mask.png', 'edit', 7, geometry, config, ['a.png', 'b.png'])['workflow']
        self.assertEqual(graph['76']['inputs']['conditioning'], ['72', 0])
        self.assertEqual(graph['60']['inputs']['positive'], ['76', 0])

    def test_qwen_reference_prompt_preserves_literal_request_and_assigns_roles(self):
        request = 'Place the subject on the left.'
        self.assertEqual(qwen_reference_prompt(request, 0), request)
        self.assertIn('Image 2 is an auxiliary reference', qwen_reference_prompt(request, 1))
        self.assertIn('Images 2 through 5', qwen_reference_prompt(request, 4))
        self.assertTrue(qwen_reference_prompt(request, 4).endswith(request))
        self.assertIn('Return the edited image 1', qwen_reference_prompt(request, 4))
