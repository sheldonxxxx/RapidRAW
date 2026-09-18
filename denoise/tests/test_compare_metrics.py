"""Regression tests for the shared metric implementation.

Covers the reported full-photo comparator defect (row axis vs channel
axis on 3D arrays) and the required validator behaviours. Small synthetic
arrays only; real-fixture parity lives in the parity reports.
"""
import json

import numpy as np
import pytest

from rapidraw_denoise.metrics import (
    _check_consistency,
    full_metrics,
    tile_metrics,
)


def test_exact_equality_passes_clean():
    a = np.random.default_rng(0).normal(size=(4, 17, 23)).astype(np.float32)
    e = full_metrics("eq", a, a.copy())
    assert e["pass"] and e["max_abs_err"] == 0 and e["mae"] == 0
    assert e["signed_mean_err_per_channel"] == [0, 0, 0, 0]
    assert e["consistency_problems"] == []
    t = tile_metrics("eq4", a[None], a[None].copy())
    assert t["pass"] and t["max_abs_err_channel"] == 0  # argmax first element


def test_constant_per_channel_offsets():
    ref = np.zeros((4, 32, 32), np.float32)
    out = np.stack([np.full((32, 32), v, np.float32)
                    for v in (1e-6, -2e-6, 3e-6, -4e-6)])
    e = full_metrics("offsets", out, ref)
    assert e["signed_mean_err_per_channel"] == pytest.approx([1e-6, -2e-6, 3e-6, -4e-6])
    assert e["mae"] == pytest.approx(2.5e-6)
    # Invariant: mean abs channel bias (2.5e-6) <= MAE.
    assert e["mean_abs_channel_bias"] <= e["mae"] * (1 + 1e-9) + 1e-18
    assert e["consistency_problems"] == []


def test_signed_cancellation_is_consistent():
    ref = np.zeros((4, 16, 16), np.float32)
    out = np.stack([np.full((16, 16), 5e-6 if c % 2 == 0 else -5e-6,
                            np.float32) for c in range(4)])
    e = full_metrics("cancel", out, ref)
    assert e["signed_mean_err_per_channel"] == pytest.approx([5e-6, -5e-6, 5e-6, -5e-6])
    assert e["mae"] == pytest.approx(5e-6)
    assert e["mean_abs_channel_bias"] == pytest.approx(5e-6)
    assert e["consistency_problems"] == []


def test_old_row_axis_bug_is_demonstrated_and_fixed():
    # The old buggy `arr[:, c]` reduction indexed axis 1, which on 3D
    # [C,H,W] arrays is the ROW axis (height), not channels and not columns.
    # Fixture: per-channel offsets, constant across rows and columns. The old
    # expression returns the same grand mean for every c (no channel info);
    # the correct per-channel means differ, and full_metrics must return them.
    v = [1e-6, -2e-6, 3e-6, -4e-6]
    out = np.stack([np.full((8, 8), x, np.float32) for x in v])
    ref = np.zeros((4, 8, 8), np.float32)
    old_row_means = np.array([float(out[:, c].mean()) for c in range(4)])
    assert np.allclose(old_row_means, np.mean(v))  # old: channel-blind
    e = full_metrics("rows", out, ref)
    assert e["signed_mean_err_per_channel"] == pytest.approx(v)
    assert not np.allclose(old_row_means,
                           e["signed_mean_err_per_channel"])  # genuinely differs
    assert e["mean_abs_channel_bias"] <= e["mae"] * (1 + 1e-9) + 1e-18
    assert e["consistency_problems"] == []


def test_sparse_outlier_located_and_counted():
    ref = np.zeros((1, 4, 16, 16), np.float32)
    out = np.zeros((1, 4, 16, 16), np.float32)
    out[0, 2, 5, 7] = 5e-4
    e = tile_metrics("outlier", out, ref)
    assert e["elementwise_violations"] == 1
    assert e["max_abs_err_location_nchw"] == [0, 2, 5, 7]
    assert e["max_abs_err_channel"] == 2
    assert not e["pass"]
    assert e["consistency_problems"] == []  # metrics self-consistent; gates fail


def test_uneven_shapes_supported():
    rng = np.random.default_rng(2)
    ref = rng.normal(size=(4, 7, 13)).astype(np.float32) * 0.01
    out = (ref.astype("float64") + 1e-7).astype(np.float32)
    e = full_metrics("odd", out, ref)
    assert e["shape"] == [4, 7, 13]
    assert e["consistency_problems"] == []


def test_nan_inf_rejected():
    good = np.zeros((4, 8, 8), np.float32)
    for bad in (np.nan, np.inf):
        bad_arr = np.full((4, 8, 8), bad, np.float32)
        with pytest.raises(ValueError):
            full_metrics("bad", bad_arr, good)
        with pytest.raises(ValueError):
            full_metrics("bad", good, bad_arr)
        with pytest.raises(ValueError):
            tile_metrics("bad", bad_arr[None], good[None])


def test_region_partition_agrees_with_whole():
    rng = np.random.default_rng(4)
    ref = rng.normal(size=(4, 400, 400)).astype(np.float32)
    out = (ref.astype("float64") + rng.normal(size=(4, 400, 400)) * 1e-6).astype(np.float32)
    h, w = 400, 400
    outer = np.zeros((h, w), bool)
    outer[:64, :] = True
    regions = {"outer": outer, "rest": ~outer}
    e = full_metrics("regions", out, ref, regions)
    assert e["consistency_problems"] == []
    assert abs(e["region_weighted_mae"] - e["mae"]) <= e["mae"] * 1e-9 + 1e-18


