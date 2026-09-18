"""Backend-neutral NumPy orchestration for Nonlocal RAW inference.

Moved verbatim from inference.py: conditioning, tiling, transforms, Welford
ensemble accumulation, and pilot/row-correction orchestration keep identical
arithmetic, order of operations, clipping locations, reflection padding, and
progress semantics. This module must not import Torch or ONNX Runtime; tensor
prediction is supplied through the small TilePredictor contract.
"""
import time
import numpy as np
from .noise import estimate_noise


class TilePredictor:
    """Structural interface; input is one conditioned CHW tile, output is one
    denoised CHW tile. Implement using the repository's typing conventions."""

    def predict(self, tile: np.ndarray) -> np.ndarray:
        raise NotImplementedError

    def execution_info(self) -> dict:
        raise NotImplementedError


def tiled_apply(image, predict, tile=256, halo=64, progress=None):
    if tile % 4 or halo % 4 or halo < 0 or tile <= 2 * halo:
        raise ValueError("Tile and halo must be multiples of four, with tile > 2*halo")
    _, h, w = image.shape
    core = tile - 2 * halo
    ny, nx = (h + core - 1)//core, (w + core - 1)//core
    padded = np.pad(image, ((0,0),(halo, ny*core-h+halo),(halo,nx*core-w+halo)), mode="reflect")
    out = None
    for y in range(0, h, core):
        for x in range(0, w, core):
            prediction = np.asarray(predict(np.ascontiguousarray(padded[:, y:y+tile, x:x+tile])), dtype=np.float32)
            if prediction.shape[1:] != (tile,tile) or not np.isfinite(prediction).all():
                raise RuntimeError("Denoiser returned invalid pixels")
            if out is None:
                out = np.empty((prediction.shape[0],h,w), np.float32)
            cy,cx = min(core,h-y),min(core,w-x)
            out[:, y:y+cy,x:x+cx] = prediction[:,halo:halo+cy,halo:halo+cx]
            if progress:
                progress((y//core)*nx+x//core+1, ny*nx)
    return out


def transform(x, i):
    x = np.rot90(x, i % 4, axes=(-2,-1))
    return x[..., ::-1] if i >= 4 else x


def inverse_transform(x, i):
    x = x[..., ::-1] if i >= 4 else x
    return np.rot90(x, -(i % 4), axes=(-2,-1))


def denoise_with_predictor(packed, predictor, profile=None, tile=256, halo=64, ensemble=1, noise_scale=1., pilot=False, progress=None, row_correction=False):
    if ensemble not in (1, 4, 8) or not np.isfinite(noise_scale) or noise_scale <= 0:
        raise ValueError("Ensemble must be 1, 4, or 8; noise scale must be positive")
    start=time.monotonic()
    profile = profile or estimate_noise(packed)
    image=np.clip(packed,0,1)
    variance=profile.variance(packed)
    def predict(tile_array):
        return predictor.predict(tile_array)
    # Pilot conditioning uses the same observed input, never a second denoising
    # pass over the previous prediction. This isolates noise-map estimation.
    row_info=None
    if pilot or row_correction:
        conditioned=np.concatenate([image,np.sqrt(np.maximum(variance,1e-12))*noise_scale])
        initial=tiled_apply(conditioned,predict,tile,halo)
        if pilot:
            variance=profile.variance(np.clip(initial,0,1))
        if row_correction:
            residual=packed-initial
            row=np.median(residual,axis=2,keepdims=True)
            row-=np.median(row,axis=1,keepdims=True)
            sampling_variance=np.median(variance,axis=2,keepdims=True)*np.pi/(2*packed.shape[2])
            observed=np.var(row,axis=1,keepdims=True)
            shrink=np.maximum(0,1-np.mean(sampling_variance,axis=1,keepdims=True)/np.maximum(observed,1e-12))
            row*=shrink
            # Never shift the global black point or correct above two estimated
            # read-noise standard deviations in this experimental component.
            limit=2*np.sqrt(np.asarray(profile.read,dtype=np.float32))[:,None,None]
            row=np.clip(row,-limit,limit)
            image=np.clip(packed-row,0,1)
            row_info={"rms":float(np.sqrt(np.mean(row**2))),"shrinkage":shrink.ravel().tolist()}
    conditioned=np.concatenate([image,np.sqrt(np.maximum(variance,1e-12))*noise_scale])
    mean=np.zeros_like(image); m2=np.zeros_like(image)
    for i in range(ensemble):
        tile_progress = (lambda done, total: progress({"completed_passes":i,"total_passes":ensemble,
                         "completed_tiles":done,"total_tiles":total})) if progress else None
        candidate=inverse_transform(tiled_apply(transform(conditioned,i),predict,tile,halo,tile_progress),i)
        delta=candidate-mean
        mean+=delta/(i+1)
        m2+=delta*(candidate-mean)
        if progress:
            progress({"completed_passes":i+1,"total_passes":ensemble})
    disagreement=m2/max(ensemble-1,1)
    if not np.isfinite(mean).all():
        raise RuntimeError("Nonfinite inference result")
    info={"elapsed_seconds":time.monotonic()-start,"tile":tile,"halo":halo,"ensemble":ensemble,
          "pilot_conditioning":pilot,"row_correction":row_info,"noise_scale":noise_scale,"noise_profile":profile.to_dict(),
          "parameters":None,
          "disagreement_mean_variance":float(disagreement.mean()),
          "disagreement_interpretation":"Transform sensitivity, not calibrated epistemic uncertainty"}
    info.update(predictor.execution_info())
    return mean,disagreement,info
