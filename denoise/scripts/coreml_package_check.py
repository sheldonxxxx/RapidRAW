"""Validate a converted CoreML .mlpackage on real fixture tiles (diagnostic).

Loads the package with coremltools (native CoreML prediction on this Mac),
runs fixture input tiles, and scores outputs with the frozen tile_metrics
gates against each fixture's direct output. One tile by default
(portrait tile-00); --all runs all 18 tiles across the three photos.
Records per-tile latency. No production/adapter change; the package under
test is identified by its manifest hash.

Usage: coreml_package_check.py --package DIR --fixtures-root DIR [--all]
Env (fixed at launch): none; all paths are argv.
"""
import argparse
import json
import sys
import time
from pathlib import Path

PHOTOS = ("portrait", "landscape", "phone")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--package", required=True)
    ap.add_argument("--fixtures-root", required=True)
    ap.add_argument("--all", action="store_true")
    ns = ap.parse_args()
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    import warnings
    warnings.filterwarnings("ignore")
    import numpy as np

    from rapidraw_denoise.metrics import tile_metrics

    pkg = Path(ns.package)
    manifest = json.loads((pkg / "manifest.json").read_text())
    try:
        import coremltools as ct
        t0 = time.monotonic()
        ml = ct.models.MLModel(str(pkg / manifest["artifact"]))
        load_s = time.monotonic() - t0
    except Exception as exc:
        print(json.dumps({"status": "error",
                          "error": f"{type(exc).__name__}: {exc}"}))
        return 1
    rep = {"status": "ok", "package_sha256": manifest["package_sha256"],
           "coremltools": ct.__version__, "load_s": load_s,
           "input": manifest["input"], "output": manifest["output"]}
    try:
        in_name = manifest["input"]["name"]
        rows = []
        root = Path(ns.fixtures_root)
        for photo in PHOTOS:
            tdir = root / f"{photo}-controlled-fp32" / "tiles"
            idxs = range(6) if ns.all else (0,)
            for i in idxs:
                with np.load(tdir / f"tile-{i:02d}.npz",
                             allow_pickle=False) as f:
                    x = np.ascontiguousarray(f["input"])[0]
                    ref = np.ascontiguousarray(f["output"])[0]
                t1 = time.monotonic()
                out = ml.predict({in_name: np.ascontiguousarray(x[None])})
                dt = time.monotonic() - t1
                y = np.asarray(out[manifest["output"]["name"]
                                   ] if manifest["output"]["name"] in out
                               else out[list(out.keys())[0]])
                if y.shape[0] == 1:
                    y = y[0]
                m = tile_metrics(f"coreml-{photo}-{i:02d}", y[None], ref[None])
                rows.append({"photo": photo, "tile": i, "predict_s": dt,
                             "max_abs_err": m["max_abs_err"],
                             "pass": m["pass"]})
        rep["tiles"] = len(rows)
        rep["rows"] = rows
        rep["worst_max"] = max(r["max_abs_err"] for r in rows)
        rep["all_pass"] = all(r["pass"] for r in rows)
    except Exception as exc:
        import traceback
        rep.update({"status": "error", "error": f"{type(exc).__name__}: {exc}",
                    "traceback_tail": traceback.format_exc()[-1500:]})
        print(json.dumps(rep, indent=2))
        return 1
    print(json.dumps(rep, indent=2))
    return 0 if rep.get("all_pass") else 1


if __name__ == "__main__":
    raise SystemExit(main())
