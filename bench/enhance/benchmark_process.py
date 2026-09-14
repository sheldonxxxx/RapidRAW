#!/usr/bin/env python3
"""Record sampled process-tree RSS and device VRAM for a benchmark command.

Requires psutil. Pass --output result.json -- followed by a command and arguments.
The command's normal output remains visible. GPU occupancy includes other apps;
memory sampling is evidence, not a guarantee of the absolute allocation peak.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import subprocess
import time

import psutil
from storage_policy import require_free_space


def gpu_memory():
    try:
        result = subprocess.run(["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits", "--id=0"], check=True, text=True, capture_output=True, timeout=2)
        return int(result.stdout.strip())
    except (OSError, ValueError, subprocess.SubprocessError):
        return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command:
        parser.error("Provide a benchmark command after --")
    if args.output.exists():
        parser.error("Output already exists; choose a new evidence file")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    require_free_space(args.output.parent)
    baseline = gpu_memory()
    samples = []
    started = time.monotonic()
    child = subprocess.Popen(command)
    process = psutil.Process(child.pid)
    while child.poll() is None:
        try:
            tree = [process, *process.children(recursive=True)]
            rss = 0
            for member in tree:
                try:
                    rss += member.memory_info().rss
                except (psutil.Error, OSError):
                    pass
            samples.append({"seconds": time.monotonic() - started, "rss_process_tree_bytes": rss, "process_count": len(tree), "gpu_device_used_mib": gpu_memory() if baseline is not None else None})
        except (psutil.Error, OSError):
            pass
        time.sleep(0.2)
    gpu = [s["gpu_device_used_mib"] for s in samples if s["gpu_device_used_mib"] is not None]
    report = {
        "schema_version": 1, "exit_code": child.returncode, "elapsed_seconds": time.monotonic() - started,
        "sample_count": len(samples), "peak_sampled_process_tree_rss_bytes": max((s["rss_process_tree_bytes"] for s in samples), default=None),
        "gpu_device_baseline_mib": baseline, "gpu_device_peak_sampled_mib": max(gpu, default=None),
        "sampling_interval_seconds": 0.2, "samples": samples,
        "limits": "RSS sums may count shared pages more than once; GPU memory includes all device users. Sampling misses shorter-lived peaks.",
    }
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({k: v for k, v in report.items() if k != "samples"}))
    return child.returncode


if __name__ == "__main__":
    raise SystemExit(main())
