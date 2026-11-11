"""Add the rating-trend flags ("flags": ["rating_sensitive", "engine_move"]) to an exported
problem file, in place, from its pBest / pBestPlus / pBestTop values. No engine work.

Thresholds come from the file's _CONFIG when it has them, else stratmine/flags.py defaults;
they are written back into the _CONFIG so the trainer can show them.

  python addflags.py ../strategic_review.js
"""
import argparse
import json
import os
import sys
from collections import Counter

sys.path.insert(0, os.path.dirname(__file__))
from stratmine.flags import DEFAULTS, rating_flags  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("js", nargs="+", help="Exported problem file(s) to update in place")
    for k, v in DEFAULTS.items():
        ap.add_argument("--" + k.replace("_", "-"), type=float, default=None,
                        help=f"Override (default: the file's config, else {v})")
    a = ap.parse_args()

    for path in a.js:
        with open(path, encoding="utf-8") as f:
            lines = f.read().split("\n")
        cfg_i = next((i for i, l in enumerate(lines)
                      if l.startswith("export const") and "_CONFIG = " in l), None)
        cfg = json.loads(lines[cfg_i].split(" = ", 1)[1].rstrip(";")) if cfg_i is not None else {}
        thr = {k: next(x for x in (getattr(a, k), cfg.get(k), v) if x is not None)
                for k, v in DEFAULTS.items()}
        counts, total = Counter(), 0
        for i, line in enumerate(lines):
            if not line.startswith("  {"):
                continue
            p = json.loads(line.strip().rstrip(","))
            total += 1
            top = p.get("pBestTop")
            p["flags"] = rating_flags(p["pBest"] / 100, p["pBestPlus"] / 100,
                                      None if top is None else top / 100, **thr)
            counts.update(p["flags"])
            lines[i] = "  " + json.dumps(p, separators=(",", ":")) + ","
        if cfg_i is not None:
            cfg.update(thr)
            name = lines[cfg_i].split(" = ", 1)[0]
            lines[cfg_i] = f"{name} = {json.dumps(cfg)};"
        with open(path, "w", encoding="utf-8", newline="\n") as f:
            f.write("\n".join(lines))
        print(f"{path}: {total} problems; rating_sensitive {counts['rating_sensitive']}, "
              f"engine_move {counts['engine_move']}")


if __name__ == "__main__":
    main()
