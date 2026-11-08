"""Add a "what changed" breakdown to an exported problem file (after explain.py), in place.

Stockfish 14 with `Use NNUE false` prints its classical evaluation term by term (mobility,
king safety, pawns, threats, ...). For each problem we compare those terms between the
punishment line and the best line, at the same quiet positions (my turn, not in check, last
move not a capture), averaged over all such turns in the first --plies plies. The result says
which positional factors the game move gave away.

  python whatchanged.py ../strategic_review.js
"""
import argparse
import json
import os
import subprocess
import sys
import threading
from concurrent.futures import ThreadPoolExecutor

import chess

sys.path.insert(0, os.path.dirname(__file__))
from stratmine.__main__ import DEFAULT_SF  # noqa: E402

TERMS = ["Pawns", "Knights", "Bishops", "Rooks", "Queens", "Mobility", "King safety",
         "Threats", "Passed", "Space"]
# Stockfish 14 classical phase: non-pawn material between these limits, MG piece values.
MG_VALUE = {chess.KNIGHT: 781, chess.BISHOP: 825, chess.ROOK: 1276, chess.QUEEN: 2538}
MIDGAME_LIMIT, ENDGAME_LIMIT = 15258, 3915


def phase(board):
    npm = sum(MG_VALUE.get(p.piece_type, 0) for p in board.piece_map().values())
    npm = max(ENDGAME_LIMIT, min(MIDGAME_LIMIT, npm))
    return (npm - ENDGAME_LIMIT) * 128 // (MIDGAME_LIMIT - ENDGAME_LIMIT)


class ClassicalEval:
    def __init__(self, path):
        self.p = subprocess.Popen([path], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                  text=True, bufsize=1)
        self._send("uci")
        self._until("uciok")
        self._send("setoption name Use NNUE value false")
        self._send("isready")
        self._until("readyok")

    def _send(self, s):
        self.p.stdin.write(s + "\n")
        self.p.stdin.flush()

    def _until(self, token):
        lines = []
        while True:
            line = self.p.stdout.readline()
            if not line:
                raise RuntimeError("stockfish exited")
            lines.append(line.rstrip("\n"))
            if token in line:
                return lines

    def terms(self, board):
        """White-POV classical terms in pawns, blended by game phase."""
        self._send(f"position fen {board.fen()}")
        self._send("eval")
        lines = self._until("Final evaluation")
        ph = phase(board)
        out = {}
        for line in lines:
            cells = [c.strip() for c in line.split("|")]
            if len(cells) < 5 or cells[1] not in TERMS:
                continue
            mg, eg = (float(v) for v in cells[4].split())
            out[cells[1]] = (mg * ph + eg * (128 - ph)) / 128
        return out

    def close(self):
        try:
            self._send("quit")
            self.p.wait(timeout=5)
        except Exception:  # noqa: BLE001
            self.p.kill()


def quiet_positions(fen, line, me, plies):
    """{turn index: board} for my turns that are quiet."""
    b = chess.Board(fen)
    out, t = {}, -1
    for k, u in enumerate(line[:plies + 1]):
        mv = chess.Move.from_uci(u)
        capture = b.is_capture(mv)
        b.push(mv)
        if b.turn == me:
            t += 1
            if not capture and not b.is_check() and not b.is_game_over():
                out[t] = b.copy(stack=False)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("js")
    ap.add_argument("--plies", type=int, default=12)
    ap.add_argument("--min-show", type=float, default=0.15,
                    help="Smallest term difference (pawns) worth listing")
    ap.add_argument("--first-turn", type=int, default=2)
    ap.add_argument("--last-turn", type=int, default=4)
    ap.add_argument("--min-share", type=float, default=0.25,
                    help="Classical positional difference must be at least this share of the loss")
    ap.add_argument("--workers", type=int, default=12)
    ap.add_argument("--stockfish", default=next((x for x in DEFAULT_SF if x and os.path.exists(x)), None))
    a = ap.parse_args()

    with open(a.js, encoding="utf-8") as f:
        lines = f.read().split("\n")
    idx = [i for i, l in enumerate(lines) if l.startswith("  {")]
    probs = [json.loads(lines[i].strip().rstrip(",")) for i in idx]

    local = threading.local()
    evals = []

    def ev():
        if not hasattr(local, "e"):
            local.e = ClassicalEval(a.stockfish)
            evals.append(local.e)
        return local.e

    def work(p):
        me = chess.Board(p["fen"]).turn
        sign = 1 if me == chess.WHITE else -1
        qp = quiet_positions(p["fen"], p.get("punish", []), me, a.plies)
        qb = quiet_positions(p["fen"], p["line"], me, a.plies)
        # Turns 2-4 (indices 1-3): on a 200-problem sample, agreement with the real loss was
        # best there (64-71%); turn 1 was no better than chance.
        turns = sorted(t for t in set(qp) & set(qb) if a.first_turn - 1 <= t <= a.last_turn - 1)
        if not turns:
            p["changed"] = {"turns": [], "terms": [], "total": None, "explains": False}
            return p
        acc = {t: 0.0 for t in TERMS}
        for t in turns:
            tp, tb = ev().terms(qp[t]), ev().terms(qb[t])
            for term in TERMS:
                # Positive = the best line is better for me on this term = my move gave it away.
                acc[term] += sign * (tb.get(term, 0) - tp.get(term, 0))
        diffs = {term: round(v / len(turns), 2) for term, v in acc.items()}
        total = round(sum(diffs.values()), 2)
        loss = p["scores"].get(p["played"], 1000) / 100
        # Only claim an explanation when the classical eval agrees the move was worse and
        # accounts for a real share of the loss; otherwise it would mislead (~1/3 of cases).
        explains = total > 0 and total >= a.min_share * loss
        ranked = sorted(diffs.items(), key=lambda kv: -kv[1])
        p["changed"] = {
            "turns": [t + 1 for t in turns],
            "terms": [[k, v] for k, v in ranked if v >= a.min_show] if explains else [],
            "total": total,
            "explains": explains,
        }
        return p

    try:
        with ThreadPoolExecutor(a.workers) as ex:
            probs = list(ex.map(work, probs))
    finally:
        for e in evals:
            e.close()

    for i, p in zip(idx, probs):
        lines[i] = "  " + json.dumps(p, separators=(",", ":")) + ","
    with open(a.js, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))

    shown = [p for p in probs if p["changed"]["terms"]]
    top = {}
    for p in shown:
        k = p["changed"]["terms"][0][0]
        top[k] = top.get(k, 0) + 1
    print(f"{len(probs)} problems; no quiet comparison turns: "
          f"{sum(not p['changed']['turns'] for p in probs)}; "
          f"explained by the classical eval: {sum(p['changed']['explains'] for p in probs)}; "
          f"with a listed term: {len(shown)}")
    print("largest term given away:", dict(sorted(top.items(), key=lambda kv: -kv[1])))


if __name__ == "__main__":
    main()
