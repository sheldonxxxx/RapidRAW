"""Opt-in depth routes and workflow switching for the existing AI connector."""
import asyncio
import base64
import hashlib
import io
import json
import os
from pathlib import Path
import struct
from types import SimpleNamespace
from urllib.parse import urlparse

import aiohttp
from fastapi import FastAPI, File, HTTPException, UploadFile
from PIL import Image

from .app import atomic_json, execute, read_bounded, write_private

PROFILE = 'marigold-v2-q4-v1'
ASSETS = {
    'unet/Qwen-Image-Edit-2509-Q4_K_M.gguf': '08f27cdf3e760edef5136ab0afdb9d3ed7a2799bd730b8d5cd9ecb291d808425',
    'loras/marigold_v2_depth_log_stage2.safetensors': 'ec1f5649eef5ddb487b4de2222f6b62837f094c02d652843bd4fceb481037ca0',
    'vae/marigold_v2_depth_log_stage2_vae.safetensors': '0c1a95f7410678a93b59ba42b3a069f50b54ff9f6e35525699eb8fcd63ce332c',
    'embeddings/marigold_v2_depth_conditioning.safetensors': '9f5c00a2df993136c541cdbc37bcfb81ab1ba81adaec25bfb9cbfff81edd7c9c',
}


def depth_png(data):
    # Keep RGB16 bytes intact: Pillow's RGB decoder would discard eight bits.
    if len(data) < 33 or data[:16] != b'\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR':
        raise ValueError('Depth output must be a 16-bit PNG')
    w, h, bits, color = struct.unpack('>IIBB', data[16:26])
    if bits != 16 or color not in (0, 2) or not w or not h or w*h > 1_048_576:
        raise ValueError('Depth output must be grayscale or RGB16, at most one megapixel')
    with Image.open(io.BytesIO(data)) as im:
        im.verify()
    return w, h


def source_png(data):
    if len(data) > 8*1024*1024:
        raise ValueError('Analysis source exceeds 8 MiB')
    with Image.open(io.BytesIO(data)) as im:
        if im.format != 'PNG' or im.mode != 'RGB' or max(im.size) > 1024 or min(im.size) < 64:
            raise ValueError('Analysis source must be RGB PNG, 64–1024 pixels per edge')
        im.verify()


def create_depth_app(config=None, app=None, lock=None, switch=None):
    if config is None:
        config = {name: os.environ['MARIGOLD_'+name.upper()] for name in ('comfy_url', 'comfy_root', 'models_dir', 'state_dir')}
    url = config['comfy_url'].rstrip('/')
    parsed = urlparse(url)
    if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError('MARIGOLD_COMFY_URL must be an HTTP(S) URL without credentials')
    root, models, state = (Path(config[k]).expanduser().resolve() for k in ('comfy_root', 'models_dir', 'state_dir'))
    if not root.is_dir() or not models.is_dir() or state.is_relative_to(root/'input') or state.is_relative_to(root/'output'):
        raise ValueError('Use existing Comfy/model directories and a separate state directory')
    inputs = root/'input'/'rapidraw-depth'
    inputs.mkdir(parents=True, exist_ok=True)
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    template = json.loads((Path(__file__).parent/'depth_profiles'/'marigold-v2-q4.json').read_text())
    fingerprint = hashlib.sha256(json.dumps(dict(profile=PROFILE, graph=template, assets=ASSETS), sort_keys=True).encode()).hexdigest()
    app = app or FastAPI(title='RapidRAW Optional Depth', docs_url=None, redoc_url=None)
    app.state.execute = execute
    settings = SimpleNamespace(comfy_url=url, generation_timeout=300)
    lock = lock or asyncio.Lock()
    verified = {}

    def verify_assets():
        for name, expected in ASSETS.items():
            path = models/name
            stat = path.stat()
            signature = (stat.st_size, stat.st_mtime_ns, stat.st_ino)
            if verified.get(name) != signature:
                with path.open('rb') as stream:
                    if hashlib.file_digest(stream, 'sha256').hexdigest() != expected:
                        raise ValueError('Marigold model checksum mismatch: '+name)
                verified[name] = signature

    async def ready():
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=10)) as client:
            async with client.get(url+'/object_info') as response:
                response.raise_for_status()
                nodes = json.loads(await read_bounded(response, 32*1024*1024))
            missing = {n['class_type'] for n in template.values()}-nodes.keys()
            if missing:
                raise ValueError('Missing Comfy nodes: '+', '.join(sorted(missing)))
            async with client.get(url+'/system_stats') as response:
                response.raise_for_status()
                stats = await response.json()
            argv = stats.get('system', {}).get('argv', [])
            if any(flag in argv for flag in ('--highvram', '--gpu-only', '--disable-smart-memory')):
                raise ValueError('Marigold needs Comfy normal/low VRAM model offloading')
        await asyncio.to_thread(verify_assets)
        return dict(protocol_version=1, provider='marigold', profile=PROFILE, ready=True,
                    encoding='png16', direction='near-bright', space='relative-log-depth',
                    workflow_sha256=fingerprint, analysis_long_edge=1024, models=ASSETS)

    app.state.depth_ready = ready

    @app.get('/depth/capabilities')
    async def capabilities():
        try:
            return await app.state.depth_ready()
        except Exception as exc:
            raise HTTPException(503, 'Marigold is not ready: '+str(exc)[:1000]) from exc

    @app.post('/depth')
    async def depth(file: UploadFile = File(...)):
        data = await file.read(8*1024*1024+1)
        try:
            source_png(data)
        except Exception as exc:
            raise HTTPException(400, str(exc)) from exc
        key = hashlib.sha256(data+fingerprint.encode()).hexdigest()
        output, receipt = state/(key+'.png'), state/(key+'.json')
        # Serializes only this optional service; another editor owns its own jobs.
        async with lock:
            if output.is_file() and receipt.is_file():
                saved, metadata = output.read_bytes(), json.loads(receipt.read_text())
                depth_png(saved)
                if hashlib.sha256(saved).hexdigest() == metadata['map_sha256']:
                    return dict(depth_png_base64=base64.b64encode(saved).decode(), metadata=metadata, cached=True)
            try:
                capabilities = await app.state.depth_ready()
                if switch is not None:
                    await switch.activate(url, 'depth')
                path = inputs/(key+'.png')
                write_private(path, data)
                graph = json.loads(json.dumps(template))
                graph['1']['inputs']['image'] = path.relative_to(root/'input').as_posix()
                graph['16']['inputs']['filename_prefix'] = 'rapidraw-depth/'+key
                async def event(_):
                    pass
                result, prompt_id, _ = await app.state.execute(settings, graph, '16', event)
                width, height = depth_png(result)
                metadata = dict(profile=PROFILE, workflow_sha256=fingerprint, models=capabilities['models'],
                                source_sha256=hashlib.sha256(data).hexdigest(), map_sha256=hashlib.sha256(result).hexdigest(),
                                prompt_id=prompt_id, width=width, height=height, direction='near-bright', space='relative-log-depth')
                write_private(output, result)
                atomic_json(receipt, metadata)
                return dict(depth_png_base64=base64.b64encode(result).decode(), metadata=metadata, cached=False)
            except Exception as exc:
                raise HTTPException(503, 'Marigold depth failed: '+str(exc)[:1000]) from exc

    return app