def test_p99_is_exact_not_sampled():
    # 100 values 0..99 scaled: exact linear-interpolation P99 is computable.
    vals = np.arange(100, dtype="float64").reshape(1, 1, 10, 10) / 100.0
    ref = np.zeros((1, 1, 10, 10), np.float32)
    e = tile_metrics("p99", vals.astype(np.float32), ref)
    assert e["p99_abs_err"] == pytest.approx(float(np.quantile(vals, 0.99)))
    assert e["p99_abs_err"] <= e["max_abs_err"]


def test_4d_channel_indexing_selects_channels():
    # Proves `[:, c]` on 4D [N,C,H,W] is per-channel (tile path is correct).
    ref = np.zeros((1, 4, 8, 8), np.float32)
    out = np.stack([np.full((8, 8), v, np.float32)
                    for v in (1e-6, -2e-6, 3e-6, -4e-6)])[None]
    e = tile_metrics("ch4d", out, ref)
    assert e["signed_mean_err_per_channel"] == pytest.approx([1e-6, -2e-6, 3e-6, -4e-6])
    assert e["consistency_problems"] == []


def test_consistency_checker_rejects_impossible_stats():
    bad = {"mean_abs_channel_bias": 2.0, "mae": 1.0, "rmse": 1.5,
           "max_abs_err": 2.0, "p99_abs_err": 1.2}
    assert any("triangle" in p for p in _check_consistency(bad))
    good = {"mean_abs_channel_bias": 0.5, "mae": 1.0, "rmse": 1.2,
            "max_abs_err": 2.0, "p99_abs_err": 1.1}
    assert _check_consistency(good) == []


def test_compare_files_rejects_degenerate_regions_and_missing_inputs(tmp_path):
    from rapidraw_denoise.compare_full import compare_files
    tiny = np.zeros((4, 8, 8), np.float32)
    a, r = tmp_path / "a.npy", tmp_path / "r.npy"
    np.save(a, tiny)
    np.save(r, tiny)
    with pytest.raises(ValueError):
        compare_files("tiny", a, r)
    with pytest.raises(FileNotFoundError):
        compare_files("missing", tmp_path / "nope.npy", r)


def test_compare_files_binds_hashes_and_full_metrics(tmp_path):
    from rapidraw_denoise.compare_full import compare_files
    rng = np.random.default_rng(11)
    ref = rng.normal(size=(4, 400, 400)).astype(np.float32)
    out = (ref.astype("float64") + 1e-7).astype(np.float32)
    a, r = tmp_path / "a.npy", tmp_path / "r.npy"
    np.save(a, out)
    np.save(r, ref)
    e = compare_files("ok", a, r)
    assert e["pass"] and e["consistency_problems"] == []
    assert set(e["regions"]) == {"outer", "seam", "interior"}
    assert len(e["actual"]["sha256"]) == 64 and len(e["reference"]["sha256"]) == 64
    assert e["mean_abs_channel_bias"] <= e["mae"] * (1 + 1e-9) + 1e-18


def test_profile_audit_reads_exact_provider_tags(tmp_path):
    from rapidraw_denoise.profile_audit import audit_profile
    events = [
        {"cat": "Node", "name": "node1_kernel_time",
         "args": {"provider": "CUDAExecutionProvider", "op_name": "Conv"}},
        {"cat": "Node", "name": "node2_kernel_time",
         "args": {"provider": "CUDAExecutionProvider", "op_name": "GridSample"}},
        {"cat": "Node", "name": "node3_kernel_time",
         "args": {"provider": "CPUExecutionProvider", "op_name": "Expand"}},
        {"cat": "Node", "name": "Memcpy_token_1_kernel_time",
         "args": {"provider": "CUDAExecutionProvider", "op_name": "MemcpyToHost"}},
        {"cat": "Session", "name": "model_run", "args": {}},
    ]
    p = tmp_path / "profile.json"
    p.write_text(__import__("json").dumps(events))
    r = audit_profile(p)
    assert r["total_events"] == 5 and r["node_events"] == 4
    assert r["node_events_missing_provider_tag"] == 0
    assert r["node_events_by_provider"] == {
        "CUDAExecutionProvider": 3, "CPUExecutionProvider": 1}
    assert r["ops_by_provider"]["CUDAExecutionProvider"]["Conv"] == 1
    assert r["ops_by_provider"]["CPUExecutionProvider"]["Expand"] == 1
    assert r["memcpy_to_host_events_included"] == 1
    assert r["node_names_with_kernel_time_suffix"] == 4
    assert "device-only" in r["timing_scope"]
    assert "NOT total process VRAM" in r["allocator_scope"]


def test_profile_audit_case_sensitive_provider_not_conflated(tmp_path):
    # A naive case-insensitive "cuda" match would miscount; exact tags only.
    from rapidraw_denoise.profile_audit import audit_profile
    events = [
        {"cat": "Node", "name": "n1_kernel_time",
         "args": {"provider": "CUDAExecutionProvider", "op_name": "Conv"}},
        {"cat": "Node", "name": "n2_kernel_time",
         "args": {"provider": "CPUExecutionProvider", "op_name": "Expand"}},
    ]
    p = tmp_path / "profile.json"
    p.write_text(__import__("json").dumps(events))
    r = audit_profile(p)
    assert r["node_events_by_provider"]["CPUExecutionProvider"] == 1
    assert "Cuda" not in json.dumps(r["node_events_by_provider"])
