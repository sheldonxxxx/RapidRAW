"""Precision ablation: configs 1-4 (Torch) on identical conditioned inputs."""
import json
import os

import numpy as np
import torch

from rapidraw_denoise.inference import load_model

CKPT = "/mnt/data/rapidraw/denoise-research/models/nonlocal-raw-weights.pt"
PHOTOS = ["portrait", "landscape", "phone"]

model = load_model(CKPT, device="cuda").eval().float()

results = []
for photo in PHOTOS:
    for i in range(6):
        with np.load(
            f"/tmp/nlx-fixtures/{photo}-controlled-fp32/tiles/tile-{i:02d}.npz",
            allow_pickle=False,
        ) as f:
            x = np.ascontiguousarray(f["input"]).astype("float32")
            ref = np.ascontiguousarray(f["output"]).astype("float64")
        xt = torch.from_numpy(x).to("cuda")
        outs = {}
        # 1: original production (native sampler, original backend flags)
        os.environ["RAPIDRAW_DENOISE_SAMPLER"] = "cuda"
        torch.backends.cuda.matmul.allow_tf32 = False
        torch.backends.cudnn.allow_tf32 = True
        with torch.inference_mode():
            outs["prod_native_origflags"] = (
                model(xt).float().cpu().numpy().astype("float64")
            )
        # 2: native sampler, TF32 fully disabled
        torch.backends.cuda.matmul.allow_tf32 = False
        torch.backends.cudnn.allow_tf32 = False
        with torch.inference_mode():
            outs["native_noTF32"] = (
                model(xt).float().cpu().numpy().astype("float64")
            )
        # 3: reference sampler, TF32 fully disabled, CUDA
        os.environ["RAPIDRAW_DENOISE_SAMPLER"] = "reference"
        with torch.inference_mode():
            outs["ref_noTF32_cuda"] = (
                model(xt).float().cpu().numpy().astype("float64")
            )
        entry = {"tile": f"{photo}-{i:02d}", "configs": {}}
        for name, arr in outs.items():
            ae = np.abs(arr - ref)
            entry["configs"][name] = {
                "max": float(ae.max()),
                "mae": float(ae.mean()),
            }
        results.append(entry)
        print(
            f"{photo}-{i:02d} "
            + " ".join(
                f"{k}=max{v['max']:.3g}/mae{v['mae']:.3g}"
                for k, v in entry["configs"].items()
            ),
            flush=True,
        )

with open("/tmp/nlx-ablation-torch.json", "w") as f:
    json.dump(results, f, indent=2)
print("wrote /tmp/nlx-ablation-torch.json")
