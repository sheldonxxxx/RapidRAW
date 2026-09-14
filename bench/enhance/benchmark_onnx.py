#!/usr/bin/env python3
"""Measure an installed enhancement model without downloading weights.

Dependencies: numpy, Pillow, onnxruntime (or onnxruntime-gpu), psutil.
This measures direct model inference, not RapidRAW rendering or export latency.
Use a fresh output directory for each image/model/provider configuration.
"""

from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import platform
import statistics
import subprocess
import sys
import threading
import time

import numpy as np
import onnxruntime as ort
from PIL import Image
import psutil


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


class MemorySampler:
    """Sample resident memory; GPU readings are whole-device, not allocations."""

    def __init__(self, gpu: bool):
        self.process = psutil.Process()
        self.gpu = gpu
        self.stop = threading.Event()
        self.samples: list[dict] = []
        self.thread = threading.Thread(target=self._run, daemon=True)

    def _sample(self):
        sample = {"seconds": time.monotonic(), "rss_bytes": self.process.memory_info().rss}
        if self.gpu:
            try:
                result = subprocess.run(
                    ["nvidia-smi", "--query-gpu=memory.used,utilization.gpu", "--format=csv,noheader,nounits", "--id=0"],
                    check=True, capture_output=True, text=True, timeout=2,
                )
                used, utilization = result.stdout.strip().split(",")
                sample.update(gpu_device_used_mib=int(used), gpu_utilization_percent=int(utilization))
            except (OSError, ValueError, subprocess.SubprocessError):
                pass
        self.samples.append(sample)

    def _run(self):
        while not self.stop.wait(0.2):
            self._sample()

    def __enter__(self):
        self._sample()
        self.thread.start()
        return self

    def __exit__(self, *_):
        self.stop.set()
        self.thread.join(timeout=3)
        self._sample()

    def summary(self):
        gpu = [s["gpu_device_used_mib"] for s in self.samples if "gpu_device_used_mib" in s]
        return {
            "sample_count": len(self.samples),
            "interval_seconds": 0.2,
            "baseline_rss_bytes": self.samples[0]["rss_bytes"],
            "peak_sampled_rss_bytes": max(s["rss_bytes"] for s in self.samples),
            "gpu_device_baseline_mib": gpu[0] if gpu else None,
            "gpu_device_peak_sampled_mib": max(gpu) if gpu else None,
            "gpu_scope": "Whole-device occupancy, includes other processes; sampled peaks may miss transients.",
        }


def prepare(args):
    with Image.open(args.image) as image:
        image = image.convert("RGB")
    source_size = image.size
    if args.size:
        image = image.resize((args.size, args.size), Image.Resampling.BICUBIC)
    rgb = np.asarray(image).astype(np.float32) / 255.0
    height, width = rgb.shape[:2]
    if args.kind == "matting":
        if args.trimap is None:
            raise ValueError("Matting requires --trimap with 0, 128 and 255 labels")
        with Image.open(args.trimap) as trimap:
            trimap = np.asarray(trimap.convert("L").resize(image.size, Image.Resampling.NEAREST))
        trimap = np.where(trimap < 64, 0.0, np.where(trimap > 192, 1.0, 128.0 / 255.0)).astype(np.float32)
        data = np.concatenate((rgb * 2.0 - 1.0, trimap[..., None]), axis=2)
    elif args.kind == "segmentation":
        data = (rgb - np.array([0.485, 0.456, 0.406], np.float32)) / np.array([0.229, 0.224, 0.225], np.float32)
    else:
        data = rgb
    if args.multiple:
        pad_height = (-height) % args.multiple
        pad_width = (-width) % args.multiple
        data = np.pad(data, ((0, pad_height), (0, pad_width), (0, 0)), mode="constant" if args.kind == "matting" else "reflect")
    tensor = np.ascontiguousarray(data.transpose(2, 0, 1)[None])
    image.save(args.output / "input.png")
    return tensor, source_size, (width, height)


