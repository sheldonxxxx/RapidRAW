"""Optional surface analysis on the existing connector queue."""
import asyncio
import base64
import hashlib
import json
from pathlib import Path
import uuid

import aiohttp
from fastapi import File, HTTPException, UploadFile

from .app import atomic_json, read_bounded, save_history, write_private
from .depth import ASSETS as DEPTH_ASSETS, depth_png, source_png

MODEL_REVISION = '70e2127d026c8f6b62d8049b73f5392e1e81ebfa'
TASK_ASSETS = {
    'normals': {
        'loras/marigold_v2_normals.safetensors': '94a96e203f47797b23a21c6fe0bf169db178342698871f6a95d944537a680135',
        'vae/marigold_v2_normals_vae.safetensors': '66db6213a47b53e8835df48c9977f06cd74c9a973c6f0ac4d65a725de03add71',
        'embeddings/marigold_v2_normals_conditioning.safetensors': 'a0f82526b471482dfb2c2403aa63582f7732241d706f1f5b0daeda88762eeb5f',
    },
    'albedo': {
        'loras/marigold_v2_albedo.safetensors': '263ec11bb29625c5ec7b145ea2fbc9e8e7854ad4a229031e020e55d614e8e919',
        'vae/marigold_v2_albedo_vae.safetensors': '91524d3ecafcbb25ceea3d7a76b09581eb27664fb1ba09996db3da2b1f91563f',
        'embeddings/marigold_v2_albedo_conditioning.safetensors': 'f3d70cc7d4d37743e3f4da197b97a2d2847a8a172a50f86112642ecfa99834fd',
    },
}
SPACES = {'normals': 'camera-unit-normal-xyz-encoded-0-1', 'albedo': 'srgb-albedo'}


def material_assets(kind):
    backbone = 'unet/Qwen-Image-Edit-2509-Q4_K_M.gguf'
    return {backbone: DEPTH_ASSETS[backbone], **TASK_ASSETS[kind]}


def material_workflow(kind):
    if kind not in TASK_ASSETS:
        raise ValueError('Choose normals or albedo')
    path = Path(__file__).parent/'surface_profiles'/f'marigold-v2-{kind}-q4.json'
    return json.loads(path.read_text())


def material_png(data):
    size = depth_png(data)
    if data[25] != 2:
        raise ValueError('Surface output must be RGB16 PNG')
    return size


def add_material_routes(app, settings, config, lock, switch):
    models = Path(config['models_dir']).expanduser().resolve()
    state = Path(config['state_dir']).expanduser().resolve()
    if not models.is_dir() or state.is_relative_to(settings.input_dir) or state.is_relative_to(settings.comfy_root/'output'):
        raise ValueError('Use an existing model directory and separate state directory')
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    inputs = settings.input_dir/'rapidraw-materials'
    inputs.mkdir(parents=True, exist_ok=True)
    verified = {}

    def verify(kind):
        for name, expected in material_assets(kind).items():
            path = models/name
            stat = path.stat()
            signature = (stat.st_size, stat.st_mtime_ns, stat.st_ino)
            if verified.get(name) != signature:
                with path.open('rb') as stream:
                    if hashlib.file_digest(stream, 'sha256').hexdigest() != expected:
                        raise ValueError('Surface model checksum mismatch')
                verified[name] = signature

    async def ready(kind):
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=10)) as client:
            async with client.get(settings.comfy_url+'/object_info') as response:
                response.raise_for_status()
                nodes = json.loads(await read_bounded(response, 32*1024*1024))
            if {n['class_type'] for n in material_workflow(kind).values()}-nodes.keys():
                raise ValueError('Required surface analysis nodes are missing')
            async with client.get(settings.comfy_url+'/system_stats') as response:
                response.raise_for_status()
                stats = await response.json()
            if any(flag in stats.get('system', {}).get('argv', []) for flag in ('--highvram', '--gpu-only', '--disable-smart-memory')):
                raise ValueError('Surface analysis requires Comfy model offloading')
        await asyncio.to_thread(verify, kind)

    app.state.material_ready = ready

    @app.get('/materials/capabilities')
    async def capabilities():
        tasks = {}
        for kind in TASK_ASSETS:
            try:
                await app.state.material_ready(kind)
                tasks[kind] = dict(ready=True, encoding='rgb16-png', space=SPACES[kind])
            except Exception:
                tasks[kind] = dict(ready=False)
        return dict(protocol_version=1, experimental=True, tasks=tasks, analysis_long_edge=1024)

    @app.post('/materials/{kind}')
    async def analyze(kind: str, file: UploadFile = File(...)):
        if kind not in TASK_ASSETS:
            raise HTTPException(404, 'Unknown surface analysis task')
        data = await file.read(8*1024*1024+1)
        try:
            source_png(data)
        except Exception:
            raise HTTPException(400, 'Use an RGB PNG with 64–1024 pixels per edge') from None
        graph = material_workflow(kind)
        profile = 'marigold-v2-'+kind+'-q4-v1'
        fingerprint = hashlib.sha256(json.dumps(dict(profile=profile, graph=graph, assets=material_assets(kind)), sort_keys=True).encode()).hexdigest()
        key = hashlib.sha256(data+fingerprint.encode()).hexdigest()
        output, receipt = state/(key+'.png'), state/(key+'.json')
        async with lock:
            if output.is_file() and receipt.is_file():
                try:
                    saved, metadata = output.read_bytes(), json.loads(receipt.read_text())
                    material_png(saved)
                    if hashlib.sha256(saved).hexdigest() == metadata['map_sha256']:
                        return dict(map_png_base64=base64.b64encode(saved).decode(), metadata=metadata, cached=True)
                except (OSError, ValueError, KeyError, TypeError):
                    # A partial or damaged cache cannot become an accepted map.
                    pass
            request_id = uuid.uuid4().hex
            evidence = state/request_id
            evidence.mkdir(mode=0o700)
            try:
                await app.state.material_ready(kind)
                await switch.activate(settings.comfy_url, 'materials:'+kind)
                source = inputs/(key+'.png')
                write_private(source, data)
                graph['1']['inputs']['image'] = source.relative_to(settings.input_dir).as_posix()
                graph['16']['inputs']['filename_prefix'] = 'rapidraw-materials/'+request_id
                atomic_json(evidence/'workflow.json', graph)
                events = []
                async def on_event(event):
                    if event['kind'] == 'history':
                        save_history(evidence/'history.json', event['history'])
                        event = {k: v for k, v in event.items() if k != 'history'}
                    events.append(event)
                    events[:] = events[-256:]
                    atomic_json(evidence/'events.json', events)
                result, prompt_id, _ = await app.state.execute(settings, graph, '16', on_event)
                width, height = material_png(result)
                metadata = dict(profile=profile, kind=kind, encoding='rgb16-png', space=SPACES[kind],
                                source_sha256=hashlib.sha256(data).hexdigest(), map_sha256=hashlib.sha256(result).hexdigest(),
                                workflow_sha256=fingerprint, models=material_assets(kind), width=width, height=height,
                                prompt_id=prompt_id, request_id=request_id)
                write_private(output, result)
                atomic_json(receipt, metadata)
                return dict(map_png_base64=base64.b64encode(result).decode(), metadata=metadata, cached=False)
            except Exception as exc:
                atomic_json(evidence/'error.json', dict(error=str(exc)[:8000]))
                raise HTTPException(503, 'Surface analysis failed; inspect request '+request_id) from exc
