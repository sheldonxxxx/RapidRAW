"""RapidRAW protocol 2 service backed by a local ComfyUI installation."""
import asyncio
import base64
import hashlib
import io
import json
import os
from pathlib import Path
import re
import secrets
import time
import uuid

import aiohttp
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from PIL import Image, ImageOps
from pydantic import BaseModel, ConfigDict, Field

from .config import Settings, load_catalog, select_profile
from .geometry import geometry, restore_output
from .workflows import build_workflow

MAX_IMAGE_BYTES = 128 * 1024 * 1024
MAX_IMAGE_PIXELS = 100_000_000
MAX_HISTORY_BYTES = 2 * 1024 * 1024
MAX_ERROR_CHARS = 8000
SOURCE_ID = r'^[A-Za-z0-9_-]{16,128}$'


class InpaintRequest(BaseModel):
    model_config = ConfigDict(extra='forbid', allow_inf_nan=False)
    source_id: str = Field(pattern=SOURCE_ID)
    mask_image_base64: str = Field(max_length=4*((MAX_IMAGE_BYTES+2)//3))
    prompt: str = Field(min_length=1, max_length=20000)
    negative_prompt: str = Field(default='', max_length=20000)
    seed: int = Field(default=0, ge=0, le=9007199254740991, strict=True)
    profile: str | None = Field(default=None, pattern=r'^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$')
    megapixels: float | None = Field(default=None, ge=.0625, le=16)


def write_private(path, data):
    temporary = path.with_name(path.name+'.'+uuid.uuid4().hex+'.tmp')
    try:
        with temporary.open('xb') as stream:
            os.chmod(temporary, 0o600)
            stream.write(data)
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def atomic_json(path, value):
    write_private(path, (json.dumps(value, indent=2)+'\n').encode())


def checked_image(data):
    image = Image.open(io.BytesIO(data))
    if image.width*image.height > MAX_IMAGE_PIXELS or getattr(image, 'n_frames', 1) != 1:
        image.close()
        raise ValueError('Unsupported image dimensions or animation')
    return image


class SourceConflict(ValueError):
    pass


def store_source(cache, source_id, data):
    with checked_image(data) as image:
        image.verify()
    target = cache / (source_id+'.jpg')
    temporary = cache / (uuid.uuid4().hex+'.tmp')
    try:
        with temporary.open('xb') as stream:
            os.chmod(temporary, 0o600)
            stream.write(data)
        try:
            # A linked complete file is visible atomically; existing identifiers
            # remain immutable even when two upload requests arrive together.
            os.link(temporary, target)
        except FileExistsError:
            if target.read_bytes() != data:
                raise SourceConflict('Source identifier already contains different image bytes')
    finally:
        temporary.unlink(missing_ok=True)


def read_request_images(source_path, mask_base64, config):
    mask_bytes = base64.b64decode(mask_base64, validate=True)
    if len(mask_bytes) > MAX_IMAGE_BYTES:
        raise ValueError('Mask image is too large')
    source_bytes = source_path.read_bytes()
    with checked_image(mask_bytes) as image:
        # Native selection is grayscale RGB, including in opaque RGBA PNGs.
        mask = image.convert('L')
    with checked_image(source_bytes) as image:
        source = ImageOps.exif_transpose(image).convert('RGB')
    return source, mask, geometry(source.size, mask, config), source_bytes, mask_bytes


def prepare_evidence(evidence, receipt, workflow, source_bytes, mask, mask_bytes, mask_path):
    evidence.mkdir(mode=0o700)
    write_private(evidence/'source.jpg', source_bytes)
    write_private(evidence/'request-mask.png', mask_bytes)
    mask_rgba = Image.new('RGBA', mask.size, (0, 0, 0, 0))
    mask_rgba.putalpha(mask)
    stream = io.BytesIO()
    mask_rgba.save(stream, format='PNG')
    write_private(mask_path, stream.getvalue())
    atomic_json(evidence/'workflow.json', workflow)
    atomic_json(evidence/'receipt.json', receipt)


def save_history(path, history):
    data = json.dumps(history).encode()
    if len(data) > MAX_HISTORY_BYTES:
        atomic_json(path, dict(truncated=True, bytes=len(data), sha256=hashlib.sha256(data).hexdigest()))
    else:
        write_private(path, data)


async def read_bounded(response, maximum):
    data = bytearray()
    async for chunk in response.content.iter_chunked(65536):
        data.extend(chunk)
        if len(data) > maximum:
            raise RuntimeError('Comfy response exceeded its size limit')
    return bytes(data)


async def execute(settings, graph, output_node, on_event):
    timeout = aiohttp.ClientTimeout(total=60)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        client_id = 'rapidraw-'+uuid.uuid4().hex
        await on_event(dict(kind='submission_started', client_id=client_id))
        async with session.post(settings.comfy_url+'/prompt', json={'prompt': graph, 'client_id': client_id}) as response:
            result = json.loads(await read_bounded(response, MAX_HISTORY_BYTES))
            if response.status != 200:
                await on_event(dict(kind='rejected'))
                raise RuntimeError('Comfy rejected workflow: '+json.dumps(result)[:MAX_ERROR_CHARS])
        prompt_id = result['prompt_id']
        if not isinstance(prompt_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', prompt_id):
            raise RuntimeError('Comfy returned an invalid prompt identifier')
        await on_event(dict(kind='submitted', prompt_id=prompt_id))
        deadline = time.monotonic()+settings.generation_timeout
        while time.monotonic() < deadline:
            async with session.get(settings.comfy_url+'/history/'+prompt_id) as response:
                response.raise_for_status()
                history = json.loads(await read_bounded(response, MAX_HISTORY_BYTES)).get(prompt_id)
            if history:
                await on_event(dict(kind='history', prompt_id=prompt_id, history=history))
                if history.get('status', {}).get('status_str') == 'error':
                    events = history.get('status', {}).get('messages', [])
                    detail = next((value.get('exception_message') for key, value in events if key == 'execution_error'), 'Unknown execution error')
                    raise RuntimeError(str(detail)[:MAX_ERROR_CHARS])
                outputs = history.get('outputs', {}).get(output_node, {}).get('images', [])
                if len(outputs) != 1:
                    raise RuntimeError('Comfy did not return exactly one result')
                params = {key: outputs[0][key] for key in ('filename', 'subfolder', 'type') if key in outputs[0]}
                async with session.get(settings.comfy_url+'/view', params=params) as response:
                    response.raise_for_status()
                    data = await read_bounded(response, MAX_IMAGE_BYTES)
                return data, prompt_id, history
            await asyncio.sleep(.2)
        raise TimeoutError('Generation timed out; its Comfy job may still finish. No shared jobs were interrupted.')


def public_generation(receipt):
    return {key: receipt[key] for key in ('request_id', 'seed', 'profile', 'source_size', 'generated_size', 'context', 'seconds')}


def create_app(settings=None):
    settings = settings or Settings.from_env()
    listing = load_catalog(settings)
    settings.input_dir.mkdir(parents=True, exist_ok=True)
    settings.cache_dir.mkdir(mode=0o700, exist_ok=True)
    settings.receipt_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    app = FastAPI(title='RapidRAW Comfy Connector', docs_url=None, redoc_url=None)
    app.state.settings = settings
    app.state.execute = execute
    lock = asyncio.Lock()

    @app.exception_handler(RequestValidationError)
    async def validation_error(request, exc):
        # Validation details must not echo an uploaded mask, prompt or source ID.
        return JSONResponse(status_code=422, content={'detail': 'Invalid generation request fields'})

    @app.get('/capabilities')
    async def capabilities():
        profiles = [dict(id=name, label=item['label'], default_megapixels=item['config']['megapixels'], megapixels=item['megapixels']) for name, item in listing['profiles'].items()]
        return dict(protocol_version=2, generation=dict(seed=True, default_profile=listing['default_profile'], profiles=profiles))

    @app.get('/health')
    async def health():
        connected = False
        try:
            async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=5)) as session:
                async with session.get(settings.comfy_url+'/system_stats') as response:
                    data = json.loads(await read_bounded(response, MAX_HISTORY_BYTES))
                    connected = response.status == 200 and 'system' in data
        except (aiohttp.ClientError, ValueError, TimeoutError, RuntimeError):
            pass
        return dict(status='ok' if connected else 'error', connected=connected, protocol_version=2)

    @app.post('/upload_source')
    async def upload(source_id: str = Form(...), file: UploadFile = File(...)):
        if not re.fullmatch(SOURCE_ID, source_id):
            raise HTTPException(400, 'Invalid source identifier')
        data = await file.read(MAX_IMAGE_BYTES+1)
        if len(data) > MAX_IMAGE_BYTES:
            raise HTTPException(413, 'Source image is too large')
        try:
            await asyncio.to_thread(store_source, settings.cache_dir, source_id, data)
        except SourceConflict as exc:
            raise HTTPException(409, str(exc)) from exc
        except Exception as exc:
            raise HTTPException(400, 'Source is not a valid image') from exc
        return dict(status='ok')

    @app.post('/inpaint')
    async def inpaint(request: InpaintRequest):
        started = time.monotonic()
        try:
            profile, config = select_profile(listing, request.profile, request.megapixels)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        source_path = settings.cache_dir/(request.source_id+'.jpg')
        if not source_path.is_file():
            raise HTTPException(404, 'Source not cached')
        try:
            source, mask, g, source_bytes, mask_bytes = await asyncio.to_thread(read_request_images, source_path, request.mask_image_base64, config)
        except Exception as exc:
            raise HTTPException(400, 'Mask is invalid, empty or differs from the source dimensions') from exc
        seed = request.seed or secrets.randbelow(9007199254740991)+1
        if request.negative_prompt:
            config['negative_prompt'] = request.negative_prompt
        request_id = uuid.uuid4().hex
        mask_path = settings.cache_dir/(request_id+'-mask.png')
        evidence = settings.receipt_dir/request_id
        graph = build_workflow(source_path.relative_to(settings.input_dir).as_posix(), mask_path.relative_to(settings.input_dir).as_posix(), request.prompt, seed, g, config)
        receipt = dict(request_id=request_id, source_id=request.source_id,
                       source_sha256=hashlib.sha256(source_bytes).hexdigest(), source_path=str(evidence/'source.jpg'),
                       cached_source_path=str(source_path), mask_sha256=hashlib.sha256(mask_bytes).hexdigest(),
                       mask_path=str(evidence/'request-mask.png'), inference_mask_path=str(mask_path),
                       seed=seed, profile=profile, config=config, requested_megapixels=request.megapixels,
                       source_size=list(source.size), context=g,
                       workflow_sha256=hashlib.sha256(json.dumps(graph['workflow'], sort_keys=True).encode()).hexdigest(),
                       prompt=request.prompt, negative_prompt=request.negative_prompt,
                       status='prepared', created_unix=time.time(), execution_events=[])
        await asyncio.to_thread(prepare_evidence, evidence, receipt, graph['workflow'], source_bytes, mask, mask_bytes, mask_path)

        async def on_event(event):
            event = dict(event, unix=time.time())
            history = event.pop('history', None)
            if history is not None:
                await asyncio.to_thread(save_history, evidence/'history.json', history)
            receipt['execution_events'].append(event)
            receipt['execution_events'] = receipt['execution_events'][-256:]
            if event.get('prompt_id'):
                receipt['prompt_id'] = event['prompt_id']
            if event['kind'] in ('submission_started', 'submitted', 'rejected'):
                receipt['status'] = event['kind']
            await asyncio.to_thread(atomic_json, evidence/'receipt.json', receipt)

        try:
            queued = time.monotonic()
            async with lock:
                receipt['queue_wait_seconds'] = time.monotonic()-queued
                inference_started = time.monotonic()
                data, prompt_id, history = await app.state.execute(settings, graph['workflow'], graph['output_node'], on_event)
                receipt['comfy_wait_seconds'] = time.monotonic()-inference_started
            receipt['prompt_id'] = prompt_id
            await asyncio.to_thread(save_history, evidence/'history.json', history)
            await asyncio.to_thread(write_private, evidence/'generated.png', data)
            response, generated_size = await asyncio.to_thread(restore_output, data, mask, g, graph['output_kind'])
            receipt.update(status='completed', generated_size=generated_size, seconds=time.monotonic()-started, finished_unix=time.time())
            await on_event(dict(kind='completed', prompt_id=prompt_id))
            response['generation'] = public_generation(receipt)
            return response
        except asyncio.CancelledError:
            receipt.update(status='cancelled', error='Request cancelled; any submitted Comfy job was not interrupted.', seconds=time.monotonic()-started, finished_unix=time.time())
            await asyncio.shield(on_event(dict(kind='cancelled')))
            raise
        except Exception as exc:
            status = 'submission_unknown' if receipt['status'] == 'submission_started' else 'failed'
            receipt.update(status=status, error=str(exc)[:MAX_ERROR_CHARS], error_type=type(exc).__name__, seconds=time.monotonic()-started, finished_unix=time.time())
            await on_event(dict(kind=status))
            raise HTTPException(502, dict(message='Generation did not complete. Check the private receipt before retrying; a submitted job may still finish.', request_id=request_id, prompt_id=receipt.get('prompt_id'))) from exc

    return app
