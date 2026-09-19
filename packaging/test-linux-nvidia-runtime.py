#!/usr/bin/env python3
"""Unit tests for the Linux NVIDIA runtime-pack builder (no network).

Builds tiny local fixture archives and exercises lock validation, the
official-source allowlist, SHA rejection, path-traversal/absolute/duplicate
rejection, hardlink rejection, required-file matching, license handling,
manifest coverage (README hashed, runtime.json sole self exclusion),
exact-tree verification, provenance checks, symlink safety and
byte-reproducible archives. Production source policy accepts only the two
official HTTPS roots; fixtures use allowlisted fixture URLs with pre-staged
archives and a stubbed download function, so tests never touch the network
and never weaken the production command. Run standalone or under pytest.
"""

import hashlib
import io
import json
import shutil
import sys
import tarfile
import tempfile
import unittest
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent


def load_builder():
    spec = spec_from_file_location(
        "pack_builder", HERE / "build-linux-nvidia-runtime.py")
    module = module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


builder = load_builder()

# Fixture archives use allowlisted URLs (production policy applies to tests
# too); the bytes are pre-staged under work/archives/ and builder.download
# is stubbed to raise, so no network ever happens.
FIXTURE_ROOT = "https://developer.download.nvidia.com/compute/unit-test-fixtures/"
MS_FIXTURE_ROOT = "https://github.com/microsoft/onnxruntime/releases/download/v9.9.9/"


def make_archive(path, members):
    """Create a .tar.xz fixture. members: list of (name, bytes|kind).

    bytes -> regular file; ("link", target) -> symlink; ("hardlink", target)
    -> hardlink; ("dir",) -> dir.
    """
    path = Path(path)
    with tarfile.open(path, "w:xz") as archive:
        for entry in members:
            name = entry[0]
            info = tarfile.TarInfo(name)
            payload = entry[1]
            if isinstance(payload, tuple) and payload[0] == "link":
                info.type = tarfile.SYMTYPE
                info.linkname = payload[1]
                archive.addfile(info)
            elif isinstance(payload, tuple) and payload[0] == "hardlink":
                info.type = tarfile.LNKTYPE
                info.linkname = payload[1]
                archive.addfile(info)
            elif payload == "dir":
                info.type = tarfile.DIRTYPE
                archive.addfile(info)
            else:
                info.size = len(payload)
                info.mode = 0o644
                archive.addfile(info, io.BytesIO(payload))
    return path


def good_lib_tree():
    # Mimics real redistributables: the top directory itself is a bare
    # entry, which must still count toward single-root stripping.
    return [
        ("pkg", "dir"),
        ("pkg/lib/", "dir"),
        ("pkg/lib/libfoo.so.9.1", b"ELF-FAKE-foo"),
        ("pkg/lib/libfoo.so.9", ("link", "libfoo.so.9.1")),
        ("pkg/lib/libfoo.so", ("link", "libfoo.so.9")),
        ("pkg/LICENSE", b"MIT-ish license text"),
    ]


def lock_for(basename, sha, size, url_root=FIXTURE_ROOT,
             extra_component=None, license_files=("LICENSE",)):
    components = [{
        "name": "foo",
        "version": "9.9",
        "source_url": url_root + basename,
        "archive_sha256": sha,
        "archive_size": size,
        "license_label": "unit-test",
        "license_files": list(license_files),
        "required_files": ["lib/libfoo.so*"],
    }]
    if extra_component is not None:
        components.append(extra_component)
    return {
        "$schema": "rapidraw-linux-nvidia-runtime-lock-v1",
        "pack_name": "TEST-PACK",
        "arch": "x86_64",
        "os": "linux",
        "components": components,
    }


def read_manifest(out):
    return json.loads((Path(out) / "runtime.json").read_text())


def write_manifest(out, manifest):
    (Path(out) / "runtime.json").write_text(json.dumps(manifest, indent=2) + "\n")


