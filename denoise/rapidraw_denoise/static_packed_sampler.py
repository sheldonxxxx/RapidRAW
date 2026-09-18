"""Export-only static packed sampler for Nonlocal blocks.

Drops in for ``vendor.nonlocalmf.sampling.deform_neighbourhood`` inside an
isolated export clone only: one ``grid_sample`` per fixed-size block instead
of one per neighbour (89 calls -> 5 for the current 320 model). Precomputes
ONLY static integer pixel/neighbour coordinate bases; learned offsets still
flow through the graph unchanged.

Arithmetic order is preserved against the reference loop
(``(yy +ysteem row - pad) + offset``, then ``(2*coord+1)/size - 1``) so the
packed path reproduces the loop path. FP32-only for deployment (FP64 is
accepted for independent oracle tests, not as a production format).
Buffers are non-persistent: no checkpoint keys are added.
"""
from __future__ import annotations

import torch
from torch import Tensor, nn
import torch.nn.functional as F

SAMPLER_VERSION = "static-packed-v1"


class StaticPackedSampler(nn.Module):
    """Sample K learned neighbours with a single grid_sample.

    Offset order: dy0, dx0, dy1, dx1, ... (row-major neighbours).
    Output order: channel-major, neighbour-minor (matches the fork).
    """

    def __init__(self, *, channels: int, height: int, width: int,
                 neighbourhood: tuple[int, int], batch_size: int = 1,
                 dtype: torch.dtype = torch.float32) -> None:
        super().__init__()
        sizes = (channels, height, width, batch_size, *neighbourhood)
        if any(type(v) is not int or v <= 0 for v in sizes):
            raise ValueError("All dimensions must be positive integers")
        if dtype not in (torch.float32, torch.float64):
            raise ValueError("Static packed sampler supports FP32/FP64 only")
        kh, kw = neighbourhood
        if kh % 2 == 0 or kw % 2 == 0:
            raise ValueError("Only odd centred neighbourhoods are supported")
        self.channels, self.height, self.width = channels, height, width
        self.batch_size, self.k = batch_size, kh * kw
        self.input_shape = (batch_size, channels, height, width)
        self.offset_shape = (batch_size, 2 * self.k, height, width)
        index = torch.arange(self.k, dtype=torch.int64)
        row = torch.div(index, kw, rounding_mode="floor").to(dtype)
        col = (index % kw).to(dtype)
        yy = torch.arange(height, dtype=dtype).reshape(1, height, 1)
        xx = torch.arange(width, dtype=dtype).reshape(1, 1, width)
        py = yy + row.reshape(self.k, 1, 1) - kh // 2
        px = xx + col.reshape(self.k, 1, 1) - kw // 2
        self.register_buffer("pixel_y", py.expand(self.k, height, width)
                             .contiguous().unsqueeze(0), persistent=False)
        self.register_buffer("pixel_x", px.expand(self.k, height, width)
                             .contiguous().unsqueeze(0), persistent=False)

    def forward(self, x: Tensor, offsets: Tensor) -> Tensor:
        if tuple(x.shape) != self.input_shape or tuple(offsets.shape) != self.offset_shape:
            raise ValueError("Input or offsets do not match the fixed sampler shape")
        if (x.dtype not in (torch.float32, torch.float64)
                or x.dtype != offsets.dtype or x.dtype != self.pixel_x.dtype):
            raise ValueError("Features, offsets and coordinate buffers need matching FP32/FP64")
        if x.device != offsets.device or x.device != self.pixel_x.device:
            raise ValueError("Features, offsets and coordinate buffers need matching devices")
        off = offsets.reshape(self.batch_size, self.k, 2, self.height, self.width)
        y = self.pixel_y + off[:, :, 0]
        z = self.pixel_x + off[:, :, 1]
        gx = (2 * z + 1) / self.width - 1
        gy = (2 * y + 1) / self.height - 1
        grid = torch.stack((gx, gy), dim=-1).reshape(
            self.batch_size, self.k * self.height, self.width, 2)
        sampled = F.grid_sample(x, grid, mode="bilinear",
                                padding_mode="zeros", align_corners=False)
        return sampled.reshape(self.batch_size, self.channels * self.k,
                               self.height, self.width)


# Shape-keyed module cache: blocks with identical geometry share one
# immutable module (e.g. the two 5x5 32-channel 320-scale blocks).
_module_cache: dict[tuple, StaticPackedSampler] = {}


def packed_deform_neighbourhood(x: Tensor, offsets: Tensor,
                                neighbourhood_size, stride=1, padding=0,
                                dilation=1, offset_groups=1) -> Tensor:
    """Drop-in for ``deform_neighbourhood`` with the export-only packed path.

    Supports exactly the released RAW configuration (stride/dilation/
    offset_groups 1, odd centred neighbourhoods, batch 1, FP32/FP64).
    Anything else raises: never silently fall back to a different sampler.
    """
    if stride != 1 or dilation != 1 or offset_groups != 1:
        raise ValueError("Packed sampler supports the released RAW architecture only")
    kh, kw = tuple(neighbourhood_size)
    ph, pw = (padding if isinstance(padding, tuple) else (padding, padding))
    if ph != kh // 2 or pw != kw // 2:
        raise ValueError("Packed sampler requires centred padding")
    b, c, h, w = (int(v) for v in x.shape)
    if b != 1:
        raise ValueError("Packed sampler supports batch 1 only")
    key = (c, h, w, kh, kw, str(x.dtype), str(x.device))
    mod = _module_cache.get(key)
    if mod is None:
        mod = StaticPackedSampler(channels=c, height=h, width=w,
                                  neighbourhood=(kh, kw), batch_size=1,
                                  dtype=x.dtype).to(x.device)
        _module_cache[key] = mod
    return mod(x, offsets)


def cache_size() -> int:
    return len(_module_cache)


def clear_cache() -> None:
    _module_cache.clear()
