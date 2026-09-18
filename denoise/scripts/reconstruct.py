"""Reconstruct a testable tree from the pinned base + tracked patch + overlay.

The review archive is an OVERLAY, not a standalone repository: it contains
the new/changed Python source under ``source/`` but not the full RapidRAW
checkout. This script rebuilds an exact testable tree without touching any
working checkout:

1. ``git archive <base-commit>`` from a repo path into an empty DEST.
2. Apply ``source/patch-tracked.diff`` with ``patch -p1`` (tracked-file delta).
3. Overlay ``source/denoise/**`` onto ``DEST/denoise/`` (new modules, tests,
   scripts, pyproject).
4. Optionally verify every REVIEW-MANIFEST.json entry hash against the
   extraction ROOT, and run the fast contract tests (no GPU, no weights)
   with a supplied Python.

Usage:
  reconstruct.py --source <nl-review/source> --repo <git-repo> --dest <dir>
                 [--root <nl-review>] [--pytest-python <bin>] [--no-tests]

Network is never used. DEST must not exist (never overwrite).
"""
import argparse
import hashlib
import json
import shutil
import subprocess
import sys
from pathlib import Path

CONTRACT_TESTS = ["tests/test_compare_metrics.py",
                  "tests/test_contract_rejections.py"]


def run(cmd, **kw):
    proc = subprocess.run(cmd, capture_output=True, text=True, **kw)
    if proc.returncode != 0:
        raise RuntimeError(f"{' '.join(cmd)} failed:\n{proc.stdout}\n{proc.stderr}")
    return proc


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--source", required=True, help="Archive source/ dir")
    ap.add_argument("--repo", required=True, help="Git repo for git archive")
    ap.add_argument("--dest", required=True, help="New dir to create")
    ap.add_argument("--root", default=None,
                    help="Extraction root holding REVIEW-MANIFEST.json")
    ap.add_argument("--pytest-python", default=sys.executable)
    ap.add_argument("--no-tests", action="store_true")
    args = ap.parse_args(argv)
    source, dest = Path(args.source), Path(args.dest)
    if dest.exists():
        print(json.dumps({"status": "error",
                          "error": f"refusing to overwrite {dest}"}))
        return 1
    base = (source / "base-commit.txt").read_text().strip().split()[0]
    # Stream the pinned-base archive straight into dest via tar (no network,
    # no checkout side effects on any working tree).
    archive = subprocess.run(["git", "-C", str(args.repo), "archive", base],
                             capture_output=True)
    if archive.returncode != 0:
        print(json.dumps({"status": "error", "error": archive.stderr.decode()}))
        return 1
    dest.mkdir(parents=True)
    tar = subprocess.run(["tar", "-x", "-C", str(dest)], input=archive.stdout)
    if tar.returncode != 0:
        print(json.dumps({"status": "error", "error": "tar extraction failed"}))
        return 1
    patch = subprocess.run(["patch", "-p1", "-d", str(dest), "--forward", "-s"],
                           input=(source / "patch-tracked.diff").read_bytes(),
                           capture_output=True)
    if patch.returncode != 0:
        print(json.dumps({"status": "error",
                          "error": f"patch failed: {patch.stderr.decode()}"}))
        return 1
    for child in ("denoise",):
        src = source / child
        if src.is_dir():
            shutil.copytree(src, dest / child, dirs_exist_ok=True)
    # scripts/ ships inside source/denoise per archive layout already; also
    # accept a top-level source/scripts copy for older layouts.
    top_scripts = source / "scripts"
    if top_scripts.is_dir():
        for f in top_scripts.glob("*.py"):
            shutil.copy2(f, dest / "denoise" / "scripts" / f.name)
    result = {"status": "ok", "base": base, "dest": str(dest),
              "overlay": sorted(p.name for p in (source / "denoise").iterdir())}
    if args.root:
        root = Path(args.root)
        manifest = json.loads((root / "REVIEW-MANIFEST.json").read_text())["files"]
        bad = [p for p, e in manifest.items()
               if hashlib.sha256((root / p).read_bytes()).hexdigest() != e["sha256"]]
        result["manifest_entries"] = len(manifest)
        result["manifest_mismatches"] = bad
        if bad:
            print(json.dumps({"status": "error", "manifest_mismatches": bad}))
            return 1
    if not args.no_tests:
        import os
        env = dict(os.environ, PYTHONPATH=str(dest / "denoise"))
        proc = subprocess.run(
            [args.pytest_python, "-m", "pytest", *CONTRACT_TESTS, "-q",
             "-p", "no:cacheprovider"],
            capture_output=True, text=True, cwd=str(dest / "denoise"), env=env)
        result["pytest_exit"] = proc.returncode
        result["pytest_tail"] = proc.stdout.strip().splitlines()[-1:]
        print(json.dumps(result, indent=2))
        return 0 if proc.returncode == 0 else 1
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
