"""An explicit, isolated workspace for reproducible study artifacts."""

import os
from pathlib import Path


def workspace():
    value = os.environ.get("RAPIDRAW_DENOISE_STUDY_ROOT")
    if not value:
        raise RuntimeError(
            "Set RAPIDRAW_DENOISE_STUDY_ROOT to your experiment workspace"
        )
    root = Path(value).expanduser().resolve()
    return root, root / "quality-study"


ROOT, STUDY = workspace()


def require_space(extra_gib=2):
    import shutil

    ROOT.mkdir(parents=True, exist_ok=True)
    if shutil.disk_usage(ROOT).free < (20 + extra_gib) * 1024**3:
        raise OSError(
            f"Study requires 20 GiB reserve plus {extra_gib} GiB output allowance"
        )
    STUDY.mkdir(exist_ok=True)
