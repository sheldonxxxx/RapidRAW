from .common import require_space

require_space()
import json, time, numpy as np, torch
from rapidraw_denoise.inference import load_model, tiled_apply
from rapidraw_denoise.raw import RawFrame
from rapidraw_denoise.noise import synthesize, estimate_noise
from .evaluate import extra_metrics
from .common import ROOT as R, STUDY as S

torch.set_num_threads(4)
model = load_model(R / "models/nonlocal-raw-weights.pt")
entries = json.loads((S / "dataset-manifest.json").read_text())["files"]
report = {
    "complete": False,
    "records": [],
    "interpretation": "Validation-only tile/halo convergence. Full 512-pixel prediction is a numerical reference, not noise-free ground truth.",
}


@torch.inference_mode()
def predict(x):
    return (
        model(torch.from_numpy(np.ascontiguousarray(x[None])).cuda())[0].cpu().numpy()
    )


for entry in entries:
    if entry["role"] != "clean" or entry["split"] != "validation":
        continue
    f = RawFrame(R / "data" / entry["filename"])
    h, w = f.packed.shape[1:]
    y = (h - 512) // 8 * 4
    x = (w - 512) // 8 * 4
    ref = np.clip(f.packed[:, y : y + 512, x : x + 512], 0, 1)
    obs = synthesize(ref, [0.003] * 4, [3e-5] * 4, 8723)
    pr = estimate_noise(obs)
    xx = np.concatenate([np.clip(obs, 0, 1), np.sqrt(pr.variance(obs))])
    full = predict(xx)
    outputs = {}
    for tile, halo in [(320, 64), (384, 96), (448, 128)]:
        torch.cuda.reset_peak_memory_stats()
        start = time.monotonic()
        p = tiled_apply(xx, predict, tile, halo)
        interior = p[:, 128:-128, 128:-128]
        diff = interior - full[:, 128:-128, 128:-128]
        outputs[f"{tile}/{halo}"] = {
            "scores": extra_metrics(ref[:, 128:-128, 128:-128], interior),
            "reference_rmse": float(np.sqrt(np.mean(diff**2))),
            "reference_max_error": float(abs(diff).max()),
            "seconds": time.monotonic() - start,
            "peak_vram_bytes": torch.cuda.max_memory_allocated(),
        }
    report["records"].append({"scene": entry["scene"], "variants": outputs})
    f.close()
    (S / "context-check.json").write_text(json.dumps(report, indent=2))
    print(entry["scene"], outputs, flush=True)
report["complete"] = True
(S / "context-check.json").write_text(json.dumps(report, indent=2))
