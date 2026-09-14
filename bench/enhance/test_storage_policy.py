import collections
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from storage_policy import require_free_space


class StoragePolicyTests(unittest.TestCase):
    def test_uses_output_ancestor_and_rejects_low_space(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            usage = collections.namedtuple("Usage", "free")
            with patch("storage_policy.shutil.disk_usage", return_value=usage(10 * 1024 ** 3)) as disk:
                with self.assertRaisesRegex(RuntimeError, "STORAGE_LOW"):
                    require_free_space(root / "new" / "run", 20)
                disk.assert_called_once_with(root)
                require_free_space(root / "new", 5)
            for value in (0, -1, float("nan"), float("inf")):
                with self.assertRaises(ValueError):
                    require_free_space(root, value)


if __name__ == "__main__":
    unittest.main()