class LockTests(unittest.TestCase):
    def write_lock(self, lock):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        path = Path(tmp.name) / "lock.json"
        path.write_text(json.dumps(lock))
        return path

    def test_rejects_bad_schema(self):
        with self.assertRaises(builder.PackError):
            builder.load_lock("/nonexistent.json")
        bad = self.write_lock({"$schema": "nope"})
        with self.assertRaises(builder.PackError):
            builder.load_lock(bad)

    def test_rejects_non_official_scheme(self):
        for url in ("ftp://example.com/x.tar.xz",
                    "http://developer.download.nvidia.com/x.tar.xz",
                    "file:///tmp/x.tar.xz",
                    "https://evil.example.com/compute/x.tar.xz",
                    "https://github.com/other/project/releases/download/x.tar.xz"):
            lock = lock_for("x.tar.xz", "0" * 64, 1)
            lock["components"][0]["source_url"] = url
            with self.assertRaises(builder.PackError, msg=url):
                builder.load_lock(self.write_lock(lock))

    def test_accepts_official_roots(self):
        for url in (MS_FIXTURE_ROOT + "x.tgz",
                    FIXTURE_ROOT + "y.tar.xz"):
            lock = lock_for("y.tar.xz", "0" * 64, 1)
            lock["components"][0]["source_url"] = url
            loaded = builder.load_lock(self.write_lock(lock))
            self.assertEqual(loaded["components"][0]["source_url"], url)

    def test_rejects_duplicate_component(self):
        comp = {"name": "dup", "version": "1",
                "source_url": FIXTURE_ROOT + "x.tar.xz",
                "archive_sha256": "0" * 64, "archive_size": 1,
                "license_label": "l",
                "license_files": ["L"], "required_files": ["lib/*.so"]}
        lock = {"$schema": builder.LOCK_SCHEMA, "pack_name": "P",
                "arch": "x86_64", "os": "linux", "components": [comp, dict(comp)]}
        with self.assertRaises(builder.PackError):
            builder.load_lock(self.write_lock(lock))

    def test_rejects_non_linux_arch(self):
        lock = lock_for("x.tar.xz", "0" * 64, 1)
        lock["arch"] = "aarch64"
        with self.assertRaises(builder.PackError):
            builder.load_lock(self.write_lock(lock))


class ArchiveSafetyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def build_pack(self, members, basename="foo-9.9.tar.xz",
                   lock_extra=None, license_files=("LICENSE",),
                   url_root=FIXTURE_ROOT):
        archive = make_archive(self.root / basename, members)
        sha = builder.sha256_file(archive)
        lock = lock_for(basename, sha, archive.stat().st_size,
                        url_root=url_root, license_files=license_files)
        if lock_extra:
            lock.update(lock_extra)
        lock_path = self.root / "lock.json"
        lock_path.write_text(json.dumps(lock))
        # Pre-stage the fixture archive and stub out downloading: the
        # production build path never sees file:// URLs and tests never
        # touch the network.
        staged = self.root / "work" / "archives" / basename
        staged.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(archive, staged)
        out = self.root / "pack"
        with mock.patch.object(builder, "download",
                               side_effect=AssertionError("network in test")):
            code = builder.main(["build", "--lock", str(lock_path),
                                 "--work-dir", str(self.root / "work"),
                                 "--out", str(out)])
        return code, out

    def verify_pack(self, out):
        return builder.main(["verify", "--lock", str(self.root / "lock.json"),
                             "--pack", str(out)])

    def test_good_tree_builds_and_verifies(self):
        code, out = self.build_pack(good_lib_tree())
        self.assertEqual(code, 0)
        manifest = read_manifest(out)
        self.assertEqual(manifest["pack"], "TEST-PACK")
        self.assertEqual(manifest["manifest_schema"], builder.MANIFEST_SCHEMA)
        # 3 libs + LICENSE + README.txt
        self.assertEqual(manifest["files_total"], 5)
        self.assertEqual(manifest["manifest_excludes"], ["runtime.json"])
        self.assertTrue((out / "lib" / "libfoo.so.9").is_symlink())
        self.assertEqual(self.verify_pack(out), 0)

    def test_readme_covered_by_manifest(self):
        code, out = self.build_pack(good_lib_tree())
        self.assertEqual(code, 0)
        manifest = read_manifest(out)
        entries = {e["path"]: e for e in manifest["files"]}
        self.assertIn("README.txt", entries)
        entry = entries["README.txt"]
        self.assertIsNotNone(entry["sha256"])
        self.assertEqual(entry["sha256"],
                         builder.sha256_file(out / "README.txt"))
        self.assertNotIn("runtime.json", entries)

    def test_sha_mismatch_rejected(self):
        archive = make_archive(self.root / "a.tar.xz", good_lib_tree())
        lock = lock_for("a.tar.xz", "f" * 64, archive.stat().st_size)
        lock_path = self.root / "lock.json"
        lock_path.write_text(json.dumps(lock))
        staged = self.root / "work" / "archives" / "a.tar.xz"
        staged.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(archive, staged)
        with mock.patch.object(builder, "download",
                               side_effect=AssertionError("network in test")):
            code = builder.main(["build", "--lock", str(lock_path),
                                 "--work-dir", str(self.root / "work"),
                                 "--out", str(self.root / "pack")])
        self.assertEqual(code, 1)

    def test_file_url_lock_rejected_by_production_build(self):
        lock = lock_for("a.tar.xz", "0" * 64, 1)
        lock["components"][0]["source_url"] = "file:///tmp/a.tar.xz"
        lock_path = self.root / "lock.json"
        lock_path.write_text(json.dumps(lock))
        code = builder.main(["build", "--lock", str(lock_path),
                             "--work-dir", str(self.root / "work"),
                             "--out", str(self.root / "pack")])
        self.assertEqual(code, 1)

    def test_traversal_rejected(self):
        members = good_lib_tree() + [("pkg/../../evil.so", b"x")]
        code, _ = self.build_pack(members)
        self.assertEqual(code, 1)

    def test_absolute_entry_rejected(self):
        members = good_lib_tree() + [("/abs/evil.so", b"x")]
        code, _ = self.build_pack(members)
        self.assertEqual(code, 1)

    def test_escaping_symlink_rejected(self):
        members = good_lib_tree() + [("pkg/lib/evil.so", ("link", "/etc/passwd"))]
        code, _ = self.build_pack(members)
        self.assertEqual(code, 1)

    def test_hardlink_member_rejected(self):
        members = good_lib_tree() + [
            ("pkg/lib/libfoo-hard", ("hardlink", "pkg/lib/libfoo.so.9.1"))]
        code, _ = self.build_pack(members)
        self.assertEqual(code, 1)

    def test_missing_required_rejected(self):
        members = [m for m in good_lib_tree() if "libfoo" not in m[0]]
        code, _ = self.build_pack(members)
        self.assertEqual(code, 1)

    def test_missing_license_rejected(self):
        members = [m for m in good_lib_tree() if "LICENSE" not in m[0]]
        code, _ = self.build_pack(members)
        self.assertEqual(code, 1)

    def test_refuses_to_overwrite(self):
        code, out = self.build_pack(good_lib_tree())
        self.assertEqual(code, 0)
        archive = self.root / "foo-9.9.tar.xz"
        lock = lock_for("foo-9.9.tar.xz", builder.sha256_file(archive),
                        archive.stat().st_size)
        lock_path = self.root / "lock.json"
        lock_path.write_text(json.dumps(lock))
        with mock.patch.object(builder, "download",
                               side_effect=AssertionError("network in test")):
            again = builder.main(["build", "--lock", str(lock_path),
                                  "--work-dir", str(self.root / "work2"),
                                  "--out", str(out)])
        self.assertEqual(again, 1)

    def test_verify_detects_tampering(self):
        code, out = self.build_pack(good_lib_tree())
        self.assertEqual(code, 0)
        (out / "lib" / "libfoo.so.9.1").write_bytes(b"TAMPERED-CONTENT")
        self.assertEqual(self.verify_pack(out), 1)

    def test_verify_rejects_extra_unmanifested_so(self):
        code, out = self.build_pack(good_lib_tree())
        self.assertEqual(code, 0)
        (out / "lib" / "libevil.so.1").write_bytes(b"INJECTED")
        self.assertEqual(self.verify_pack(out), 1)

    def test_archive_refuses_pack_with_extra_file(self):
        code, out = self.build_pack(good_lib_tree())
        self.assertEqual(code, 0)
        (out / "lib" / "libevil.so.1").write_bytes(b"INJECTED")
        tgz = self.root / "pack.tgz"
        code = builder.main(["archive", "--lock", str(self.root / "lock.json"),
                             "--pack", str(out), "--archive-out", str(tgz)])
        self.assertEqual(code, 1)
        self.assertFalse(tgz.exists())

    def test_verify_rejects_totals_mismatch(self):
        code, out = self.build_pack(good_lib_tree())
        self.assertEqual(code, 0)
        manifest = read_manifest(out)
        manifest["files_total"] += 1
        write_manifest(out, manifest)
        self.assertEqual(self.verify_pack(out), 1)
        manifest = read_manifest(out)
        manifest["files_total"] = len(manifest["files"])
        manifest["bytes_total"] += 1
        write_manifest(out, manifest)
        self.assertEqual(self.verify_pack(out), 1)

    def test_verify_rejects_provenance_tampering(self):
        code, out = self.build_pack(good_lib_tree())
        self.assertEqual(code, 0)
        pristine = read_manifest(out)
        tampers = {
            "version": "9.10",
            "variant": "cuda99",
            "source_url": FIXTURE_ROOT + "other.tar.xz",
            "archive_sha256": "e" * 64,
            "archive_size": pristine["components"][0]["archive_size"] + 1,
            "license_label": "renamed",
            "license_files": ["OTHER-LICENSE"],
        }
        for key, bad in tampers.items():
            manifest = json.loads(json.dumps(pristine))
            manifest["components"][0][key] = bad
            write_manifest(out, manifest)
            self.assertEqual(self.verify_pack(out), 1, msg=key)
        write_manifest(out, pristine)
        self.assertEqual(self.verify_pack(out), 0)

    def test_verify_rejects_schema_tampering(self):
        code, out = self.build_pack(good_lib_tree())
        self.assertEqual(code, 0)
        manifest = read_manifest(out)
        manifest["manifest_schema"] = "rapidraw-linux-nvidia-runtime-manifest-v9"
        write_manifest(out, manifest)
        self.assertEqual(self.verify_pack(out), 1)
        manifest["manifest_schema"] = builder.MANIFEST_SCHEMA
        manifest["manifest_excludes"] = []
        write_manifest(out, manifest)
        self.assertEqual(self.verify_pack(out), 1)

    def test_verify_rejects_dangling_symlink(self):
        code, out = self.build_pack(good_lib_tree())
        self.assertEqual(code, 0)
        # Manifest the dangling link correctly so only the resolution gate
        # can fire: per-entry and exact-tree checks must pass first.
        link = out / "lib" / "libdangling.so"
        link.symlink_to("libnonexistent.so.9")
        manifest = read_manifest(out)
        manifest["files"].append({
            "path": "lib/libdangling.so", "sha256": None,
            "size": link.lstat().st_size, "symlink_to": "libnonexistent.so.9"})
        manifest["files"].sort(key=lambda e: e["path"])
        manifest["files_total"] = len(manifest["files"])
        manifest["bytes_total"] = sum(e["size"] for e in manifest["files"])
        write_manifest(out, manifest)
        self.assertEqual(self.verify_pack(out), 1)

    def test_verify_rejects_escaping_symlink(self):
        code, out = self.build_pack(good_lib_tree())
        self.assertEqual(code, 0)
        link = out / "lib" / "libescape.so"
        link.symlink_to("/etc/hostname")
        manifest = read_manifest(out)
        manifest["files"].append({
            "path": "lib/libescape.so", "sha256": None,
            "size": link.lstat().st_size, "symlink_to": "/etc/hostname"})
        manifest["files"].sort(key=lambda e: e["path"])
        manifest["files_total"] = len(manifest["files"])
        manifest["bytes_total"] = sum(e["size"] for e in manifest["files"])
        write_manifest(out, manifest)
        self.assertEqual(self.verify_pack(out), 1)

    def test_verify_rejects_unsafe_manifest_paths(self):
        code, out = self.build_pack(good_lib_tree())
        self.assertEqual(code, 0)
        pristine = read_manifest(out)
        for bad_path in ("../evil.so", "/abs/evil.so", "lib/./evil.so",
                         "lib/sub/../../evil.so", "", "runtime.json"):
            manifest = json.loads(json.dumps(pristine))
            victim = dict(manifest["files"][0])
            victim["path"] = bad_path
            manifest["files"].append(victim)
            manifest["files_total"] = len(manifest["files"])
            manifest["bytes_total"] = sum(e["size"] for e in manifest["files"])
            write_manifest(out, manifest)
            self.assertEqual(self.verify_pack(out), 1, msg=bad_path)
        # Duplicate manifest path.
        manifest = json.loads(json.dumps(pristine))
        manifest["files"].append(dict(manifest["files"][0]))
        manifest["files_total"] = len(manifest["files"])
        manifest["bytes_total"] = sum(e["size"] for e in manifest["files"])
        write_manifest(out, manifest)
        self.assertEqual(self.verify_pack(out), 1)
        write_manifest(out, pristine)
        self.assertEqual(self.verify_pack(out), 0)

    def test_archive_subcommand_tars_verified_tree(self):
        code, out = self.build_pack(good_lib_tree())
        self.assertEqual(code, 0)
        tgz = self.root / "pack.tgz"
        lock_path = self.root / "lock.json"
        code = builder.main(["archive", "--lock", str(lock_path),
                             "--pack", str(out), "--archive-out", str(tgz)])
        self.assertEqual(code, 0)
        self.assertTrue(tgz.is_file() and tgz.stat().st_size > 0)
        again = builder.main(["archive", "--lock", str(lock_path),
                              "--pack", str(out),
                              "--archive-out", str(tgz)])
        self.assertEqual(again, 1)  # refuses to overwrite

    def test_archives_of_same_tree_are_byte_identical(self):
        code, out = self.build_pack(good_lib_tree())
        self.assertEqual(code, 0)
        lock_path = self.root / "lock.json"
        first = self.root / "first-pack.tgz"
        second = self.root / "nested" / "renamed-pack.tgz"
        for target in (first, second):
            code = builder.main(["archive", "--lock", str(lock_path),
                                 "--pack", str(out),
                                 "--archive-out", str(target)])
            self.assertEqual(code, 0)
        self.assertEqual(builder.sha256_file(first), builder.sha256_file(second))

    def test_manifest_files_sorted_with_hashes(self):
        code, out = self.build_pack(good_lib_tree())
        self.assertEqual(code, 0)
        manifest = read_manifest(out)
        paths = [entry["path"] for entry in manifest["files"]]
        self.assertEqual(paths, sorted(paths))
        for entry in manifest["files"]:
            if entry["symlink_to"] is None:
                self.assertEqual(len(entry["sha256"]), 64)


if __name__ == "__main__":
    unittest.main()
