"""Audit CPU-placed Expand nodes: dtype/shape/deps/sizes/consumers + profile timing."""
import json
import re

import numpy as np
import onnx
import onnxruntime as ort

MODEL = "/tmp/nlx-model/bundle-pinned-320-fp32/model.onnx"
PLACE_LOG = "/tmp/nlx-placement.log"

proto = onnx.load(MODEL)
try:
    proto = onnx.shape_inference.infer_shapes(proto, strict_mode=True)
    print("shape inference: ok")
except Exception as e:
    print("shape inference failed:", e)
nodes = {n.name: n for n in proto.graph.node}
inits = {i.name: i for i in proto.graph.initializer}

cpu_names = []
grab = False
with open(PLACE_LOG) as f:
    for line in f:
        if "Number of nodes: 59" in line:
            grab = True
            continue
        if "Number of nodes: 3600" in line:
            break
        if grab:
            m = re.search(r"^\s*(\S+) \((node_[^)]+)\)", line.split("]  ", 1)[-1])
            if m:
                cpu_names.append((m.group(1), m.group(2)))
print("cpu nodes listed:", len(cpu_names))

# Type/shape environment.
types = {}
for v in list(proto.graph.input) + list(proto.graph.value_info) + list(
    proto.graph.output
):
    t = v.type.tensor_type
    dims = [d.dim_value for d in t.shape.dim]
    types[v.name] = (t.elem_type, dims)
for name, init in inits.items():
    types[name] = (init.data_type, list(init.dims))

consumers = {}
for n in proto.graph.node:
    for i in n.input:
        consumers.setdefault(i, []).append(f"{n.op_type}({n.name})")

from collections import Counter

groups: Counter = Counter()
detail = []
for op, name in cpu_names:
    n = nodes[name]
    assert n.op_type == op == "Expand", (op, name)
    out = n.output[0]
    etype, dims = types[out]
    assert all(d >= 0 for d in dims), (name, dims)
    nelems = 1
    for d in dims:
        nelems *= d
    total_elems = 0  # recomputed below
    dtype = {1: "float32", 7: "int64"}.get(etype, f"elem_{etype}")
    groups[(dtype, tuple(dims))] += 1
    detail.append((name, dtype, dims, nelems, consumers.get(out, [])))
print("cpu Expand groups (dtype, shape) -> count:")
grand = 0
for key in sorted(groups):
    print("  ", key, groups[key])
print("sample nodes (first 2 per group):")
shown: Counter = Counter()
for name, dtype, dims, nelems, cons in detail:
    grand += nelems
    if shown[(dtype, tuple(dims))] < 2:
        print(f"  {name}: {dtype} {dims} ({nelems} elems) consumers={cons}")
        shown[(dtype, tuple(dims))] += 1
print("total output elems:", grand)
all_cons = set()
for op, name in cpu_names:
    all_cons.update(consumers.get(nodes[name].output[0], []))
print("distinct consumer nodes:", len(all_cons))
print("consumer kinds:", sorted(set(c.split('(')[0] for c in all_cons)))

# Profile: one tile, separate graph nodes vs execution events, host vs kernel.
with np.load(
    "/tmp/nlx-fixtures/portrait-controlled-fp32/tiles/tile-00.npz",
    allow_pickle=False,
) as f:
    x = np.ascontiguousarray(f["input"]).astype("float32")

opts = ort.SessionOptions()
opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_DISABLE_ALL
opts.enable_profiling = True
opts.profile_file_prefix = "/tmp/nlx-expand-audit"
session = ort.InferenceSession(
    MODEL,
    sess_options=opts,
    providers=["CUDAExecutionProvider"],
    provider_options=[{"use_tf32": "0"}],
)
ro = ort.RunOptions()
ro.add_run_config_entry("gpu_profiler_enable", "true")
session.run(["denoised_raw"], {"raw_with_noise": x}, run_options=ro)
prof_path = session.end_profiling()
print("profile:", prof_path)
events = json.load(open(prof_path))
print("total events:", len(events))
node_events = [e for e in events if e.get("cat") == "Node"]
print("Node events:", len(node_events))
uniq_nodes = set(e["name"] for e in node_events)
print("unique graphed nodes executed:", len(uniq_nodes))
cuda_eps = [e for e in node_events if "Cuda" in str(e.get("args", {}).get("provider", ""))]
print("Node events with CUDA provider tag:", len(cuda_eps))
kern = [e for e in events if "kernel" in str(e.get("cat", "")).lower() or "Kernel" in e.get("name", "")]
print("kernel-like events:", len(kern))
host_dur = sum(e.get("dur", 0) for e in node_events)
print("sum Node dur (us, host-observed operator time):", host_dur)
