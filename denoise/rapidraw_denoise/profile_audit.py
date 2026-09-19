"""ORT profile audit: correct provider-tag accounting for a saved trace.

Reads args.provider EXACTLY (case-sensitive). Node events whose names end
in _kernel_time are ordinary ORT operator-level host-observed durations,
NOT separately instrumented device-only CUDA kernel times (device timing
requires CUDA profiling/CUPTI or equivalent such as Nsight Systems).
Session-level events must not be summed with operator durations. Do NOT
subtract summed Node durations from wall-clock tile time and present the
remainder as measured framework/transfer/launch overhead: asynchronous GPU
execution may be waited on at synchronization/output copy. Allocator fields
are ORT telemetry with stated scope, never total process VRAM.
"""
import json
import sys
from collections import Counter
from pathlib import Path


def _event_dur_us(event):
    try:
        dur = event.get("dur", 0) or 0
        return int(dur)
    except (TypeError, ValueError):
        return 0


def audit_profile(path, top_n=10):
    events = json.loads(Path(path).read_text())
    node_events = [e for e in events if e.get("cat") == "Node"]
    other_events = [e for e in events if e.get("cat") != "Node"]
    by_provider: Counter = Counter()
    missing_provider = 0
    op_by_provider: dict[str, Counter] = {}
    memcpy = 0
    dur_by_provider: Counter = Counter()
    dur_by_op: Counter = Counter()
    node_dur_list = []
    for e in node_events:
        args = e.get("args") or {}
        provider = args.get("provider")
        dur = _event_dur_us(e)
        if provider is None:
            missing_provider += 1
            continue
        by_provider[provider] += 1
        # Operator type is args.op_name; the event name is the graph node id.
        op = str(args.get("op_name") or e.get("name", ""))
        op_by_provider.setdefault(provider, Counter())[op] += 1
        if op == "MemcpyToHost":
            memcpy += 1
        dur_by_provider[provider] += dur
        dur_by_op[f"{provider}::{op}"] += dur
        node_dur_list.append((dur, str(e.get("name", "")),
                              op, str(provider)))
    kernel_suffix = sum(1 for e in node_events
                        if "_kernel_time" in str(e.get("name", "")))
    allocator_peaks = {}
    for e in events:
        args = e.get("args") or {}
        for key in ("mem_in_use_peak", "mem_arena_held"):
            if key in args:
                allocator_peaks[key] = max(allocator_peaks.get(key, 0),
                                           int(args[key]))
    unique_nodes = len({e.get("name") for e in node_events})
    total_node_dur = sum(dur_by_provider.values())
    # Top operators by total host-observed duration (shares of Node total).
    top_ops = []
    for key, total in dur_by_op.most_common(top_n):
        provider, _, op = key.partition("::")
        top_ops.append({
            "op": op,
            "provider": provider,
            "total_dur_us": int(total),
            "share": (float(total) / float(total_node_dur)
                      if total_node_dur else 0.0),
        })
    # Top individual node executions by single-event duration.
    node_dur_list.sort(reverse=True)
    top_nodes = [{"node": name, "op": op, "provider": provider,
                  "dur_us": int(dur)}
                 for dur, name, op, provider in node_dur_list[:top_n]]
    gridsample_dur = sum(total for key, total in dur_by_op.items()
                         if key.endswith("::GridSample"))
    return {
        "profile": str(path),
        "total_events": len(events),
        "node_events": len(node_events),
        "unique_graphed_nodes_executed": unique_nodes,
        "node_events_missing_provider_tag": missing_provider,
        "node_events_by_provider": dict(by_provider),
        "ops_by_provider": {k: dict(v) for k, v in op_by_provider.items()},
        "memcpy_to_host_events_included": memcpy,
        "node_names_with_kernel_time_suffix": kernel_suffix,
        "non_node_events": sorted({str(e.get("name")) for e in other_events}),
        "timing_scope": ("operator-level host-observed durations; NOT separately "
                         "instrumented device-only CUDA kernel times "
                         "(use CUPTI/Nsight for device timing; do NOT "
                         "subtract this Node total from wall time as overhead)"),
        "allocator_telemetry_bytes": allocator_peaks,
        "allocator_scope": ("ORT session telemetry fields; NOT total process VRAM"),
        "node_total_dur_us": int(total_node_dur),
        "node_dur_us_by_provider": {k: int(v)
                                    for k, v in dur_by_provider.items()},
        "top_ops_by_dur": top_ops,
        "top_nodes_by_dur": top_nodes,
        "gridsample_dur_us": int(gridsample_dur),
        "gridsample_share": (float(gridsample_dur) / float(total_node_dur)
                             if total_node_dur else 0.0),
        "dur_unit": ("microseconds (ORT profile dur; host-observed operator "
                       "latency, not device kernel time)"),
    }


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if len(argv) != 2:
        print(json.dumps({"status": "error",
                          "error": "usage: profile_audit.py PROFILE_JSON OUTPUT_JSON"}),
              file=sys.stderr)
        return 1
    src, dst = Path(argv[0]), Path(argv[1])
    if dst.exists():
        print(json.dumps({"status": "error",
                          "error": f"refusing to overwrite {dst}"}),
              file=sys.stderr)
        return 1
    try:
        result = audit_profile(src)
    except Exception as exc:
        print(json.dumps({"status": "error",
                          "error": f"{type(exc).__name__}: {exc}"}),
              file=sys.stderr)
        return 1
    dst.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({"status": "ok",
                      "node_events": result["node_events"],
                      "by_provider": result["node_events_by_provider"]},
                     indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
