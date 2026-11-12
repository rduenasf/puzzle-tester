"""Add "what went wrong" data to an exported problem file (e.g. ../strategic_review.js), in place.

For each problem:
  punish  = [game move] + Stockfish's best continuation after it (from the mining cache)
  trace   = a shallow-search eval (from the solver's side) after every ply of both the
            punishment line and the best line. The deep evals are flat by construction
            (they are the engine's own lines), so only the shallow trace shows *when* a
            quick look starts to see the damage.
  nature  = immediate | concrete (critical ply + move) | positional (never visible to the
            shallow search within the line) | marginal (re-score says the move is ~fine)

  python explain.py ../strategic_review.js --cache work/sf_cache.json
"""
import argparse
import json
import os
import sys
import threading
from concurrent.futures import ThreadPoolExecutor

import chess
import chess.engine

sys.path.insert(0, os.path.dirname(__file__))
from stratmine.__main__ import DEFAULT_SF  # noqa: E402
from stratmine.mine import material  # noqa: E402

CLAMP = 1000


def pov_cp(score, color):
    return max(-CLAMP, min(CLAMP, score.pov(color).score(mate_score=100000)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("js", help="Exported problems file to update in place")
    ap.add_argument("--cache", default=os.path.join(os.path.dirname(__file__), "work", "sf_cache.json"))
    ap.add_argument("--plies", type=int, default=12, help="Plies to follow after the decision (6 of your turns)")
    ap.add_argument("--shallow-depth", type=int, default=5,
                    help="Shallow value = median of the scores at depths 1..N")
    ap.add_argument("--deep-depth", type=int, default=16, help="For punishment lines not in the cache")
    ap.add_argument("--workers", type=int, default=12)
    ap.add_argument("--critical-share", type=float, default=0.5,
                    help="Critical ply = first ply where the shallow gap reaches this share of the loss")
    ap.add_argument("--critical-cap", type=int, default=200,
                    help="...or this many cp, whichever is smaller (a 380cp gap on an 850cp loss is plain to see)")
    ap.add_argument("--marginal", type=int, default=30, help="Re-scored loss at or below this = marginal")
    ap.add_argument("--concrete-turns", type=int, default=3,
                    help="Material lost within this many of your turns = concrete")
    ap.add_argument("--stockfish", default=next((x for x in DEFAULT_SF if x and os.path.exists(x)), None))
    a = ap.parse_args()

    with open(a.js, encoding="utf-8") as f:
        lines = f.read().split("\n")
    idx = [i for i, l in enumerate(lines) if l.startswith("  {")]
    probs = [json.loads(lines[i].strip().rstrip(",")) for i in idx]
    with open(a.cache, encoding="utf-8") as f:
        cache = json.load(f)
    print(f"{len(probs)} problems; shallow depth {a.shallow_depth}, {a.plies} plies", flush=True)

    local = threading.local()

    def engine():
        if not hasattr(local, "eng"):
            local.eng = chess.engine.SimpleEngine.popen_uci(a.stockfish)
            local.eng.configure({"Threads": 1, "Hash": 16})
            engines.append(local.eng)
        return local.eng

    engines = []

    def shallow(board, me):
        if board.is_checkmate():
            return -CLAMP if board.turn == me else CLAMP
        if board.is_game_over():
            return 0
        # Very shallow searches are unstable (a lone depth-3 score can be off by 900cp), so
        # take the median of the scores at depths 1..N from one search.
        scores = {}
        with engine().analysis(board, chess.engine.Limit(depth=a.shallow_depth),
                               game=object()) as an:
            for info in an:
                if "score" in info and "depth" in info and "upperbound" not in info \
                        and "lowerbound" not in info:
                    scores[info["depth"]] = pov_cp(info["score"], me)
        vals = sorted(scores.values())
        return vals[len(vals) // 2] if vals else 0

    def trace(fen, seq, me):
        """Shallow eval at each of my turns along seq (after each opponent reply).
        Positions with the opponent to move are skipped: there a quick search sees threats
        against me that I can still parry, which makes the trace jump by 500+cp."""
        b = chess.Board(fen)
        out, plies, mats = [], [], []
        for k, mv in enumerate(seq):
            b.push(mv)
            if b.turn == me:
                out.append(shallow(b, me))
                plies.append(k)
                mats.append(material(b, me))
        return out, plies, mats, b

    def work(p):
        board = chess.Board(p["fen"])
        me = board.turn
        played = chess.Move.from_uci(p["played"])
        after = board.copy(stack=False)
        after.push(played)
        hit = cache.get(f"{after.fen()}|16|1")
        if hit is not None:
            pv = [chess.Move.from_uci(u) for u in (hit[0]["pv"] if hit else [])]
        else:
            info = engine().analyse(after, chess.engine.Limit(depth=a.deep_depth))
            pv = info.get("pv", [])
        punish = [played] + pv[:a.plies]
        best = [chess.Move.from_uci(u) for u in p["line"][:a.plies + 1]]
        tp, plies_p, mp, end_p = trace(p["fen"], punish, me)
        tb, _, mb, end_b = trace(p["fen"], best, me)

        loss = p["scores"].get(p["played"], CLAMP)
        deep_best = p["eval"]
        deep_punish = deep_best - loss
        # Gap between the two shallow traces at each of my turns (best minus punishment).
        n = min(len(tp), len(tb))
        gaps = [tb[t] - tp[t] for t in range(n)]
        need = max(a.marginal, min(a.critical_share * loss, a.critical_cap))
        crit = next((t for t, g in enumerate(gaps) if g >= need), None)  # index of my turn
        mat_diff = material(end_b, me) - material(end_p, me)  # pawns I'm worse off at the end
        # Material gap vs the best line at each of my turns. Stockfish's eval already contains
        # positional judgment (king safety, structure), so the eval trace can't tell positional
        # from concrete; whether the punishment actually wins material can.
        mat_gaps = [mb[t] - mp[t] for t in range(min(len(mp), len(mb)))]
        # First turn from which I stay at least a pawn down (ignores gaps that last only
        # until my recapture).
        # It must hold for at least two of my turns: a gap seen only at the end of the line may
        # be undone by a recapture just past it.
        mat_turn = next((t for t in range(len(mat_gaps) - 1)
                         if all(g >= 1 for g in mat_gaps[t:])), None)
        if loss <= a.marginal:
            kind = "marginal"
        elif mat_turn is None:
            kind = "positional"            # no material lost in the whole line
        elif mat_turn < a.concrete_turns:
            kind = "concrete"              # material goes within the first few turns
        else:
            kind = "positional_then_material"  # position first, material only later

        def san_at(ply):
            b = board.copy(stack=False)
            for mv in punish[:ply]:
                b.push(mv)
            return f"{b.fullmove_number}{'.' if b.turn else '...'}" + b.san(punish[ply])

        crit_ply = plies_p[crit] if crit is not None else None   # eval: quick look sees it
        mat_ply = plies_p[mat_turn] if mat_turn is not None else None
        p["punish"] = [m.uci() for m in punish]
        p["trace"] = {"depth": a.shallow_depth, "punish": tp, "best": tb, "plies": plies_p,
                      "matPunish": mp, "matBest": mb,
                      "deepPunish": deep_punish, "deepBest": deep_best}
        p["nature"] = {"kind": kind,
                       "turn": crit, "ply": crit_ply,
                       "move": san_at(crit_ply) if crit_ply is not None else None,
                       "matTurn": mat_turn, "matPly": mat_ply,
                       "matMove": san_at(mat_ply) if mat_ply is not None else None,
                       # the lasting loss (smallest gap from then on), not a mid-exchange peak
                       "matGap": min(mat_gaps[mat_turn:]) if mat_turn is not None else 0,
                       "materialEnd": mat_diff, "gapEnd": gaps[-1] if gaps else None}
        return p

    done = [0]

    def run(p):
        r = work(p)
        done[0] += 1
        if done[0] % 100 == 0:
            print(f"  {done[0]}/{len(probs)}", flush=True)
        return r

    try:
        with ThreadPoolExecutor(a.workers) as ex:
            probs = list(ex.map(run, probs))
    finally:
        for e in engines:
            e.quit()

    for i, p in zip(idx, probs):
        lines[i] = "  " + json.dumps(p, separators=(",", ":")) + ","
    with open(a.js, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    kinds = {}
    for p in probs:
        kinds[p["nature"]["kind"]] = kinds.get(p["nature"]["kind"], 0) + 1
    print("nature:", kinds)


if __name__ == "__main__":
    main()
