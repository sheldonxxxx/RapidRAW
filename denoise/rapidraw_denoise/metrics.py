"""Shared numerical comparison metrics for Nonlocal ONNX validation.

Single implementation used by tile validation (4D batched arrays) and
full-photo comparison (3D arrays). All metrics derive from one
``candidate - reference`` difference over one explicitly documented domain,
in FP64. Frozen gates are parameters, never relaxed here.

P99 method: np.quantile with default linear interpolation over ALL elements
(exact full-sort computation, not a sample or a mean of chunk percentiles).

Every report carries self-consistency checks; a violated invariant rejects
the report instead of publishing impossible statistics.
"""
import numpy as np
from pathlib import Path

ATOL = 1e-4
RTOL = 1e-4
MAE_GATE = 1e-5
P99_GATE = 1e-4
CHANNEL_BIAS_GATE = 1e-5
# Pure arithmetic slack for FP64 reduction reordering (not a policy change).
SLACK = 1e-9


def load_float32_array(path, *, ndim, channels, label):
    """Load a saved ``.npy`` array, validating the ORIGINAL dtype first.

    Any original dtype other than float32 is rejected before any cast, so a
    float64/uint16/uint32 candidate can never become a valid-looking float32
    comparison. ``allow_pickle`` is always False.
    """
    path = Path(path)
    if not path.is_file():
        raise FileNotFoundError(f"missing {label} input: {path}")
    raw = np.load(path, allow_pickle=False)
    if not isinstance(raw, np.ndarray):
        raise ValueError(f"{label} {path} is not an ndarray")
    if raw.dtype != np.dtype("float32"):
        raise ValueError(
            f"{label} {path} has original dtype {raw.dtype}; "
            "only float32 evidence is accepted (refusing conversion)")
    if raw.ndim != ndim or raw.shape[0] != channels:
        raise ValueError(
            f"{label} {path} must be {ndim}D with {channels} channels, "
            f"got shape {raw.shape}")
    if not np.isfinite(raw).all():
        raise ValueError(f"{label} {path} contains non-finite values")
    return raw


def require_case_set(pairs, expected=None, *, label="comparison"):
    """Validate a ``[(name, actual, ref), ...]`` case set.

    Rejects an empty set, malformed rows, and duplicate names. When
    ``expected`` identities are given, the set must match them exactly (no
    missing, no extra). Returns the pairs unchanged.
    """
    rows = list(pairs)
    if not rows:
        raise ValueError(f"{label}: empty case set rejected (nothing to compare)")
    names = []
    for row in rows:
        if (not isinstance(row, (list, tuple))) or len(row) != 3:
            raise ValueError(f"{label}: malformed case row {row!r}")
        names.append(row[0])
    duplicates = sorted({n for n in names if names.count(n) > 1})
    if duplicates:
        raise ValueError(f"{label}: duplicate case names rejected: {duplicates}")
    if expected is not None:
        missing = [n for n in expected if n not in names]
        extra = [n for n in names if n not in expected]
        if missing or extra:
            raise ValueError(
                f"{label}: case set != expected identities "
                f"(missing={missing}, extra={extra})")
    return rows


def _check_consistency(m):
    problems = []
    if m["mean_abs_channel_bias"] > m["mae"] * (1 + SLACK) + 1e-18:
        problems.append("mean_abs_channel_bias exceeds MAE (triangle inequality)")
    if m["mae"] > m["rmse"] * (1 + SLACK) + 1e-18:
        problems.append("MAE exceeds RMSE")
    if m["rmse"] > m["max_abs_err"] * (1 + SLACK) + 1e-18:
        problems.append("RMSE exceeds max")
    if m["p99_abs_err"] > m["max_abs_err"] * (1 + SLACK) + 1e-18:
        problems.append("P99 exceeds max")
    return problems


