"""Verify the export-only static packed sampler against the loop sampler.

1. Loads the pinned checkpoint strictly (CPU), runs one real tile through
   the model while recording every deform_neighbourhood call site
   (features, offsets, neighbourhood), and compares loop vs packed outputs
   per site (bitwise + gate statistics).
2. Runs the full Torch pipeline over every fixture tile in the given
   fixture dirs with the packed sampler patched in (this process only) and
   checks each output against the fixture's direct eager output under the
   frozen tile gates.

Usage: verify_packed_sampler.py --checkpoint CKPT --fixtures DIR [DIR...]
       --report PATH
The pinned checkpoint may also come from NONLOCAL_ONNX_CKPT_PINNED; one of
the two is required.
Exit 0 = all sites bitwise-equal (or within gates) and all tiles pass.
"""
import argparse
import json
import os
import sys
from pathlib import Path

import numpy as np

REPO = Path(__file__).resolve().parent.parent.parent
CHECKPOINT_ENV = "NONLOCAL_ONNX_CKPT_PINNED"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--checkpoint",
                    help=f"Pinned CPU checkpoint; falls back to ${CHECKPOINT_ENV}")
    ap.add_argument("--fixtures", nargs="+", required=True)
    ap.add_argument("--report", required=True)
    args = ap.parse_args()
    checkpoint = args.checkpoint or os.environ.get(CHECKPOINT_ENV)
    if not checkpoint:
        ap.error(f"--checkpoint or {CHECKPOINT_ENV} is required")
    import torch

    from rapidraw_denoise.inference import TorchTilePredictor, load_model
    from rapidraw_denoise import metrics
    from rapidraw_denoise.static_packed_sampler import (
        SAMPLER_VERSION,
        cache_size,
        clear_cache,
        packed_deform_neighbourhood,
    )
    from rapidraw_denoise.vendor.nonlocalmf import network as network_mod
    from rapidraw_denoise.vendor.nonlocalmf import sampling as sampling_mod

    report_path = Path(args.report)
    if report_path.exists():
        print(json.dumps({"status": "error",
                          "error": f"refusing to overwrite {report_path}"}),
              file=sys.stderr)
        return 1
    if __import__("hashlib").sha256(
            Path(checkpoint).read_bytes()).hexdigest() != \
            "c16747d852b93a95908792cdbac901f89cca98e35b91ea7db6214de42fbd3cad":
        print(json.dumps({"status": "error",
                          "error": "checkpoint is not the pinned weights"}),
              file=sys.stderr)
        return 1
    model = load_model(checkpoint, device="cpu")
    model.eval()

    with np.load(Path(args.fixtures[0]) / "tiles/tile-00.npz",
                 allow_pickle=False) as f:
        probe = torch.from_numpy(np.ascontiguousarray(f["input"])[0]).unsqueeze(0)

    calls = []
    # network.py binds deform_neighbourhood directly at import; the export
    # clone is routed by rebinding that name in this process only (the
    # default forward path and other processes are untouched).
    orig = network_mod.deform_neighbourhood

    def recorder(x, offsets, **kw):
        out = sampling_mod.reference_sampling(x, offsets, **kw)
        calls.append({"x": x.detach().clone(), "offsets": offsets.detach().clone(),
                      "kwargs": dict(kw)})
        return out

    network_mod.deform_neighbourhood = recorder
    try:
        with torch.no_grad():
            ref_out = model(probe)
    finally:
        network_mod.deform_neighbourhood = orig
    assert len(calls) == 5, f"expected 5 sampling sites, got {len(calls)}"
    site_results = []
    all_bitwise = True
    with torch.no_grad():
        for i, call in enumerate(calls):
            packed = packed_deform_neighbourhood(
                call["x"], call["offsets"], **call["kwargs"])
            loop = sampling_mod.reference_sampling(
                call["x"], call["offsets"], **call["kwargs"])
            bitwise = bool(torch.equal(packed, loop))
            maxdiff = float((packed - loop).abs().max())
            all_bitwise &= bitwise
            site_results.append({
                "site": i,
                "feature_shape": list(call["x"].shape),
                "neighbourhood": list(call["kwargs"]["neighbourhood_size"]),
                "bitwise_equal": bitwise,
                "max_abs_diff": maxdiff,
            })
            print(f"site {i} {list(call['x'].shape)} nb={call['kwargs']['neighbourhood_size']}: "
                  f"bitwise={bitwise} maxdiff={maxdiff:.3g}", flush=True)
    clear_cache()

    # Full-pipeline parity over every fixture tile with the packed sampler.
    tile_files = []
    for fx in args.fixtures:
        fx = Path(fx)
        found = sorted((fx / "tiles").glob("tile-*.npz"))
        if not found:
            raise ValueError(f"no tiles in {fx}")
        tile_files.extend(found)
    sampling_mod.deform_neighbourhood = packed_deform_neighbourhood
    network_mod.deform_neighbourhood = packed_deform_neighbourhood
    try:
        pred = TorchTilePredictor(model)
        per_tile, failures = [], 0
        for fp in tile_files:
            with np.load(fp, allow_pickle=False) as f:
                x = np.ascontiguousarray(f["input"])[0]
                ref = np.ascontiguousarray(f["output"])[0]
            got = pred.predict(x)
            m = metrics.tile_metrics(str(fp), got[None], ref[None])
            per_tile.append({"fixture": str(fp), "pass": m["pass"],
                             "max_abs_err": m["max_abs_err"], "mae": m["mae"]})
            failures += not m["pass"]
    finally:
        sampling_mod.deform_neighbourhood = orig
        network_mod.deform_neighbourhood = orig
        clear_cache()

    report = {"status": "pass" if (all_bitwise and failures == 0) else "fail",
              "sampler_version": SAMPLER_VERSION,
              "checkpoint": checkpoint,
              "sites": site_results,
              "all_sites_bitwise": all_bitwise,
              "packed_module_cache_entries": cache_size(),
              "tiles_total": len(per_tile), "tiles_failed": failures,
              "per_tile": per_tile}
    report_path.write_text(json.dumps(report, indent=2) + "\n")
    print(f"sites bitwise: {all_bitwise}; tiles {len(per_tile) - failures}/{len(per_tile)}")
    return 0 if report["status"] == "pass" else 2


if __name__ == "__main__":
    raise SystemExit(main())
