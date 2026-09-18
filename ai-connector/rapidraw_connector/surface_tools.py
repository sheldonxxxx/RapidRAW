"""CPU previews for optional Marigold maps; this is not the native photo renderer.

Normals encode camera X right, Y up, Z toward the viewer without a transfer
function. Comfy's postprocessed albedo is sRGB. Neither map replaces photo pixels.
"""
import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
from PIL import Image
import png


def linear(value):
    value = np.asarray(value, dtype=np.float32)
    return np.where(value <= .04045, value / 12.92, ((value + .055) / 1.055) ** 2.4)


def srgb(value):
    value = np.clip(value, 0, 1)
    return np.where(value <= .0031308, 12.92 * value, 1.055 * value ** (1 / 2.4) - .055)


def read_map(path):
    with Path(path).open('rb') as stream:
        width, height, rows, info = png.Reader(file=stream).read()
        if info['bitdepth'] != 16 or info['planes'] != 3 or info['greyscale'] or info['alpha']:
            raise ValueError('Use a three-channel RGB16 PNG from the surface endpoint')
        return np.vstack([np.asarray(row, dtype=np.uint16) for row in rows]).reshape(height, width, 3).astype(np.float32) / 65535


def resize_map(value, size):
    """Resize numeric channels without gamma conversion. Size is (width, height)."""
    if value.shape[:2] == (size[1], size[0]):
        return value.copy()
    if value.ndim == 2:
        return np.array(Image.fromarray(value.astype(np.float32)).resize(size, Image.Resampling.BILINEAR))
    return np.stack([resize_map(value[..., channel], size) for channel in range(value.shape[-1])], axis=-1)


def normal_field(encoded, size):
    normals = resize_map(encoded * 2 - 1, size)
    lengths = np.linalg.norm(normals, axis=-1, keepdims=True)
    # An undefined/zero vector contributes no directional exposure.
    return normals / np.maximum(lengths, 1e-6)


def directional_response(encoded, size, angle):
    """Signed side-facing exposure field; angle 0 is right, 90 up, 180 left."""
    normals = normal_field(encoded, size)
    radians = np.deg2rad(angle)
    return np.clip(normals[..., 0] * np.cos(radians) + normals[..., 1] * np.sin(radians), -1, 1)


def exposure(source, response, stops, mask=None):
    """Apply bounded exposure to original sRGB pixels, preserving excluded pixels."""
    if not np.isfinite(stops) or abs(stops) > 1.5:
        raise ValueError('Choose an exposure amount between -1.5 and 1.5 stops')
    if stops == 0:
        return source.copy()
    field = np.clip(response, -1, 1)
    if mask is not None:
        field = field * np.clip(mask, 0, 1)
    result = np.rint(srgb(linear(source / 255) * np.exp2(field[..., None] * stops)) * 255).astype(np.uint8)
    result[field == 0] = source[field == 0]
    return result


def color_mask(encoded, size, point, tolerance=.13, roi=None):
    """Select similar linear RGB chromaticities; this is not semantic segmentation.

    A normalized point picks a median 5x5 patch. Black estimates are excluded.
    An optional mask can confine the selection to an object or a painted area.
    """
    if not .005 <= tolerance <= 1 or not all(0 <= p <= 1 for p in point):
        raise ValueError('Use a point in [0,1] and tolerance between .005 and 1')
    colors = linear(encoded)
    h, w = colors.shape[:2]
    x, y = round(point[0] * (w - 1)), round(point[1] * (h - 1))
    total = colors.sum(axis=-1, keepdims=True)
    chroma = colors / np.maximum(total, 1e-6)
    sample = chroma[max(0, y-2):y+3, max(0, x-2):x+3]
    target = np.median(sample.reshape(-1, 3), axis=0)
    distance = np.linalg.norm(chroma - target, axis=-1)
    ramp = np.clip((tolerance * 1.5 - distance) / tolerance, 0, 1)
    selected = ramp * ramp * (3 - 2 * ramp)
    selected *= np.clip(total[..., 0] / .015, 0, 1)
    selected = resize_map(selected, size)
    if roi is not None:
        selected *= np.clip(roi, 0, 1)
    return selected


