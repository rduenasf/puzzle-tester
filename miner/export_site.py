"""Export mined problems to ../strategic.js for the website's Strategy mode.

Every legal move of each problem is scored with Stockfish (multipv = all legal moves),
so the browser can grade any first move without an engine.

The best move, its line and the eval come from the mining run (its deeper single-line
search), not from this table: the table only grades the alternatives. Losses are measured
from the table's own value for the mined best move, so they share one scale; a move the
table rates above it counts as 0 (MINING-DECISIONS.md §8.2).

  python export_site.py work/last30_problems.csv --out ../strategic.js
"""
import argparse
import csv
import json
import os
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor

import chess
import chess.engine

sys.path.insert(0, os.path.dirname(__file__))
from stratmine.__main__ import cache_for, default_stockfish  # noqa: E402
from addclocks import WORK, add_clocks  # noqa: E402
from phrases import problem_id, problem_name  # noqa: E402
from stratmine.clocks import GameIndex  # noqa: E402
from stratmine.flags import DEFAULTS as FLAG_DEFAULTS, rating_flags  # noqa: E402

MATE_CP = 1000  # cap: any move that walks into / misses a mate counts as a 1000cp loss


def raw_scores(sf_path, fen, depth, time_limit):
    """Score of every legal move (cp for the side to move, mates as +-100000), searched together
    with multipv = all legal moves. Stops at `depth` or after `time_limit` seconds, whichever
    comes first. Returns {"vals": {uci: cp}, "depth": depth reached, "timed_out": bool}."""
    board = chess.Board(fen)
    eng = chess.engine.SimpleEngine.popen_uci(sf_path)
    try:
        eng.configure({"Threads": 1, "Hash": 64})
        n = board.legal_moves.count()
        t0 = time.time()
        infos = eng.analyse(board, chess.engine.Limit(depth=depth, time=time_limit), multipv=n)
        elapsed = time.time() - t0
    finally:
        eng.quit()
    me = board.turn
    reached = min(i.get("depth", 0) for i in infos)
    return {"vals": {i["pv"][0].uci(): i["score"].pov(me).score(mate_score=100000) for i in infos},
            "depth": reached, "timed_out": reached < depth and elapsed >= time_limit * 0.98,
            "seconds": round(elapsed, 1)}


def losses(raw, ref_uci):
    """cp loss of every move, measured from the table's value for `ref_uci` (the mined best
    move). Returns (scores, the table's own top move)."""
    vals = raw["vals"]
    top = max(vals, key=vals.get)
    ref = vals.get(ref_uci, vals[top])
    return {u: min(MATE_CP, max(0, ref - v)) for u, v in vals.items()}, top


class ScoreCache:
    """Raw per-move scores keyed by "FEN|depth|all" (like the mining cache), one file per engine.
    Raw scores, not losses, are stored: losses depend on the mined best move, which can change
    between mining runs."""

    def __init__(self, path):
        self.path, self.data, self.dirty, self.saved_at = path, {}, 0, time.time()
        if path and os.path.exists(path):
            with open(path, encoding="utf-8") as f:
                self.data = json.load(f)

    @staticmethod
    def key(fen, depth):
        return f"{fen}|{depth}|all"

    def save(self, force=False):
        if self.path and self.dirty and (force or time.time() - self.saved_at > 60):
            tmp = self.path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(self.data, f)
            os.replace(tmp, self.path)
            self.dirty, self.saved_at = 0, time.time()


