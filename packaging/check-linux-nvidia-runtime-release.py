#!/usr/bin/env python3
"""Offline release-contract check for the Linux NVIDIA runtime pack.

Verifies that packaging/linux-nvidia-runtime.release.json exactly pins
packaging/linux-nvidia-runtime.lock.json BEFORE any expensive download or
build: metadata $schema, lock SHA-256, lock $schema, exact component order
and name/version/variant/archive_sha256 pins, plus pack_name,
manifest_schema and os/arch agreement. Also runnable as a self-test with
--self-test (fixture JSON only, no network). Exit 0 on success, 1 with a
clear message on any mismatch.
"""

import argparse
import copy
import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path

RELEASE_SCHEMA = "rapidraw-linux-nvidia-runtime-release-v1"
MANIFEST_SCHEMA = "rapidraw-linux-nvidia-runtime-manifest-v1"


class ContractError(Exception):
    pass


def check_release_contract(lock_path, release_path):
    """Raise ContractError on the first contract violation."""
    lock_path, release_path = Path(lock_path), Path(release_path)
    try:
        lock = json.loads(lock_path.read_text())
        release = json.loads(release_path.read_text())
    except (OSError, ValueError) as exc:
        raise ContractError(f"unreadable JSON: {exc}")
    if release.get("$schema") != RELEASE_SCHEMA:
        raise ContractError(
            f"release $schema must be {RELEASE_SCHEMA!r}, "
            f"got {release.get('$schema')!r}")
    if lock.get("$schema") != release.get("lock_schema"):
        raise ContractError(
            f"lock $schema {lock.get('$schema')!r} != "
            f"release lock_schema {release.get('lock_schema')!r}")
    actual_lock_sha = hashlib.sha256(lock_path.read_bytes()).hexdigest()
    if actual_lock_sha != release.get("lock_sha256"):
        raise ContractError(
            f"lock SHA mismatch: file is {actual_lock_sha}, "
            f"release pins {release.get('lock_sha256')!r}")
    locked = lock.get("components")
    pinned = release.get("components")
    if not locked or not pinned:
        raise ContractError("lock and release must both list components")
    if [c.get("name") for c in pinned] != [c.get("name") for c in locked]:
        raise ContractError("release component order/names must match the lock")
    for want, got in zip(locked, pinned):
        for key in ("name", "version", "archive_sha256"):
            if got.get(key) != want.get(key):
                raise ContractError(
                    f"component {want.get('name')!r}: release {key} "
                    f"{got.get(key)!r} != lock {want.get(key)!r}")
        if got.get("variant") != want.get("variant"):
            raise ContractError(
                f"component {want.get('name')!r}: release variant "
                f"{got.get('variant')!r} != lock {want.get('variant')!r}")
    if release.get("pack_name") != lock.get("pack_name"):
        raise ContractError("release pack_name must match the lock")
    if release.get("manifest_schema") != MANIFEST_SCHEMA:
        raise ContractError(
            f"release manifest_schema must be {MANIFEST_SCHEMA!r}")
    if release.get("os") != lock.get("os") or release.get("arch") != lock.get("arch"):
        raise ContractError("release os/arch must match the lock")
    return True


def _fixture():
    lock = {
        "$schema": "rapidraw-linux-nvidia-runtime-lock-v1",
        "pack_name": "TEST-PACK",
        "arch": "x86_64",
        "os": "linux",
        "components": [
            {"name": "a", "version": "1", "archive_sha256": "0" * 64},
            {"name": "b", "version": "2", "variant": "cuda13",
             "archive_sha256": "1" * 64},
        ],
    }
    release = {
        "$schema": RELEASE_SCHEMA,
        "pack_name": "TEST-PACK",
        "manifest_schema": MANIFEST_SCHEMA,
        "os": "linux",
        "arch": "x86_64",
        "lock_schema": lock["$schema"],
        "lock_sha256": None,  # filled after writing the lock fixture
        "components": copy.deepcopy(lock["components"]),
    }
    return lock, release


class ContractSelfTests(unittest.TestCase):
    def write_pair(self, root, lock, release, lock_sha=None):
        lock_path = Path(root) / "lock.json"
        lock_path.write_text(json.dumps(lock))
        release["lock_sha256"] = (
            lock_sha if lock_sha is not None
            else hashlib.sha256(lock_path.read_bytes()).hexdigest())
        release_path = Path(root) / "release.json"
        release_path.write_text(json.dumps(release))
        return lock_path, release_path

    def test_good_pair_passes(self):
        with tempfile.TemporaryDirectory() as tmp:
            lock, release = _fixture()
            paths = self.write_pair(tmp, lock, release)
            self.assertTrue(check_release_contract(*paths))

    def test_tampers_rejected(self):
        cases = []
        lock, release = _fixture()
        cases.append(("release schema", {"release": {"$schema": "v9"}}))
        cases.append(("lock sha", {"lock_sha": "f" * 64}))
        cases.append(("lock schema", {"lock": {"$schema": "other"}}))
        cases.append(("pack name", {"release": {"pack_name": "OTHER"}}))
        cases.append(("manifest schema", {"release": {"manifest_schema": "other"}}))
        cases.append(("os", {"release": {"os": "macos"}}))
        lock2, release2 = _fixture()
        release2["components"] = list(reversed(release2["components"]))
        cases.append(("component order", {"pair": (lock2, release2)}))
        lock3, release3 = _fixture()
        release3["components"][0]["version"] = "9"
        cases.append(("component version", {"pair": (lock3, release3)}))
        lock4, release4 = _fixture()
        release4["components"][1]["variant"] = "cuda12"
        cases.append(("component variant", {"pair": (lock4, release4)}))
        lock5, release5 = _fixture()
        release5["components"].append(
            {"name": "extra", "version": "1", "archive_sha256": "2" * 64})
        cases.append(("extra component", {"pair": (lock5, release5)}))
        for name, tamper in cases:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as tmp:
                lock, release = tamper.get("pair", _fixture())
                lock = copy.deepcopy(lock)
                release = copy.deepcopy(release)
                for key, value in tamper.get("lock", {}).items():
                    lock[key] = value
                for key, value in tamper.get("release", {}).items():
                    release[key] = value
                paths = self.write_pair(
                    tmp, lock, release, lock_sha=tamper.get("lock_sha"))
                with self.assertRaises(ContractError, msg=name):
                    check_release_contract(*paths)


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--lock", required=False)
    parser.add_argument("--release", required=False)
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args(argv)
    if args.self_test:
        suite = unittest.TestLoader().loadTestsFromTestCase(ContractSelfTests)
        result = unittest.TextTestRunner(verbosity=1).run(suite)
        return 0 if result.wasSuccessful() else 1
    if not args.lock or not args.release:
        print("error: --lock and --release are required (or --self-test)",
              file=sys.stderr)
        return 2
    try:
        check_release_contract(args.lock, args.release)
    except ContractError as exc:
        print(f"error: release contract violation: {exc}", file=sys.stderr)
        return 1
    print("release contract ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
