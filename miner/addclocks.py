"""Add the game clock ("gameClock": {"left", "spent"} in seconds) to an exported problem file, in place.

Matches each problem to its source game by URL and position, so no engine work is needed.
Daily games and games without [%clk] comments get no gameClock.

  python addclocks.py ../strategic.js ../strategic_review.js
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from stratmine.clocks import GameIndex  # noqa: E402

WORK = os.path.join(os.path.dirname(__file__), "work")


def add_clocks(js_path, index):
    with open(js_path, encoding="utf-8") as f:
        lines = f.read().split("\n")
    found = total = 0
    for i, line in enumerate(lines):
        if not line.startswith("  {"):
            continue
        p = json.loads(line.strip().rstrip(","))
        total += 1
        clk = index.clock(p.get("link", ""), p["fen"])
        p.pop("gameClock", None)
        if clk:
            p["gameClock"] = clk
            found += 1
        lines[i] = "  " + json.dumps(p, separators=(",", ":")) + ","
    with open(js_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    print(f"{js_path}: game clock for {found}/{total} problems")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("js", nargs="+", help="Exported problem file(s) to update in place")
    ap.add_argument("--pgn", default=",".join(os.path.join(WORK, n) for n in ("chesscom.pgn", "lichess.pgn")),
                    help="Source PGN file(s), comma-separated")
    a = ap.parse_args()
    index = GameIndex([p for p in a.pgn.split(",") if os.path.exists(p)])
    for js in a.js:
        add_clocks(js, index)


if __name__ == "__main__":
    main()
