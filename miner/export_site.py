"""Export mined problems to ../strategic.js for the website's Strategy mode.

Every legal move of each problem is scored with Stockfish (multipv = all legal moves),
so the browser can grade any first move without an engine.

  python export_site.py work/last30_problems.csv --out ../strategic.js
"""
import argparse
import csv
import json
import os
import sys
from concurrent.futures import ThreadPoolExecutor

import chess
import chess.engine

sys.path.insert(0, os.path.dirname(__file__))
from stratmine.__main__ import DEFAULT_SF  # noqa: E402
from addclocks import WORK, add_clocks  # noqa: E402
from stratmine.clocks import GameIndex  # noqa: E402

MATE_CP = 1000  # cap: any move that walks into / misses a mate counts as a 1000cp loss


def score_all(sf_path, fen, depth):
    board = chess.Board(fen)
    eng = chess.engine.SimpleEngine.popen_uci(sf_path)
    try:
        eng.configure({"Threads": 1, "Hash": 64})
        n = board.legal_moves.count()
        infos = eng.analyse(board, chess.engine.Limit(depth=depth), multipv=n)
    finally:
        eng.quit()
    me = board.turn
    vals = {}
    for info in infos:
        mv = info["pv"][0]
        vals[mv.uci()] = (info["score"].pov(me).score(mate_score=100000), info["pv"])
    best_uci = max(vals, key=lambda u: vals[u][0])
    best_val, best_pv = vals[best_uci]
    scores = {u: min(MATE_CP, max(0, best_val - v)) for u, (v, _) in vals.items()}
    return best_uci, [m.uci() for m in best_pv], max(-MATE_CP, min(MATE_CP, best_val)), scores


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("csv", nargs="+")
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "..", "strategic.js"))
    ap.add_argument("--var", default="STRATEGIC", help="Exported JS constant name")
    ap.add_argument("--id-prefix", default="s")
    ap.add_argument("--config", default=None,
                    help="The mining run's *_config.json, exported as <VAR>_CONFIG")
    ap.add_argument("--pgn", default=",".join(os.path.join(WORK, n) for n in ("chesscom.pgn", "lichess.pgn")),
                    help="Source PGN file(s) for the game clocks, comma-separated")
    ap.add_argument("--feedback", default=None,
                    help="Trainer feedback export(s), comma-separated: problems rated bad are left out")
    ap.add_argument("--depth", type=int, default=16)
    ap.add_argument("--workers", type=int, default=12)
    ap.add_argument("--stockfish", default=next((x for x in DEFAULT_SF if x and os.path.exists(x)), None))
    a = ap.parse_args()

    rows = []
    for path in a.csv:
        with open(path, encoding="utf-8") as f:
            rows += list(csv.DictReader(f))
    if a.feedback:  # leave out problems rated bad in the trainer (same key as app.js: link#fen)
        from feedback import load as load_feedback
        bad = {k for k, e in load_feedback(a.feedback.split(",")).items() if e.get("rating") == "bad"}
        before = len(rows)
        rows = [r for r in rows if f"{r['game']}#{r['fen']}" not in bad]
        print(f"feedback: left out {before - len(rows)} problems rated bad ({len(bad)} bad ratings)")
    print(f"scoring {len(rows)} problems at depth {a.depth} (all legal moves)...", flush=True)
    with ThreadPoolExecutor(a.workers) as ex:
        results = list(ex.map(lambda r: score_all(a.stockfish, r["fen"], a.depth), rows))

    out, changed = [], 0
    for i, (r, (best, line, ev, scores)) in enumerate(zip(rows, results), 1):
        board = chess.Board(r["fen"])
        played = board.parse_san(r["my_move"]).uci()
        mined_best = board.parse_san(r["best_move"]).uci()
        changed += best != mined_best
        out.append({
            "id": f"{a.id_prefix}{i:03d}-{r['date'].replace('.', '')}",
            "fen": r["fen"],
            "line": line,
            "eval": ev,
            "played": played,
            "scores": scores,
            "kind": r["type"],
            "timeClass": r["time_class"],
            "date": r["date"],
            "link": r["game"],
            "maiaElo": int(r["maia_elo"]),
            "pPlayed": float(r["p_my"]),
            "pBest": float(r["p_best"]),
            "pBestPlus": float(r["p_best_plus"]),
            # p(best) at a fixed strong Elo (--elo-top); missing in runs before it existed
            **({"pBestTop": float(r["p_best_top"])} if r.get("p_best_top") not in (None, "") else {}),
            "minedBest": mined_best,
            "timeControl": r.get("time_control", ""),
            # Values of each mining check (from the mining run, not the re-score above)
            "checks": {
                "cpLoss": int(r["cp_loss"]),
                "evalBefore": int(r["eval_before"]),
                "forcing": int(r["forcing_in_line"]),
                "materialLost": int(r["material_lost"]) if r.get("material_lost") not in (None, "") else None,
                "shallowRank": int(r["shallow_rank"]) if r["shallow_rank"] not in ("", "None") else None,
                "myRank": int(r["maia_rank_my"]) if r.get("maia_rank_my") not in (None, "") else None,
            },
        })
    with open(a.out, "w", encoding="utf-8") as f:
        f.write("// Generated by miner/export_site.py from mined problems. Do not edit by hand.\n"
                "// scores: centipawn loss vs Stockfish's best for every legal move (capped at "
                f"{MATE_CP}).\n// played: the move from the original game. eval: best line, side to move.\n")
        f.write(f"export const {a.var} = [\n")
        for p in out:
            f.write("  " + json.dumps(p, separators=(",", ":")) + ",\n")
        f.write("];\n")
        if a.config:
            with open(a.config, encoding="utf-8") as cf:
                cfg = json.load(cf)
            keep = ["depth", "skip_plies", "cp_min", "cp_max", "max_eval", "forcing_plies",
                    "max_forcing", "quiet_above", "max_material_lost", "shallow_depth",
                    "shallow_multipv", "p_best_min", "p_best_max", "elo_delta",
                    "p_best_strong_min", "elo_top", "p_gain_min", "natural", "typical", "easy_miss",
                    "blunder", "blunder_max",
                    "since", "maia_model", "elo_map"]
            f.write(f"export const {a.var}_CONFIG = "
                    + json.dumps({k: cfg.get(k) for k in keep}) + ";\n")
    add_clocks(a.out, GameIndex([p for p in a.pgn.split(",") if os.path.exists(p)]))
    played_loss = sorted(p["scores"][p["played"]] for p in out)
    print(f"wrote {len(out)} problems -> {a.out}")
    print(f"  best move differs from the mining run in {changed} problems (engine noise)")
    print(f"  your game move's loss now: median {played_loss[len(played_loss) // 2]}cp, "
          f"{sum(x <= 30 for x in played_loss)} problems where it is now within 30cp")


if __name__ == "__main__":
    main()
