from .common import require_space

require_space()
import argparse, json, hashlib, time
import numpy as np
from scipy.ndimage import gaussian_filter
from rapidraw_denoise.raw import RawFrame, sha256
from rapidraw_denoise.paired import register, exposure_fit
from rapidraw_denoise.noise import estimate_noise, synthesize
from .common import ROOT, STUDY


def regions(image, size=384):
    # Selection is fixed from source/reference content before model inference.
    _, h, w = image.shape
    candidates = []
    for fy in np.linspace(0.05, 0.95, 7):
        for fx in np.linspace(0.05, 0.95, 7):
            y = int((h - size) * fy) // 4 * 4
            x = int((w - size) * fx) // 4 * 4
            plane = image[[1, 3], y : y + size, x : x + size].mean(0)
            smooth = gaussian_filter(plane, 1)
            signal = float(np.mean(smooth))
            edge = float(
                np.mean(np.diff(smooth, axis=0) ** 2)
                + np.mean(np.diff(smooth, axis=1) ** 2)
            )
            sat = float(np.mean(plane > 0.98))
            candidates.append((y, x, signal, edge, sat))
    usable = [c for c in candidates if c[4] < 0.05 and c[2] > 0.002] or candidates
    chosen = []
    for label, ordered in [
        ("texture", sorted(usable, key=lambda c: -c[3])),
        ("shadow", sorted(usable, key=lambda c: c[2])),
        ("flat", sorted(usable, key=lambda c: c[3])),
    ]:
        point = next(
            (
                c
                for c in ordered
                if all(abs(c[0] - q[1]) + abs(c[1] - q[2]) > size // 2 for q in chosen)
            ),
            ordered[0],
        )
        chosen.append((label, point[0], point[1]))
    center = (int((h - size) * 0.5) // 4 * 4, int((w - size) * 0.5) // 4 * 4)
    chosen.append(("center", *center))
    return chosen


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--resume", action="store_true")
    p.add_argument("--split", required=True, choices=["train", "validation", "test"])
    a = p.parse_args()
    manifest = json.loads((STUDY / "dataset-manifest.json").read_text())
    out = STUDY / f"patches-{a.split}"
    out.mkdir(exist_ok=a.resume)
    report = {
        "split": a.split,
        "records": [],
        "excluded_pairs": [],
        "complete": False,
        "selection": "Four content-selected 384-square packed crops; score central 256-square. Regions frozen before inference.",
    }
    if a.resume and (out / "manifest.json").exists():
        report = json.loads((out / "manifest.json").read_text())
    for entry in [
        e for e in manifest["files"] if e["role"] == "clean" and e["split"] == a.split
    ]:
        if any(r["scene"] == entry["scene"] for r in report["records"]):
            continue
        path = ROOT / "data" / entry["filename"]
        while not path.exists():
            time.sleep(3)
        cf = RawFrame(path)
        clean = cf.packed.copy()
        scene = entry["scene"]
        meta = cf.metadata()
        # Content previews are retained for visual selection; full source stays untouched.
        from PIL import Image

        rgb = cf.render()
        preview = Image.fromarray(np.rint(rgb / 257).astype(np.uint8))
        preview.thumbnail((1000, 1000))
        preview.save(out / f"{scene}-overview.jpg", quality=93)
        del rgb
        if a.split == "train":
            # More spatial diversity than the old two-crop adaptation; bounded disk/memory.
            for i, (_, y, x) in enumerate(regions(clean, size=512)):
                patch = np.clip(clean[:, y : y + 512, x : x + 512], 0, 1).copy()
                np.save(out / f"{scene}-{i}.npy", patch)
                report["records"].append(
                    {
                        "scene": scene,
                        "crop": i,
                        "path": f"{scene}-{i}.npy",
                        "metadata": meta,
                        "origin": [y, x],
                    }
                )
            cf.close()
            continue
        noisy_entry = next(
            e for e in manifest["files"] if e["role"] == "noisy" and e["scene"] == scene
        )
        noisy_path = ROOT / "data" / noisy_entry["filename"]
        while not noisy_path.exists():
            time.sleep(3)
        nf = RawFrame(noisy_path)
        pair = None
        try:
            if cf.positions != nf.positions:
                raise ValueError("CFA mismatch")
            ref, obs, align = register(clean, nf.packed)
            gain, offset, residual = exposure_fit(ref, obs)
            if np.max(np.abs(align["remaining_fractional_shift_yx"])) > 0.25:
                raise ValueError("Residual subpixel shift exceeds .25 packed pixels")
            profile = estimate_noise(nf.packed)
            pair = (ref, obs, align, gain, offset, residual, profile)
        except Exception as e:
            report["excluded_pairs"].append({"scene": scene, "reason": str(e)})
        for i, (label, y, x) in enumerate(regions(clean)):
            target = np.clip(clean[:, y : y + 384, x : x + 384], 0, 1).copy()
            for level, shot, read in [
                ("low", 0.0005, 2e-6),
                ("medium", 0.003, 3e-5),
                ("high", 0.008, 8e-5),
            ]:
                seed = int(
                    hashlib.sha256(
                        f"{a.split}/{scene}/{i}/{level}".encode()
                    ).hexdigest()[:8],
                    16,
                )
                noisy = synthesize(target, [shot] * 4, [read] * 4, seed)
                prof = estimate_noise(noisy)
                name = f"{scene}-{i}-{level}.npz"
                np.savez_compressed(
                    out / name,
                    reference=target,
                    observed=noisy,
                    shot=np.array(prof.shot),
                    read=np.array(prof.read),
                    gain=np.ones((4, 1, 1), np.float32),
                    offset=np.zeros((4, 1, 1), np.float32),
                )
                report["records"].append(
                    {
                        "scene": scene,
                        "kind": "synthetic",
                        "seed": seed,
                        "level": level,
                        "crop": i,
                        "region": label,
                        "origin": [y, x],
                        "path": name,
                        "metadata": meta,
                        "oracle": {"shot": shot, "read": read},
                        "noise": prof.to_dict(),
                    }
                )
        if pair:
            ref, obs, align, gain, offset, residual, profile = pair
            for i, (label, y, x) in enumerate(regions(ref)):
                name = f"{scene}-{i}-real.npz"
                np.savez_compressed(
                    out / name,
                    reference=ref[:, y : y + 384, x : x + 384],
                    observed=obs[:, y : y + 384, x : x + 384],
                    shot=np.array(profile.shot),
                    read=np.array(profile.read),
                    gain=gain,
                    offset=offset,
                )
                report["records"].append(
                    {
                        "scene": scene,
                        "kind": "real",
                        "level": noisy_entry["iso"],
                        "crop": i,
                        "region": label,
                        "origin": [y, x],
                        "path": name,
                        "metadata": meta,
                        "source_sha256": sha256(noisy_path),
                        "alignment": align,
                        "photometric_residual_mad": residual,
                        "noise": profile.to_dict(),
                    }
                )
        cf.close()
        nf.close()
        print(
            json.dumps(
                {
                    "scene": scene,
                    "records": len(report["records"]),
                    "excluded": report["excluded_pairs"][-1:] if not pair else [],
                }
            ),
            flush=True,
        )
        (out / "manifest.json").write_text(json.dumps(report, indent=2))
    report["complete"] = True
    (out / "manifest.json").write_text(json.dumps(report, indent=2))
    print("COMPLETE", a.split, len(report["records"]), flush=True)


if __name__ == "__main__":
    main()
