"""macOS Apple-silicon benchmark for the pinned Nonlocal ONNX bundle.

One process per config (argv: ort-cpu | coreml-cpu-gpu | coreml-all).
Each run records: session init (cold compile for CoreML), first predict,
3 warm-up + 10 measured tile runs (np.median / np.quantile-linear P95),
one real-tile parity check against the fixture's direct output under the
frozen gates, effective vs ORT-reported provider options, session
providers, and host RSS. No Torch import on the ORT paths.

Usage: bench_mac.py {ort-cpu,coreml-cpu-gpu,coreml-all} [--tile-idx N]
Env (fixed at launch): NONLOCAL_ONNX_BUNDLE, NONLOCAL_ONNX_FIXTURES.
"""
import argparse
import json
import os
import resource
import sys
import time
from pathlib import Path

import numpy as np

REPO = Path(__file__).resolve().parent.parent.parent
BUNDLE = Path(os.environ.get(
    "NONLOCAL_ONNX_BUNDLE",
    REPO / "nonlocal-onnx-evidence/model/bundle-pinned-320-fp32"))
FIXTURES = Path(os.environ.get(
    "NONLOCAL_ONNX_FIXTURES",
    REPO / "nonlocal-onnx-evidence/fixtures/portrait-controlled-fp32"))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("config", choices=("ort-cpu", "coreml-cpu-gpu", "coreml-all"))
    ap.add_argument("--tile-idx", type=int, default=0)
    ap.add_argument("--out", default=None)
    ns = ap.parse_args()

    from rapidraw_denoise.onnx_backend import OnnxTilePredictor

    with np.load(FIXTURES / "tiles" / f"tile-{ns.tile_idx:02d}.npz",
                 allow_pickle=False) as f:
        x = np.ascontiguousarray(f["input"])[0]
        ref = np.ascontiguousarray(f["output"])[0]
    assert x.dtype == np.float32 and x.shape == (8, 320, 320)

    if ns.config == "ort-cpu":
        kwargs = {"provider": "cpu"}
    elif ns.config == "coreml-cpu-gpu":
        kwargs = {"provider": "coreml",
                  "provider_options": {"MLComputeUnits": "CPUAndGPU"}}
    else:
        kwargs = {"provider": "coreml",
                  "provider_options": {"MLComputeUnits": "ALL"}}
    rep = {"config": ns.config, "bundle": str(BUNDLE),
           "fixture": f"tile-{ns.tile_idx:02d}"}
    t0 = time.monotonic()
    pred = OnnxTilePredictor(BUNDLE, **kwargs)
    rep["session_init_s"] = time.monotonic() - t0
    info = pred.execution_info()
    rep["provider_requested"] = info["provider_requested"]
    rep["provider_actual"] = info["provider_actual"]
    rep["provider_options_effective"] = info["provider_options_effective"]
    rep["provider_options_reported"] = info["provider_options_reported"]
    rep["fallback_disabled"] = info["fallback_disabled"]
    rep["onnxruntime"] = info["onnxruntime"]

    t1 = time.monotonic()
    first = pred.predict(x)
    rep["first_predict_s"] = time.monotonic() - t1
    assert first.shape == (4, 320, 320) and np.isfinite(first).all()

    warm, meas = [], []
    for _ in range(3):
        t = time.monotonic()
        pred.predict(x)
        warm.append((time.monotonic() - t) * 1000)
    for _ in range(10):
        t = time.monotonic()
        pred.predict(x)
        meas.append((time.monotonic() - t) * 1000)
    rep["warmup_ms_ordered"] = warm
    rep["measured_ms_ordered"] = list(meas)
    rep["median_ms"] = float(np.median(meas))
    rep["p95_ms"] = float(np.quantile(meas, 0.95, method="linear"))

    # One real-tile parity check under the frozen gates.
    from rapidraw_denoise.metrics import tile_metrics
    m = tile_metrics(f"mac-{ns.config}", first[None], ref[None])
    rep["parity"] = {k: m[k] for k in (
        "max_abs_err", "mae", "p99_abs_err", "elementwise_violations",
        "signed_mean_err_per_channel", "mean_abs_channel_bias",
        "consistency_problems", "pass")}
    rep["torch_imported"] = "torch" in sys.modules
    rep["rss_mb"] = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / (1024 * 1024)
    out = ns.out or f"/tmp/nlx-bench-mac-{ns.config}.json"
    Path(out).write_text(json.dumps(rep, indent=2) + "\n")
    print(json.dumps({"config": ns.config, "init_s": round(rep["session_init_s"], 1),
                      "first_s": round(rep["first_predict_s"], 2),
                      "median_ms": round(rep["median_ms"], 1),
                      "p95_ms": round(rep["p95_ms"], 1),
                      "parity_pass": rep["parity"]["pass"],
                      "providers": rep["provider_actual"]}, indent=2))
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
