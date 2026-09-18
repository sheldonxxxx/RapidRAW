"""Phase-C shared-pipeline tests: orchestration only, fake predictors.

Denoising-quality evidence lives in parity reports, not here.
"""
import numpy as np
import pytest

from rapidraw_denoise import pipeline
from rapidraw_denoise.noise import NoiseProfile
from rapidraw_denoise.pipeline import TilePredictor


def _profile():
    return NoiseProfile(shot=[0.002] * 4, read=[0.00003] * 4, diagnostics=[])


class Identity(TilePredictor):
    def __init__(self):
        self.calls = 0

    def predict(self, tile):
        self.calls += 1
        a = np.asarray(tile)
        # Denoiser contract: conditioned 8-channel tiles yield 4-channel output.
        return a[:4] if a.shape[0] == 8 else a

    def execution_info(self):
        return {}


class Scale2(TilePredictor):
    def predict(self, tile):
        return np.asarray(tile) * 2.0

    def execution_info(self):
        return {}


def test_tiling_identity_odd_rectangular():
    for shape in [(4, 13, 17), (4, 64, 64), (4, 73, 91), (3, 83, 71)]:
        a = np.random.default_rng(42).normal(size=shape).astype(np.float32)
        assert np.array_equal(pipeline.tiled_apply(a, lambda x: x, tile=32, halo=8), a)


def test_transform_inverses_rectangular_and_negative_stride():
    x = np.arange(4 * 13 * 17).reshape(4, 13, 17)
    for i in range(8):
        assert np.array_equal(pipeline.inverse_transform(pipeline.transform(x, i), i), x)
    view = np.ascontiguousarray(
        np.random.default_rng(3).normal(size=(8, 40, 40)).astype(np.float32)
    )[:, ::-1, :]
    assert not view.flags["C_CONTIGUOUS"]
    out = pipeline.tiled_apply(view, lambda t: t, tile=32, halo=8)
    assert np.array_equal(out, np.ascontiguousarray(view))


def test_four_rotation_ensemble_averages_transforms():
    rng = np.random.default_rng(5)
    packed = rng.uniform(-0.05, 0.9, size=(4, 96, 96)).astype(np.float32)
    profile = _profile()
    mean, _, info = pipeline.denoise_with_predictor(
        packed, Identity(), profile, tile=64, halo=16, ensemble=4)
    assert info["ensemble"] == 4
    # Manual Welford mean of the four inverse-transformed tiled singles.
    image = np.clip(packed, 0, 1)
    variance = profile.variance(packed)
    conditioned = np.concatenate([image, np.sqrt(np.maximum(variance, 1e-12))])
    singles = [pipeline.inverse_transform(
        pipeline.tiled_apply(pipeline.transform(conditioned, i),
                             lambda t: t[:4], tile=64, halo=16), i)
        for i in range(4)]
    np.testing.assert_array_equal(mean, sum(singles) / 4)


def test_invalid_inputs_fail_closed():
    with pytest.raises(ValueError):
        pipeline.tiled_apply(np.ones((4, 64, 64), np.float32), lambda x: x,
                             tile=32, halo=16)
    with pytest.raises(ValueError):
        pipeline.denoise_with_predictor(
            np.ones((4, 96, 96), np.float32), Identity(), _profile(), ensemble=3)
    with pytest.raises(RuntimeError):
        pipeline.tiled_apply(np.ones((4, 64, 64), np.float32),
                             lambda x: x * np.nan, tile=32, halo=8)


def test_progress_semantics_preserved():
    image = np.random.default_rng(41).normal(size=(4, 83, 71)).astype(np.float32)
    progress = []
    out = pipeline.tiled_apply(
        image, lambda x: x, tile=32, halo=8,
        progress=lambda done, total: progress.append((done, total)))
    assert np.array_equal(out, image)
    assert [done for done, _ in progress] == list(range(1, len(progress) + 1))
    events = []
    pipeline.denoise_with_predictor(
        np.random.default_rng(6).uniform(-0.05, 0.9, size=(4, 96, 96)).astype(np.float32),
        Identity(), _profile(), tile=64, halo=16, ensemble=4,
        progress=events.append)
    passes = [e for e in events if set(e) == {"completed_passes", "total_passes"}]
    assert [e["completed_passes"] for e in passes] == [1, 2, 3, 4]
    tiles = [e for e in events if "completed_tiles" in e]
    assert tiles and all(e["total_passes"] == 4 for e in tiles)
