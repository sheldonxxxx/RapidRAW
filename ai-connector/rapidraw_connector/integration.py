"""Match a generated repair to surrounding source colour and safe source texture."""
import numpy as np
from PIL import Image, ImageFilter


def match_boundary(source, generated, mask):
    """Extend the outside colour residual smoothly into the selected region.

    Only unselected source pixels provide boundary conditions. The generated
    detail remains intact; the caller still applies the original alpha once.
    """
    if source.size != generated.size or source.size != mask.size:
        raise ValueError('Integration images must share context dimensions')
    size = source.size
    scale = min(1.0, 256 / max(size))
    small = tuple(max(1, round(v * scale)) for v in size)
    s = np.asarray(source.convert('RGB').resize(small, Image.Resampling.BOX), dtype=np.float32)
    g = np.asarray(generated.convert('RGB').resize(small, Image.Resampling.BOX), dtype=np.float32)
    # BOX includes soft selected pixels, avoiding source-object contamination.
    occupied = Image.fromarray((np.asarray(mask.convert('L')) > 0).astype(np.float32))
    selected = np.asarray(occupied.resize(small, Image.Resampling.BOX)) > 0
    # Conservatively exclude one additional reduced pixel from the boundary fit.
    padded = np.pad(selected, 1, mode='edge')
    inside = np.zeros_like(selected)
    for dy in range(3):
        for dx in range(3):
            inside |= padded[dy:dy+small[1], dx:dx+small[0]]
    if not selected.any() or inside.all() or min(small) < 3:
        return generated.copy(), {'method': 'none', 'reason': 'insufficient_unselected_context'}
    difference = s - g
    if float(np.max(np.median(np.abs(difference[~inside]), axis=0))) > 24:
        return generated.copy(), {'method': 'none', 'reason': 'large_context_change'}
    residual = np.clip(difference, -32.0, 32.0)
    correction = residual.copy()
    correction[inside] = np.median(residual[~inside], axis=0)
    change = 0.0
    for iteration in range(1200):
        p = np.pad(correction, ((1,1),(1,1),(0,0)), mode='edge')
        average = (p[:-2,1:-1] + p[2:,1:-1] + p[1:-1,:-2] + p[1:-1,2:]) * .25
        change = float(np.max(np.abs(average[inside] - correction[inside])))
        correction[inside] = average[inside]
        if change < .01:
            break
    channels = [np.asarray(Image.fromarray(correction[:,:,i]).resize(size, Image.Resampling.BILINEAR)) for i in range(3)]
    full = np.stack(channels, axis=-1)
    result = np.asarray(generated.convert('RGB'), dtype=np.float32) + full
    result = Image.fromarray(np.clip(np.rint(result), 0, 255).astype(np.uint8))
    return result, {'method': 'boundary_colour_v1', 'iterations': iteration+1,
                    'last_change': change, 'max_correction': float(np.abs(full).max())}


def _laplacian(rgb):
    gray = np.mean(rgb.astype(np.float32), axis=2)
    p = np.pad(gray, 1, mode='edge')
    return np.abs(4 * gray - p[:-2, 1:-1] - p[2:, 1:-1]
                  - p[1:-1, :-2] - p[1:-1, 2:])


def _highpass(rgb, radius=5):
    blurred = np.asarray(Image.fromarray(rgb).filter(ImageFilter.GaussianBlur(radius)),
                         dtype=np.float32)
    return rgb.astype(np.float32) - blurred


