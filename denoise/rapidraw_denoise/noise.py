"""Blind, per-CFA-plane Poisson-Gaussian noise estimation.

Estimate Var[y|x] = shot*x + read from non-overlapping diagonal Haar
coefficients. Use low-texture blocks in intensity strata, exclude clipping,
and robustly fit nonnegative parameters. This is an estimate, not calibration
ground truth; diagnostics accompany every inference result.
"""
from dataclasses import asdict, dataclass, field
import numpy as np
from scipy.optimize import nnls


@dataclass
class NoiseProfile:
    shot: list[float]
    read: list[float]
    diagnostics: list[dict] = field(default_factory=list)
    method: str = "stratified-haar-irls-v1"

    def __post_init__(self):
        for values in (self.shot, self.read):
            if len(values) != 4 or not np.isfinite(values).all() or np.any(np.asarray(values) < 0):
                raise ValueError("Noise parameters must contain four finite nonnegative values in RGBG order")
        if np.any(np.asarray(self.shot) + np.asarray(self.read) <= 0):
            raise ValueError("Every channel needs nonzero noise variance")

    def to_dict(self):
        return asdict(self)

    def variance(self, image):
        return np.asarray(self.shot, np.float32)[:, None, None] * np.maximum(image, 0) + np.asarray(self.read, np.float32)[:, None, None]


def estimate_noise(packed, block=32):
    if packed.ndim != 3 or packed.shape[0] != 4 or not np.isfinite(packed).all():
        raise ValueError("Expected finite four-plane packed RAW")
    shots, reads, reports = [], [], []
    for plane in packed:
        h, w = (s // block * block for s in plane.shape)
        if min(h, w) < block * 2:
            raise ValueError("Noise estimation needs at least 64 x 64 packed pixels")
        tiles = plane[:h, :w].reshape(h // block, block, w // block, block).transpose(0, 2, 1, 3).reshape(-1, block, block)
        a, b, c, d = tiles[:, 0::2, 0::2], tiles[:, 0::2, 1::2], tiles[:, 1::2, 0::2], tiles[:, 1::2, 1::2]
        hh = (a - b - c + d) * .5
        low = (a + b + c + d) * .25
        center = np.median(hh, axis=(1, 2), keepdims=True)
        variances = (np.median(np.abs(hh - center), axis=(1, 2)) / .6744897501960817) ** 2
        means = tiles.mean(axis=(1, 2))
        texture = np.mean(np.diff(low, axis=1)**2, axis=(1, 2)) + np.mean(np.diff(low, axis=2)**2, axis=(1, 2))
        # Negative values after black subtraction are real noise observations.
        # Reject zero-clipped inputs, not signed shadow samples.
        valid = ((tiles >= .995).mean((1, 2)) < .01) & ((tiles == 0).mean((1, 2)) < .05) & (variances > 0)
        candidates = np.flatnonzero(valid)
        if len(candidates) < 12:
            raise ValueError("Too few unclipped blocks to estimate noise; supply measured shot/read parameters")
        selected = []
        # Selection uses low-frequency texture, separate from the HH statistic.
        for ids in np.array_split(candidates[np.argsort(means[candidates])], min(12, len(candidates) // 4)):
            selected.extend(ids[np.argsort(texture[ids])[:max(3, len(ids) // 3)]])
        ids = np.asarray(selected)
        x, y = means[ids].astype(np.float64), variances[ids].astype(np.float64)
        design = np.stack([x, np.ones_like(x)], 1)
        weights = np.ones_like(x)
        for _ in range(8):
            coef, _ = nnls(design * np.sqrt(weights[:, None]), y * np.sqrt(weights))
            predicted = np.maximum(design @ coef, 1e-10)
            residual = (y - predicted) / predicted
            scale = max(float(np.median(abs(residual - np.median(residual))) * 1.4826), 1e-10)
            weights = np.minimum(1., 1.345 * scale / np.maximum(abs(residual), 1e-12)) / predicted**2
            weights /= weights.max()
        shot, read = map(float, coef)
        read = max(read, 1e-10)
        pred = shot * x + read
        reports.append({"blocks": int(len(tiles)), "valid_blocks": int(len(candidates)), "fit_blocks": int(len(ids)),
                        "intensity_span": float(np.ptp(x)), "median_variance_ratio": float(np.median(y / pred)),
                        "relative_mad": float(np.median(abs(y-pred) / pred)),
                        "weak_identifiability": bool(np.ptp(x) < .05 or shot == 0)})
        shots.append(shot); reads.append(read)
    return NoiseProfile(shots, reads, reports)


def synthesize(clean, shot, read, seed, row_sigma=0., black_bias=0.):
    """Physics-based training corruption with optional structured-noise stressors."""
    rng = np.random.default_rng(seed)
    a = np.broadcast_to(np.asarray(shot, np.float32).reshape(-1, 1, 1), clean.shape)
    b = np.broadcast_to(np.asarray(read, np.float32).reshape(-1, 1, 1), clean.shape)
    if np.any(a <= 0) or np.any(b < 0):
        raise ValueError("Shot must be positive and read variance nonnegative")
    out = rng.poisson(np.maximum(clean, 0) / a) * a + rng.normal(size=clean.shape) * np.sqrt(b)
    out += rng.normal(size=(clean.shape[0], clean.shape[1], 1)) * row_sigma + black_bias
    return out.astype(np.float32)
