"""A scoped memory budget for the optional Marigold sampler."""
from contextvars import ContextVar

import comfy.model_management as memory
from comfy_extras.nodes_custom_sampler import SamplerCustomAdvanced

_reserve = ContextVar('rapidraw_marigold_reserve', default=None)
_original_reserved_memory = memory.extra_reserved_memory


def reserved_memory():
    value = _reserve.get()
    original = _original_reserved_memory()
    return original if value is None else max(original, value)


# The override is local to the sampler's execution context. Ordinary nodes and
# other threads call the original function, including after errors/cancellation.
memory.extra_reserved_memory = reserved_memory


class RapidRAWMarigoldSampler:
    @classmethod
    def INPUT_TYPES(cls):
        return {'required': {'noise': ('NOISE',), 'guider': ('GUIDER',),
                             'sampler': ('SAMPLER',), 'sigmas': ('SIGMAS',),
                             'latent_image': ('LATENT',)}}

    RETURN_TYPES = ('LATENT', 'LATENT')
    RETURN_NAMES = ('output', 'denoised_output')
    FUNCTION = 'sample'
    CATEGORY = 'RapidRAW/depth'

    def sample(self, noise, guider, sampler, sigmas, latent_image):
        samples = latent_image['samples']
        if samples.shape[0] != 1 or samples.shape[-1]*samples.shape[-2] > 16384:
            raise ValueError('Marigold shared GPU profile requires batch one and at most one megapixel')
        total = memory.get_total_memory(memory.get_torch_device())
        token = _reserve.set(max(0, total-7*1024**3))
        try:
            return SamplerCustomAdvanced.execute(noise, guider, sampler, sigmas, latent_image).result
        finally:
            _reserve.reset(token)


NODE_CLASS_MAPPINGS = {'RapidRAWMarigoldSampler': RapidRAWMarigoldSampler}
NODE_DISPLAY_NAME_MAPPINGS = {'RapidRAWMarigoldSampler': 'Marigold Depth · Shared GPU'}