def match_stochastic_texture(source, generated, mask, origin):
    """Borrow only high-frequency detail from a nearby unselected source patch.

    A conservative surface check rejects colourful or structured scenes. The
    source donor is contiguous, disjoint from the original selection, and
    contributes no low-frequency colour or removed-object pixels.
    """
    if generated.size != mask.size:
        raise ValueError('Generated context and mask must share dimensions')
    x0, y0 = origin
    if source.width < x0 + generated.width or source.height < y0 + generated.height:
        raise ValueError('Generated context lies outside source')
    bounds = mask.getbbox()
    if not bounds:
        return generated.copy(), {'method': 'none', 'reason': 'empty_selection'}
    left, top, right, bottom = bounds
    width, height = right - left, bottom - top
    if width < 48 or height < 48 or width * height > 2_000_000:
        return generated.copy(), {'method': 'none', 'reason': 'selection_geometry'}
    pad = 100
    box = (max(0, left-pad), max(0, top-pad),
           min(mask.width, right+pad), min(mask.height, bottom+pad))
    local_mask = np.asarray(mask.crop(box).convert('L')) > 0
    dilated = Image.fromarray((local_mask * 255).astype(np.uint8)).filter(
        ImageFilter.MaxFilter(75))
    ring = (np.asarray(dilated) > 0) & ~local_mask
    if int(ring.sum()) < 3000:
        return generated.copy(), {'method': 'none', 'reason': 'insufficient_surface'}
    reference = np.asarray(source.crop((x0+box[0], y0+box[1],
                                        x0+box[2], y0+box[3])).convert('RGB'))
    pixels = reference[ring].astype(np.float32)
    saturation = pixels.max(axis=1) - pixels.min(axis=1)
    variation = float(pixels.std(axis=0).mean())
    edge = float(np.quantile(_laplacian(reference)[ring], .95))
    if (float(np.quantile(saturation, .9)) > 16 or variation > 18
            or edge < 18):
        return generated.copy(), {'method': 'none', 'reason': 'not_uniform_texture',
                                  'saturation_p90': float(np.quantile(saturation, .9)),
                                  'variation': variation, 'edge_p95': edge}
    target_median = np.median(pixels, axis=0)
    target_detail = float(_highpass(reference)[ring].std())
    gx, gy = x0 + left, y0 + top
    # For ground-like stochastic surfaces, sample below the selection so the
    # donor has at least as much native detail under perspective.
    offsets_y = [step * height + 80 for step in (1, 2, 3)]
    offsets_x = [0, -width//2, width//2]
    donors = []
    for dy in offsets_y:
        for dx in offsets_x:
            x, y = gx + dx, gy + dy
            if x < 0 or y < 0 or x + width > source.width or y + height > source.height:
                continue
            overlap = mask.crop((x-x0-30, y-y0-30,
                                 x-x0+width+30, y-y0+height+30))
            # PIL pads outside the context with black; any selected overlap is rejected.
            if overlap.getbbox():
                continue
            donor = np.asarray(source.crop((x, y, x+width, y+height)).convert('RGB'))
            tile_medians = []
            tile_width, tile_height = max(24, width//8), max(24, height//4)
            for ty in range(0, height, tile_height):
                for tx in range(0, width, tile_width):
                    tile = donor[ty:min(height,ty+tile_height),
                                 tx:min(width,tx+tile_width)]
                    tile_medians.append(np.median(tile, axis=(0,1)))
            tile_medians = np.asarray(tile_medians)
            deviation = np.linalg.norm(tile_medians - np.median(tile_medians, axis=0),
                                       axis=1)
            if np.quantile(deviation, .9) > 22 or deviation.max() > 35:
                continue
            median = np.median(donor.reshape(-1, 3), axis=0)
            colour = float(np.linalg.norm(median - target_median))
            structure = float(np.quantile(_laplacian(donor), .995))
            detail = float(_highpass(donor).std())
            score = (.6*colour + .4*structure + 2*abs(detail-target_detail)
                     + .002*(abs(dx)+abs(dy)))
            donors.append((score, colour, structure, x, y, donor))
    if not donors:
        return generated.copy(), {'method': 'none', 'reason': 'no_clean_donor'}
    score, colour, structure, dx, dy, donor = min(donors, key=lambda item: item[0])
    if colour > 18 or structure > 80 or score > 45:
        return generated.copy(), {'method': 'none', 'reason': 'no_matching_donor',
                                  'best_score': score}
    result = generated.copy()
    area = np.asarray(generated.crop(bounds).convert('RGB'))
    low = np.asarray(Image.fromarray(area).filter(ImageFilter.GaussianBlur(5)),
                     dtype=np.float32)
    restored = np.clip(np.rint(low + _highpass(donor)), 0, 255).astype(np.uint8)
    result.paste(Image.fromarray(restored), bounds[:2])
    return result, {'method': 'source_texture_v1', 'donor_origin': [dx, dy],
                    'score': score, 'colour_distance': colour,
                    'structure': structure}
