#!/usr/bin/env python3
"""Export verified upstream restoration checkpoints for RapidRAW.

Run with Python 3.13 and bench/enhance/restoration-requirements.txt installed.
All downloaded source, weights, licenses and output stay in --output-dir.
No photograph is uploaded. PyTorch is needed for preparation only; RapidRAW
runs the resulting ONNX graph natively.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import logging
from pathlib import Path
import sys
import types
import urllib.request


NAF_REV = "2b4af71ebe098a92a75910c233a3965a3e93ede4"
SWIN_REV = "6545850fbf8df298df73d81f3e8cba638787c8bd"
SPECS = {
    "nafnet_gopro_w32": {
        "repository": "megvii-research/NAFNet",
        "revision": NAF_REV,
        "license": "MIT (architecture); Apache-2.0 (BasicSR utilities)",
        "checkpoint": "NAFNet-GoPro-width32.pth",
        "checkpoint_url": "https://drive.usercontent.google.com/download?id=1Fr2QadtDCEXg6iwWX8OzeZLbHOx2t5Bj&export=download&confirm=t",
        "checkpoint_sha256": "19394e6155d12ef6371d1d57496f87f0ec88f92bdffa27c0792690722d5d1a5c",
        "source": {
            "basicsr/models/archs/NAFNet_arch.py": "01b22270cc93f1bb90c0e3e4490e98b023fcf73f8552860b4a9ee880ce5c6967",
            "basicsr/models/archs/arch_util.py": "5a11af2e7c2d7a7b57c1fbd7e19cf0a50b4b4e8c7ae7dd203a915d7a707e7005",
            "basicsr/models/archs/local_arch.py": "c4df2ba4d896442a0f6ec984accd6e68f31edce3afdf066add202c25a0d1af26",
        },
        "scale": 1,
        "multiple": 16,
        "max_tile": 384,
    },
    "swinir_lightweight_x2": {
        "repository": "JingyunLiang/SwinIR",
        "revision": SWIN_REV,
        "license": "Apache-2.0",
        "checkpoint": "002_lightweightSR_DIV2K_s64w8_SwinIR-S_x2.pth",
        "checkpoint_url": "https://github.com/JingyunLiang/SwinIR/releases/download/v0.0/002_lightweightSR_DIV2K_s64w8_SwinIR-S_x2.pth",
        "checkpoint_sha256": "193b229909ca89cd8b55de9c9e7fce146ae759d59dfcd78d8feb9dd1d6fa0fd7",
        "source": {
            "models/network_swinir.py": "9e143898679ebeebc5d2fc94ad1b89c38aa4a4d43da4e0fcba0f93e476994913",
        },
        "scale": 2,
        "multiple": 8,
        "max_tile": 384,
    },
}


def sha256(path: Path) -> str:
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def fetch(url: str, target: Path, digest: str | None = None) -> Path:
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        if digest is not None and sha256(target) != digest:
            raise ValueError(f"Checksum mismatch for existing {target.name}")
        return target
    partial = target.with_suffix(target.suffix + ".part")
    try:
        with urllib.request.urlopen(url, timeout=120) as response, partial.open("wb") as output:
            while chunk := response.read(1024 * 1024):
                output.write(chunk)
        if digest is not None and sha256(partial) != digest:
            raise ValueError(f"Checksum mismatch downloading {target.name}")
        partial.replace(target)
    finally:
        partial.unlink(missing_ok=True)
    return target


def module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec)
    sys.modules[name] = result
    spec.loader.exec_module(result)
    return result


def load_model(model_id: str, root: Path):
    import torch

    spec = SPECS[model_id]
    source_root = root / "sources" / spec["repository"].split("/")[1]
    base = f"https://raw.githubusercontent.com/{spec['repository']}/{spec['revision']}"
    for name, digest in spec["source"].items():
        fetch(f"{base}/{name}", source_root / name, digest)
    fetch(f"{base}/LICENSE", source_root / "LICENSE")
    checkpoint = fetch(spec["checkpoint_url"], root / spec["checkpoint"], spec["checkpoint_sha256"])
    if model_id == "nafnet_gopro_w32":
        # Load the official architecture without importing BasicSR's training,
        # CUDA extensions or package-wide dataset registration. arch_util only
        # uses this utility for unrelated network-initialization logging.
        for package in ["basicsr", "basicsr.models", "basicsr.models.archs", "basicsr.utils"]:
            sys.modules.setdefault(package, types.ModuleType(package))
        sys.modules["basicsr.utils"].get_root_logger = logging.getLogger
        arch = source_root / "basicsr/models/archs"
        module("basicsr.models.archs.arch_util", arch / "arch_util.py")
        module("basicsr.models.archs.local_arch", arch / "local_arch.py")
        architecture = module("basicsr.models.archs.NAFNet_arch", arch / "NAFNet_arch.py")
        model = architecture.NAFNetLocal(
            img_channel=3, width=32, middle_blk_num=1,
            enc_blk_nums=[1, 1, 1, 28], dec_blk_nums=[1, 1, 1, 1],
            train_size=(1, 3, 256, 256), fast_imp=False,
        )
    else:
        architecture = module("rapidraw_swinir", source_root / "models/network_swinir.py")
        model = architecture.SwinIR(
            upscale=2, in_chans=3, img_size=64, window_size=8, img_range=1.0,
            depths=[6, 6, 6, 6], embed_dim=60, num_heads=[6, 6, 6, 6],
            mlp_ratio=2, upsampler="pixelshuffledirect", resi_connection="1conv",
        )
    state = torch.load(checkpoint, map_location="cpu", weights_only=True)
    model.load_state_dict(state.get("params", state), strict=True)
    return model.eval(), checkpoint, source_root


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", choices=SPECS, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--threads", type=int, default=4)
    args = parser.parse_args()
    import numpy as np
    import onnx
    import onnxruntime as ort
    import torch

    if not 1 <= args.threads <= 16:
        parser.error("--threads must be between 1 and 16")
    torch.set_num_threads(args.threads)
    torch.manual_seed(0)
    root = args.output_dir.resolve()
    root.mkdir(parents=True, exist_ok=True)
    spec = SPECS[args.model]
    model, checkpoint, source_root = load_model(args.model, root)
    target = root / (args.model + ".onnx")
    partial = root / (args.model + ".partial.onnx")
    if target.exists():
        raise FileExistsError(f"Refusing to replace existing model: {target}")

    probe = torch.rand(1, 3, 128, 128)
    with torch.inference_mode():
        torch.onnx.export(
            model, probe, partial, input_names=["input"], output_names=["output"],
            opset_version=17, dynamo=False, do_constant_folding=True,
            dynamic_axes={"input": {2: "height", 3: "width"}, "output": {2: "output_height", 3: "output_width"}},
        )
    graph = onnx.load(str(partial))
    onnx.checker.check_model(graph)
    options = ort.SessionOptions()
    options.intra_op_num_threads = args.threads
    options.enable_mem_pattern = False
    session = ort.InferenceSession(str(partial), sess_options=options, providers=["CPUExecutionProvider"])
    comparisons = []
    # Validate dynamic shapes, including rectangular input and the maximum tile.
    # Export success alone does not prove transformer attention masks are dynamic.
    for height, width in [(128, 128), (192, 256), (384, 384)]:
        rng = np.random.default_rng(height * 1000 + width)
        pixels = rng.random((1, 3, height, width), dtype=np.float32)
        with torch.inference_mode():
            expected = model(torch.from_numpy(pixels)).numpy()
        actual = session.run(None, {"input": pixels})[0]
        if actual.shape != (1, 3, height * spec["scale"], width * spec["scale"]):
            raise AssertionError(f"Wrong ONNX output shape: {actual.shape}")
        if not np.isfinite(actual).all():
            raise AssertionError("Non-finite ONNX output")
        error = np.abs(actual - expected)
        if float(error.max()) > 2e-3 or float(error.mean()) > 1e-4:
            raise AssertionError(f"ONNX/PyTorch mismatch at {height}x{width}: {error.max()}")
        comparisons.append({"input": [1, 3, height, width], "max_abs_error": float(error.max()), "mean_abs_error": float(error.mean())})
        print(json.dumps(comparisons[-1]), flush=True)

    partial.replace(target)
    receipt = {
        "model_id": args.model, "filename": target.name, "sha256": sha256(target),
        "bytes": target.stat().st_size, "source_repository": f"https://github.com/{spec['repository']}",
        "source_revision": spec["revision"], "checkpoint_sha256": sha256(checkpoint),
        "license": spec["license"], "license_file": str((source_root / "LICENSE").relative_to(root)),
        "input": {"name": "input", "layout": "NCHW", "dtype": "float32", "channels": "RGB", "range": [0, 1], "color_space": "sRGB", "multiple": spec["multiple"], "max_tile": spec["max_tile"]},
        "output": {"name": "output", "layout": "NCHW", "dtype": "float32", "scale": spec["scale"]},
        "export": {"torch": torch.__version__, "onnx": onnx.__version__, "onnxruntime": ort.__version__, "opset": 17, "dynamic_spatial_axes": True},
        "numerical_validation": comparisons,
        "quality_validation": "Export parity only; assess real photographs before choosing strength and performance profiles.",
    }
    target.with_suffix(".export.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps(receipt, indent=2))


if __name__ == "__main__":
    main()
