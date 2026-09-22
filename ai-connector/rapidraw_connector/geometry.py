"""Selection context and native-coordinate response packing."""
import base64
import io
import math

from PIL import Image


def geometry(source_size, mask, config):
    bounds = mask.getbbox()
    if mask.size != tuple(source_size) or not bounds:
        raise ValueError('Selection is empty or has different dimensions')
    left, top, right, bottom = bounds
    fraction = float(config.get('margin_fraction', .5))
    minimum = int(config.get('min_margin', 64))
    if not 0 <= fraction <= 4 or minimum < 16:
        raise ValueError('Invalid selection context margin')
    margin = max(minimum, math.ceil(max(right-left, bottom-top)*fraction))
    left, top = max(0, left-margin), max(0, top-margin)
    right, bottom = min(source_size[0], right+margin), min(source_size[1], bottom+margin)
    width, height = right-left, bottom-top
    megapixels = float(config.get('megapixels', 1))
    multiple = int(config.get('dimension_multiple', 16))
    if not .0625 <= megapixels <= 16 or multiple not in (16, 32):
        raise ValueError('Invalid generation resolution')
    scale = math.sqrt(megapixels*1024*1024/(width*height))
    gen_width = max(multiple, round(width*scale/multiple)*multiple)
    gen_height = max(multiple, round(height*scale/multiple)*multiple)
    return dict(source_size=list(source_size), selection_bounds=list(bounds),
                x=left, y=top, width=width, height=height,
                gen_width=gen_width, gen_height=gen_height,
                requested_megapixels_1024=megapixels,
                actual_megapixels_decimal=gen_width*gen_height/1e6,
                restore_scale_x=width/gen_width, restore_scale_y=height/gen_height,
                margin_pixels=margin)


def encode_png(image):
    stream = io.BytesIO()
    image.save(stream, format='PNG')
    return base64.b64encode(stream.getvalue()).decode('ascii')


def pack(context, mask, g):
    """Return RGB without blending; the native caller owns selection alpha."""
    if context.size != (g['width'], g['height']):
        raise ValueError('Restored context dimensions mismatch')
    bounds = mask.getbbox()
    if not bounds:
        raise ValueError('Selection is empty')
    left, top, right, bottom = bounds
    width, height = mask.size
    left, top = max(0, left-16), max(0, top-16)
    right, bottom = min(width, right+16), min(height, bottom+16)
    if left < g['x'] or top < g['y'] or right > g['x']+g['width'] or bottom > g['y']+g['height']:
        raise ValueError('Response crop lies outside the restored context')
    color = context.crop((left-g['x'], top-g['y'], right-g['x'], bottom-g['y']))
    return dict(x=left, y=top, width=right-left, height=bottom-top,
                color=encode_png(color), mask=encode_png(mask.crop((left, top, right, bottom))))


def restore_output(data, mask, g, output_kind, source=None, integration_report=None,
                   texture=False):
    with Image.open(io.BytesIO(data)) as image:
        if output_kind != 'generation' or image.size != (g['gen_width'], g['gen_height']):
            raise ValueError('Profile returned unexpected generation dimensions')
        generated = image.convert('RGB')
    context = generated.resize((g['width'], g['height']), Image.Resampling.LANCZOS)
    if source is not None:
        from .integration import match_boundary
        box = (g['x'], g['y'], g['x'] + g['width'], g['y'] + g['height'])
        context, report = match_boundary(source.crop(box), context, mask.crop(box))
        if integration_report is not None:
            integration_report.update(report)
        if texture:
            from .integration import match_stochastic_texture
            context, texture_report = match_stochastic_texture(
                source, context, mask.crop(box), (g['x'], g['y']))
            if integration_report is not None:
                integration_report['texture'] = texture_report
    return pack(context, mask, g), list(generated.size)
