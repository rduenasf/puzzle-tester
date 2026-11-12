"""Add "what went wrong" data to an exported problem file (e.g. ../strategic_review.js), in place.

For each problem:
  punish  = [game move] + Stockfish's best continuation after it (from the mining cache)
  trace   = a shallow-search eval (from the solver's side) after every ply of both the
            punishment line and the best line. The deep evals are flat by construction
            (they are the engine's own lines), so only the shallow trace shows *when* a
            quick look starts to see the damage.
  nature  = immediate | concrete (critical ply + move) | positional (never visible to the
            shallow search within the line) | marginal (re-score says the move is ~fine)

  python explain.py ../strategic_review.js   (cache: work/<engine's cache file>, see cache_for)
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
from stratmine.__main__ import cache_for, default_stockfish  # noqa: E402
from stratmine.mine import material  # noqa: E402

CLAMP = 1000


def pov_cp(score, color):
    return max(-CLAMP, min(CLAMP, score.pov(color).score(mate_score=100000)))


# ---- trapped pieces (MINING-DECISIONS.md §9.7) ----
VAL = {chess.PAWN: 1, chess.KNIGHT: 3, chess.BISHOP: 3, chess.ROOK: 5, chess.QUEEN: 9, chess.KING: 100}


def unsafe(b, sq, me):
    """My piece on sq can be won: attacked by a cheaper piece, or attacked and undefended."""
    att = [VAL[b.piece_type_at(s)] for s in b.attackers(not me, sq)]
    if not att:
        return False
    return min(att) < VAL[b.piece_type_at(sq)] or not b.attackers(me, sq)


def trapped(b, me):
    """With me to move: my knights/bishops/rooks/queens that can be won where they stand and
    have no move to a square where they can't (a capture worth at least the piece counts as safe)."""
    out = []
    for sq, pc in b.piece_map().items():
        if pc.color != me or pc.piece_type in (chess.PAWN, chess.KING) or not unsafe(b, sq, me):
            continue
        escape = False
        for mv in b.legal_moves:
            if mv.from_square != sq:
                continue
            cap = b.piece_type_at(mv.to_square)
            gain = VAL[cap] if cap else 0
            b.push(mv)
            bad = unsafe(b, mv.to_square, me) and gain < VAL[pc.piece_type]
            b.pop()
            if not bad:
                escape = True
                break
        if not escape:
            out.append(sq)
    return out


def first_trap(fen, seq, me):
    """(index of my turn, ply, square) of the first trapped piece at my turns along seq, or None."""
    b = chess.Board(fen)
    t = 0
    for k, mv in enumerate(seq):
        b.push(mv)
        if b.turn == me:
            tr = trapped(b, me)
            if tr:
                return t, k, tr[0], b.piece_at(tr[0])
            t += 1
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("js", help="Exported problems file to update in place")
    ap.add_argument("--cache", default=None,
                    help="The mining run's Stockfish cache (default: work/<this engine's cache file>)")
    ap.add_argument("--plies", type=int, default=12, help="Plies to follow after the decision (6 of your turns)")
    ap.add_argument("--shallow-depth", type=int, default=5,
                    help="Shallow value = median of the scores at depths 1..N")
    ap.add_argument("--deep-depth", type=int, default=None,
                    help="Depth of the punishment lines: the cache entries read and any searched "
                         "here (default: the mining run's depth from the file's _CONFIG, else 16)")
    ap.add_argument("--workers", type=int, default=12)
    ap.add_argument("--critical-share", type=float, default=0.5,
                    help="Critical ply = first ply where the shallow gap reaches this share of the loss")
    ap.add_argument("--critical-cap", type=int, default=200,
                    help="...or this many cp, whichever is smaller (a 380cp gap on an 850cp loss is plain to see)")
    ap.add_argument("--marginal", type=int, default=30, help="Re-scored loss at or below this = marginal")
    ap.add_argument("--concrete-turns", type=int, default=3,
                    help="Material lost within this many of your turns = concrete")
    ap.add_argument("--trap-gap", type=int, default=2,
                    help="Trapped piece counts only if I end the line this many pawns down vs the best line")
    ap.add_argument("--stockfish", default=default_stockfish())
    a = ap.parse_args()
    if a.cache is None:
        a.cache = os.path.join(os.path.dirname(__file__), "work", cache_for(a.stockfish))

    with open(a.js, encoding="utf-8") as f:
        lines = f.read().split("\n")
    idx = [i for i, l in enumerate(lines) if l.startswith("  {")]
    probs = [json.loads(lines[i].strip().rstrip(",")) for i in idx]
    if a.deep_depth is None:
        cfg_line = next((l for l in lines if l.startswith("export const") and "_CONFIG = " in l), None)
        cfg = json.loads(cfg_line.split(" = ", 1)[1].rstrip(";")) if cfg_line else {}
        a.deep_depth = cfg.get("depth") or 16
    # The mining run's cache for this engine. Missing (e.g. problems mined with another engine):
    # every punishment line is searched at --deep-depth instead.
    cache = {}
    if os.path.exists(a.cache):
        with open(a.cache, encoding="utf-8") as f:
            cache = json.load(f)
    else:
        print(f"no cache at {a.cache}: searching every punishment line at depth {a.deep_depth}", flush=True)
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
        hit = cache.get(f"{after.fen()}|{a.deep_depth}|1")
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

        # A piece of mine gets trapped in the punishment line (earlier than any in the best
        # line) and I end the line at least --trap-gap pawns down: the material rule above can
        # call this positional when the piece falls at the very end of the line.
        trap = None
        tr_p, tr_b = first_trap(p["fen"], punish, me), first_trap(p["fen"], best, me)
        if (kind != "marginal" and tr_p and (tr_b is None or tr_p[0] < tr_b[0])
                and mat_gaps and mat_gaps[-1] >= a.trap_gap):
            t, ply, sq, pc = tr_p
            trap = {"turn": t, "ply": ply, "move": san_at(ply),
                    "piece": pc.symbol().upper() + chess.square_name(sq)}

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
                       "materialEnd": mat_diff, "gapEnd": gaps[-1] if gaps else None,
                       "trapped": trap}
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
