from pathlib import Path
import json, time, numpy as np
from rapidraw_denoise.raw import RawFrame
from .prepare import regions
from .common import ROOT as R, STUDY as S

entries = json.loads((S / "supplement-manifest.json").read_text())["files"]
out = S / "patches-camera"
out.mkdir()
old = json.loads((S / "patches-train/manifest.json").read_text())
report = {
    "records": [],
    "complete": False,
    "selection": "Existing 16 Sony scenes plus 8 additional train scenes, camera-balanced sampling; validation and test unchanged.",
}
for row in old["records"]:
    report["records"].append(
        {
            **row,
            "camera": "SONY ILCE-7C",
            "path": str(Path("..") / "patches-train" / row["path"]),
        }
    )
for entry in entries:
    p = R / "data" / entry["filename"]
    while not p.exists():
        time.sleep(2)
    camera = entry["camera"]
    f = RawFrame(p)
    for i, (_, y, x) in enumerate(regions(f.packed, size=512)):
        target = out / f"{entry['scene']}-{i}.npy"
        np.save(target, np.clip(f.packed[:, y : y + 512, x : x + 512], 0, 1).copy())
        report["records"].append(
            {
                "scene": entry["scene"],
                "camera": camera,
                "path": target.name,
                "origin": [y, x],
                "metadata": f.metadata(),
            }
        )
    f.close()
    print(entry["scene"], camera, flush=True)
report["complete"] = True
(out / "manifest.json").write_text(json.dumps(report, indent=2))
(S / "supplement-cameras.json").write_text(json.dumps(entries, indent=2))
print("COMPLETE", len(report["records"]), flush=True)
