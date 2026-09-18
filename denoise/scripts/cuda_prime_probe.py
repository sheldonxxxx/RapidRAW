"""CUDA process-state probe: ORT-only vs Torch-import vs Torch+CUDA-init.

Fresh-process single-tile timing under identical session configuration
(CUDA EP, use_tf32=0, graph optimization off, same bundle/tile), with
cold totals that INCLUDE interpreter setup. Records loaded CUDA/cuDNN
library paths (Linux maps), threading env, and GPU operating conditions.

Modes: ort-only | torch-import | torch-cuda-init
Preload variant: run mode ort-only with LD_PRELOAD set externally; the
script records the preload env verbatim (no production change).

Usage: cuda_prime_probe.py --mode M --bundle DIR --fixtures DIR
  --photo portrait --tile-idx 0 [--out JSON]
"""
import argparse
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

T0 = time.monotonic()


def smi():
    try:
        p = subprocess.run(
            ["nvidia-smi",
             "--query-gpu=utilization.gpu,memory.used,clocks.sm,clocks.mem,"
             "power.draw,temperature.gpu",
             "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=30)
        return (p.stdout.strip() or None) if p.returncode == 0 else None
    except Exception as exc:
        return f"unavailable: {exc}"


def cuda_maps():
    libs = {}
    try:
        for line in open("/proc/self/maps").read().splitlines():
            m = re.search(r"/\S*?(lib(?:cudart|cublasLt?|cublas|cudnn(?:_[a-z0-9]+)?|torch_cuda|nvJitLink|nvrtc|c10_cuda|caffe2_nvrtc)\S*?\.so[\S]*)\s*$", line)
            if m:
                libs.setdefault(m.group(1).split(" ")[0], None)
        out = []
        for path in sorted(libs):
            try:
                st = os.stat(path)
                out.append({"path": path, "bytes": st.st_size,
                            "mtime": int(st.st_mtime)})
            except OSError:
                out.append({"path": path, "bytes": None, "mtime": None})
        return out
    except Exception as exc:
        return f"unavailable: {exc}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", required=True,
                    choices=("ort-only", "torch-import", "torch-cuda-init"))
    ap.add_argument("--bundle", required=True)
    ap.add_argument("--fixtures", required=True)
    ap.add_argument("--photo", required=True)
    ap.add_argument("--tile-idx", type=int, default=0)
    ap.add_argument("--out", default=None)
    ns = ap.parse_args()
    import numpy as np

    rep = {"mode": ns.mode, "bundle": ns.bundle,
           "ld_preload": os.environ.get("LD_PRELOAD"),
           "thread_env": {k: os.environ.get(k) for k in
                          ("OMP_NUM_THREADS", "MKL_NUM_THREADS",
                           "OPENBLAS_NUM_THREADS", "ORT_NUM_THREADS")},
           "smi_before": smi()}
    t_setup0 = time.monotonic()
    if ns.mode in ("torch-import", "torch-cuda-init"):
        import torch
        rep["torch"] = torch.__version__
        rep["torch_cuda"] = torch.version.cuda
        if ns.mode == "torch-cuda-init":
            torch.cuda.init()
            rep["torch_cuda_prime_alloc_B"] = torch.cuda.max_memory_allocated()
    rep["setup_s"] = time.monotonic() - t_setup0
    rep["smi_after_setup"] = smi()

    import onnxruntime as ort
    rep["onnxruntime"] = ort.__version__
    bundle = Path(ns.bundle)
    manifest = json.loads((bundle / "manifest.json").read_text())
    with np.load(Path(ns.fixtures) / "tiles" / f"tile-{ns.tile_idx:02d}.npz",
                 allow_pickle=False) as f:
        x = np.ascontiguousarray(f["input"])[0]
    assert x.dtype == np.float32 and x.shape == (8, 320, 320)
    opts = ort.SessionOptions()
    opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_DISABLE_ALL
    t1 = time.monotonic()
    sess = ort.InferenceSession(
        str(bundle / "model.onnx"), sess_options=opts,
        providers=["CUDAExecutionProvider"],
        provider_options=[{"use_tf32": "0"}])
    rep["session_init_s"] = time.monotonic() - t1
    rep["providers"] = sess.get_providers()
    if "CUDAExecutionProvider" not in rep["providers"]:
        print(json.dumps({"status": "error", "providers": rep["providers"],
                          "error": "CUDA provider not taken; refusing CPU fallback"}))
        return 1
    name = sess.get_inputs()[0].name
    t2 = time.monotonic()
    first = sess.run(None, {name: np.ascontiguousarray(x[None])})[0]
    rep["first_predict_s"] = time.monotonic() - t2
    assert first.shape == (1, 4, 320, 320) and np.isfinite(first).all()
    meas = []
    for _ in range(3):
        t = time.monotonic()
        sess.run(None, {name: np.ascontiguousarray(x[None])})
        meas.append((time.monotonic() - t) * 1000)
    rep["measured_ms_ordered"] = meas
    rep["median_ms"] = float(np.median(meas))
    rep["cuda_libs"] = cuda_maps()
    rep["smi_after"] = smi()
    rep["cold_total_s"] = time.monotonic() - T0
    out = ns.out or f"/tmp/nlx-primeprobe-{ns.mode}.json"
    Path(out).write_text(json.dumps(rep, indent=2) + "\n")
    print(json.dumps({"mode": ns.mode, "init_s": round(rep["session_init_s"], 2),
                      "first_s": round(rep["first_predict_s"], 3),
                      "median_ms": round(rep["median_ms"], 1),
                      "cold_total_s": round(rep["cold_total_s"], 1)}, indent=2))
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
