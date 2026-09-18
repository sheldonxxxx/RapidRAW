"""Disposable-environment CoreML converter-compatibility probe (diagnostic only).

Modes (argv):
  env             record interpreter/arch/package identity as JSON (no conversion)
  minimal-int     convert a tiny traced module that forces aten::Int shape
                  handling (mirrors the packed sampler's int(x.shape) path);
                  expects the NumPy>=2.4 scalar-cast failure in bad envs
  trivial-predict convert + natively predict a tiny Linear model, proving
                  wheel/arch/runtime loading separately from Nonlocal conversion

No weights, no fixtures, no production code paths. Prints one JSON object.
"""
import argparse
import json
import platform
import sys


def env_record():
    rec = {"python": sys.version.split()[0],
           "executable": sys.executable,
           "platform": platform.platform(),
           "machine": platform.machine(),
           "os_version": platform.mac_ver()[0]}
    import importlib.metadata as md
    for pkg in ("torch", "numpy", "coremltools", "einops", "scipy"):
        try:
            rec[pkg] = md.version(pkg)
        except Exception:
            rec[pkg] = None
    try:
        import coremltools, os
        rec["coremltools_path"] = os.path.realpath(coremltools.__file__)
        import inspect
        from coremltools.converters.mil.frontend.torch import ops
        src = inspect.getsource(ops._cast)
        rec["converter__cast_uses_dtype_of_val"] = "dtype(x.val)" in src
    except Exception as exc:
        rec["coremltools_path"] = f"unavailable: {exc}"
    return rec


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=("env", "minimal-int", "trivial-predict"))
    ns = ap.parse_args()
    import warnings
    warnings.filterwarnings("ignore")
    rep = {"mode": ns.mode, "env": env_record()}
    if ns.mode == "env":
        rep["status"] = "env-recorded"
        print(json.dumps(rep, indent=2))
        return
    try:
        import numpy as np
        import torch
        import coremltools as ct
        if ns.mode == "minimal-int":
            class ShapeInt(torch.nn.Module):
                def forward(self, x):
                    b, c, h, w = (int(v) for v in x.shape)
                    y = x.reshape(b, c, h * w).reshape(b, c, h, w)
                    return y + float(c)
            m = ShapeInt().eval()
            with torch.no_grad():
                traced = torch.jit.trace(m, torch.zeros(1, 2, 8, 8),
                                         strict=False, check_trace=False)
            ml = ct.convert(
                traced,
                inputs=[ct.TensorType(name="x", shape=(1, 2, 8, 8),
                                      dtype=np.float32)],
                minimum_deployment_target=ct.target.macOS15)
            rep["status"] = "converted"
            rep["spec_description"] = str(ml.get_spec().description)[:200]
        else:
            m = torch.nn.Sequential(torch.nn.Linear(4, 4)).eval()
            with torch.no_grad():
                traced = torch.jit.trace(m, torch.zeros(1, 4),
                                         strict=False, check_trace=False)
            ml = ct.convert(
                traced, inputs=[ct.TensorType(name="x", shape=(1, 4))],
                minimum_deployment_target=ct.target.macOS15)
            out = ml.predict({"x": np.zeros((1, 4), dtype=np.float32)})
            rep["status"] = "predicted"
            rep["output_keys"] = sorted(out.keys())
    except Exception as exc:
        import traceback
        rep["status"] = "error"
        rep["error"] = f"{type(exc).__name__}: {exc}"
        rep["traceback_tail"] = traceback.format_exc()[-1500:]
    print(json.dumps(rep, indent=2))


if __name__ == "__main__":
    main()