def score_rows(a, rows):
    """Raw scores for each row: from the cache, else Stockfish on a.workers processes.
    Prints progress every 10s; saves the cache every minute."""
    cache = ScoreCache(None if a.no_cache else os.path.join(WORK, cache_for(a.stockfish).replace(
        "sf_cache", "export_cache")))
    keys = [ScoreCache.key(r["fen"], a.depth) for r in rows]
    todo = sorted({k for k in keys if k not in cache.data
                   or (a.rescore_timeouts and cache.data[k].get("timed_out"))})
    print(f"scoring {len(rows)} problems at depth {a.depth} (all legal moves): "
          f"{len(set(keys)) - len(todo)} cached, {len(todo)} to search on {a.workers} processes, "
          f"limit {a.time_limit:g}s each" + (f"  [cache {cache.path}]" if cache.path else ""), flush=True)
    t0 = last = time.time()
    done, timed_out = 0, 0
    running = {}  # future -> (fen, start time)
    with ThreadPoolExecutor(a.workers) as ex:
        futs = {}
        for k in todo:
            fen = k.split("|")[0]
            f = ex.submit(lambda fen=fen: (time.time(), raw_scores(a.stockfish, fen, a.depth, a.time_limit)))
            futs[f] = k
        pending = set(futs)
        while pending:
            finished = [f for f in pending if f.done()]
            for f in finished:
                pending.discard(f)
                _, raw = f.result()
                cache.data[futs[f]] = raw
                cache.dirty += 1
                done += 1
                if raw["timed_out"]:
                    timed_out += 1
                    print(f"  time limit: depth {raw['depth']}/{a.depth} after {raw['seconds']:.0f}s: "
                          f"{futs[f].split('|')[0]}", flush=True)
            cache.save()
            now = time.time()
            if pending and now - last >= 10:
                last = now
                rate = done / (now - t0) if done else 0
                eta = f"eta {(len(todo) - done) / rate / 60:.1f} min" if rate else "eta ?"
                print(f"  {done}/{len(todo)} searched  {now - t0:.0f}s elapsed  {eta}"
                      + (f"  {timed_out} hit the time limit" if timed_out else ""), flush=True)
            if pending:
                time.sleep(0.5)
    cache.save(force=True)
    if todo:
        print(f"  {done}/{len(todo)} searched in {time.time() - t0:.0f}s"
              + (f", {timed_out} stopped at the time limit (shallower depth; "
                 "--rescore-timeouts retries them)" if timed_out else ""), flush=True)
    return [cache.data[k] for k in keys]


