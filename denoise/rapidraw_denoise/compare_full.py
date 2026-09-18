"""Full-photo comparisons under frozen gates with seam/interior/outer analysis.

Single metric implementation lives in rapidraw_denoise.metrics; this module
adds file verification (ORIGINAL float32 dtype checked before any cast,
[4,H,W], finite, read-only handling), regional analysis, case-set validation
(nonempty, duplicate-free, optional exact expected identities), structured
errors and exit codes:
0 = all pass, 2 = gate failures, 1 = tool/invalid error (saved as JSON).

For ensemble-4 comparisons (``--ensemble 4``), an additional diagnostic
``regions_e4`` entry unions the inverse-mapped tile-boundary lines of all
four rotation passes (diagnostic attribution only; tiling, thresholds and
pass/fail gates are unchanged), plus stats over the newly attributed seam
pixels (``seam_e4_extra``).
"""
import hashlib
import json
import sys
from pathlib import Path

import numpy as np

from .metrics import full_metrics, load_float32_array, require_case_set

CORE = 192
OUTER_BAND = 64
SEAM_HALF_WIDTH = 8


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for block in iter(lambda: stream.read(4 * 1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _grid_lines(n):
    """Marked seam-line indices for one axis of length n (tiled_apply grid).

    Tiles step by CORE from 0; stitch lines sit at tile starts (multiples of
    CORE) plus the far edge. Mirrors the construction in region_masks.
    """
    marked = set()
    for start in range(0, n, CORE):
        for edge in (start, min(start + CORE, n)):
            lo, hi = max(0, edge - SEAM_HALF_WIDTH), min(n, edge + SEAM_HALF_WIDTH)
            marked.update(range(lo, hi))
    return marked


def region_masks(h, w):
    yy, xx = np.mgrid[0:h, 0:w]
    outer = ((yy < OUTER_BAND) | (yy >= h - OUTER_BAND)
             | (xx < OUTER_BAND) | (xx >= w - OUTER_BAND))
    rows = sorted(_grid_lines(h))
    cols = sorted(_grid_lines(w))
    seam_y = np.zeros(h, bool)
    seam_y[rows] = True
    seam_x = np.zeros(w, bool)
    seam_x[cols] = True
    seam = (seam_y[:, None] | seam_x[None, :]) & ~outer
    interior = ~(outer | seam)
    return {"outer": outer, "seam": seam, "interior": interior}


def region_masks_e4(h, w):
    """Diagnostic seam mask unioning all four rotation-pass boundaries.

    Pass ``i`` tiles ``rot90(conditioned, i)``; stitch lines at multiples of
    CORE in pass coordinates map back through the inverse rotation. For odd
    dimensions the mirrored lines (H-1-p, W-1-q) differ from the unrotated
    grid, which the plain mask would misclassify as interior. Diagnostic
    only: same outer band, same construction rule per pass.
    """
    rows = set(_grid_lines(h)) | {h - 1 - p for p in _grid_lines(h)}
    cols = set(_grid_lines(w)) | {w - 1 - q for q in _grid_lines(w)}
    rows = sorted(r for r in rows if 0 <= r < h)
    cols = sorted(c for c in cols if 0 <= c < w)
    yy, xx = np.mgrid[0:h, 0:w]
    outer = ((yy < OUTER_BAND) | (yy >= h - OUTER_BAND)
             | (xx < OUTER_BAND) | (xx >= w - OUTER_BAND))
    seam_y = np.zeros(h, bool)
    seam_y[rows] = True
    seam_x = np.zeros(w, bool)
    seam_x[cols] = True
    seam = (seam_y[:, None] | seam_x[None, :]) & ~outer
    interior = ~(outer | seam)
    return {"outer": outer, "seam": seam, "interior": interior}


def _region_stats(ae, masks):
    stats = {}
    for rname, mask in masks.items():
        sub = ae[:, mask]
        stats[rname] = {
            "max": float(sub.max()),
            "mean": float(sub.mean()),
            "pixels": int(sub.size),
        }
    return stats


def compare_files(name, actual_path, ref_path, ensemble=1):
    actual_path, ref_path = Path(actual_path), Path(ref_path)
    record = {"comparison": name,
              "actual": {"path": str(actual_path),
                         "sha256": sha256_file(actual_path)},
              "reference": {"path": str(ref_path),
                            "sha256": sha256_file(ref_path)}}
    # Original dtypes validated before any cast (load_float32_array).
    actual = load_float32_array(actual_path, ndim=3, channels=4, label="actual")
    ref = load_float32_array(ref_path, ndim=3, channels=4, label="reference")
    if actual.shape != ref.shape:
        raise ValueError(f"shape mismatch: {actual.shape} vs {ref.shape}")
    h, w = ref.shape[1], ref.shape[2]
    masks = region_masks(h, w)
    for rname, mask in masks.items():
        if not mask.any():
            raise ValueError(f"empty {rname} region for shape {(h, w)}")
    entry = full_metrics(name, actual, ref, masks)
    entry.update(record)
    # Regions form a disjoint complete partition; order for readability.
    entry["regions"] = {k: entry["regions"][k] for k in ("outer", "seam", "interior")}
    if ensemble == 4:
        masks4 = region_masks_e4(h, w)
        ae = np.abs(actual.astype("float64") - ref.astype("float64"))
        entry["regions_e4"] = _region_stats(ae, masks4)
        extra = masks4["seam"] & ~masks["seam"]
        sub = ae[:, extra]
        entry["seam_e4_extra"] = {
            "note": "pixels attributed to seam only by the 4-pass diagnostic "
                    "mask (inverse-mapped rotation boundaries); diagnostic, "
                    "no gate effect",
            "max": float(sub.max()),
            "mean": float(sub.mean()),
            "pixels": int(sub.size),
        }
    elif ensemble != 1:
        raise ValueError(f"ensemble must be 1 or 4, got {ensemble}")
    return entry


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    # Usage: compare_full.py PAIRS_JSON OUTPUT_JSON [--expect-cases a,b,...]
    #        [--ensemble {1,4}]
    positional, expected, ensemble = [], None, 1
    i = 0
    while i < len(argv):
        tok = argv[i]
        if tok == "--expect-cases" and i + 1 < len(argv):
            expected = [c for c in argv[i + 1].split(",") if c]
            i += 2
        elif tok == "--ensemble" and i + 1 < len(argv):
            ensemble = int(argv[i + 1])
            i += 2
        elif tok.startswith("--"):
            print(json.dumps({"status": "error",
                              "error": f"unknown flag: {tok}"}),
                  file=sys.stderr)
            return 1
        else:
            positional.append(tok)
            i += 1
    if len(positional) != 2:
        print(json.dumps({"status": "error",
                          "error": "usage: compare_full.py PAIRS_JSON OUTPUT_JSON "
                                   "[--expect-cases a,b,...] [--ensemble {1,4}]"}),
              file=sys.stderr)
        return 1
    pairs_path, output_path = Path(positional[0]), Path(positional[1])
    if output_path.exists():
        print(json.dumps({"status": "error",
                          "error": f"refusing to overwrite {output_path}"}),
              file=sys.stderr)
        return 1
    try:
        pairs = require_case_set(json.loads(pairs_path.read_text()),
                                 expected, label=str(pairs_path))
        out = [compare_files(name, a, r, ensemble) for name, a, r in pairs]
    except Exception as exc:  # invalid inputs reject the report
        error = {"status": "error", "error": f"{type(exc).__name__}: {exc}",
                 "pairs": str(pairs_path)}
        output_path.write_text(json.dumps(error, indent=2) + "\n")
        print(json.dumps(error), file=sys.stderr)
        return 1
    with open(output_path, "w") as f:
        json.dump(out, f, indent=2)
        f.write("\n")
    for e in out:
        print(f"{e['comparison']}: {'PASS' if e['pass'] else 'FAIL'} "
              f"max={e['max_abs_err']:.3g} mae={e['mae']:.3g} "
              f"p99={e['p99_abs_err']:.3g} viol={e['elementwise_violations']} "
              + " ".join(f"{k}max={v['max']:.2g}"
                         for k, v in e["regions"].items()))
    return 0 if all(e["pass"] for e in out) else 2


if __name__ == "__main__":
    raise SystemExit(main())
