#!/usr/bin/env python3
"""Deterministic Linux x86_64 NVIDIA runtime-pack builder for RapidRAW.

Builds a self-contained CUDA user-space runtime (official ONNX Runtime 1.30
CUDA 13, cuDNN 9.20.0.48, and the exact CUDA component versions validated by
the native fleet) from pinned official redistributable archives. NVIDIA
driver libraries are never included; the host driver provides them.

Usage:
  build-linux-nvidia-runtime.py build --lock LOCK --work-dir DIR --out PACK
      [--archive-out PACK.tgz]
  build-linux-nvidia-runtime.py verify --lock LOCK --pack PACK

Rules (fail closed): x86_64 Linux only; downloads only from pinned official
HTTPS URLs under the Microsoft ONNX Runtime release root or the NVIDIA
developer-download root (no http://, file:// or other hosts in production);
every archive SHA-256 verified before extraction; extraction to staging only
with absolute/traversal/duplicate/special-file/hardlink rejection; only
required runtime shared-library chains plus license/notice files are copied
(symlinks preserved, every link must resolve to an existing target inside the
pack); verification is an EXACT-TREE check that rejects any unmanifested
payload; refuses to overwrite existing outputs. No Python/pip/system-CUDA
content ever enters the pack.
"""

import argparse
import fnmatch
import gzip
import hashlib
import json
import os
import shutil
import sys
import tarfile
import tempfile
import urllib.request
from pathlib import Path

PACK_MTIME = 0  # fixed member timestamps for reproducible archives
LOCK_SCHEMA = "rapidraw-linux-nvidia-runtime-lock-v1"
MANIFEST_SCHEMA = "rapidraw-linux-nvidia-runtime-manifest-v1"
# runtime.json cannot hash itself; it is the sole documented exception to the
# hashed file inventory. Every other regular file or symlink in the pack must
# be listed in runtime.json "files".
MANIFEST_SELF_FILE = "runtime.json"
MANIFEST_EXCLUDES = ["runtime.json"]

# Production source policy: official upstream roots only. Unit tests use
# allowlisted https:// fixture URLs with pre-staged archives and a stubbed
# download function, so no production flag or code path weakens this.
OFFICIAL_SOURCE_PREFIXES = (
    "https://github.com/microsoft/onnxruntime/releases/download/",
    "https://developer.download.nvidia.com/",
)


