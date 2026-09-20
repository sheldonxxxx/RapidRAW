"""Benchmark-only ORT profiling opt-in (fail-closed, no behavior change).

Covers the smallest profiling support for the Nonlocal CUDA diagnostic:
- profiling off by default, explicit opt-in only;
- argument validation (prefix requires enable, non-bool rejected);
- end_profiling() fail-closed when profiling was not enabled;
- profiling does not change prediction numerics (fake + real CPU);
- profile audit timing summaries (provider/operator shares, GridSample).
"""
import json
import sys
import types
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

from rapidraw_denoise import onnx_backend as backend_mod

PINNED = backend_mod.PINNED_CHECKPOINT_SHA256
TILE = backend_mod.PRODUCTION_TILE
REPO = Path(__file__).resolve().parent.parent.parent
BUNDLE = REPO / "nonlocal-onnx-evidence/model/bundle-packed-320-fp32"
FIXTURE_TILE = (REPO / "nonlocal-onnx-evidence/fixtures"
                / "portrait-controlled-fp32/tiles/tile-00.npz")


class FakeSession:
    shape = (1, 4, TILE, TILE)
    dtype = np.float32

    def __init__(self, *args, **kwargs):
        self.providers = list(kwargs["providers"])
        sess_opts = kwargs.get("sess_options")
        # Record profiling flags without executing inference.
        self.profiling_requested = bool(
            getattr(sess_opts, "enable_profiling", False))
        self.profile_prefix = getattr(sess_opts, "profile_file_prefix", None)
        self.fallback_disabled = False
        self.runs = 0
        self._profile_path = "/tmp/fake-profile.json"

    def get_providers(self):
        return list(self.providers)

    def disable_fallback(self):
        self.fallback_disabled = True

    def get_inputs(self):
        return [SimpleNamespace(name="raw_with_noise",
                                shape=[1, 8, TILE, TILE],
                                type="tensor(float)")]

    def get_outputs(self):
        return [SimpleNamespace(name="denoised_raw",
                                shape=[1, 4, TILE, TILE],
                                type="tensor(float)")]

    def run(self, names, feed):
        self.runs += 1
        return [np.zeros(self.shape, dtype=self.dtype)]

    def end_profiling(self):
        return self._profile_path


def install_fake(monkeypatch):
    fake = types.ModuleType("onnxruntime")
    fake.__version__ = "FAKE_NO_INFERENCE"
    fake.get_available_providers = lambda: ["CPUExecutionProvider",
                                            "CUDAExecutionProvider"]
    fake.SessionOptions = type("SessionOptions", (), {})
    fake.GraphOptimizationLevel = types.SimpleNamespace(ORT_DISABLE_ALL=0)
    fake.InferenceSession = FakeSession
    monkeypatch.setitem(sys.modules, "onnxruntime", fake)
    return fake


def make_bundle(tmp_path, **overrides):
    bundle = tmp_path / "bundle-prof"
    bundle.mkdir(exist_ok=True)
    (bundle / "model.onnx").write_bytes(b"FAKE MODEL - profiling control flow")
    import hashlib
    manifest = {
        "manifest_version": 1,
        "diagnostic_shape": False,
        "source_checkpoint_sha256": PINNED,
        "checkpoint_pinned_match": True,
        "model_sha256": hashlib.sha256(
            (bundle / "model.onnx").read_bytes()).hexdigest(),
        "tile": TILE,
        "precision": "fp32",
        "input_name": "raw_with_noise",
        "input_shape": [1, 8, TILE, TILE],
        "input_dtype": "float32",
        "output_name": "denoised_raw",
        "output_shape": [1, 4, TILE, TILE],
        "output_dtype": "float32",
        "model_file": "model.onnx",
        "sampler_implementation": "static-packed (static-packed-v1; export-only route)",
    }
    manifest.update(overrides)
    (bundle / "manifest.json").write_text(json.dumps(manifest))
    return bundle


X = np.zeros((8, TILE, TILE), np.float32)


def test_profiling_off_by_default(monkeypatch, tmp_path):
    install_fake(monkeypatch)
    p = backend_mod.OnnxTilePredictor(make_bundle(tmp_path), "cpu")
    assert p.profiling_enabled is False
    assert p.execution_info()["profiling_enabled"] is False
    assert p.session.profiling_requested is False


def test_profile_prefix_requires_enable(monkeypatch, tmp_path):
    install_fake(monkeypatch)
    with pytest.raises(ValueError, match="profile_prefix.*enable_profiling"):
        backend_mod.OnnxTilePredictor(
            make_bundle(tmp_path), "cpu",
            profile_prefix="/tmp/prefix")


