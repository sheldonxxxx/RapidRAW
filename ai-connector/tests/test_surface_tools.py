import importlib.util
import tempfile
from pathlib import Path
import unittest

AVAILABLE = all(importlib.util.find_spec(name) for name in ('numpy', 'png'))
if AVAILABLE:
    import numpy as np
    from rapidraw_connector.surface_tools import color_mask, directional_response, exposure, linear, normal_field, read_map, recolor, srgb
    from test_materials import rgb16


@unittest.skipUnless(AVAILABLE, 'Install requirements-surface.txt for CPU surface previews')
class SurfaceTools(unittest.TestCase):
    def test_rgb16_keeps_lower_bits_and_transfer_function_is_explicit(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'map.png'
            path.write_bytes(rgb16())
            np.testing.assert_allclose(read_map(path)[0, 0], np.array([12345, 32768, 65432])/65535, atol=1e-7)
        values = np.array([0, .02, .25, .5, 1], dtype=np.float32)
        np.testing.assert_allclose(srgb(linear(values)), values, atol=1e-6)

    def test_normals_resize_renormalizes_without_gamma_and_direction_reverses(self):
        encoded = np.array([[[1, .5, .5], [.5, 1, .5]]], dtype=np.float32)
        field = normal_field(encoded, (5, 3))
        np.testing.assert_allclose(np.linalg.norm(field, axis=-1), 1, atol=1e-6)
        a = directional_response(encoded, (5, 3), 0)
        b = directional_response(encoded, (5, 3), 180)
        np.testing.assert_allclose(a, -b, atol=1e-6)
        np.testing.assert_allclose(directional_response(np.array([[[.5, .5, 1]]]), (5, 3), 0), 0)

    def test_zero_amount_and_excluded_pixels_are_exact_and_recolor_retains_luminance(self):
        source = np.random.default_rng(2).integers(0, 256, (12, 16, 3), dtype=np.uint8)
        mask = np.zeros((12, 16)); mask[3:8, 4:11] = 1
        for result in (exposure(source, mask, 0), recolor(source, mask, [50, 160, 220], 0)):
            np.testing.assert_array_equal(result, source)
        for result in (exposure(source, np.ones_like(mask), .8, mask), recolor(source, mask, [50, 160, 220], 1)):
            np.testing.assert_array_equal(result[mask == 0], source[mask == 0])
        result = recolor(source, mask, [50, 160, 220], 1)
        weights = np.array([.2126, .7152, .0722])
        np.testing.assert_allclose(linear(result / 255) @ weights, linear(source / 255) @ weights, atol=.005)

    def test_color_selection_crosses_shading_but_respects_region_and_black(self):
        albedo = np.array([[[.5, .15, .2], [.25, .075, .1], [0, 0, 0]]], dtype=np.float32)
        # Build a constant-colour reference with a separate black area.
        albedo = np.tile(albedo, (8, 8, 1)); albedo[:, :5] = [.5, .15, .2]
        roi = np.ones((16, 48)); roi[:, 35:] = 0
        mask = color_mask(albedo, (48, 16), (.03, .5), .2, roi)
        self.assertTrue(np.isfinite(mask).all())
        self.assertGreater(mask[:, :8].min(), .99)
        self.assertEqual(mask[:, 35:].max(), 0)
        for value in (-1, 2, float('nan')):
            with self.assertRaises(ValueError):
                recolor(np.zeros((2, 2, 3), dtype=np.uint8), np.ones((2, 2)), [30, 100, 200], value)
