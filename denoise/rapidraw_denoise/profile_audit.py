"""ORT profile audit: correct provider-tag accounting for a saved trace.

Reads args.provider EXACTLY (case-sensitive). Node events whose names end
in _kernel_time are ordinary ORT operator-level durations, NOT separately
instrumented device-only CUDA kernel times. Session-level events must not be
summed with operator durations. Allocator fields are ORT telemetry with
stated scope, never total process VRAM.
"""
import json
import sys
from collections import Counter
from pathlib import Path


def audit_profile(path):
    events = json.loads(Path(path).read_text())
    node_events = [e for e in events if e.get("cat") == "Node"]
    other_events = [e for e in events if e.get("cat") != "Node"]
    by_provider: Counter = Counter()
    missing_provider = 0
    op_by_provider: dict[str, Counter] = {}
    memcpy = 0
    for e in node_events:
        args = e.get("args") or {}
        provider = args.get("provider")
        if provider is None:
            missing_provider += 1
            continue
        by_provider[provider] += 1
        # Operator type is args.op_name; the event name is the graph node id.
        op = str(args.get("op_name") or e.get("name", ""))
        op_by_provider.setdefault(provider, Counter())[op] += 1
        if op == "MemcpyToHost":
            memcpy += 1
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
                         "instrumented device-only CUDA kernel times"),
        "allocator_telemetry_bytes": allocator_peaks,
        "allocator_scope": ("ORT session telemetry fields; NOT total process VRAM"),
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
