"""Coordinate model residency across workflows on a single GPU server."""
import asyncio
import json

import aiohttp

from .app import read_bounded


class WorkflowSwitch:
    def __init__(self, urls):
        self.urls = set(url.rstrip('/') for url in urls)
        self.active = None

    async def activate(self, url, workflow):
        target = (url.rstrip('/'), workflow)
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=10)) as client:
            # A timed-out or externally submitted job still owns the GPU.
            # Never interrupt it, unload beneath it, or submit a competing job.
            for worker in self.urls:
                async with client.get(worker+'/queue') as response:
                    response.raise_for_status()
                    queue = json.loads(await read_bounded(response, 2*1024*1024))
                if queue.get('queue_running') or queue.get('queue_pending'):
                    raise RuntimeError('GPU workflow is still running; retry after it finishes')
            if self.active != target:
                for worker in self.urls:
                    async with client.post(worker+'/free', json={'unload_models': True, 'free_memory': False}) as response:
                        response.raise_for_status()
                # Comfy consumes the free flag in its worker loop, including idle workers.
                await asyncio.sleep(1.2)
                self.active = target