def parse_line(board, san_line):
    """UCI moves of a mining CSV best_line ("10...e6 11. Nf3 Nc6 ...")."""
    b, out = board.copy(stack=False), []
    for tok in san_line.split():
        tok = re.sub(r"^\d+\.(\.\.)?", "", tok)  # move number, alone or glued to the move
        if not tok:
            continue
        mv = b.parse_san(tok)
        out.append(mv.uci())
        b.push(mv)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("csv", nargs="+")
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "..", "strategic.js"))
    ap.add_argument("--var", default="STRATEGIC", help="Exported JS constant name")
    ap.add_argument("--id-prefix", default="", help="Prefix before the id")
    ap.add_argument("--config", default=None,
                    help="The mining run's *_config.json, exported as <VAR>_CONFIG")
    ap.add_argument("--pgn", default=",".join(os.path.join(WORK, n) for n in ("chesscom.pgn", "lichess.pgn")),
                    help="Source PGN file(s) for the game clocks, comma-separated")
    ap.add_argument("--feedback", default=None,
                    help="Trainer feedback export(s), comma-separated: problems rated bad are left out")
    ap.add_argument("--exclude-tc", default="60+1",
                    help="Comma list of TimeControl headers to leave out ('' = none); same "
                         "default as mining's --exclude-tc")
    ap.add_argument("--depth", type=int, default=20,
                    help="Depth of the all-moves table (same as mining)")
    ap.add_argument("--workers", type=int, default=12)
    ap.add_argument("--stockfish", default=default_stockfish())
    ap.add_argument("--time-limit", type=float, default=1200,
                    help="Seconds per problem; a search still running then stops at the depth it reached")
    ap.add_argument("--no-cache", action="store_true",
                    help="Ignore and don't write work/export_cache-<engine>.json")
    ap.add_argument("--rescore-timeouts", action="store_true",
                    help="Search again the cached problems that stopped at the time limit")
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
    # Same rule as mining (--exclude-tc): a CSV mined before that filter, or with it off,
    # must not bring those games back into the site.
    excluded = {t.strip() for t in (a.exclude_tc or "").split(",") if t.strip()}
    before = len(rows)
    rows = [r for r in rows if r.get("time_control", "") not in excluded]
    if before - len(rows):
        print(f"exclude-tc: left out {before - len(rows)} problems from {', '.join(sorted(excluded))} games")
    raws = score_rows(a, rows)
    results = [losses(raw, chess.Board(r["fen"]).parse_san(r["best_move"]).uci())
               for r, raw in zip(rows, raws)]

    cfg = {}
    if a.config:
        with open(a.config, encoding="utf-8") as cf:
            cfg = json.load(cf)
    thr = {k: cfg.get(k) if cfg.get(k) is not None else v for k, v in FLAG_DEFAULTS.items()}
    out, changed = [], 0
    for r, (scores, top) in zip(rows, results):
        board = chess.Board(r["fen"])
        played = board.parse_san(r["my_move"]).uci()
        mined_best = board.parse_san(r["best_move"]).uci()
        changed += top != mined_best
        line = parse_line(board, r["best_line"]) or [mined_best]
        out.append({
            # Stable across runs (phrases.py): id = hash of link + FEN; name = a phrase to remember
            "id": a.id_prefix + problem_id(r["game"], r["fen"]),
            "name": problem_name(r["game"], r["fen"]),
            "fen": r["fen"],
            "line": line,  # the mining run's best line (line[0] == minedBest)
            "eval": max(-MATE_CP, min(MATE_CP, int(r["eval_before"]))),
            "played": played,
            "scores": scores,
            "kind": r["type"],
            "timeClass": r["time_class"],
            "date": r["date"],
            "link": r["game"],
            # Players from the mined CSV; add_clocks below fills them from the PGN for older CSVs
            **({"white": r["white"], "black": r["black"]} if r.get("white") and r.get("black") else {}),
            "maiaElo": int(r["maia_elo"]),
            "pPlayed": float(r["p_my"]),
            "pBest": float(r["p_best"]),
            "pBestPlus": float(r["p_best_plus"]),
            # p(best) at a fixed strong Elo (--elo-top); missing in runs before it existed
            **({"pBestTop": float(r["p_best_top"])} if r.get("p_best_top") not in (None, "") else {}),
            # p(my move) at +elo_delta and at the top Elo; missing in older runs (addtop.py fills them)
            **({"pPlayedPlus": float(r["p_my_plus"])} if r.get("p_my_plus") not in (None, "") else {}),
            **({"pPlayedTop": float(r["p_my_top"])} if r.get("p_my_top") not in (None, "") else {}),
            # Rating-trend tags (stratmine/flags.py); recomputed for CSVs mined before them
            "flags": (r["flags"].split() if "flags" in r else rating_flags(
                float(r["p_best"]) / 100, float(r["p_best_plus"]) / 100,
                float(r["p_best_top"]) / 100 if r.get("p_best_top") not in (None, "") else None, **thr)),
            "minedBest": mined_best,
            # Repeated positions (MINING-DECISIONS.md §6.10); missing in runs before them.
            # seen: games where I reached this position / games where it became a problem.
            **({"repeat": r["repeat"]} if r.get("repeat") else {}),
            **({"seen": {"games": int(r["reached_games"]), "puzzles": int(r["puzzle_games"])}}
               if r.get("reached_games") not in (None, "") and int(r["reached_games"]) > 1 else {}),
            "timeControl": r.get("time_control", ""),
            # Values of each mining check (from the mining run, not the re-score above)
            "checks": {
                "cpLoss": int(r["cp_loss"]),
                "evalBefore": int(r["eval_before"]),
                "forcing": int(r["forcing_in_line"]),
                "materialLost": int(r["material_lost"]) if r.get("material_lost") not in (None, "") else None,
                "myRank": int(r["maia_rank_my"]) if r.get("maia_rank_my") not in (None, "") else None,
            },
        })
    if len({p["id"] for p in out}) != len(out):
        sys.exit("export: two problems got the same id; make problem_id longer")
    with open(a.out, "w", encoding="utf-8") as f:
        f.write("// Generated by miner/export_site.py from mined problems. Do not edit by hand.\n"
                "// scores: centipawn loss vs the mined best move for every legal move (capped at "
                f"{MATE_CP}).\n// played: the move from the original game. line, eval: the mining run's "
                "best line and eval, side to move.\n")
        f.write(f"export const {a.var} = [\n")
        for p in out:
            f.write("  " + json.dumps(p, separators=(",", ":")) + ",\n")
        f.write("];\n")
        if a.config:
            keep = ["depth", "skip_plies", "cp_min", "cp_max", "max_eval", "forcing_plies",
                    "max_forcing", "quiet_above", "max_material_lost", "p_best_min", "p_best_max", "elo_delta",
                    "p_best_strong_min", "elo_top", "p_gain_min", "natural", "typical", "easy_miss",
                    "blunder", "blunder_max", "drift", "drift_window", "drift_total",
                    "drift_max_single", "drift_cp_min", "opening_plies", *FLAG_DEFAULTS,
                    "since", "maia_model", "elo_map"]
            conf = {k: thr.get(k, cfg.get(k)) for k in keep}
            conf["export_depth"] = a.depth  # depth of the all-moves table (depth = mining)
            f.write(f"export const {a.var}_CONFIG = " + json.dumps(conf) + ";\n")
    add_clocks(a.out, GameIndex([p for p in a.pgn.split(",") if os.path.exists(p)]))
    played_loss = sorted(p["scores"][p["played"]] for p in out)
    print(f"wrote {len(out)} problems -> {a.out}")
    print(f"  the table's own top move differs from the mined best in {changed} problems "
          "(the mined best is kept; moves the table rates above it count as 0)")
    print(f"  your game move's loss now: median {played_loss[len(played_loss) // 2]}cp, "
          f"{sum(x <= 30 for x in played_loss)} problems where it is now within 30cp")


if __name__ == "__main__":
    main()
