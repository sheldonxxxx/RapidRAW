"""I/O-binding path tests (require real CUDA; skipped elsewhere).

Validates the optional preallocated-device-buffer path: numerical identity
with the unbound path, no output aliasing across consecutive tiles, stable
buffer addresses, and fail-closed construction rules. Not hardware-speed
claims; timing lives in the benchmark reports.
"""
import os
from pathlib import Path

import numpy as np
import pytest

REPO = Path(__file__).resolve().parent.parent.parent
BUNDLE = Path(os.environ.get(
    "NONLOCAL_ONNX_BUNDLE",
    REPO / "nonlocal-onnx-evidence/model/bundle-pinned-320-fp32"))
FIXTURES = Path(os.environ.get(
    "NONLOCAL_ONNX_FIXTURES",
    REPO / "nonlocal-onnx-evidence/fixtures/portrait-controlled-fp32"))

real_ort = pytest.importorskip("onnxruntime")
requires_cuda = pytest.mark.skipif(
    "CUDAExecutionProvider" not in real_ort.get_available_providers(),
    reason="CUDA provider absent")


def _tile(i):
    with np.load(FIXTURES / "tiles" / f"tile-{i:02d}.npz",
                 allow_pickle=False) as f:
        return (np.ascontiguousarray(f["input"])[0],
                np.ascontiguousarray(f["output"])[0])


@requires_cuda
def test_binding_matches_unbound_numerically():
    from rapidraw_denoise.onnx_backend import OnnxTilePredictor
    x, ref = _tile(0)
    plain = OnnxTilePredictor(BUNDLE, provider="cuda")
    bound = OnnxTilePredictor(BUNDLE, provider="cuda", io_binding=True)
    assert bound.execution_info()["io_binding"] is True
    assert plain.execution_info()["io_binding"] is False
    got_bound = bound.predict(x)
    got_plain = plain.predict(x)
    np.testing.assert_array_equal(got_bound, got_plain)
    np.testing.assert_allclose(got_bound, ref, atol=1e-4, rtol=1e-4)


@requires_cuda
def test_binding_outputs_do_not_alias_stale_buffers():
    from rapidraw_denoise.onnx_backend import OnnxTilePredictor
    bound = OnnxTilePredictor(BUNDLE, provider="cuda", io_binding=True)
    in_ptr = bound._bound_input.data_ptr()
    out_ptr = bound._bound_output.data_ptr()
    x0, _ = _tile(0)
    x1, _ = _tile(1)
    first = bound.predict(x0)
    assert first.base is None  # fresh host copy, not a buffer view
    assert bound._bound_input.data_ptr() == in_ptr
    assert bound._bound_output.data_ptr() == out_ptr
    first_copy = first.copy()
    second = bound.predict(x1)
    np.testing.assert_array_equal(first, first_copy)  # next run kept it intact
    assert not np.array_equal(first, second)  # distinct tiles, distinct outputs
    assert second.base is None


@requires_cuda
def test_binding_rejects_non_cuda_provider():
    from rapidraw_denoise.onnx_backend import OnnxTilePredictor
    with pytest.raises(ValueError, match="io_binding.*cuda"):
        OnnxTilePredictor(BUNDLE, provider="cpu", io_binding=True)
