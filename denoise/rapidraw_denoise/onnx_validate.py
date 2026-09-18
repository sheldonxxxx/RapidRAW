"""Validate a Nonlocal ONNX bundle against saved CPU-reference fixtures.

Compares ORT output with the fixture's direct unclipped eager output on every
fixture tile independently (never averaged away) under the frozen gates:

  shape/dtype exact; finite required
  |actual-reference| <= 1e-4 + 1e-4*|reference| elementwise
  MAE <= 1e-5; P99 abs err <= 1e-4; per-channel signed mean err <= 1e-5

Session construction (manifest lineage, model hash, provider availability,
``disable_fallback``, live session metadata) is delegated to the single
``OnnxTilePredictor`` implementation, so this entry point enforces the same
contract as the pipeline. Fixture arrays are loaded through the shared
original-dtype-first loader. Exit codes: 0 = all pass, 2 = gate failures,
1 = tool/invalid error. Errors are durably saved to ``--report`` when its
parent exists and the path itself is new (never overwritten).
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

from .metrics import (
    CHANNEL_BIAS_GATE,
    MAE_GATE,
    P99_GATE,
    tile_metrics,
)
from .onnx_backend import OnnxTilePredictor, sha256_file

ATOL = 1e-4
RTOL = 1e-4
PRODUCTION_TILE = 320


def build_arg_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--bundle", type=Path, required=True,
                   help="Bundle dir with model.onnx + manifest.json")
    p.add_argument("--fixtures", type=Path, required=True, action="append",
                   help="Fixture dir(s) from capture_reference.py; repeatable")
    p.add_argument("--provider", choices=["cpu", "cuda", "coreml"], default="cpu")
    p.add_argument("--optimize", action="store_true",
                   help="Enable ORT graph optimizations (separate report identity)")
    p.add_argument("--use-tf32", action="store_true",
                   help="FAST_EXPERIMENTAL only: CUDA TF32 on. Labels the report "
                   "experimental; never a strict pass")
    p.add_argument("--allow-diagnostic-shape", action="store_true",
                   help="Permit validating a non-320 diagnostic bundle (labelled only)")
    p.add_argument("--report", type=Path, required=True,
                   help="New JSON report file to write (parent must exist)")
    return p


def _save_error(report_path: Path, message: str) -> None:
    # Durable failure report: only when the destination is a new path whose
    # parent exists. Never overwrite, never create parent dirs implicitly.
    if not report_path.exists() and report_path.parent.is_dir():
        report_path.write_text(
            json.dumps({"status": "error", "error": message,
                        "report": str(report_path)}, indent=2) + "\n")


def main(argv: list[str] | None = None) -> int:
    args = build_arg_parser().parse_args(argv)
    try:
        bundle = args.bundle.resolve()
        report_path = args.report.resolve()
        if report_path.exists():
            raise ValueError(f"--report already exists (never overwrite): {report_path}")
        predictor = OnnxTilePredictor(
            bundle, provider=args.provider,
            optimize=args.optimize,
            allow_diagnostic_shape=args.allow_diagnostic_shape,
            use_tf32=args.use_tf32)
        tile = predictor.tile
        if tile != PRODUCTION_TILE and not args.allow_diagnostic_shape:
            raise ValueError(f"Bundle tile {tile} is diagnostic; "
                             "pass --allow-diagnostic-shape for a labelled smoke check only")

        fixture_files: list[Path] = []
        for fx in args.fixtures:
            fx = fx.resolve()
            if not fx.is_dir():
                raise ValueError(
                    f"Requested fixture directory missing or not a directory: {fx}")
            found = sorted((fx / "tiles").glob("tile-*.npz"))
            if not found:
                raise ValueError(
                    f"Requested fixture directory contains no tiles: {fx}/tiles/")
            fixture_files.extend(found)
        resolved = [fp.resolve() for fp in fixture_files]
        duplicates = sorted({str(p) for p in resolved if resolved.count(p) > 1})
        if duplicates:
            raise ValueError(
                f"Duplicate fixture files selected (same directory given twice "
                f"or aliasing paths): {duplicates}")
        fixture_files = resolved
        per_fixture = []
        failures = 0
        for fp in fixture_files:
            # Each NPZ is loaded once; the exact batched contract is enforced
            # on the ORIGINAL arrays before batch zero is selected, so an
            # extra input batch is rejected even when batch zero is valid.
            with np.load(fp, allow_pickle=False) as f:
                if not {"input", "output"}.issubset(f.files):
                    raise ValueError(f"Fixture {fp} must contain input+output arrays")
                x = np.ascontiguousarray(f["input"])
                ref = np.ascontiguousarray(f["output"])
            for arr, what, want in ((x, "input", (1, 8, tile, tile)),
                                    (ref, "output", (1, 4, tile, tile))):
                if arr.dtype != np.dtype("float32"):
                    raise ValueError(
                        f"Fixture {fp} {what} has original dtype {arr.dtype}; "
                        "only float32 accepted")
                if arr.shape != want:
                    raise ValueError(
                        f"Fixture {fp} {what} shape {arr.shape} != exact {want} "
                        "(a second batch is rejected even if batch zero is valid)")
            if not np.isfinite(x).all() or not np.isfinite(ref).all():
                raise ValueError(f"Fixture {fp} contains non-finite values")
            # One session reused across all tiles; provider placement was
            # verified at construction and re-verified on every predict call.
            actual = predictor.predict(x[0])
            actual4d = actual[None]
            ref4d = ref
            entry: dict = {"fixture": str(fp), "shape": list(actual4d.shape)}
            # Shared metric implementation (4D [N,C,H,W]; channel axis 1).
            # Any internal inconsistency rejects the entry.
            m = tile_metrics(str(fp), actual4d, ref4d)
            entry.update({k: v for k, v in m.items() if k != "comparison"})
            data_range = float(ref.astype("float64").max()
                               - ref.astype("float64").min())
            entry["psnr_data_range"] = data_range
            entry["psnr_db"] = (
                float(20 * np.log10(data_range / entry["rmse"]))
                if entry["rmse"] > 0 and data_range > 0 else None
            )
            reasons: list[str] = []
            if entry["elementwise_violations"]:
                loc = entry["max_abs_err_location_nchw"]
                worst = entry["max_abs_err"]
                reasons.append(
                    f"{entry['elementwise_violations']} elementwise violations "
                    f"(max {worst:.3g} at {loc})"
                )
            if entry["mae"] > MAE_GATE:
                reasons.append(f"MAE {entry['mae']:.3g} > {MAE_GATE}")
            if entry["p99_abs_err"] > P99_GATE:
                reasons.append(f"P99 {entry['p99_abs_err']:.3g} > {P99_GATE}")
            for c, bias in enumerate(entry["signed_mean_err_per_channel"]):
                if abs(bias) > CHANNEL_BIAS_GATE:
                    reasons.append(
                        f"channel {c} signed mean {bias:.3g} > {CHANNEL_BIAS_GATE}")
            for problem in entry["consistency_problems"]:
                reasons.append(f"consistency: {problem}")
            entry["pass"] = not reasons
            entry["reasons"] = reasons
            if reasons:
                failures += 1
            per_fixture.append(entry)

        info = predictor.execution_info()
        report = {
            "status": "pass" if failures == 0 else "fail",
            "bundle": str(bundle),
            "model_sha256": sha256_file(bundle / "model.onnx"),
            "manifest": predictor.manifest,
            "provider_requested": info["provider_requested"],
            "provider_actual": info["provider_actual"],
            "fallback_disabled": info["fallback_disabled"],
            "session_input": info["session_input"],
            "session_output": info["session_output"],
            "available_providers": __import__("onnxruntime").get_available_providers(),
            "graph_optimizations": info["graph_optimizations"],
            "shape_policy": info["shape_policy"],
            "precision_policy": ("FAST_EXPERIMENTAL tf32 (not strict)"
                                 if args.use_tf32 else "strict-fp32"),
            "use_tf32": info["use_tf32"],
            "ort_version": info["onnxruntime"],
            "fixtures": [str(f) for f in fixture_files],
            "tolerances": {"atol": ATOL, "rtol": RTOL, "mae": MAE_GATE,
                           "p99": P99_GATE, "channel_bias": CHANNEL_BIAS_GATE},
            "per_fixture": per_fixture,
            "failed_fixtures": failures,
            "total_fixtures": len(per_fixture),
        }
        report_path.write_text(json.dumps(report, indent=2) + "\n")
        print(json.dumps({"status": report["status"], "failed": failures,
                          "total": len(per_fixture), "report": str(report_path)}, indent=2))
        return 0 if failures == 0 else 2
    except Exception as exc:
        message = f"{type(exc).__name__}: {exc}"
        try:
            # args is always bound here (parse_args either returns or exits).
            _save_error(args.report.resolve(), message)
        except Exception:
            pass
        print(json.dumps({"status": "error", "error": message}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
