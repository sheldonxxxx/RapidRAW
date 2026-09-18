"""Candidate-bundle CUDA benchmark (torch-free process).

Benchmarks one ONNX bundle with NumPy-in/NumPy-out timing only: session
init, 3 warm-up + 10 measured tile runs (np.median / np.quantile-linear
P95), ensemble-1 xN full assemblies + one ensemble-4 on the representative
photo. Imports numpy/scipy/onnxruntime only; asserts Torch was never
imported. One process per configuration; env fixed at launch.

Usage: bench_candidate.py --bundle DIR --fixtures DIR --out PATH
       [--provider cuda] [--optimize] [--photo portrait] [--repeats-e1 3]
       [--skip-e4]
"""
import argparse
import json
import resource
import subprocess
import sys
import time
from pathlib import Path

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
    ap.add_argument("--bundle", required=True)
    ap.add_argument("--fixtures", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--provider", default="cuda", choices=("cuda", "cpu"))
    ap.add_argument("--optimize", action="store_true",
                    help="Enable ORT graph optimizations (vs controlled off)")
    ap.add_argument("--io-binding", action="store_true",
                    help="Use preallocated reusable device buffers (CUDA only)")
    ap.add_argument("--tf32", action="store_true",
                    help="FAST_EXPERIMENTAL only: CUDA TF32 on (labels the run "
                    "experimental; never a strict pass)")
    ap.add_argument("--photo", default="portrait")
    ap.add_argument("--repeats-e1", type=int, default=3)
    ap.add_argument("--skip-e4", action="store_true")
    ap.add_argument("--torch-prime", action="store_true",
                    help="Diagnostic only: import torch and touch the CUDA "
                    "context/allocator before session creation (mimics the "
                    "older bench_v2 process state). Recorded, never default.")
    ns = ap.parse_args()
    out_path = Path(ns.out)
    if out_path.exists():
        print(json.dumps({"status": "error",
                          "error": f"refusing to overwrite {out_path}"}),
              file=sys.stderr)
        return 1
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    from rapidraw_denoise.noise import NoiseProfile
    from rapidraw_denoise.onnx_backend import OnnxTilePredictor
    from rapidraw_denoise.pipeline import denoise_with_predictor

    fx = Path(ns.fixtures)
    # Native packed-RAW input + noise profile mirror the closeout bench.
    native_dir = Path(f"/tmp/nlx-native/{ns.photo}")
    req = json.load(open(native_dir / "request.json"))
    photo = np.fromfile(native_dir / "input.f32",
                        dtype="<f4").reshape(tuple(req["shape"]))
    meta = json.load(open(fx / "metadata.json"))
    profile = NoiseProfile(**meta["noise_profile"])
    with np.load(fx / "tiles/tile-00.npz", allow_pickle=False) as f:
        tile8 = np.ascontiguousarray(f["input"])[0]

    rep = {"bundle": ns.bundle, "provider": ns.provider,
           "optimize": ns.optimize, "photo": ns.photo,
           "torch_prime": ns.torch_prime,
           "torch_imported_at_start": "torch" in sys.modules,
           "smi_before": smi()}
    if ns.torch_prime:
        import torch  # noqa: diagnostic path only
        torch.cuda.init()
        rep["torch_cuda_prime_alloc_B"] = torch.cuda.max_memory_allocated()
    t0 = time.monotonic()
    pred = OnnxTilePredictor(ns.bundle, provider=ns.provider,
                             optimize=ns.optimize,
                             io_binding=ns.io_binding,
                             use_tf32=ns.tf32)
    if ns.tf32:
        rep["precision_policy"] = ("FAST_EXPERIMENTAL tf32 (not strict; "
                                   "gates must be reported separately)")
    rep["session_init_s"] = time.monotonic() - t0
    info = pred.execution_info()
    rep["providers"] = info["provider_actual"]
    rep["provider_options_effective"] = info["provider_options_effective"]
    rep["fallback_disabled"] = info["fallback_disabled"]
    rep["graph_optimizations"] = info["graph_optimizations"]
    rep["io_binding"] = info["io_binding"]
    import onnxruntime as ort
    rep["onnxruntime"] = ort.__version__

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

    rep["full_e1_wall_s_runs"] = []
    for r in range(ns.repeats_e1):
        t1 = time.monotonic()
        out, _, _ = denoise_with_predictor(photo, pred, profile, 320, 64, 1)
        wall = time.monotonic() - t1
        assert out.shape == photo.shape and np.isfinite(out).all()
        rep["full_e1_wall_s_runs"].append(wall)
        print(f"e1 run{r}: wall={wall:.1f}s", flush=True)
    if not ns.skip_e4:
        t1 = time.monotonic()
        out, _, _ = denoise_with_predictor(photo, pred, profile, 320, 64, 4)
        wall = time.monotonic() - t1
        assert out.shape == photo.shape and np.isfinite(out).all()
        rep["full_e4_wall_s"] = wall
        print(f"e4: wall={wall:.1f}s", flush=True)
    rep["torch_imported_at_end"] = "torch" in sys.modules
    if not ns.torch_prime:
        assert "torch" not in sys.modules, "torch must not be imported on this path"
    rep["torch_vram_alloc_B"] = None
    rep["torch_vram_reserved_B"] = None
    rep["vram_note"] = "ORT VRAM not measured; no Torch in this process"
    rep["rss_mb"] = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024
    rep["smi_after"] = smi()
    out_path.write_text(json.dumps(rep, indent=2) + "\n")
    print(f"wrote {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