def _base_metrics(name, diff, ref, regions=None):
    ae = np.abs(diff)
    bound = ATOL + RTOL * np.abs(ref)
    rmse = float(np.sqrt((ae ** 2).mean()))
    mae = float(ae.mean())
    p99 = float(np.quantile(ae, 0.99))
    entry = {
        "comparison": name,
        "max_abs_err": float(ae.max()),
        "mae": mae,
        "p99_abs_err": p99,
        "p99_method": "np.quantile linear interpolation over all elements (exact)",
        "rmse": rmse,
        "elementwise_violations": int((ae > bound).sum()),
        "elementwise_violation_fraction": float((ae > bound).mean()),
    }
    if regions is not None:
        if ae.ndim != 3:
            raise ValueError("regional analysis requires 3D [C,H,W] arrays")
        entry["regions"] = {}
        wsum, wtot = 0.0, 0
        for rname, mask in regions.items():
            sub = ae[:, mask]
            entry["regions"][rname] = {
                "max": float(sub.max()),
                "mean": float(sub.mean()),
                "pixels": int(sub.size),
            }
            wsum += float(sub.sum())
            wtot += int(sub.size)
        entry["region_weighted_mae"] = wsum / wtot
        if abs(entry["region_weighted_mae"] - mae) > mae * SLACK + 1e-18:
            entry.setdefault("consistency_problems", []).append(
                "region-weighted MAE disagrees with whole-domain MAE")
    return entry


def full_metrics(name, actual_3d, ref_3d, regions=None):
    """Metrics for 3D [C,H,W] full-photo arrays. Channel axis is axis 0."""
    if actual_3d.ndim != 3 or ref_3d.ndim != 3:
        raise ValueError("full_metrics requires 3D [C,H,W] arrays")
    if actual_3d.shape != ref_3d.shape:
        raise ValueError("shape mismatch")
    if not np.isfinite(actual_3d).all() or not np.isfinite(ref_3d).all():
        raise ValueError("non-finite values")
    actual = np.asarray(actual_3d, dtype="float64")
    ref = np.asarray(ref_3d, dtype="float64")
    d = actual - ref
    entry = _base_metrics(name, d, ref, regions)
    entry["shape"] = list(actual.shape)
    bias = [float(d[c].mean()) for c in range(d.shape[0])]
    entry["signed_mean_err_per_channel"] = bias
    entry["mean_abs_channel_bias"] = float(np.mean(np.abs(bias)))
    entry["data_range"] = float(ref.max() - ref.min())
    entry["consistency_problems"] = entry.get("consistency_problems", []) + _check_consistency(entry)
    entry["pass"] = bool(
        entry["elementwise_violations"] == 0
        and entry["mae"] <= MAE_GATE
        and entry["p99_abs_err"] <= P99_GATE
        and all(abs(b) <= CHANNEL_BIAS_GATE for b in bias)
        and not entry["consistency_problems"]
    )
    return entry


def tile_metrics(name, actual_4d, ref_4d):
    """Metrics for 4D [N,C,H,W] tile arrays. Channel axis is axis 1."""
    if actual_4d.ndim != 4 or ref_4d.ndim != 4:
        raise ValueError("tile_metrics requires 4D [N,C,H,W] arrays")
    if actual_4d.shape != ref_4d.shape:
        raise ValueError("shape mismatch")
    if not np.isfinite(actual_4d).all() or not np.isfinite(ref_4d).all():
        raise ValueError("non-finite values")
    actual = np.asarray(actual_4d, dtype="float64")
    ref = np.asarray(ref_4d, dtype="float64")
    d = actual - ref
    entry = _base_metrics(name, d, ref)
    entry["shape"] = list(actual.shape)
    nch = d.shape[1]
    loc = [int(v) for v in np.unravel_index(int(np.abs(d).argmax()), d.shape)]
    entry["max_abs_err_location_nchw"] = loc
    entry["max_abs_err_channel"] = loc[1]
    bias = [float(d[:, c].mean()) for c in range(nch)]
    entry["signed_mean_err_per_channel"] = bias
    entry["mean_abs_channel_bias"] = float(np.mean(np.abs(bias)))
    entry["consistency_problems"] = _check_consistency(entry)
    entry["pass"] = bool(
        entry["elementwise_violations"] == 0
        and entry["mae"] <= MAE_GATE
        and entry["p99_abs_err"] <= P99_GATE
        and all(abs(b) <= CHANNEL_BIAS_GATE for b in bias)
        and not entry["consistency_problems"]
    )
    return entry
