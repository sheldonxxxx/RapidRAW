"""Single-backend packed-RAW benchmark (one process, fixed env, no mutation).

Usage: bench_v2.py {onnx-cuda,torch-native,torch-native-tf32off,torch-ref}
       [--repeats-e1 N] [--skip-e4]

Env (set at launch, NEVER mutated in-process): RAPIDRAW_DENOISE_SAMPLER,
TF32 flags. torch-native uses the process default (TF32 allowed: actual
production policy); torch-native-tf32off disables matmul/cudnn TF32 before
load for the equal-precision comparison; torch-ref additionally forces the
reference sampler. Records env snapshot + two-sided behavioral sampler
probe with invocation counters (reference binding must reproduce the
reference loop bitwise; native binding must differ from it; missing ext
fails loud). Saves ordered warm-up + measured samples
(median = np.median; P95 = np.quantile linear, both documented), session
init separately, full-assembly NumPy-in -> NumPy-out walls (3x ensemble-1
plus one ensemble-4 unless skipped), and scoped memory notes (Torch
allocator counters on torch runs only; ORT VRAM recorded null, never as
Torch counters).
"""
import argparse
import json
import os
import resource
import subprocess
import sys
import time

import numpy as np


def smi():
    try:
        out = subprocess.run(
            ["nvidia-smi",
             "--query-gpu=utilization.gpu,memory.used,memory.total",
             "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=30)
        return out.stdout.strip()
    except Exception as exc:
        return f"unavailable: {exc}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("backend", choices=("onnx-cuda", "torch-native",
                                       "torch-native-tf32off", "torch-ref"))
    ap.add_argument("--repeats-e1", type=int, default=3)
    ap.add_argument("--skip-e4", action="store_true")
    ns = ap.parse_args()
    backend = ns.backend

    import torch  # noqa: F401  (required by pipeline/noise; onnx path never calls it)
    from rapidraw_denoise.noise import NoiseProfile
    from rapidraw_denoise.pipeline import denoise_with_predictor

    if backend in ("torch-ref", "torch-native-tf32off"):
        # Controlled/equal-precision configuration, applied once before load.
        torch.backends.cuda.matmul.allow_tf32 = False
        torch.backends.cudnn.allow_tf32 = False
    env_snapshot = {
        "RAPIDRAW_DENOISE_SAMPLER": os.environ.get("RAPIDRAW_DENOISE_SAMPLER"),
        "cuda_matmul_tf32": torch.backends.cuda.matmul.allow_tf32,
        "cudnn_tf32": torch.backends.cudnn.allow_tf32,
        "torch": torch.__version__,
    }
    rep = {"backend": backend, "env_snapshot": env_snapshot,
           "smi_before": smi()}

    request = json.load(open("/tmp/nlx-native/portrait/request.json"))
    portrait = np.fromfile("/tmp/nlx-native/portrait/input.f32",
                           dtype="<f4").reshape(tuple(request["shape"]))
    meta = json.load(
        open("/tmp/nlx-fixtures/portrait-controlled-fp32/metadata.json"))
    profile = NoiseProfile(**meta["noise_profile"])
    with np.load("/tmp/nlx-fixtures/portrait-controlled-fp32/tiles/tile-00.npz",
                 allow_pickle=False) as f:
        tile8 = np.ascontiguousarray(f["input"])[0]

    if backend == "onnx-cuda":
        from rapidraw_denoise.onnx_backend import OnnxTilePredictor
        import onnxruntime as ort
        rep["onnxruntime"] = ort.__version__
        t0 = time.monotonic()
        pred = OnnxTilePredictor("/tmp/nlx-model/bundle-pinned-320-fp32",
                                 provider="cuda")
        rep["session_init_s"] = time.monotonic() - t0
        info = pred.execution_info()
        rep["providers"] = info["provider_actual"]
        rep["fallback_disabled"] = info["fallback_disabled"]
        rep["sampler_probe"] = "n/a (ONNX graph; reference-sampler export)"
    else:
        from rapidraw_denoise.inference import TorchTilePredictor, load_model
        from rapidraw_denoise.vendor.nonlocalmf import sampling as sampling_mod
        # Two-sided behavioral probe with invocation counters BEFORE timed runs.
        calls = {"deform": 0, "reference": 0}
        orig_deform = sampling_mod.deform_neighbourhood
        orig_ref = sampling_mod.reference_sampling

        def counting_deform(*a, **k):
            calls["deform"] += 1
            return orig_deform(*a, **k)

        def counting_ref(*a, **k):
            calls["reference"] += 1
            return orig_ref(*a, **k)

        sampling_mod.deform_neighbourhood = counting_deform
        sampling_mod.reference_sampling = counting_ref
        try:
            torch.manual_seed(123)
            px = torch.randn(1, 2, 9, 11).to("cuda")
            po = torch.randn(1, 18, 9, 11).to("cuda") * 0.3
            try:
                got = sampling_mod.deform_neighbourhood(
                    px, po, neighbourhood_size=(3, 3), stride=1, padding=(1, 1),
                    dilation=1, offset_groups=1)
            except ModuleNotFoundError as exc:
                rep["sampler_probe"] = f"EXT-MISSING-FAIL: {exc}"
                raise
            want = sampling_mod.reference_sampling(px, po, (3, 3), padding=(1, 1))
            equal = bool(torch.equal(got, want))
        finally:
            sampling_mod.deform_neighbourhood = orig_deform
            sampling_mod.reference_sampling = orig_ref
        rep["sampler_probe_calls"] = calls
        # Mechanism corroboration: in reference mode deform_neighbourhood
        # delegates to reference_sampling internally (2 counted reference
        # calls: delegated + explicit probe); in native mode the only
        # reference call is the explicit probe (deform took the ext path).
        expected_ref_calls = {"torch-native": 1, "torch-native-tf32off": 1,
                              "torch-ref": 2}[backend]
        assert calls["deform"] >= 1 and calls["reference"] == expected_ref_calls, calls
        rep["sampler_probe_bitwise_equal_to_reference"] = equal
        expected_equal = {"torch-native": False, "torch-native-tf32off": False,
                          "torch-ref": True}[backend]
        rep["sampler_probe"] = ("reference-binding" if equal
                                else "native-ext-binding")
        assert equal == expected_equal, rep["sampler_probe"]
        t0 = time.monotonic()
        model = load_model(
            "/mnt/data/rapidraw/denoise-research/models/nonlocal-raw-weights.pt",
            device="cuda")
        rep["model_load_s"] = time.monotonic() - t0
        pred = TorchTilePredictor(model)

    warm, meas = [], []
    for _ in range(3):
        t = time.monotonic()
        pred.predict(tile8)
        warm.append((time.monotonic() - t) * 1000)
    for _ in range(10):
        t = time.monotonic()
        pred.predict(tile8)
        meas.append((time.monotonic() - t) * 1000)
    rep["warmup_ms_ordered"] = warm
    rep["measured_ms_ordered"] = list(meas)
    rep["median_ms"] = float(np.median(meas))
    rep["median_method"] = "np.median over 10 measured tile runs"
    rep["p95_ms"] = float(np.quantile(meas, 0.95, method="linear"))
    rep["p95_method"] = "np.quantile linear interpolation over 10 measured runs"
    if backend == "onnx-cuda":
        rep["torch_vram_alloc_B"] = None
        rep["torch_vram_reserved_B"] = None
        rep["vram_note"] = ("ORT VRAM not measured; Torch allocator counters "
                            "do not apply to the ONNX path")
    else:
        rep["torch_vram_alloc_B"] = torch.cuda.max_memory_allocated()
        rep["torch_vram_reserved_B"] = torch.cuda.max_memory_reserved()
    rep["rss_mb"] = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024

    rep["full_e1_wall_s_runs"] = []
    for r in range(ns.repeats_e1):
        t1 = time.monotonic()
        out, _, _ = denoise_with_predictor(portrait, pred, profile, 320, 64, 1)
        wall = time.monotonic() - t1
        assert out.shape == portrait.shape and np.isfinite(out).all()
        rep["full_e1_wall_s_runs"].append(wall)
        print(f"{backend} e1 run{r}: wall={wall:.1f}s", flush=True)
    if not ns.skip_e4:
        t1 = time.monotonic()
        out, _, _ = denoise_with_predictor(portrait, pred, profile, 320, 64, 4)
        wall = time.monotonic() - t1
        assert out.shape == portrait.shape and np.isfinite(out).all()
        rep["full_e4_wall_s"] = wall
        print(f"{backend} e4: wall={wall:.1f}s", flush=True)
    rep["smi_after"] = smi()
    out_name = f"/tmp/nlx-bench-v2-{backend}.json"
    with open(out_name, "w") as f:
        json.dump(rep, f, indent=2)
    print(f"wrote {out_name}")


if __name__ == "__main__":
    main()
