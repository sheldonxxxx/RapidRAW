"""Precision ablation: config 5 (saved ONNX on CUDA, TF32 off) + repeat worst."""
import json

import numpy as np
import onnxruntime as ort

opts = ort.SessionOptions()
opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_DISABLE_ALL
session = ort.InferenceSession(
    "/tmp/nlx-model/bundle-pinned-320-fp32/model.onnx",
    sess_options=opts,
    providers=["CUDAExecutionProvider"],
    provider_options=[{"use_tf32": "0"}],
)
print("providers:", session.get_providers(), flush=True)

WORST = ("phone", 5)
results = []
for photo in ["portrait", "landscape", "phone"]:
    for i in range(6):
        with np.load(
            f"/tmp/nlx-fixtures/{photo}-controlled-fp32/tiles/tile-{i:02d}.npz",
            allow_pickle=False,
        ) as f:
            x = np.ascontiguousarray(f["input"]).astype("float32")
            ref = np.ascontiguousarray(f["output"]).astype("float64")
        reps = []
        for r in range(3 if (photo, i) == WORST else 1):
            a = np.asarray(
                session.run(["denoised_raw"], {"raw_with_noise": x})[0],
                dtype="float64",
            )
            reps.append(a)
        ae = np.abs(reps[0] - ref)
        entry = {
            "tile": f"{photo}-{i:02d}",
            "max": float(ae.max()),
            "mae": float(ae.mean()),
        }
        if len(reps) > 1:
            spread = max(
                float(np.abs(reps[j] - reps[0]).max()) for j in (1, 2)
            )
            entry["repeat_spread_max"] = spread
        results.append(entry)
        print(f"{photo}-{i:02d} max={ae.max():.3g} mae={ae.mean():.3g} " +
              (f"repeat_spread={entry.get('repeat_spread_max', 0):.3g}" if (photo, i) == WORST else ""),
              flush=True)

with open("/tmp/nlx-ablation-ort.json", "w") as f:
    json.dump(results, f, indent=2)
print("wrote /tmp/nlx-ablation-ort.json")
