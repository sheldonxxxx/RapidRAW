"""Validated deployment paths and generation profiles."""
from dataclasses import dataclass
import json
import math
import os
from pathlib import Path
from typing import Literal
from urllib.parse import urlparse

from pydantic import BaseModel, ConfigDict, Field, model_validator


class Profile(BaseModel):
    model_config = ConfigDict(extra='forbid', allow_inf_nan=False)
    id: str = Field(pattern=r'^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$')
    family: Literal['klein', 'boogu']
    model: str
    text_encoder: str
    vae: str
    steps: int = Field(ge=1, le=100)
    cfg: float = Field(ge=0, le=30)
    megapixels: float = Field(ge=.0625, le=16)
    mode: Literal['masked', 'context'] = 'masked'
    margin_fraction: float = Field(default=.5, ge=0, le=4)
    min_margin: int = Field(default=64, ge=16, le=8192)
    dimension_multiple: Literal[16] = 16
    kv_cache: bool = False
    shift: float | None = Field(default=None, ge=0, le=100)
    sampler: Literal['euler', 'lcm'] = 'euler'
    scheduler: Literal['simple', 'sgm_uniform'] = 'simple'
    denoise: float = Field(default=1, gt=0, le=1)
    weight_dtype: Literal['default', 'fp8_e4m3fn', 'fp8_e5m2'] = 'default'
    encoder_device: Literal['default', 'cpu'] = 'default'
    negative_prompt: str = Field(default='', max_length=20000)

    @model_validator(mode='after')
    def validate_model_names(self):
        for name in (self.model, self.text_encoder, self.vae):
            path = Path(name)
            if path.is_absolute() or '..' in path.parts or '\\' in name or not name.endswith('.safetensors'):
                raise ValueError('Model names must be relative .safetensors paths')
        if self.kv_cache and self.family != 'klein':
            raise ValueError('KV cache requires a Klein profile')
        return self


@dataclass(frozen=True)
class Settings:
    comfy_root: Path
    profile_dir: Path
    state_dir: Path
    comfy_url: str = 'http://127.0.0.1:8188'
    generation_timeout: float = 1800

    def __post_init__(self):
        for name in ('comfy_root', 'profile_dir', 'state_dir'):
            object.__setattr__(self, name, Path(getattr(self, name)).expanduser().resolve())
        url = self.comfy_url.rstrip('/')
        parsed = urlparse(url)
        if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError('COMFY_URL must be an HTTP(S) service URL without credentials')
        object.__setattr__(self, 'comfy_url', url)
        if not math.isfinite(self.generation_timeout) or not 1 <= self.generation_timeout <= 86400:
            raise ValueError('GENERATION_TIMEOUT must be between 1 and 86400 seconds')
        if not self.comfy_root.is_dir() or not self.profile_dir.is_dir():
            raise ValueError('COMFY_ROOT and PROFILE_DIR must be existing directories')
        if self.state_dir.is_relative_to(self.comfy_root / 'input') or self.state_dir.is_relative_to(self.comfy_root / 'output'):
            raise ValueError('STATE_DIR must be outside Comfy input and output directories')

    @classmethod
    def from_env(cls):
        values = {}
        for name in ('COMFY_ROOT', 'PROFILE_DIR', 'STATE_DIR'):
            value = os.environ.get(name)
            if not value:
                raise ValueError(f'{name} is required')
            values[name.lower()] = Path(value)
        return cls(**values, comfy_url=os.environ.get('COMFY_URL', 'http://127.0.0.1:8188'),
                   generation_timeout=float(os.environ.get('GENERATION_TIMEOUT', '1800')))

    @property
    def input_dir(self):
        return self.comfy_root / 'input'

    @property
    def cache_dir(self):
        return self.input_dir / 'rapidraw-connector'

    @property
    def receipt_dir(self):
        return self.state_dir / 'receipts'


def load_catalog(settings):
    listing = json.loads((settings.profile_dir / 'profiles.json').read_text())
    profiles = {}
    for name, item in listing['profiles'].items():
        path = (settings.profile_dir / item['config']).resolve()
        if not path.is_relative_to(settings.profile_dir):
            raise ValueError('Profile configuration is outside PROFILE_DIR')
        try:
            profile = Profile.model_validate(json.loads(path.read_text()))
        except ValueError:
            raise ValueError('Invalid generation profile configuration') from None
        if profile.id != name:
            raise ValueError('Profile identifier differs from catalog entry')
        resolutions = item['megapixels']
        if not resolutions or any(isinstance(mp, bool) or not isinstance(mp, (int, float)) or not math.isfinite(mp) or not .0625 <= mp <= 16 for mp in resolutions):
            raise ValueError('Invalid advertised profile resolutions')
        if profile.megapixels not in resolutions:
            raise ValueError('Default resolution is not advertised')
        label = item['label']
        if not isinstance(label, str) or not 1 <= len(label) <= 120:
            raise ValueError('Invalid profile label')
        profiles[name] = dict(config=profile.model_dump(exclude_unset=True), label=label,
                              megapixels=list(resolutions))
    if listing['default_profile'] not in profiles:
        raise ValueError('Default generation profile is missing')
    return dict(default_profile=listing['default_profile'], profiles=profiles)


def select_profile(listing, name, megapixels):
    name = name or listing['default_profile']
    item = listing['profiles'].get(name)
    if item is None:
        raise ValueError('Unknown generation profile')
    config = dict(item['config'])
    if megapixels is not None:
        if not math.isfinite(megapixels) or megapixels not in item['megapixels']:
            raise ValueError('Generation resolution is not supported by this profile')
        config['megapixels'] = megapixels
    return name, config
