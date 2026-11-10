"""Add Maia p(best) at a fixed strong Elo ("pBestTop") to an exported problem file, in place.

For files exported before `mine` reported --elo-top. Rebuilds each position's move history
from the source game, exactly as `mine` does, so no Stockfish work is needed.

  python addtop.py ../strategic_review.js --csv work/v4_problems.csv
"""
import argparse
import csv
import json
import os
import re
import sys

import chess

sys.path.insert(0, os.path.dirname(__file__))
from addclocks import WORK  # noqa: E402
from stratmine.clocks import GameIndex  # noqa: E402
from stratmine.maia import MaiaPolicy  # noqa: E402


def history(game, fen):
    """The last 8 positions up to and including `fen` (as `mine` passes them to Maia)."""
    boards = [game.board()]
    for mv in game.mainline_moves():
        if boards[-1].fen() == fen:
            break
        b = boards[-1].copy()
        b.push(mv)
        boards.append(b)
    if boards[-1].fen() != fen:
        return None
    return boards[-8:]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("js", help="Exported problem file to update in place")
    ap.add_argument("--csv", required=True, help="Mined problems CSV (for the opponent's Maia Elo)")
    ap.add_argument("--elo", type=int, default=2600)
    ap.add_argument("--pgn", default=",".join(os.path.join(WORK, n) for n in ("chesscom.pgn", "lichess.pgn")))
    ap.add_argument("--maia-model", default="maia3-23m")
    ap.add_argument("--checkpoint")
    ap.add_argument("--device")
    a = ap.parse_args()

    with open(a.csv, encoding="utf-8") as f:
        opp = {(r["game"], r["fen"]): int(r["opp_maia_elo"]) for r in csv.DictReader(f)}
    index = GameIndex([p for p in a.pgn.split(",") if os.path.exists(p)])
    maia = MaiaPolicy(a.maia_model, a.checkpoint, a.device)

    with open(a.js, encoding="utf-8") as f:
        lines = f.read().split("\n")
    done = total = 0
    for i, line in enumerate(lines):
        if line.startswith("export const") and "_CONFIG = " in line:
            name, cfg = line.split(" = ", 1)
            cfg = json.loads(cfg.rstrip(";"))
            cfg["elo_top"] = a.elo
            lines[i] = f"{name} = {json.dumps(cfg)};"
            continue
        if not line.startswith("  {"):
            continue
        p = json.loads(line.strip().rstrip(","))
        total += 1
        p.pop("pBestTop", None)
        game = index.get(p.get("link", ""))
        hist = history(game, p["fen"]) if game else None
        opp_elo = opp.get((p.get("link", ""), p["fen"]))
        if hist and opp_elo is not None:
            (probs,) = maia.policy(hist, [a.elo], opp_elo)
            best = chess.Move.from_uci(p.get("minedBest") or p["line"][0])
            p["pBestTop"] = round(100 * probs.get(best, 0.0), 1)
            done += 1
        else:
            print(f"  skipped {p['id']}: {'no game' if not game else 'position not found' if not hist else 'not in CSV'}")
        lines[i] = "  " + json.dumps(p, separators=(",", ":")) + ","
    with open(a.js, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(lines))
    print(f"{a.js}: p(best) at {a.elo} for {done}/{total} problems")


if __name__ == "__main__":
    main()
