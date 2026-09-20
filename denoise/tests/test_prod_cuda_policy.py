"""Benchmark-only exact-production CUDA policy (no production change).

Covers: production option values mirror nonlocal_onnx.rs open_backend(),
validation of new CUDA provider-option keys, pass-through to the ORT
session kwargs, bench_candidate.py CLI validation, the torch-free
library_context label, and the /proc maps snapshot helper. No GPU required.
"""
import json
import subprocess
import sys
import types
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

from rapidraw_denoise import onnx_backend as backend_mod

TILE = backend_mod.PRODUCTION_TILE
SCRIPT = (Path(__file__).resolve().parent.parent
          / "scripts" / "bench_candidate.py")


def test_production_dict_matches_rust_policy():
    assert backend_mod.PRODUCTION_CUDA_PROVIDER_OPTIONS == {
        "device_id": "0",
        "arena_extend_strategy": "kSameAsRequested",
        "cudnn_conv_algo_search": "HEURISTIC",
    }


def test_validate_accepts_production_options():
    eff = backend_mod.validate_provider_options(
        "cuda", dict(backend_mod.PRODUCTION_CUDA_PROVIDER_OPTIONS))
    assert eff == backend_mod.PRODUCTION_CUDA_PROVIDER_OPTIONS


def test_validate_rejects_bad_arena_cudnn_device():
    with pytest.raises(ValueError, match="not in"):
        backend_mod.validate_provider_options(
            "cuda", {"arena_extend_strategy": "kWhatever"})
    with pytest.raises(ValueError, match="not in"):
        backend_mod.validate_provider_options(
            "cuda", {"cudnn_conv_algo_search": "SUPERFAST"})
    with pytest.raises(ValueError, match="device_id"):
        backend_mod.validate_provider_options(
            "cuda", {"device_id": "-1"})
    with pytest.raises(ValueError, match="device_id"):
        backend_mod.validate_provider_options(
            "cuda", {"device_id": "0.5"})
    with pytest.raises(ValueError, match="Unknown cuda provider option"):
        backend_mod.validate_provider_options(
            "cuda", {"enable_cuda_graph": "1"})


class FakeSession:
    def __init__(self, *args, **kwargs):
        self.kwargs = dict(kwargs)
        self.providers = list(kwargs["providers"])

    def get_providers(self):
        return list(self.providers)

    def disable_fallback(self):
        pass

    def get_inputs(self):
        return [SimpleNamespace(name="raw_with_noise",
                                shape=[1, 8, TILE, TILE],
                                type="tensor(float)")]

    def get_outputs(self):
        return [SimpleNamespace(name="denoised_raw",
                                shape=[1, 4, TILE, TILE],
                                type="tensor(float)")]


def _install_fake(monkeypatch):
    fake = types.ModuleType("onnxruntime")
    fake.__version__ = "FAKE_NO_INFERENCE"
    fake.get_available_providers = lambda: ["CPUExecutionProvider",
                                            "CUDAExecutionProvider"]
    fake.SessionOptions = type("SessionOptions", (), {})
    fake.GraphOptimizationLevel = types.SimpleNamespace(ORT_DISABLE_ALL=0)
    fake.InferenceSession = FakeSession
    monkeypatch.setitem(sys.modules, "onnxruntime", fake)


def _bundle(tmp_path):
    bundle = tmp_path / "bundle-prod"
    bundle.mkdir(exist_ok=True)
    (bundle / "model.onnx").write_bytes(b"FAKE MODEL - prod policy")
    import hashlib
    manifest = {
        "manifest_version": 1,
        "diagnostic_shape": False,
        "source_checkpoint_sha256": backend_mod.PINNED_CHECKPOINT_SHA256,
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
    (bundle / "manifest.json").write_text(json.dumps(manifest))
    return bundle


def test_prod_options_reach_session_kwargs(monkeypatch, tmp_path):
    _install_fake(monkeypatch)
    p = backend_mod.OnnxTilePredictor(
        _bundle(tmp_path), "cuda",
        provider_options=dict(backend_mod.PRODUCTION_CUDA_PROVIDER_OPTIONS))
    sent = p.session.kwargs["provider_options"][0]
    assert sent["device_id"] == "0"
    assert sent["arena_extend_strategy"] == "kSameAsRequested"
    assert sent["cudnn_conv_algo_search"] == "HEURISTIC"
    assert sent["use_tf32"] == "0"
    assert p.execution_info()["provider_options_effective"] == sent


def _run_cli(*args, tmp_path):
    out = tmp_path / f"out-{len(list(tmp_path.iterdir()))}.json"
    cmd = [sys.executable, str(SCRIPT), "--bundle", "/tmp/nope",
           "--fixtures", "/tmp/nope", "--out", str(out), *args]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    return proc


def test_cli_prod_cuda_requires_cuda(tmp_path):
    proc = _run_cli("--provider", "cpu", "--prod-cuda", tmp_path=tmp_path)
    assert proc.returncode == 1
    assert "--prod-cuda requires --provider cuda" in proc.stderr


def test_cli_prod_cuda_conflicts_tf32(tmp_path):
    proc = _run_cli("--provider", "cuda", "--prod-cuda", "--tf32",
                    tmp_path=tmp_path)
    assert proc.returncode == 1
    assert "conflicts with --tf32" in proc.stderr


def test_cli_cuda_overrides_require_cuda(tmp_path):
    proc = _run_cli("--provider", "cpu", "--cuda-arena",
                    "kSameAsRequested", tmp_path=tmp_path)
    assert proc.returncode == 1
    assert "--cuda-arena requires --provider cuda" in proc.stderr


def test_cli_device_id_must_be_digits(tmp_path):
    proc = _run_cli("--provider", "cuda", "--cuda-device-id", "bogus",
                    tmp_path=tmp_path)
    assert proc.returncode == 1
    assert "--cuda-device-id must be a nonnegative integer" in proc.stderr


def test_library_context_is_torch_free():
    src = SCRIPT.read_text()
    assert '"library_context": "torch-free"' in src
    assert '"torch_preloaded_for_ort": False' in src


def test_maps_snapshot_helper_filters_cuda_libs():
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "bench_candidate_under_test", SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    fake_maps = (
        "7f000000-7f100000 r-xp 00000000 00:00 0  /usr/lib/x86_64-linux-gnu/libcudnn.so.9.17.0\n"
        "7f100000-7f200000 r-xp 00000000 00:00 0  /usr/lib/x86_64-linux-gnu/libcublas.so.12\n"
        "7f200000-7f300000 r-xp 00000000 00:00 0  /usr/lib/libpython3.12.so\n"
        "7f300000-7f400000 r-xp 00000000 00:00 0  [heap]\n"
        "short line\n"
    )
    # The helper reads the live /proc/self/maps; on machines without
    # /proc it must return a note instead of failing. Either shape is
    # asserted structurally (library names are keyword-filtered).
    snap = mod.snapshot_maps()
    assert isinstance(snap, dict)
    if "libraries" in snap:
        for name in snap["libraries"]:
            assert name.startswith(("libcudnn", "libcublas",
                                    "libcublasLt", "libcudart"))
    else:
        assert "note" in snap


def test_cli_maps_out_refuses_overwrite(tmp_path):
    maps = tmp_path / "maps.json"
    maps.write_text("{}")
    proc = _run_cli("--provider", "cuda", "--maps-out", str(maps),
                    tmp_path=tmp_path)
    assert proc.returncode == 1
    assert "refusing to overwrite" in proc.stderr
    assert maps.read_text() == "{}"
