"""Check the output volume before allocating benchmark artifacts."""
import math
import os
from pathlib import Path
import shutil


def require_free_space(output, minimum_gib=None):
    minimum = float(os.environ.get("RAPIDRAW_MIN_FREE_GIB", "20") if minimum_gib is None else minimum_gib)
    if not math.isfinite(minimum) or minimum <= 0:
        raise ValueError("RAPIDRAW_MIN_FREE_GIB must be a positive finite number")
    parent = Path(output).resolve()
    while not parent.exists():
        parent = parent.parent
    free = shutil.disk_usage(parent).free
    if free < minimum * 1024 ** 3:
        raise RuntimeError(f"STORAGE_LOW: {free / 1024 ** 3:.1f} GiB free on output volume; {minimum:g} GiB required")
