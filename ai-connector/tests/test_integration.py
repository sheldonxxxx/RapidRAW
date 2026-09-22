"""Photometric integration must not learn the object being removed."""
import unittest
import numpy as np
from PIL import Image
from rapidraw_connector.integration import match_boundary, match_stochastic_texture

class IntegrationTests(unittest.TestCase):
    def test_shifted_background_corrected_without_copying_removed_object(self):
        source=np.full((96,128,3),[70,90,110],dtype=np.uint8)
        source[30:65,40:85]=[230,15,15]
        generated=np.full_like(source,[80,98,114])
        mask=np.zeros((96,128),dtype=np.uint8);mask[25:70,35:90]=255
        fixed,report=match_boundary(Image.fromarray(source),Image.fromarray(generated),Image.fromarray(mask))
        self.assertEqual(report['method'],'boundary_colour_v1')
        np.testing.assert_allclose(np.array(fixed)[30:65,40:85],[70,90,110]*np.ones((35,45,3)),atol=1)
        composited=np.array(Image.composite(fixed,Image.fromarray(source),Image.fromarray(mask)))
        np.testing.assert_array_equal(composited[mask==0],source[mask==0])

    def test_no_context_leaves_generation_unchanged(self):
        source=Image.new('RGB',(40,40),(20,30,40));generated=Image.new('RGB',(40,40),(90,80,70))
        for alpha in (0,255):
            fixed,report=match_boundary(source,generated,Image.new('L',source.size,alpha))
            self.assertEqual(fixed.tobytes(),generated.tobytes())
            self.assertEqual(report['method'],'none')

    def test_already_matching_context_keeps_generated_detail(self):
        source=Image.new('RGB',(100,100),(70,90,110));g=np.array(source)
        g[40:60,40:60]=[75,95,115]
        mask=Image.new('L',source.size);mask.paste(255,(30,30,70,70))
        fixed,_=match_boundary(source,Image.fromarray(g),mask)
        np.testing.assert_array_equal(np.array(fixed),g)

    def test_large_context_reinterpretation_is_not_forced_to_match(self):
        source=Image.new('RGB',(100,100),(20,30,40));generated=Image.new('RGB',(100,100),(180,90,120))
        mask=Image.new('L',source.size);mask.paste(255,(30,30,70,70))
        fixed,report=match_boundary(source,generated,mask)
        self.assertEqual(fixed.tobytes(),generated.tobytes())
        self.assertEqual(report['reason'],'large_context_change')

    def test_texture_borrows_clean_grain_without_copying_removed_object(self):
        rng=np.random.default_rng(42)
        source=np.clip(np.rint(110+rng.normal(0,6,(360,360,1))),0,255).astype(np.uint8)
        source=np.repeat(source,3,axis=2)
        source[120:185,125:225]=[220,20,20]
        generated=np.full_like(source,110)
        mask=np.zeros((360,360),dtype=np.uint8)
        mask[110:195,115:235]=255
        result,report=match_stochastic_texture(
            Image.fromarray(source),Image.fromarray(generated),
            Image.fromarray(mask),(0,0))
        self.assertEqual(report['method'],'source_texture_v1')
        patch=np.asarray(result)[120:185,125:225]
        self.assertGreater(float(patch.std()),5)
        self.assertLess(float(patch.mean()),125)
        self.assertLess(int(patch.max()),170)
        composite=np.asarray(Image.composite(result,Image.fromarray(source),
                                             Image.fromarray(mask)))
        np.testing.assert_array_equal(composite[mask==0],source[mask==0])

    def test_texture_skips_coloured_subject(self):
        source=Image.new('RGB',(360,360),(170,50,90))
        generated=Image.new('RGB',(360,360),(145,60,90))
        mask=Image.new('L',(360,360))
        mask.paste(255,(100,100,240,200))
        result,report=match_stochastic_texture(source,generated,mask,(0,0))
        self.assertEqual(result.tobytes(),generated.tobytes())
        self.assertEqual(report['reason'],'not_uniform_texture')
