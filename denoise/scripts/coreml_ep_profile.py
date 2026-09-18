"""Short CoreML-EP execution-state diagnostic (not a benchmark).

One process, SAME reference bundle/tile as bench_mac.py: explicit fresh
cache dir, ProfileComputePlan=1, session init + two sequential predicts.
Records at each stage: wall time, host RSS, load average, vm_stat/swap
snapshot, and cache-dir file inventory (count/bytes/mtimes) to verify
compile-cache reuse claims. ORT profiling enabled; compute-plan placement
is logged by the EP to stderr (capture it in the shell).

Run B (same cache dir, new process) measures init separately for a
cache-hit comparison. All paths are argv. Diagnostic only.
"""
import argparse
import json
import os
import resource
import subprocess
import sys
import time
from pathlib import Path


def snapshot():
    s = {"t": round(time.monotonic(), 2),
         "loadavg": list(os.getloadavg()),
         "rss_mb": round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
                         / (1024 * 1024), 1)}
    try:
        s["vm_stat"] = subprocess.run(
            ["vm_stat"], capture_output=True, text=True,
            timeout=30).stdout.strip().splitlines()[-6:]
    except Exception as exc:
        s["vm_stat"] = f"unavailable: {exc}"
    try:
        s["swapusage"] = subprocess.run(
            ["sysctl", "-n", "vm.swapusage"], capture_output=True, text=True,
            timeout=30).stdout.strip()
    except Exception as exc:
        s["swapusage"] = f"unavailable: {exc}"
    try:
        s["thermal"] = subprocess.run(
            ["pmset", "-g", "therm"], capture_output=True, text=True,
            timeout=30).stdout.strip().splitlines()[:6]
    except Exception as exc:
        s["thermal"] = f"unavailable: {exc}"
    return s


def cache_inventory(cache_dir):
    files = []
    for p in Path(cache_dir).rglob("*"):
        if p.is_file():
            st = p.stat()
            files.append({"rel": str(p.relative_to(cache_dir)),
                          "bytes": st.st_size, "mtime": int(st.st_mtime)})
    files.sort(key=lambda r: r["rel"])
    return {"count": len(files),
            "bytes": sum(f["bytes"] for f in files), "files": files}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bundle", required=True)
    ap.add_argument("--fixtures", required=True)
    ap.add_argument("--tile-idx", type=int, default=0)
    ap.add_argument("--cache-dir", required=True)
    ap.add_argument("--predicts", type=int, default=2)
    ap.add_argument("--out", required=True)
    ap.add_argument("--intra-op", type=int, default=0,
                    help="explicit intra-op thread count (0 = ORT default)")
    ap.add_argument("--no-spin", action="store_true",
                    help="disable intra/inter-op thread spinning (diagnostic only)")
    ns = ap.parse_args()
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    import numpy as np
    import onnxruntime as ort

    from rapidraw_denoise.metrics import tile_metrics

    rep = {"bundle": ns.bundle, "onnxruntime": ort.__version__,
           "providers_available": ort.get_available_providers(),
           "stages": {}}
    Path(ns.cache_dir).mkdir(parents=True, exist_ok=True)
    rep["stages"]["before"] = snapshot()
    rep["cache_before"] = cache_inventory(ns.cache_dir)
    with np.load(Path(ns.fixtures) / "tiles" / f"tile-{ns.tile_idx:02d}.npz",
                 allow_pickle=False) as f:
        x = np.ascontiguousarray(f["input"])[0]
        ref = np.ascontiguousarray(f["output"])[0]
    opts = ort.SessionOptions()
    opts.log_severity_level = 0
    opts.enable_profiling = True
    if ns.intra_op:
        opts.intra_op_num_threads = ns.intra_op
    if ns.no_spin:
        opts.add_session_config_entry("session.intra_op.allow_spinning", "0")
        opts.add_session_config_entry("session.inter_op.allow_spinning", "0")
    rep["session_options_override"] = {"intra_op_num_threads": ns.intra_op,
                                       "spinning_disabled": ns.no_spin}
    provider_options = {"ModelFormat": "MLProgram",
                        "MLComputeUnits": "CPUAndGPU",
                        "RequireStaticInputShapes": "1",
                        "EnableOnSubgraphs": "0",
                        "AllowLowPrecisionAccumulationOnGPU": "0",
                        "ProfileComputePlan": "1",
                        "ModelCacheDirectory": str(Path(ns.cache_dir).resolve())}
    t0 = time.monotonic()
    sess = ort.InferenceSession(str(Path(ns.bundle) / "model.onnx"),
                                sess_options=opts,
                                providers=["CoreMLExecutionProvider"],
                                provider_options=[provider_options])
    rep["session_init_s"] = time.monotonic() - t0
    rep["providers"] = sess.get_providers()
    name = sess.get_inputs()[0].name
    rep["stages"]["after_init"] = snapshot()
    rep["cache_after_init"] = cache_inventory(ns.cache_dir)
    preds = []
    for k in range(ns.predicts):
        t1 = time.monotonic()
        y = sess.run(None, {name: np.ascontiguousarray(x[None])})[0]
        dt = time.monotonic() - t1
        preds.append(round(dt, 3))
        rep["stages"][f"after_predict_{k+1}"] = snapshot()
    rep["predict_s_ordered"] = preds
    rep["cache_after_predicts"] = cache_inventory(ns.cache_dir)
    try:
        rep["profile_file"] = sess.end_profiling()
    except Exception as exc:
        rep["profile_file"] = f"unavailable: {exc}"
    m = tile_metrics("coreml-ep-profile", y, ref[None] if y.ndim == 4 else ref)
    rep["parity"] = {k: m[k] for k in ("max_abs_err", "pass")}
    Path(ns.out).write_text(json.dumps(rep, indent=2) + "\n")
    print(json.dumps({"init_s": round(rep["session_init_s"], 1),
                      "predicts_s": preds, "parity_pass": m["pass"],
                      "cache_files_after": rep["cache_after_predicts"]["count"]},
                     indent=2))
    print(f"wrote {ns.out}")


if __name__ == "__main__":
    main()
