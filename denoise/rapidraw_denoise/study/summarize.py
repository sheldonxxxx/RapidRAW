from pathlib import Path
import json, sys, numpy as np

p = Path(sys.argv[1])
d = json.loads(p.read_text())
rows = d["records"]
variants = list(rows[0]["scores"])
summary = {
    "complete": d["complete"],
    "records": len(rows),
    "scenes": len(set(r["scene"] for r in rows)),
    "groups": {},
}
for kind in ["synthetic", "real"]:
    rr = [r for r in rows if r["kind"] == kind]
    scenes = sorted(set(r["scene"] for r in rr))
    group = {"records": len(rr), "scenes": len(scenes), "variants": {}}
    for v in variants:
        means = {
            k: float(
                np.mean(
                    [
                        np.mean([r["scores"][v][k] for r in rr if r["scene"] == s])
                        for s in scenes
                    ]
                )
            )
            for k in [
                "psnr",
                "edge_psnr",
                "exposure_normalized_gamma_psnr",
                "flat_rmse",
                "highpass_rmse",
            ]
        }
        deltas = np.array(
            [
                np.mean(
                    [
                        r["scores"][v]["psnr"] - r["scores"]["baseline"]["psnr"]
                        for r in rr
                        if r["scene"] == s
                    ]
                )
                for s in scenes
            ]
        )
        rng = np.random.default_rng(619)
        boots = rng.choice(deltas, (10000, len(deltas)), replace=True).mean(1)
        means.update(
            {
                "raw_delta": float(deltas.mean()),
                "scene_bootstrap_95ci": np.quantile(boots, [0.025, 0.975]).tolist(),
                "worst_scene_delta": float(deltas.min()),
                "improved_scenes": int((deltas > 0).sum()),
                "scene_deltas": dict(zip(scenes, deltas.tolist())),
            }
        )
        group["variants"][v] = means
    summary["groups"][kind] = group
out = p.with_name("summary.json")
out.write_text(json.dumps(summary, indent=2))
for k, g in summary["groups"].items():
    print(k, g["records"], "records", g["scenes"], "scenes")
    for v, x in g["variants"].items():
        print(
            v,
            "PSNR",
            round(x["psnr"], 3),
            "delta",
            round(x["raw_delta"], 3),
            "CI",
            np.round(x["scene_bootstrap_95ci"], 3).tolist(),
            "worstscene",
            round(x["worst_scene_delta"], 3),
            "edge",
            round(x["edge_psnr"], 3),
        )