def test_enable_profiling_must_be_bool(monkeypatch, tmp_path):
    install_fake(monkeypatch)
    with pytest.raises(ValueError, match="enable_profiling.*bool"):
        backend_mod.OnnxTilePredictor(
            make_bundle(tmp_path), "cpu", enable_profiling="yes")


def test_end_profiling_fails_when_not_enabled(monkeypatch, tmp_path):
    install_fake(monkeypatch)
    p = backend_mod.OnnxTilePredictor(make_bundle(tmp_path), "cpu")
    with pytest.raises(RuntimeError, match="profiling was not enabled"):
        p.end_profiling()


def test_profiling_optin_sets_session_options_and_returns_path(
        monkeypatch, tmp_path):
    install_fake(monkeypatch)
    p = backend_mod.OnnxTilePredictor(
        make_bundle(tmp_path), "cpu",
        enable_profiling=True, profile_prefix=str(tmp_path / "prof"))
    assert p.profiling_enabled is True
    assert p.session.profiling_requested is True
    assert p.session.profile_prefix == str(tmp_path / "prof")
    assert p.end_profiling() == "/tmp/fake-profile.json"
    assert p.execution_info()["profile_path"] == "/tmp/fake-profile.json"


def test_profiling_does_not_change_fake_prediction(monkeypatch, tmp_path):
    install_fake(monkeypatch)
    plain = backend_mod.OnnxTilePredictor(make_bundle(tmp_path), "cpu")
    prof = backend_mod.OnnxTilePredictor(
        make_bundle(tmp_path), "cpu", enable_profiling=True)
    np.testing.assert_array_equal(plain.predict(X), prof.predict(X))


def test_audit_timing_summaries_and_gridsample_share(tmp_path):
    from rapidraw_denoise.profile_audit import audit_profile
    events = [
        {"cat": "Node", "name": "n1_kernel_time", "dur": 100,
         "args": {"provider": "CUDAExecutionProvider", "op_name": "Conv"}},
        {"cat": "Node", "name": "n2_kernel_time", "dur": 300,
         "args": {"provider": "CUDAExecutionProvider",
                  "op_name": "GridSample"}},
        {"cat": "Node", "name": "n3_kernel_time", "dur": 50,
         "args": {"provider": "CPUExecutionProvider", "op_name": "Expand"}},
        {"cat": "Node", "name": "n4_kernel_time", "dur": 50,
         "args": {"provider": "CUDAExecutionProvider",
                  "op_name": "MemcpyToHost"}},
        {"cat": "Session", "name": "model_run", "dur": 999, "args": {}},
    ]
    p = tmp_path / "profile.json"
    p.write_text(json.dumps(events))
    r = audit_profile(p)
    # Existing count behavior preserved.
    assert r["node_events"] == 4
    assert r["node_events_by_provider"] == {
        "CUDAExecutionProvider": 3, "CPUExecutionProvider": 1}
    # New timing behavior: Node total excludes Session events.
    assert r["node_total_dur_us"] == 500
    assert r["node_dur_us_by_provider"]["CUDAExecutionProvider"] == 450
    assert r["gridsample_dur_us"] == 300
    assert r["gridsample_share"] == pytest.approx(0.6)
    top_op = r["top_ops_by_dur"][0]
    assert top_op["op"] == "GridSample" and top_op["share"] == pytest.approx(0.6)
    assert r["dur_unit"].startswith("microseconds")
    assert "device-only" in r["timing_scope"]


real_ort = pytest.importorskip("onnxruntime")
requires_bundle = pytest.mark.skipif(
    not (BUNDLE / "model.onnx").is_file() or not FIXTURE_TILE.is_file(),
    reason="accepted bundle or tile fixture absent")


@requires_bundle
def test_real_cpu_profiling_matches_unprofiled_numerically(tmp_path):
    # Real-model guard that profiling is observation-only: one tile, CPU.
    from rapidraw_denoise.onnx_backend import OnnxTilePredictor
    with np.load(FIXTURE_TILE, allow_pickle=False) as f:
        x = np.ascontiguousarray(f["input"])[0]
    plain = OnnxTilePredictor(BUNDLE, provider="cpu")
    prof = OnnxTilePredictor(
        BUNDLE, provider="cpu", enable_profiling=True,
        profile_prefix=str(tmp_path / "cpu-prof"))
    got_plain = plain.predict(x)
    got_prof = prof.predict(x)
    np.testing.assert_array_equal(got_prof, got_plain)
    trace = Path(prof.end_profiling())
    assert trace.is_file()
    from rapidraw_denoise.profile_audit import audit_profile
    audit = audit_profile(trace)
    assert audit["node_events"] > 0
    assert audit["node_events_by_provider"].get("CPUExecutionProvider", 0) > 0
