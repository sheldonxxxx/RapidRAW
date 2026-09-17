"""Differentiable reference implementation of the authors' sampling operator.

An installed CUDA extension is optional. The reference path also provides an
independent numerical check of extension builds on new GPU architectures.
"""
import os
import torch
import torch.nn.functional as F


def reference_sampling(x, offsets, neighbourhood_size, stride=1, padding=0,
                       dilation=1, offset_groups=1):
    if stride != 1 or dilation != 1 or offset_groups != 1:
        raise ValueError("Reference sampler supports the released RAW architecture only")
    kh, kw = neighbourhood_size
    ph, pw = padding
    b, c, h, w = x.shape
    if offsets.shape != (b, 2 * kh * kw, h, w):
        raise ValueError("Unexpected offset tensor shape")
    yy, xx = torch.meshgrid(torch.arange(h, device=x.device, dtype=x.dtype),
                            torch.arange(w, device=x.device, dtype=x.dtype), indexing="ij")
    samples = []
    for k in range(kh * kw):
        y = yy + k // kw - ph + offsets[:, 2 * k]
        z = xx + k % kw - pw + offsets[:, 2 * k + 1]
        grid = torch.stack(((2 * z + 1) / w - 1, (2 * y + 1) / h - 1), -1)
        samples.append(F.grid_sample(x, grid, mode="bilinear", padding_mode="zeros", align_corners=False))
    return torch.stack(samples, 2).reshape(b, c * kh * kw, h, w)


def deform_neighbourhood(*args, **kwargs):
    if os.environ.get("RAPIDRAW_DENOISE_SAMPLER", "reference") == "cuda":
        from deform_neighbourhood_sampling.ops import deform_neighbourhood as native
        return native(*args, **kwargs)
    return reference_sampling(*args, **kwargs)
