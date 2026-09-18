"""Full-photo comparison entry point.

Thin delegation to the single maintained implementation in
``rapidraw_denoise.compare_full`` (run with ``denoise/`` on PYTHONPATH).
The previous standalone ``compare_full.py`` implementation (which reduced
per-channel bias over the row axis ``arr[:, c]`` on ``[C,H,W]`` arrays) is
retired: its exact source is preserved as historical evidence under
``nonlocal-onnx-evidence/superseded/compare_full-old-broken.py`` and the
reports it produced are preserved under ``superseded/``. Do not revive the
old implementation; use this wrapper.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from rapidraw_denoise.compare_full import main  # noqa: E402

if __name__ == "__main__":
    raise SystemExit(main())
