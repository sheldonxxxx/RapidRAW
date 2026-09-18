"""Traced-vs-eager check for the packed Torch model on real fixtures.

Strict-loads the pinned checkpoint (SHA-gated), routes the export-only
packed sampler, traces once on zeros (diagnostic trace anchor only), then
compares traced vs eager outputs on varied real conditioned tiles:
one per photograph by default, all 18 with --all. Gate: max abs diff
<= 1e-5 per tile. Also reports cross-fixture output spread to prove the
trace stays image-dependent (a constant-collapsed trace would fail this).

Diagnostic only: no weights, precision, offsets, or RAW processing change.
Prints one JSON object.
"""
import argparse
import hashlib
import json
import sys
from pathlib import Path

PINNED_SHA = "c16747d852b93a95908792cdbac901f89cca98e35b91ea7db6214de42fbd3cad"
PHOTOS = ("portrait", "landscape", "phone")
GATE = 1e-5


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for block in iter(lambda: stream.read(4 * 1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--checkpoint", required=True)
    ap.add_argument("--fixtures-root", required=True,
                    help="dir containing {photo}-controlled-fp32 subdirs")
    ap.add_argument("--all", action="store_true",
                    help="check every tile (6/photo); default is tile-00/photo")
    ns = ap.parse_args()
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    import warnings
    warnings.filterwarnings("ignore")
    import numpy as np
    import torch

    from rapidraw_denoise.inference import load_model
    from rapidraw_denoise.vendor.nonlocalmf import network as network_mod
    from rapidraw_denoise.vendor.nonlocalmf import sampling as sampling_mod

    ckpt = Path(ns.checkpoint)
    if sha256_file(ckpt) != PINNED_SHA:
        print(json.dumps({"status": "error",
                          "error": "checkpoint is not the pinned weights"}))
        return 1
    rep = {"checkpoint_pinned_match": True,
           "torch": torch.__version__, "numpy": np.__version__}
    try:
        model = load_model(str(ckpt), device="cpu")
        model.eval().float()
        network_mod.deform_neighbourhood = \
            __import__("rapidraw_denoise.static_packed_sampler",
                       fromlist=["packed_deform_neighbourhood"]
                       ).packed_deform_neighbourhood
        with torch.no_grad():
            traced = torch.jit.trace(model, torch.zeros(1, 8, 320, 320),
                                     strict=False, check_trace=False)
        root = Path(ns.fixtures_root)
        tiles = []
        for photo in PHOTOS:
            tdir = root / f"{photo}-controlled-fp32" / "tiles"
            idxs = range(6) if ns.all else (0,)
            for i in idxs:
                tiles.append((photo, tdir / f"tile-{i:02d}.npz"))
        rows, worst, means = [], 0.0, []
        with torch.no_grad():
            for photo, path in tiles:
                with np.load(path, allow_pickle=False) as f:
                    x = torch.from_numpy(np.ascontiguousarray(f["input"]))
                assert x.shape == (1, 8, 320, 320) and x.dtype == torch.float32
                eager = model(x)
                out = traced(x)
                d = float((out - eager).abs().max())
                worst = max(worst, d)
                means.append(out.float().mean().item())
                rows.append({"photo": photo, "tile": path.name,
                             "trace_vs_eager_max": d, "pass": d <= GATE})
        spread = max(means) - min(means)
        rep.update({"status": "ok", "tiles": len(rows), "rows": rows,
                    "worst_max": worst, "gate": GATE,
                    "all_pass": all(r["pass"] for r in rows),
                    "cross_fixture_output_spread": spread,
                    "image_dependent": spread > 0})
    except Exception as exc:
        import traceback
        rep.update({"status": "error", "error": f"{type(exc).__name__}: {exc}",
                    "traceback_tail": traceback.format_exc()[-1500:]})
        print(json.dumps(rep, indent=2))
        return 1
    finally:
        network_mod.deform_neighbourhood = sampling_mod.deform_neighbourhood
    print(json.dumps(rep, indent=2))
    return 0 if rep.get("all_pass") and rep.get("image_dependent") else 1


if __name__ == "__main__":
    raise SystemExit(main())
