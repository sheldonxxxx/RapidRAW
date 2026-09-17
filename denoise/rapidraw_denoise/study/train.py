from pathlib import Path
from .common import require_space

require_space()
import json, time, argparse
import numpy as np
import torch
from rapidraw_denoise.inference import load_model
from rapidraw_denoise.raw import sha256
from rapidraw_denoise.noise import synthesize
from .common import ROOT, STUDY as S


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--detail", type=float, default=0.0)
    p.add_argument("--steps", type=int, default=1600)
    p.add_argument("--output", required=True)
    p.add_argument("--training-directory", type=Path, default=S / "patches-train")
    p.add_argument("--camera-balanced", action="store_true")
    a = p.parse_args()
    if a.steps < 1 or a.detail < 0:
        raise ValueError("Steps must be positive and detail weight nonnegative")
    torch.set_num_threads(4)
    torch.manual_seed(20260916)
    rng = np.random.default_rng(20260916)
    out = S / a.output
    out.mkdir()
    checkpoint = ROOT / "models/nonlocal-raw-weights.pt"
    model = load_model(checkpoint)
    train_dir = a.training_directory
    tm = json.loads((train_dir / "manifest.json").read_text())
    training = [np.load(train_dir / r["path"]) for r in tm["records"]]
    camera_groups = []
    if a.camera_balanced:
        cameras = sorted({r["camera"] for r in tm["records"]})
        camera_groups = [
            [i for i, r in enumerate(tm["records"]) if r["camera"] == camera]
            for camera in cameras
        ]
    vd = S / "patches-validation"
    vm = json.loads((vd / "manifest.json").read_text())
    validation = []
    # 24 scene-balanced center crops, two fixed synthetic noise levels. Full validation follows selection.
    for r in vm["records"]:
        if (
            r["kind"] != "synthetic"
            or r["region"] != "center"
            or r["level"] not in ["medium", "high"]
        ):
            continue
        z = np.load(vd / r["path"])
        obs = z["observed"][:, 96:288, 96:288]
        ref = z["reference"][:, 112:272, 112:272]
        std = np.sqrt(
            np.maximum(
                z["shot"][:, None, None] * np.maximum(obs, 0)
                + z["read"][:, None, None],
                1e-12,
            )
        )
        validation.append(
            (
                torch.from_numpy(
                    np.concatenate([np.clip(obs, 0, 1), std]).astype(np.float32)[None]
                ).cuda(),
                ref,
                r["scene"],
            )
        )
    assert not {r["scene"] for r in tm["records"]} & {r[2] for r in validation}, (
        "Scene leakage"
    )
    optimizer = torch.optim.AdamW(model.parameters(), lr=3e-6, weight_decay=0)
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(
        optimizer, a.steps, eta_min=3e-7
    )

    @torch.inference_mode()
    def validate():
        model.eval()
        scores = []
        for x, ref, scene in validation:
            y = model(x)[0, :, 16:-16, 16:-16].cpu().numpy()
            scores.append(float(-10 * np.log10(max(np.mean((y - ref) ** 2), 1e-15))))
        return np.array(scores)

    base = validate()
    best = float(base.mean())
    best_step = 0
    history = [{"step": 0, "mean": best, "scores": base.tolist()}]
    torch.save(model.state_dict(), out / "best.pt")
    protocol = {
        "initial_sha256": sha256(checkpoint),
        "seed": 20260916,
        "training_manifest_sha256": sha256(train_dir / "manifest.json"),
        "camera_balanced": a.camera_balanced,
        "steps": a.steps,
        "detail_gradient_weight": a.detail,
        "optimizer": "AdamW lr=3e-6 -> 3e-7 cosine; zero weight decay",
        "batch": 2,
        "crop": 128,
        "train_scenes": sorted({r["scene"] for r in tm["records"]}),
        "validation_scenes": sorted({r[2] for r in validation}),
        "selection": "Mean PSNR on 24 fixed validation center patches, no patch regression >0.2 dB; initialization remains eligible. Full validation evaluation before any held-out testing.",
        "loss": "RAW L1 plus optional paired spatial gradient L1; no learned perceptual or adversarial loss",
        "noise": "Poisson-Gaussian with shared 10 percent lognormal conditioning jitter and per-channel noise variation; identical seeds across control/detail runs",
    }
    (out / "protocol.json").write_text(json.dumps(protocol, indent=2))
    start = time.monotonic()
    torch.cuda.reset_peak_memory_stats()
    for step in range(1, a.steps + 1):
        xs = []
        ys = []
        for _ in range(2):
            if camera_groups:
                group = camera_groups[int(rng.integers(len(camera_groups)))]
                image = training[group[int(rng.integers(len(group)))]]
            else:
                image = training[int(rng.integers(len(training)))]
            y, x = rng.integers(0, image.shape[1] - 128 + 1, size=2)
            clean = image[:, y : y + 128, x : x + 128]
            clean = np.rot90(clean, int(rng.integers(4)), axes=(1, 2)).copy()
            if rng.random() < 0.5:
                clean = clean[:, :, ::-1].copy()
            clean = np.clip(
                clean * np.exp(rng.uniform(np.log(0.3), np.log(2))), 0, 1
            ).astype(np.float32)
            shot = np.exp(rng.uniform(np.log(0.0001), np.log(0.012))) * np.exp(
                rng.normal(0, 0.1, 4)
            )
            read = np.exp(rng.uniform(np.log(5e-7), np.log(0.00015))) * np.exp(
                rng.normal(0, 0.15, 4)
            )
            noisy = synthesize(clean, shot, read, int(rng.integers(2**31)))
            std = np.sqrt(
                np.maximum(
                    shot[:, None, None] * np.maximum(noisy, 0) + read[:, None, None],
                    1e-12,
                )
            ) * np.exp(rng.normal(0, 0.1))
            xs.append(np.concatenate([np.clip(noisy, 0, 1), std]).astype(np.float32))
            ys.append(clean)
        model.train()
        xx = torch.from_numpy(np.stack(xs)).cuda()
        target = torch.from_numpy(np.stack(ys)).cuda()
        optimizer.zero_grad(set_to_none=True)
        prediction = model(xx)
        loss = (prediction - target).abs().mean()
        if a.detail:
            loss = loss + a.detail * 0.5 * (
                (torch.diff(prediction, dim=2) - torch.diff(target, dim=2)).abs().mean()
                + (torch.diff(prediction, dim=3) - torch.diff(target, dim=3))
                .abs()
                .mean()
            )
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1)
        optimizer.step()
        scheduler.step()
        if step % 200 == 0 or step == a.steps:
            scores = validate()
            mean = float(scores.mean())
            worst = float((scores - base).min())
            if mean > best and worst >= -0.2:
                best = mean
                best_step = step
                torch.save(model.state_dict(), out / "best.pt")
            record = {
                "step": step,
                "loss": float(loss.detach()),
                "mean": mean,
                "delta": mean - float(base.mean()),
                "worst_delta": worst,
                "best_step": best_step,
                "scores": scores.tolist(),
                "seconds": time.monotonic() - start,
                "peak_vram_mib": torch.cuda.max_memory_allocated() / 1024**2,
            }
            history.append(record)
            (out / "history.json").write_text(json.dumps(history, indent=2))
            torch.save(
                {
                    "state_dict": model.state_dict(),
                    "optimizer": optimizer.state_dict(),
                    "step": step,
                    "numpy_rng": rng.bit_generator.state,
                    "torch_rng": torch.get_rng_state(),
                },
                out / "last.pt",
            )
            print(json.dumps(record), flush=True)
    print("COMPLETE", best_step, best - float(base.mean()), flush=True)


if __name__ == "__main__":
    main()