class PackError(Exception):
    pass


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for block in iter(lambda: stream.read(4 * 1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def load_lock(path):
    try:
        lock = json.loads(Path(path).read_text())
    except (OSError, ValueError) as exc:
        raise PackError(f"lock manifest unreadable: {exc}")
    if lock.get("$schema") != LOCK_SCHEMA:
        raise PackError(f"unsupported lock schema: {lock.get('$schema')!r}")
    if lock.get("arch") != "x86_64" or lock.get("os") != "linux":
        raise PackError("this builder supports Linux x86_64 only")
    components = lock.get("components")
    if not components or not isinstance(components, list):
        raise PackError("lock must list components")
    seen = set()
    for component in components:
        for key in ("name", "version", "source_url", "archive_sha256",
                    "license_label", "license_files", "required_files"):
            if key not in component:
                raise PackError(f"component {component.get('name')!r} lacks {key!r}")
        if component["name"] in seen:
            raise PackError(f"duplicate component {component['name']!r}")
        seen.add(component["name"])
        url = component["source_url"]
        if not url.startswith(OFFICIAL_SOURCE_PREFIXES):
            raise PackError(
                f"component {component['name']!r} has non-official source URL: {url}")
        if not component["license_files"] or not component["required_files"]:
            raise PackError(f"component {component['name']!r} needs license and required files")
    return lock


def download(url, dest):
    dest = Path(dest)
    if dest.exists():
        raise PackError(f"refusing to overwrite {dest}")
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    try:
        with urllib.request.urlopen(url, timeout=120) as response, \
                open(tmp, "wb") as stream:
            shutil.copyfileobj(response, stream, length=4 * 1024 * 1024)
        os.replace(tmp, dest)
    finally:
        try:
            tmp.unlink()
        except OSError:
            pass
    return dest


def safe_members(archive):
    """Validated (member, relative_path) list; rejects hostile layouts."""
    members = archive.getmembers()
    seen = set()
    checked = []
    for member in members:
        name = member.name
        if not name or name.startswith("/") or name.startswith("\\"):
            raise PackError(f"archive has absolute entry: {name!r}")
        parts = name.split("/")
        if any(part in ("", ".", "..") for part in parts):
            raise PackError(f"archive has traversal entry: {name!r}")
        if name in seen:
            raise PackError(f"archive has duplicate entry: {name!r}")
        seen.add(name)
        if member.islnk():
            # Hardlinks are rejected fail-closed: silently converting them
            # into symlinks would change payload semantics. No validated
            # official archive for this pack requires one.
            raise PackError(f"archive has hardlink entry: {name!r}")
        if member.issym():
            target = member.linkname
            if not target or target.startswith("/") or \
                    any(part == ".." for part in target.split("/")):
                raise PackError(f"archive has escaping link: {name!r} -> {target!r}")
        elif not (member.isfile() or member.isdir()):
            raise PackError(f"archive has non-regular entry: {name!r}")
        checked.append(member)
    return checked


def strip_single_root(members):
    """If every member shares one top directory, strip it; else keep root.

    Real redistributable archives list the top directory itself as a bare
    entry, so bare entries that own the tree count toward the root.
    """
    names = {m.name for m in members}
    tops = {name.split("/")[0] for name in names}
    if len(tops) == 1:
        (root,) = tops
        if root in names or any(name.startswith(root + "/") for name in names):
            return root + "/"
    return ""


def extract_staging(archive_path, staging):
    staging = Path(staging)
    if staging.exists():
        raise PackError(f"refusing to overwrite {staging}")
    staging.mkdir(parents=True)
    with tarfile.open(archive_path, "r:*") as archive:
        members = safe_members(archive)
        prefix = strip_single_root(members)
        for member in members:
            rel = member.name[len(prefix):] if prefix else member.name
            if not rel:
                continue
            target = staging / rel
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
            elif member.issym():
                target.parent.mkdir(parents=True, exist_ok=True)
                try:
                    target.symlink_to(member.linkname)
                except FileExistsError:
                    raise PackError(f"duplicate staged path: {rel!r}")
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with archive.extractfile(member) as source, open(target, "wb") as out:
                    shutil.copyfileobj(source, out, length=4 * 1024 * 1024)
                os.chmod(target, member.mode & ~0o111000)
    return staging


def match_required(staging, patterns):
    """Map each pattern to staged files; fail on missing or collisions."""
    staging = Path(staging)
    selected = {}
    for pattern in patterns:
        hits = sorted(
            str(p.relative_to(staging)) for p in staging.glob(pattern)
            if p.is_file() or p.is_symlink())
        if not hits:
            raise PackError(f"required pattern matched nothing: {pattern!r}")
        for hit in hits:
            if hit in selected and selected[hit] != pattern:
                raise PackError(f"duplicate required file {hit!r} via {pattern!r}")
            selected[hit] = pattern
    return sorted(selected)


def copy_tree_into_pack(staging, rel_paths, pack_dir):
    pack_dir = Path(pack_dir)
    for rel in rel_paths:
        src = Path(staging) / rel
        dst = pack_dir / rel
        if dst.exists() or dst.is_symlink():
            raise PackError(f"duplicate pack path: {rel!r}")
        dst.parent.mkdir(parents=True, exist_ok=True)
        if src.is_symlink():
            # Keep the link itself (never dereference) to preserve the
            # upstream symlink chains; targets are validated below.
            dst.symlink_to(os.readlink(src))
        else:
            shutil.copy2(src, dst, follow_symlinks=False)
    # Every symlink must resolve inside the pack.
    for rel in rel_paths:
        dst = pack_dir / rel
        if dst.is_symlink():
            resolved = os.path.realpath(dst)
            if os.path.commonpath([resolved, str(pack_dir.resolve())]) != str(pack_dir.resolve()):
                raise PackError(f"pack symlink escapes: {rel!r}")


def assert_symlinks_resolve_inside(pack_dir):
    """Every symlink under pack_dir must resolve to an existing in-pack target."""
    root = Path(pack_dir).resolve()
    for entry in sorted(Path(pack_dir).rglob("*")):
        if not entry.is_symlink():
            continue
        resolved = os.path.realpath(entry)
        if os.path.commonpath([resolved, str(root)]) != str(root):
            raise PackError(
                f"pack symlink escapes: {str(entry.relative_to(pack_dir))!r}")
        if not os.path.exists(resolved):
            raise PackError(
                f"dangling pack symlink: {str(entry.relative_to(pack_dir))!r}")


def check_manifest_path(rel):
    """Manifest paths must be normalized relative POSIX form under pack root."""
    if not isinstance(rel, str) or not rel:
        raise PackError(f"manifest has empty path: {rel!r}")
    if rel.startswith("/") or "\\" in rel:
        raise PackError(f"manifest path not relative POSIX: {rel!r}")
    if any(part in ("", ".", "..") for part in rel.split("/")):
        raise PackError(f"manifest path not normalized: {rel!r}")
    if rel == MANIFEST_SELF_FILE:
        raise PackError(
            f"manifest must not list {MANIFEST_SELF_FILE}; "
            "it is covered by the explicit self-manifest exclusion")
    return rel


def build(args):
    lock = load_lock(args.lock)
    out = Path(args.out)
    if out.exists():
        raise PackError(f"refusing to overwrite {out}")
    work = Path(args.work_dir)
    archives_dir = work / "archives"
    staging_root = work / "staging"
    pack_licenses = out / "licenses"
    manifest_components = []
    for component in lock["components"]:
        name = component["name"]
        archive_path = archives_dir / Path(component["source_url"]).name
        if archive_path.exists():
            print(f"[{name}] reusing {archive_path}", flush=True)
        else:
            print(f"[{name}] downloading {component['source_url']}", flush=True)
            download(component["source_url"], archive_path)
        actual = sha256_file(archive_path)
        if actual != component["archive_sha256"]:
            raise PackError(f"[{name}] SHA mismatch: got {actual}, want {component['archive_sha256']}")
        print(f"[{name}] SHA ok", flush=True)
        staging = extract_staging(archive_path, staging_root / name)
        for license_file in component["license_files"]:
            hits = sorted(str(p.relative_to(staging)) for p in staging.glob(license_file))
            if not hits:
                raise PackError(f"[{name}] license file missing: {license_file!r}")
            for hit in hits:
                target = pack_licenses / name / Path(hit).name
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(staging / hit, target)
        # Required paths are archive-relative and already lib/-anchored
        # (staging had the single top directory stripped), so copy them
        # under out/ directly: out/lib/*.so chains, nothing else.
        for rel in match_required(staging, component["required_files"]):
            if not rel.startswith("lib/"):
                raise PackError(f"[{name}] required file outside lib/: {rel!r}")
            copy_tree_into_pack(staging, [rel], out)
        manifest_components.append({
            "name": name,
            "version": component.get("version"),
            "variant": component.get("variant"),
            "source_url": component["source_url"],
            "archive_sha256": component["archive_sha256"],
            "archive_size": archive_path.stat().st_size,
            "license_label": component["license_label"],
            "license_files": component["license_files"],
        })
    (out / "README.txt").write_text(
        f"{lock['pack_name']}\n"
        "Optional NVIDIA CUDA user-space runtime for RapidRAW on Linux x86_64.\n"
        "\n"
        "Contents: official ONNX Runtime 1.30.0 (CUDA 13 build), NVIDIA cuDNN\n"
        "9.20.0 for CUDA 13, and CUDA 13.2/13.3 user-space libraries (cuBLAS,\n"
        "cuRAND, CUDA runtime (cudart), NVRTC). Requires a compatible NVIDIA\n"
        "driver; the tested and supported baseline is driver 595.58.03 or\n"
        "newer. No Python, pip, or system CUDA toolkit is required. The\n"
        "archive is about 1.1 GB; reserve about 3 GB free for download\n"
        "plus extraction.\n"
        "\n"
        "Install (no root needed):\n"
        "  1. Download the matching <pack>.tgz and <pack>.sha256 from the\n"
        "     RapidRAW nvidia-runtime-v1.0.0 GitHub release and verify:\n"
        "       sha256sum -c <pack>.sha256\n"
        "  2. Extract it under:\n"
        "       ${XDG_DATA_HOME:-$HOME/.local/share}/rapidraw/nvidia-runtime/\n"
        "     so the pack directory is .../nvidia-runtime/<pack>\n"
        "  3. Point `current` at it:\n"
        "       ln -sfn <pack> .../nvidia-runtime/current\n"
        "The next normal RapidRAW launch activates the runtime automatically\n"
        "and defaults the ONNX and Nonlocal providers to CUDA.\n"
        "\n"
        "Override or disable:\n"
        "  RAPIDRAW_NVIDIA_RUNTIME=/absolute/path/to/pack  use a specific pack\n"
        "  RAPIDRAW_NVIDIA_RUNTIME=off                     run on CPU only\n"
        "Remove the `current` symlink (or the versioned directory) to\n"
        "uninstall; the normal CPU package keeps working unchanged.\n"
        .replace("<pack>", lock["pack_name"])
    )
    files = []
    for path in sorted((out / "lib").rglob("*")):
        if path.is_file() and not path.is_symlink() or path.is_symlink():
            if path.is_dir() and not path.is_symlink():
                continue
            rel = str(path.relative_to(out))
            files.append({"path": rel, "sha256": sha256_file(path) if not path.is_symlink() else None,
                          "size": path.lstat().st_size,
                          "symlink_to": os.readlink(path) if path.is_symlink() else None})
    for path in sorted((out / "licenses").rglob("*")):
        if path.is_file():
            rel = str(path.relative_to(out))
            files.append({"path": rel, "sha256": sha256_file(path), "size": path.stat().st_size,
                          "symlink_to": None})
    readme = out / "README.txt"
    files.append({"path": "README.txt", "sha256": sha256_file(readme),
                  "size": readme.stat().st_size, "symlink_to": None})
    files.sort(key=lambda entry: entry["path"])
    manifest = {
        "manifest_schema": MANIFEST_SCHEMA,
        "pack": lock["pack_name"],
        "arch": lock["arch"],
        "os": lock["os"],
        "builder": "packaging/build-linux-nvidia-runtime.py",
        "components": manifest_components,
        # runtime.json cannot hash itself; it is the only file allowed to
        # exist in the pack without a hashed inventory entry.
        "manifest_excludes": list(MANIFEST_EXCLUDES),
        "files": files,
        "files_total": len(files),
        "bytes_total": sum(entry["size"] for entry in files),
    }
    (out / MANIFEST_SELF_FILE).write_text(json.dumps(manifest, indent=2) + "\n")
    assert_symlinks_resolve_inside(out)
    print(f"wrote {out} ({manifest['files_total']} files, {manifest['bytes_total']} bytes)", flush=True)
    if args.archive_out:
        verify(argparse.Namespace(lock=args.lock, pack=str(out)))
        make_archive(out, lock["pack_name"], Path(args.archive_out))
    return 0


def make_archive(pack, pack_name, archive_path):
    """Deterministic .tgz of an existing pack tree (sorted, uid/gid 0)."""
    pack, archive_path = Path(pack), Path(archive_path)
    if archive_path.exists():
        raise PackError(f"refusing to overwrite {archive_path}")
    with tempfile.TemporaryDirectory(prefix="nvpack-") as tmp:
        tar_path = Path(tmp) / "pack.tar"
        with tarfile.open(tar_path, "w", format=tarfile.PAX_FORMAT) as tar:
            for entry in sorted(pack.rglob("*")):
                arcname = f"{pack_name}/{entry.relative_to(pack)}"
                info = tar.gettarinfo(str(entry), arcname=arcname)
                info.uid = info.gid = 0
                info.uname = info.gname = ""
                info.mtime = PACK_MTIME
                if entry.is_symlink():
                    tar.addfile(info)
                elif entry.is_file():
                    with open(entry, "rb") as stream:
                        tar.addfile(info, stream)
        archive_path.parent.mkdir(parents=True, exist_ok=True)
        with open(tar_path, "rb") as src, open(archive_path, "wb") as dest, \
                gzip.GzipFile(filename="", mode="wb", fileobj=dest,
                              compresslevel=9, mtime=PACK_MTIME) as gz:
            # filename="" keeps the gzip header free of the output pathname
            # so identical pack trees yield byte-identical .tgz files under
            # any output filename or directory.
            shutil.copyfileobj(src, gz)
    print(f"wrote {archive_path} ({archive_path.stat().st_size} bytes, "
          f"sha256 {sha256_file(archive_path)})", flush=True)


PROVENANCE_KEYS = ("name", "version", "variant", "source_url",
                   "archive_sha256", "archive_size", "license_label",
                   "license_files")


def verify(args):
    lock = load_lock(args.lock)
    pack = Path(args.pack)
    manifest_path = pack / MANIFEST_SELF_FILE
    try:
        manifest = json.loads(manifest_path.read_text())
    except (OSError, ValueError) as exc:
        raise PackError(f"runtime.json unreadable: {exc}")
    if manifest.get("manifest_schema") != MANIFEST_SCHEMA:
        raise PackError(
            f"unsupported manifest schema: {manifest.get('manifest_schema')!r}")
    if manifest.get("pack") != lock["pack_name"]:
        raise PackError("runtime.json pack name mismatch")
    if manifest.get("arch") != lock["arch"] or manifest.get("os") != lock["os"]:
        raise PackError("runtime.json arch/os mismatch")
    if manifest.get("manifest_excludes") != MANIFEST_EXCLUDES:
        raise PackError("runtime.json self-manifest exclusion mismatch; "
                        "only runtime.json itself may be unlisted")
    locked_names = [c["name"] for c in lock["components"]]
    if [c["name"] for c in manifest.get("components", [])] != locked_names:
        raise PackError("runtime.json component list mismatch")
    # Full provenance: a tampered runtime.json must not rewrite component
    # origins while keeping payload hashes valid.
    for locked, recorded in zip(lock["components"], manifest["components"]):
        for key in PROVENANCE_KEYS:
            if recorded.get(key) != locked.get(key):
                raise PackError(
                    f"component {locked['name']!r} provenance mismatch on {key!r}")
    entries = manifest.get("files", [])
    if not isinstance(entries, list) or not entries:
        raise PackError("runtime.json file inventory missing")
    seen_paths = set()
    for entry in entries:
        rel = check_manifest_path(entry.get("path"))
        if rel in seen_paths:
            raise PackError(f"manifest has duplicate path: {rel!r}")
        seen_paths.add(rel)
        for key in ("sha256", "size", "symlink_to"):
            if key not in entry:
                raise PackError(f"manifest entry {rel!r} lacks {key!r}")
        path = pack / rel
        if entry["symlink_to"] is not None:
            if not path.is_symlink() or os.readlink(path) != entry["symlink_to"]:
                raise PackError(f"symlink mismatch: {rel!r}")
        else:
            if not path.is_file() or path.is_symlink():
                raise PackError(f"file missing: {rel!r}")
            if not isinstance(entry["sha256"], str) or len(entry["sha256"]) != 64:
                raise PackError(f"manifest entry {rel!r} has bad sha256")
            if sha256_file(path) != entry["sha256"]:
                raise PackError(f"file hash mismatch: {rel!r}")
        if path.lstat().st_size != entry["size"]:
            raise PackError(f"file size mismatch: {rel!r}")
    if manifest.get("files_total") != len(entries):
        raise PackError("runtime.json files_total mismatch")
    if manifest.get("bytes_total") != sum(entry["size"] for entry in entries):
        raise PackError("runtime.json bytes_total mismatch")
    # EXACT-TREE check: every payload file/symlink on disk must be manifested
    # (plus the runtime.json self exception); special files always fail.
    expected = seen_paths | {MANIFEST_SELF_FILE}
    on_disk = set()
    for entry in sorted(pack.rglob("*")):
        rel = str(entry.relative_to(pack))
        if entry.is_symlink() or entry.is_file():
            if entry.is_dir() and not entry.is_symlink():
                continue
            on_disk.add(rel)
        elif entry.is_dir():
            continue
        else:
            raise PackError(f"pack has special file: {rel!r}")
    if on_disk - expected:
        raise PackError(
            f"pack has unmanifested payload: {sorted(on_disk - expected)!r}")
    if expected - on_disk:
        raise PackError(
            f"manifest lists missing payload: {sorted(expected - on_disk)!r}")
    if not manifest_path.is_file() or manifest_path.is_symlink():
        raise PackError("runtime.json missing or not a regular file")
    assert_symlinks_resolve_inside(pack)
    # Absolute-path leakage is checked by the relocation test (same pack
    # extracted at a second path must verify identically).
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    build_parser = sub.add_parser("build")
    build_parser.add_argument("--lock", required=True)
    build_parser.add_argument("--work-dir", required=True)
    build_parser.add_argument("--out", required=True)
    build_parser.add_argument("--archive-out", default=None)
    verify_parser = sub.add_parser("verify")
    verify_parser.add_argument("--lock", required=True)
    verify_parser.add_argument("--pack", required=True)
    archive_parser = sub.add_parser("archive")
    archive_parser.add_argument("--lock", required=True)
    archive_parser.add_argument("--pack", required=True)
    archive_parser.add_argument("--archive-out", required=True)
    args = parser.parse_args(argv)
    try:
        if sys.platform != "linux":
            print("warning: pack targets Linux x86_64; building elsewhere only for tests",
                  file=sys.stderr)
        if args.command == "build":
            return build(args)
        if args.command == "archive":
            verify(args)
            lock = load_lock(args.lock)
            make_archive(args.pack, lock["pack_name"], Path(args.archive_out))
            return 0
        return verify(args)
    except PackError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
