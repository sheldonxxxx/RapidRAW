"""Bounded direct CoreML MLProgram conversion of the packed Torch model.

Strict-loaded pinned checkpoint (CPU), export-only packed sampler route
(same as the packed ONNX export), explicit FLOAT32 compute precision and
float32 TensorType I/O. Writes an .mlpackage plus a manifest carrying the
pinned checkpoint lineage and the package hash. One bounded attempt: any
converter failure is reported with exact diagnostics, not retried with
different precision.

Usage: convert_coreml_direct.py --checkpoint CKPT --output DIR
"""
import argparse
import hashlib
import json
import sys
from pathlib import Path


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for block in iter(lambda: stream.read(4 * 1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--checkpoint", required=True)
    ap.add_argument("--output", required=True)
    args = ap.parse_args()
    out = Path(args.output)
    if out.exists():
        print(json.dumps({"status": "error",
                          "error": f"refusing to overwrite {out}"}),
              file=sys.stderr)
        return 1
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    import numpy as np
    import torch

    from rapidraw_denoise.inference import load_model
    from rapidraw_denoise.vendor.nonlocalmf import network as network_mod
    from rapidraw_denoise.vendor.nonlocalmf import sampling as sampling_mod

    ckpt = Path(args.checkpoint)
    if sha256_file(ckpt) != "c16747d852b93a95908792cdbac901f89cca98e35b91ea7db6214de42fbd3cad":
        print(json.dumps({"status": "error",
                          "error": "checkpoint is not the pinned weights"}),
              file=sys.stderr)
        return 1
    try:
        import coremltools as ct
    except ModuleNotFoundError as exc:
        print(json.dumps({"status": "error",
                          "error": f"coremltools is required: {exc}"}),
              file=sys.stderr)
        return 1
    model = load_model(str(ckpt), device="cpu")
    model.eval().float()
    network_mod.deform_neighbourhood = \
        __import__("rapidraw_denoise.static_packed_sampler",
                   fromlist=["packed_deform_neighbourhood"]).packed_deform_neighbourhood
    try:
        example = torch.zeros(1, 8, 320, 320)
        with torch.no_grad():
            # check_trace=False: the tracer's own double-invocation graph
            # comparison is sensitive to the export-only Python dispatch
            # (shape-keyed module cache); trace validity is instead verified
            # numerically below (traced vs eager) and against fixtures later.
            traced = torch.jit.trace(model, example, strict=False,
                                     check_trace=False)
            eager = model(example)
            traced_out = traced(example)
        trace_max = float((traced_out - eager).abs().max())
        print(json.dumps({"trace_vs_eager_max": trace_max}), flush=True)
        if trace_max > 1e-5:
            return 1
        mlmodel = ct.convert(
            traced,
            inputs=[ct.TensorType(name="raw_with_noise", shape=(1, 8, 320, 320),
                                  dtype=np.float32)],
            outputs=[ct.TensorType(name="denoised_raw", dtype=np.float32)],
            compute_precision=ct.precision.FLOAT32,
            minimum_deployment_target=ct.target.macOS15,
        )
    except Exception as exc:
        import traceback
        print(json.dumps({"status": "error",
                          "error": f"{type(exc).__name__}: {exc}",
                          "traceback": traceback.format_exc()[-3000:]}))
        return 1
    finally:
        network_mod.deform_neighbourhood = sampling_mod.deform_neighbourhood
    out.mkdir(parents=True)
    mlmodel.save(str(out / "packed.mlpackage"))
    # Hash the whole package (weights + graph).
    digest = hashlib.sha256()
    for p in sorted((out / "packed.mlpackage").rglob("*")):
        if p.is_file():
            digest.update(p.name.encode())
            with open(p, "rb") as s:
                for block in iter(lambda: s.read(4 * 1024 * 1024), b""):
                    digest.update(block)
    manifest = {
        "manifest_version": 1,
        "artifact": "packed.mlpackage",
        "conversion": "coremltools-direct-torchscript",
        "coremltools": ct.__version__,
        "torch": torch.__version__,
        "compute_precision": "FLOAT32",
        "sampler_implementation": "static-packed (static-packed-v1; export-only route)",
        "source_checkpoint_sha256": sha256_file(ckpt),
        "checkpoint_pinned_match": True,
        "input": {"name": "raw_with_noise", "shape": [1, 8, 320, 320], "dtype": "float32"},
        "output": {"name": "denoised_raw", "shape": [1, 4, 320, 320], "dtype": "float32"},
        "package_sha256": digest.hexdigest(),
        "trace_vs_eager_max": trace_max,
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps({"status": "converted", "output": str(out),
                      "package_sha256": digest.hexdigest()}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
