"""Phase-C closeout driver: ONNX-vs-controlled full-photo comparison.

Compares assembled ONNX full predictions against controlled-fp32 reference
full predictions for the six required photo/ensemble cases
(portrait/landscape/phone x e1/e4) with the repaired comparator, frozen
gates, exact expected case identities, and ensemble-4 diagnostic seam masks.
Saved arrays are re-measured (no inference rerun). Exit codes: 0 = 6/6
pass, 2 = gate failures (report still written), 1 = tool/invalid error
(such as a missing case or a job that did not actually finish).

Usage: compare_controlled_full.py [--fixtures DIR] [--onnx-dir DIR]
       [--report PATH]
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from rapidraw_denoise.compare_full import compare_files  # noqa: E402

PHOTOS = ("portrait", "landscape", "phone")
ENSEMBLES = (1, 4)
EXPECTED = [f"{p}-e{e}" for p in PHOTOS for e in ENSEMBLES]


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--fixtures", default="/tmp/nlx-fixtures",
                    help="Dir with <photo>-controlled-full/full-ensemble-<e>.npy")
    ap.add_argument("--onnx-dir", default="/tmp/nlx-fixtures",
                    help="Dir with <photo>-<tag>-full-e<e>.npy")
    ap.add_argument("--tag", default="onnx")
    ap.add_argument("--report", default="/tmp/nlx-controlled-full-report.json")
    args = ap.parse_args(argv)
    report_path = Path(args.report)
    if report_path.exists():
        print(json.dumps({"status": "error",
                          "error": f"refusing to overwrite {report_path}"}),
              file=sys.stderr)
        return 1
    try:
        out = []
        for photo in PHOTOS:
            for ensemble in ENSEMBLES:
                name = f"{photo}-e{ensemble}"
                ref = (Path(args.fixtures) / f"{photo}-controlled-full"
                       / f"full-ensemble-{ensemble}.npy")
                act = (Path(args.onnx_dir) / f"{photo}-{args.tag}-full-e{ensemble}.npy")
                for p, what in ((ref, "controlled reference"), (act, "onnx assembly")):
                    if not p.is_file() or p.stat().st_size == 0:
                        raise FileNotFoundError(
                            f"{name}: {what} missing or empty: {p} "
                            "(capture may still be running; not a pass)")
                out.append(compare_files(name, act, ref, ensemble=ensemble))
        names = [e["comparison"] for e in out]
        if sorted(names) != sorted(EXPECTED):
            raise ValueError(f"case identities != expected six: {names}")
        report = {"status": "pass" if all(e["pass"] for e in out) else "fail",
                  "expected_cases": EXPECTED,
                  "comparisons": out}
        report_path.write_text(json.dumps(report, indent=2) + "\n")
        for e in out:
            print(f"{e['comparison']}: {'PASS' if e['pass'] else 'FAIL'} "
                  f"max={e['max_abs_err']:.3g} mae={e['mae']:.3g} "
                  f"p99={e['p99_abs_err']:.3g} viol={e['elementwise_violations']} "
                  + " ".join(f"{k}max={v['max']:.2g}"
                             for k, v in e["regions"].items()))
        return 0 if all(e["pass"] for e in out) else 2
    except Exception as exc:
        error = {"status": "error", "error": f"{type(exc).__name__}: {exc}"}
        if not report_path.exists():
            report_path.write_text(json.dumps(error, indent=2) + "\n")
        print(json.dumps(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
