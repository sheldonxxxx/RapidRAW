"""Portable one-tile ONNX repro from review-archive paths.

Usage: repro_tile.py <bundle_dir> <tile_npz> [--provider PROVIDER | PROVIDER]

Compares saved ORT output with the fixture's direct eager output under the
SAME frozen gate policy as every other entry point (elementwise bound, MAE,
P99, per-channel bias via the shared metric implementation vendored below
from rapidraw_denoise.metrics -- single policy, no weaker repro gate).

Imports only numpy + onnxruntime; never touches Torch (asserted). The
adapter-side contract is enforced here too: pinned checkpoint lineage,
bundle model hash, original float32 dtypes (rejected before any cast),
exact shapes, run-time fallback disabled, live session metadata
cross-checked, and the complete raw output validated before batch 0 is
taken. The CUDA route uses the same controlled precision as the canonical
adapter (explicit ``use_tf32=0`` provider option); effective provider
options are reported, never assumed. Exit codes: 0 = pass, 2 = gate
failure, 1 = tool/invalid error.
"""
import hashlib
import json
import sys

import numpy as np

PINNED_CHECKPOINT_SHA256 = "c16747d852b93a95908792cdbac901f89cca98e35b91ea7db6214de42fbd3cad"
TILE = 320

# Frozen gates (identical values to rapidraw_denoise.metrics).
ATOL, RTOL = 1e-4, 1e-4
MAE_GATE, P99_GATE, CHANNEL_BIAS_GATE = 1e-5, 1e-4, 1e-5


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for block in iter(lambda: stream.read(4 * 1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def fail(message):
    print(json.dumps({"status": "error", "error": message}), file=sys.stderr)
    return 1


def main(argv):
    # Provider forms: bare 4th arg ("CPUExecutionProvider"), "--provider X",
    # or "--provider=X". Default is CPU.
    provider = "CPUExecutionProvider"
    rest = list(argv[1:])
    if len(rest) < 2 or len(rest) > 4:
        return fail("usage: repro_tile.py <bundle_dir> <tile_npz> "
                    "[--provider PROVIDER | PROVIDER]")
    bundle, tile = rest[0], rest[1]
    extra = rest[2:]
    if extra == []:
        pass
    elif len(extra) == 1 and not extra[0].startswith("--"):
        provider = extra[0]  # bare 4th argument (historical form)
    elif len(extra) == 2 and extra[0] == "--provider" and extra[1]:
        provider = extra[1]
    elif (len(extra) == 1 and extra[0].startswith("--provider=")
            and extra[0].split("=", 1)[1]):
        provider = extra[0].split("=", 1)[1]
    else:
        return fail("usage: repro_tile.py <bundle_dir> <tile_npz> "
                    "[--provider PROVIDER | PROVIDER]")
    if not provider:
        return fail("empty provider name")
    manifest_path = f"{bundle}/manifest.json"
    model_path = f"{bundle}/model.onnx"
    try:
        import onnxruntime as ort
    except ModuleNotFoundError as exc:
        return fail(f"onnxruntime is required: {exc}")
    # Standalone contract: this file must never import Torch itself (verified
    # statically by the contract suite and at runtime by fresh-process runs).
    # `torch_imported` below is informational: an embedding process may have
    # imported Torch beforehand, which says nothing about this script.

    try:
        manifest = json.loads(open(manifest_path).read())
    except FileNotFoundError:
        return fail(f"missing bundle manifest: {manifest_path}")
    if manifest.get("manifest_version") != 1:
        return fail(f"Unknown manifest version: {manifest.get('manifest_version')}")
    lineage = manifest.get("source_checkpoint_sha256")
    if (not lineage or lineage == "0" * 64
            or manifest.get("checkpoint_pinned_match") is not True
            or lineage != PINNED_CHECKPOINT_SHA256):
        return fail("bundle checkpoint lineage is not the pinned checkpoint")
    if manifest.get("precision") != "fp32":
        return fail(f"Unknown bundle precision: {manifest.get('precision')}")
    try:
        if manifest.get("model_sha256") != sha256_file(model_path):
            return fail("bundle model hash mismatch (modified graph rejected)")
    except FileNotFoundError:
        return fail(f"missing bundle model: {model_path}")

    try:
        with np.load(tile, allow_pickle=False) as f:
            if not {"input", "output"}.issubset(f.files):
                return fail(f"fixture {tile} must contain input+output arrays")
            x_raw, ref_raw = f["input"], f["output"]
            if np.asarray(x_raw).dtype != np.dtype("float32"):
                return fail(f"fixture input has original dtype "
                            f"{np.asarray(x_raw).dtype}; only float32 accepted")
            if np.asarray(ref_raw).dtype != np.dtype("float32"):
                return fail(f"fixture output has original dtype "
                            f"{np.asarray(ref_raw).dtype}; only float32 accepted")
            x = np.ascontiguousarray(x_raw)
            ref = np.ascontiguousarray(ref_raw)
    except FileNotFoundError:
        return fail(f"missing fixture: {tile}")
    if x.shape != (1, 8, TILE, TILE) or ref.shape != (1, 4, TILE, TILE):
        return fail(f"fixture shapes {x.shape}/{ref.shape} != "
                    f"[1,8,{TILE},{TILE}]/[1,4,{TILE},{TILE}]")
    if not np.isfinite(x).all() or not np.isfinite(ref).all():
        return fail("fixture contains non-finite values")

    try:
        available = ort.get_available_providers()
    except Exception as exc:
        return fail(f"could not list ORT providers: {exc}")
    if provider not in available:
        return fail(f"requested provider {provider} unavailable "
                    f"(available: {available}); refusing silent fallback")
    try:
        opts = ort.SessionOptions()
        opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_DISABLE_ALL
        # Controlled precision parity with the canonical adapter: CUDA runs
        # must explicitly disable TF32 (ORT defaults use_tf32=1).
        provider_options = ([{"use_tf32": "0"}]
                            if provider == "CUDAExecutionProvider" else None)
        kwargs = {"sess_options": opts, "providers": [provider]}
        if provider_options is not None:
            kwargs["provider_options"] = provider_options
        session = ort.InferenceSession(model_path, **kwargs)
        disable = getattr(session, "disable_fallback", None)
        if disable is None:
            return fail("ORT session lacks disable_fallback(); refusing to run")
        disable()
        live = session.get_providers()
        if provider not in live:
            return fail(f"session did not take {provider} (actual: {live})")
        inputs, outputs = session.get_inputs(), session.get_outputs()
        if (len(inputs) != 1 or inputs[0].name != manifest["input_name"]
                or [int(v) for v in inputs[0].shape] != [1, 8, TILE, TILE]
                or inputs[0].type != "tensor(float)"):
            return fail("session input metadata != manifest contract")
        if (len(outputs) != 1 or outputs[0].name != manifest["output_name"]
                or [int(v) for v in outputs[0].shape] != [1, 4, TILE, TILE]
                or outputs[0].type != "tensor(float)"):
            return fail("session output metadata != manifest contract")
        raw = session.run([manifest["output_name"]],
                          {manifest["input_name"]: x})[0]
    except Exception as exc:
        return fail(f"{type(exc).__name__}: {exc}")
    if (not isinstance(raw, np.ndarray) or raw.ndim != 4
            or raw.shape != (1, 4, TILE, TILE)
            or raw.dtype != np.dtype("float32")
            or not np.isfinite(raw).all()):
        return fail("invalid session output "
                    f"(shape={getattr(raw, 'shape', None)}, "
                    f"dtype={getattr(raw, 'dtype', None)})")

    # Shared gate policy: elementwise bound, MAE, P99, per-channel bias.
    actual = raw.astype("float64")
    refr = ref.astype("float64")
    ae = np.abs(actual - refr)
    bound = ATOL + RTOL * np.abs(refr)
    violations = int((ae > bound).sum())
    mae = float(ae.mean())
    p99 = float(np.quantile(ae, 0.99))
    bias = [float((actual[:, c] - refr[:, c]).mean()) for c in range(4)]
    result = {
        "bundle": bundle, "tile": tile, "provider": provider,
        "providers_actual": session.get_providers(),
        "provider_options_effective": provider_options,
        "fallback_disabled": True,
        "max_abs_err": float(ae.max()), "mae": mae, "p99_abs_err": p99,
        "signed_mean_err_per_channel": bias,
        "violations": violations,
        "torch_imported": "torch" in sys.modules,
    }
    print(json.dumps(result, indent=2))
    ok = (violations == 0 and mae <= MAE_GATE and p99 <= P99_GATE
          and all(abs(b) <= CHANNEL_BIAS_GATE for b in bias))
    return 0 if ok else 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
