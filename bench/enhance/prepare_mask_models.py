#!/usr/bin/env python3
"""Prepare optional native masking models without uploading photographs.

ViTMatte and face parsing download pinned ONNX assets. Landscape segmentation
exports the MIT-labelled OpenMMLab UperNet ConvNeXt-tiny checkpoint locally.
Install the optional export dependencies in an isolated environment:
  uv pip install torch==2.8.0 transformers==4.57.3 onnx==1.19.1 onnxruntime==1.23.2 pillow

The output manifest records source revision, asset SHA-256, shapes and a parity
check. Pass a destination outside tracked source, then import the model directory.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import tempfile
import urllib.request


ASSETS = {
    "vitmatte": {
        "filename": "vitmatte-small-f32.onnx",
        "url": "https://huggingface.co/Xenova/vitmatte-small-composition-1k/resolve/6bc1297f6140f055a227b6d2cfe8c093281f35d2/onnx/model.onnx",
        "sha256": "bf28d2e0be2c073286e88d60ad649d7123da2749a2d99133fd1098d5887e0225",
        "bytes": 103885865,
        "license": "Apache-2.0 (checkpoint), MIT (original implementation)",
        "source": "https://huggingface.co/hustvl/vitmatte-small-composition-1k",
    },
    "face": {
        "filename": "face-parsing-resnet18.onnx",
        "url": "https://github.com/yakhyo/face-parsing/releases/download/weights/resnet18.onnx",
        "sha256": "0d9bd318e46987c3bdbfacae9e2c0f461cae1c6ac6ea6d43bbe541a91727e33f",
        "bytes": 53205364,
        "license": "MIT (upstream project)",
        "source": "https://github.com/yakhyo/face-parsing",
    },
}
LANDSCAPE_ID = "openmmlab/upernet-convnext-tiny"
LANDSCAPE_REVISION = "876ffc56b819a829448f7e81e9f8606deef6fb65"


def digest(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def fetch_asset(asset: dict, output: Path) -> dict:
    path = output / asset["filename"]
    if path.exists() and digest(path) == asset["sha256"]:
        return asset
    with tempfile.NamedTemporaryFile(dir=output, prefix=path.name, suffix=".part", delete=False) as stream:
        temporary = Path(stream.name)
        try:
            with urllib.request.urlopen(asset["url"], timeout=120) as response:
                while chunk := response.read(1024 * 1024):
                    stream.write(chunk)
            stream.flush()
            if temporary.stat().st_size != asset["bytes"] or digest(temporary) != asset["sha256"]:
                raise RuntimeError(f"Model checksum mismatch: {asset['filename']}")
            temporary.replace(path)
        finally:
            temporary.unlink(missing_ok=True)
    return asset


def export_landscape(output: Path) -> dict:
    import math
    import numpy as np
    import onnx
    import onnxruntime as ort
    import torch
    from transformers import UperNetForSemanticSegmentation

    class FixedAdaptivePool(torch.nn.Module):
        """Exact adaptive average pooling using exportable static slices."""

        def __init__(self, size):
            super().__init__()
            self.size = (size, size) if isinstance(size, int) else size

        def forward(self, value):
            height, width = value.shape[-2:]
            rows = []
            for y in range(self.size[0]):
                cells = []
                for x in range(self.size[1]):
                    y0, y1 = math.floor(y * height / self.size[0]), math.ceil((y + 1) * height / self.size[0])
                    x0, x1 = math.floor(x * width / self.size[1]), math.ceil((x + 1) * width / self.size[1])
                    cells.append(value[:, :, y0:y1, x0:x1].mean((-2, -1), keepdim=True))
                rows.append(torch.cat(cells, dim=-1))
            return torch.cat(rows, dim=-2)

    def replace_pools(module):
        for name, child in list(module.named_children()):
            if isinstance(child, torch.nn.AdaptiveAvgPool2d):
                replacement = FixedAdaptivePool(child.output_size)
                setattr(module, name, replacement)
                # Transformers 4.57 UperNet also keeps its registered children
                # in a plain `layers` list used by forward(). Update that alias.
                for value in vars(module).values():
                    if isinstance(value, list):
                        for index, item in enumerate(value):
                            if item is child:
                                value[index] = replacement
            else:
                replace_pools(child)

    class LogitsOnly(torch.nn.Module):
        def __init__(self, model):
            super().__init__()
            self.model = model

        def forward(self, pixel_values):
            return self.model(pixel_values=pixel_values).logits

    model = UperNetForSemanticSegmentation.from_pretrained(
        LANDSCAPE_ID, revision=LANDSCAPE_REVISION, use_safetensors=True
    ).eval()
    torch.set_num_threads(min(4, os.cpu_count() or 1))
    torch.manual_seed(42)
    sample = torch.rand(1, 3, 512, 512) * 2 - 1
    with torch.inference_mode():
        original = model(pixel_values=sample).logits.numpy()
    replace_pools(model)
    wrapped = LogitsOnly(model).eval()
    with torch.inference_mode():
        replacement = wrapped(sample).numpy()
    pool_max_error = float(np.abs(original - replacement).max())
    if not np.allclose(original, replacement, rtol=1e-4, atol=2e-4):
        raise RuntimeError(f"Adaptive pooling replacement failed parity: {pool_max_error}")
    path = output / "upernet-convnext-tiny.onnx"
    temporary = path.with_suffix(".onnx.part")
    try:
        torch.onnx.export(
            wrapped, sample, str(temporary), export_params=True,
            opset_version=17, do_constant_folding=True,
            input_names=["pixel_values"], output_names=["logits"],
            dynamo=False,
        )
        onnx.checker.check_model(str(temporary))
        session_options = ort.SessionOptions()
        session_options.intra_op_num_threads = min(4, os.cpu_count() or 1)
        session = ort.InferenceSession(str(temporary), sess_options=session_options, providers=["CPUExecutionProvider"])
        actual = session.run(None, {"pixel_values": sample.numpy()})[0]
        max_error = float(np.abs(original - actual).max())
        agreement = float((original.argmax(1) == actual.argmax(1)).mean())
        if not np.isfinite(actual).all() or not np.allclose(original, actual, rtol=2e-3, atol=2e-3) or agreement < 0.999:
            raise RuntimeError(f"ONNX parity failed: max error {max_error}, label agreement {agreement}")
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)
    return {
        "filename": path.name, "sha256": digest(path), "bytes": path.stat().st_size,
        "source": f"https://huggingface.co/{LANDSCAPE_ID}", "revision": LANDSCAPE_REVISION,
        "license": "MIT (upstream checkpoint card)",
        "input": {"pixel_values": [1, 3, 512, 512]},
        "output": {"logits": [1, 150, 512, 512]},
        "parity": {"pool_max_error": pool_max_error, "max_error": max_error, "label_agreement": agreement},
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--models", choices=["vitmatte", "face", "landscape"], nargs="+", default=["vitmatte", "face", "landscape"])
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    os.environ.setdefault("HF_HOME", str(args.output / "hf-cache"))
    manifest = {}
    manifest_path = args.output / "mask-models.json"
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text())
    for name in args.models:
        print(f"Preparing {name}...", flush=True)
        manifest[name] = export_landscape(args.output) if name == "landscape" else fetch_asset(ASSETS[name], args.output)
        manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
        print(json.dumps(manifest[name]), flush=True)


if __name__ == "__main__":
    main()
