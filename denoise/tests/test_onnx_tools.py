"""Fast checks for the ONNX export/validation drivers.

Fail-closed paths and a one-tile CPU smoke validation. Full 18-tile parity
is recorded evidence (nonlocal-onnx-evidence/parity/), not part of this suite.
"""
import json
import os
from pathlib import Path

import pytest

from rapidraw_denoise import onnx_export, onnx_validate

REPO = Path(__file__).resolve().parent.parent.parent
# Pinned review fixtures/artifact, overridable for other checkouts:
#   NONLOCAL_ONNX_BUNDLE / NONLOCAL_ONNX_FIXTURES
BUNDLE = Path(os.environ.get(
    "NONLOCAL_ONNX_BUNDLE",
    REPO / "nonlocal-onnx-evidence/model/bundle-pinned-320-fp32"))
FIXTURE = Path(os.environ.get(
    "NONLOCAL_ONNX_FIXTURES",
    REPO / "nonlocal-onnx-evidence/fixtures/portrait-controlled-fp32"))

requires_bundle = pytest.mark.skipif(
    not (BUNDLE / "model.onnx").is_file(), reason="ONNX bundle not built"
)
requires_fixture = pytest.mark.skipif(
    not (FIXTURE / "tiles").is_dir(), reason="CPU fixtures not captured"
)


def test_export_rejects_non_reference_sampler_env(tmp_path):
    old = os.environ.get("RAPIDRAW_DENOISE_SAMPLER")
    os.environ["RAPIDRAW_DENOISE_SAMPLER"] = "cuda"
    try:
        code = onnx_export.main([
            "--checkpoint", "/tmp/ckpt.pt",
            "--fixtures", "/tmp/fx",
            "--output", str(tmp_path / "new-bundle"),
        ])
    finally:
        if old is None:
            del os.environ["RAPIDRAW_DENOISE_SAMPLER"]
        else:
            os.environ["RAPIDRAW_DENOISE_SAMPLER"] = old
    assert code == 1
    assert not (tmp_path / "new-bundle").exists()


def test_export_rejects_missing_fixture(tmp_path):
    code = onnx_export.main([
        "--checkpoint", "/tmp/ckpt.pt",
        "--fixtures", str(tmp_path / "no-such-dir"),
        "--output", str(tmp_path / "new-bundle"),
    ])
    assert code == 1


def test_validate_rejects_missing_bundle(tmp_path):
    report = tmp_path / "report.json"
    code = onnx_validate.main([
        "--bundle", str(tmp_path / "no-such-bundle"),
        "--fixtures", str(FIXTURE),
        "--provider", "cpu",
        "--report", str(report),
    ])
    assert code == 1
    # Failure reports are durable: the error is saved, not just printed.
    saved = json.loads(report.read_text())
    assert saved["status"] == "error" and "Bundle" in saved["error"]


def test_validate_rejects_unavailable_provider(tmp_path):
    real_ort = pytest.importorskip("onnxruntime")
    if "CUDAExecutionProvider" in real_ort.get_available_providers():
        pytest.skip("CUDA provider unexpectedly available")
    report = tmp_path / "report.json"
    code = onnx_validate.main([
        "--bundle", str(BUNDLE),
        "--fixtures", str(FIXTURE),
        "--provider", "cuda",
        "--report", str(report),
    ])
    assert code == 1
    saved = json.loads(report.read_text())
    assert saved["status"] == "error" and "unavailable" in saved["error"]


@requires_bundle
def test_validate_refuses_to_overwrite_report(tmp_path):
    report = tmp_path / "report.json"
    report.write_text("{}")
    code = onnx_validate.main([
        "--bundle", str(BUNDLE),
        "--fixtures", str(FIXTURE),
        "--provider", "cpu",
        "--report", str(report),
    ])
    assert code == 1
