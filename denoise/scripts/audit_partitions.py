"""Partition audit for one ONNX bundle on one provider (diagnostic only).

Runs a single real tile with ORT profiling enabled, then counts node
providers/ops with the shared profile_audit implementation. Answers the
CUDA-Graph prerequisite (all nodes on CUDA?) and quantifies CPU-resident
nodes / host copies for a candidate graph. Makes no acceptance claims.

Usage: audit_partitions.py --bundle DIR --fixtures DIR [--provider cuda]
       [--tile-idx 0] [--out PATH]
"""
import argparse
import json
import sys
import tempfile
from pathlib import Path

import numpy as np


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bundle", required=True)
    ap.add_argument("--fixtures", required=True)
    ap.add_argument("--provider", default="cuda", choices=("cuda", "cpu"))
    ap.add_argument("--tile-idx", type=int, default=0)
    ap.add_argument("--out", required=True)
    ns = ap.parse_args()
    out_path = Path(ns.out)
    if out_path.exists():
        print(json.dumps({"status": "error",
                          "error": f"refusing to overwrite {out_path}"}),
              file=sys.stderr)
        return 1
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    import onnxruntime as ort
    from rapidraw_denoise.profile_audit import audit_profile

    manifest = json.loads(open(f"{ns.bundle}/manifest.json").read())
    with np.load(Path(ns.fixtures) / "tiles" / f"tile-{ns.tile_idx:02d}.npz",
                 allow_pickle=False) as f:
        x = np.ascontiguousarray(f["input"])
    requested = {"cuda": "CUDAExecutionProvider",
                 "cpu": "CPUExecutionProvider"}[ns.provider]
    if requested not in ort.get_available_providers():
        print(json.dumps({"status": "error",
                          "error": f"{requested} unavailable"}),
              file=sys.stderr)
        return 1
    options = ort.SessionOptions()
    options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_DISABLE_ALL
    options.enable_profiling = True
    kwargs = {"sess_options": options, "providers": [requested]}
    if requested == "CUDAExecutionProvider":
        kwargs["provider_options"] = [{"use_tf32": "0"}]
    session = ort.InferenceSession(f"{ns.bundle}/model.onnx", **kwargs)
    session.disable_fallback()
    session.run([manifest["output_name"]], {manifest["input_name"]: x})
    profile_path = Path(session.end_profiling())
    audit = audit_profile(profile_path)
    result = {"bundle": ns.bundle, "provider": requested,
              "session_providers": session.get_providers(),
              "profile_file": str(profile_path),
              "node_events": audit["node_events"],
              "node_events_by_provider": audit["node_events_by_provider"],
              "memcpy_to_host_events_included": audit["memcpy_to_host_events_included"],
              "ops_by_provider": audit["ops_by_provider"],
              "cuda_graph_prerequisite_all_cuda":
                  audit["node_events_by_provider"].get("CUDAExecutionProvider", 0)
                  == audit["node_events"]
                  and audit["memcpy_to_host_events_included"] == 0,
              "timing_scope": audit["timing_scope"]}
    out_path.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({"node_events": result["node_events"],
                      "by_provider": result["node_events_by_provider"],
                      "memcpy_to_host": result["memcpy_to_host_events_included"],
                      "all_cuda": result["cuda_graph_prerequisite_all_cuda"]},
                     indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