def save_result(output, args, input_size):
    array = np.asarray(output)
    if not np.isfinite(array).all():
        raise ValueError("Model returned nonfinite output")
    np.save(args.output / "output.npy", array)
    if args.kind == "segmentation":
        labels = array[0].argmax(axis=0).astype(np.uint8)
        Image.fromarray(labels).save(args.output / "labels.png")
        if args.class_ids:
            mask = np.isin(labels, args.class_ids).astype(np.uint8) * 255
            Image.fromarray(mask).save(args.output / "output.png")
    elif args.kind == "matting":
        width, height = input_size
        alpha = np.clip(array.squeeze()[:height, :width], 0, 1)
        Image.fromarray((alpha * 255).round().astype(np.uint8)).save(args.output / "output.png")
    else:
        width, height = input_size
        image = array[0].transpose(1, 2, 0)[: height * args.scale, : width * args.scale]
        Image.fromarray((np.clip(image, 0, 1) * 255).round().astype(np.uint8)).save(args.output / "output.png")
    return {"shape": list(array.shape), "minimum": float(array.min()), "maximum": float(array.max()), "finite": True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", required=True, type=Path)
    parser.add_argument("--image", required=True, type=Path)
    parser.add_argument("--kind", required=True, choices=["matting", "segmentation", "restoration"])
    parser.add_argument("--provider", required=True, choices=["cpu", "coreml", "cuda"])
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--trimap", type=Path)
    parser.add_argument("--size", type=int, default=0, help="Square model input; 0 preserves image dimensions")
    parser.add_argument("--multiple", type=int, default=32, help="Pad dynamic inputs to this multiple (zero for matting, reflection otherwise)")
    parser.add_argument("--scale", type=int, default=1)
    parser.add_argument("--class-ids", type=int, nargs="*")
    parser.add_argument("--runs", type=int, default=3, help="Warm runs after the first inference")
    parser.add_argument("--threads", type=int, default=4)
    parser.add_argument("--gpu-memory-mib", type=int, default=4096)
    parser.add_argument("--coreml-units", choices=["ALL", "CPUAndGPU", "CPUAndNeuralEngine", "CPUOnly"], default="ALL")
    parser.add_argument("--timeout-seconds", type=int, default=600)
    parser.add_argument("--worker", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.runs < 1 or args.size < 0 or args.threads < 1 or args.multiple < 1 or args.scale < 1 or args.timeout_seconds < 1 or args.gpu_memory_mib < 1:
        parser.error("Runs, threads, multiple, scale, timeout and GPU memory must be positive; size must be nonnegative")
    if not args.worker:
        if args.output.exists():
            parser.error("Output directory already exists; retain evidence and choose a new directory")
        try:
            result = subprocess.run([sys.executable, str(Path(__file__).resolve()), *sys.argv[1:], "--worker"], timeout=args.timeout_seconds)
            status = {"status": "process_failure", "returncode": result.returncode}
        except subprocess.TimeoutExpired:
            status = {"status": "timeout", "timeout_seconds": args.timeout_seconds}
        if not (args.output / "result.json").exists():
            args.output.mkdir(parents=True, exist_ok=True)
            status.update(schema_version=1, model_name=args.model.name, requested_provider=args.provider,
                          measurement_scope="Benchmark worker terminated before reporting; this is not a successful provider result")
            (args.output / "result.json").write_text(json.dumps(status, indent=2) + "\n")
            print(json.dumps(status))
            return 1
        return 0 if json.loads((args.output / "result.json").read_text()).get("status") == "completed" else 1
    args.output.mkdir(parents=True, exist_ok=False)
    provider_name = {"cpu": "CPUExecutionProvider", "cuda": "CUDAExecutionProvider", "coreml": "CoreMLExecutionProvider"}[args.provider]
    if provider_name not in ort.get_available_providers():
        raise RuntimeError(f"Requested {provider_name} is unavailable")
    report = {
        "schema_version": 1, "measurement_scope": "Python direct ONNX inference; excludes RapidRAW processing and export",
        "model_name": args.model.name, "model_sha256": sha256(args.model),
        "image_name": args.image.name, "image_sha256": sha256(args.image),
        "runtime": ort.__version__, "platform": platform.platform(), "architecture": platform.machine(),
        "requested_provider": provider_name, "threads": args.threads,
        "warm_runs": args.runs, "kind": args.kind,
    }
    started = time.perf_counter()
    with MemorySampler(args.provider == "cuda") as memory:
        try:
            tensor, source_size, input_size = prepare(args)
            report.update(source_size=list(source_size), input_size=list(input_size), tensor_shape=list(tensor.shape))
            report["preprocess_seconds"] = time.perf_counter() - started
            options = ort.SessionOptions()
            options.intra_op_num_threads = args.threads
            options.inter_op_num_threads = 1
            options.enable_mem_pattern = False
            options.enable_profiling = True
            options.profile_file_prefix = str(args.output / "onnx-profile")
            providers: list = ["CPUExecutionProvider"]
            if args.provider == "cuda":
                providers.insert(0, (provider_name, {
                    "device_id": 0, "gpu_mem_limit": args.gpu_memory_mib * 1024 * 1024,
                    "arena_extend_strategy": "kSameAsRequested", "cudnn_conv_algo_search": "HEURISTIC",
                    "cudnn_conv_use_max_workspace": "0", "use_tf32": "0",
                }))
            elif args.provider == "coreml":
                providers.insert(0, (provider_name, {
                    "ModelFormat": "MLProgram", "MLComputeUnits": args.coreml_units,
                    "RequireStaticInputShapes": "0", "EnableOnSubgraphs": "0",
                }))
            initialized = time.perf_counter()
            session = ort.InferenceSession(str(args.model), sess_options=options, providers=providers)
            session.disable_fallback()
            report["initialization_seconds"] = time.perf_counter() - initialized
            report["session_providers"] = session.get_providers()
            report["provider_options"] = session.get_provider_options()
            if provider_name not in session.get_providers():
                raise RuntimeError("Requested provider failed to initialize; CPU fallback is not a successful benchmark")
            inputs = session.get_inputs()
            if len(inputs) != 1:
                raise ValueError("Benchmark expects a single fused NCHW input")
            report["input_contract"] = [{"name": i.name, "shape": i.shape, "type": i.type} for i in inputs]
            feed = {inputs[0].name: tensor}
            durations = []
            output = None
            for _ in range(args.runs + 1):
                before = time.perf_counter()
                output = session.run(None, feed)[0]
                durations.append(time.perf_counter() - before)
            report.update(cold_inference_seconds=durations[0], warm_inference_seconds=durations[1:], warm_median_seconds=statistics.median(durations[1:]))
            profile_path = Path(session.end_profiling())
            profile = json.loads(profile_path.read_text())
            placements = Counter(event.get("args", {}).get("provider") for event in profile if event.get("cat") == "Node" and event.get("args", {}).get("provider"))
            report["profile_node_events_by_provider"] = dict(placements)
            report["output"] = save_result(output, args, input_size)
            report["status"] = "completed"
        except Exception as error:
            report.update(status="error", error=f"{type(error).__name__}: {error}")
        report["total_seconds"] = time.perf_counter() - started
    report["memory"] = memory.summary()
    (args.output / "result.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report))
    return 0 if report["status"] == "completed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