def recolor(source, mask, target, amount):
    """Blend toward a chosen chromaticity at the photo's original luminance.

    Out-of-gamut targets reduce saturation toward neutral rather than clipping
    individual channels. Existing texture, shadows, and highlights supply detail.
    """
    if not np.isfinite(amount) or not 0 <= amount <= 1:
        raise ValueError('Choose an amount between 0 and 1')
    if amount == 0:
        return source.copy()
    weights = np.array([.2126, .7152, .0722], dtype=np.float32)
    original = linear(source / 255)
    luminance = original @ weights
    color = np.asarray(target, dtype=np.float32)
    if color.shape != (3,) or not np.isfinite(color).all() or np.any(color < 0) or np.any(color > 255):
        raise ValueError('Choose a non-black RGB colour in [0,255]')
    color = linear(color / 255)
    if color @ weights < 1e-5:
        raise ValueError('Choose a non-black RGB colour in [0,255]')
    colored = luminance[..., None] * color / (color @ weights)
    delta = colored - luminance[..., None]
    ceiling = np.where(delta > 1e-8, (1 - luminance[..., None]) / np.maximum(delta, 1e-8), 1)
    saturation = np.minimum(1, np.min(ceiling, axis=-1))
    colored = luminance[..., None] + delta * saturation[..., None]
    alpha = np.clip(mask, 0, 1) * amount
    result = np.rint(srgb(original * (1-alpha[..., None]) + colored * alpha[..., None]) * 255).astype(np.uint8)
    result[alpha == 0] = source[alpha == 0]
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['normals', 'albedo'])
    parser.add_argument('--source', type=Path, required=True, help='Already rendered, oriented sRGB photo')
    parser.add_argument('--map', type=Path, required=True, help='Matching full-frame RGB16 map')
    parser.add_argument('--output', type=Path, required=True, help='New PNG preview; existing files are refused')
    parser.add_argument('--mask', type=Path, help='Optional grayscale region mask at source dimensions')
    parser.add_argument('--mask-output', type=Path, help='New PNG selection preview (albedo only)')
    parser.add_argument('--angle', type=float, default=180, help='Normals: 0 right, 90 up, 180 left')
    parser.add_argument('--amount', type=float, default=.5, help='Normals: exposure stops; albedo: 0–1 blend')
    parser.add_argument('--point', type=float, nargs=2, default=[.5, .5], metavar=('X', 'Y'))
    parser.add_argument('--tolerance', type=float, default=.13)
    parser.add_argument('--color', type=int, nargs=3, default=[75, 140, 210], metavar=('R', 'G', 'B'))
    args = parser.parse_args()
    receipt = args.output.with_suffix('.json')
    destinations = [args.output, receipt] + ([args.mask_output] if args.mask_output else [])
    if len({p.resolve() for p in destinations}) != len(destinations) or any(p.exists() for p in destinations):
        parser.error('Choose distinct new output files; existing files are preserved')
    source = np.asarray(Image.open(args.source).convert('RGB'))
    h, w = source.shape[:2]
    encoded = read_map(args.map)
    if abs((encoded.shape[1]/encoded.shape[0])/(w/h)-1) > .03:
        parser.error('Source and map must share full-frame geometry')
    mask = np.asarray(Image.open(args.mask).convert('L'), dtype=np.float32) / 255 if args.mask else None
    if mask is not None and mask.shape != (h, w):
        parser.error('Region mask dimensions must match the source')
    if not np.isfinite(args.angle):
        parser.error('Angle must be finite')
    if args.mode == 'normals':
        if args.mask_output:
            parser.error('--mask-output is for albedo selections')
        result = exposure(source, directional_response(encoded, (w, h), args.angle), args.amount, mask)
    else:
        selected = color_mask(encoded, (w, h), args.point, args.tolerance, mask)
        result = recolor(source, selected, args.color, args.amount)
        if args.mask_output:
            Image.fromarray(np.rint(selected * 255).astype(np.uint8)).save(args.mask_output, format='PNG')
    Image.fromarray(result).save(args.output, format='PNG')
    receipt.write_text(json.dumps(dict(experimental=True, renderer='surface_tools CPU preview',
                                     source_sha256=hashlib.sha256(args.source.read_bytes()).hexdigest(),
                                     map_sha256=hashlib.sha256(args.map.read_bytes()).hexdigest(),
                                     output_sha256=hashlib.sha256(args.output.read_bytes()).hexdigest(),
                                     parameters={k: str(v) if isinstance(v, Path) else v for k, v in vars(args).items()}), indent=2))


if __name__ == '__main__':
    main()
