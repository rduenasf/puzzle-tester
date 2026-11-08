"""`mine`: extract quiet strategic mistakes from a chess.com PGN export."""

import csv
import json
import os
import sys
from collections import Counter

import chess
import chess.pgn

from .elo import to_maia
from .sf import MATE

FILTERS = [
    ("cp_range", "cp loss in [cp-min, cp-max]"),
    ("eval_bound", "|eval before| <= max-eval"),
    ("forcing", "best line mostly non-forcing"),
    ("quiet_punishment", "big loss doesn't just drop material"),
    ("shallow", "depth-N multipv top-K has deep-best"),
    ("p_best_range", "Maia p(best) at my Elo in range"),
    ("p_best_strong", "Maia p(best) at Elo+delta >= min"),
    ("p_best_gain", "Maia p(best) rises at Elo+delta"),
    ("natural", "Maia p(my move) >= p(best)"),
]


def site_of(h):
    return "lichess" if "lichess.org" in h.get("Site", "") else "chesscom"


def time_class(tc, inc_weight, site="chesscom"):
    """Estimated duration = base + inc_weight * increment, with each site's boundaries."""
    if not tc or tc == "-" or "/" in tc:  # "1/86400" = daily / correspondence
        return "daily"
    base, _, inc = tc.partition("+")
    est = float(base) + inc_weight * float(inc or 0)
    if site == "lichess":
        return ("bullet" if est < 180 else "blitz" if est < 480 else
                "rapid" if est < 1500 else "classical")
    return "bullet" if est < 180 else "blitz" if est < 600 else "rapid"


def header_int(game, key):
    try:
        return int(game.headers.get(key, ""))
    except ValueError:
        return None


def forcing_count(board, pv, plies):
    b = board.copy(stack=False)
    n = 0
    for mv in pv[:plies]:
        if b.is_capture(mv) or mv.promotion or b.gives_check(mv):
            n += 1
        b.push(mv)
    return n


PIECE_VALUES = {chess.PAWN: 1, chess.KNIGHT: 3, chess.BISHOP: 3, chess.ROOK: 5,
                chess.QUEEN: 9, chess.KING: 0}


def material(board, color):
    return sum(PIECE_VALUES[p.piece_type] * (1 if p.color == color else -1)
               for p in board.piece_map().values())


def material_lost(before, after, refutation, plies):
    """Pawns of material the mover is down after `plies` of the opponent's best line,
    compared with before the move."""
    me = before.turn
    b = after.copy(stack=False)
    for mv in refutation[:plies]:
        b.push(mv)
    return material(before, me) - material(b, me)


def san_line(board, moves):
    return board.variation_san(moves) if moves else ""


def mine(a, sf, maia):
    # Scan headers only, select games, then parse just those (the full export is 17k games).
    wanted = set(a.time_classes.split(",")) if a.time_classes else None
    users = {u.strip().lower() for u in a.user.split(",")}
    since = a.since.replace("-", ".") if a.since else None
    selected = []  # (path, offset)
    skipped = Counter()
    for path in a.pgn.split(","):
        with open(path, encoding="utf-8-sig") as f:
            while True:
                pos = f.tell()
                h = chess.pgn.read_headers(f)
                if h is None:
                    break
                if not users & {h.get("White", "").lower(), h.get("Black", "").lower()}:
                    skipped["games_without_user"] += 1
                    continue
                if h.get("Variant", "Standard") not in ("Standard", "") or h.get("SetUp") == "1":
                    skipped["games_nonstandard"] += 1
                    continue
                if since and (h.get("UTCDate") or h.get("Date", "")) < since:
                    continue
                if wanted and time_class(h.get("TimeControl"), a.inc_weight, site_of(h)) not in wanted:
                    continue
                selected.append((path, pos))
    if a.max_games:
        selected = selected[-a.max_games:]
    games = []
    for path, pos in selected:
        with open(path, encoding="utf-8-sig") as f:
            f.seek(pos)
            games.append(chess.pgn.read_game(f))

    if a.workers > 1:
        # Parallel pre-pass: every position after the opening, grouped per game so each
        # worker's hash table stays useful. The main loop below then reads the cache.
        groups = []
        for game in games:
            b = game.board()
            grp = []
            for ply, mv in enumerate(game.mainline_moves()):
                if ply >= a.skip_plies:
                    grp.append(b.copy(stack=False))
                b.push(mv)
            grp.append(b.copy(stack=False))
            groups.append(grp)
        sf.analyse_many(groups, a.depth, a.workers)
    elo_by_class = {"bullet": a.elo_bullet, "blitz": a.elo_blitz,
                    "rapid": a.elo_rapid, "daily": a.elo_rapid}

    stats = Counter(skipped)
    fails_any = Counter()
    drift_stats = Counter()
    drift_fails = Counter()
    problems, features = [], []

    for gi, game in enumerate(games, 1):
        h = game.headers
        me = chess.WHITE if h.get("White", "").lower() in users else chess.BLACK
        stats["games"] += 1
        site = site_of(h)
        stats["games_" + site] += 1
        tclass = time_class(h.get("TimeControl"), a.inc_weight, site)
        my_hdr = header_int(game, "WhiteElo" if me == chess.WHITE else "BlackElo")
        opp_raw = header_int(game, "BlackElo" if me == chess.WHITE else "WhiteElo")
        # Lichess games always use the header rating: the fixed --elo-* values are chess.com.
        if (a.my_elo == "header" or site == "lichess") and my_hdr is not None:
            my_raw = my_hdr
        else:
            my_raw = elo_by_class.get(tclass, a.elo_rapid)
        my_elo = to_maia(my_raw, tclass, a.elo_map, a.elo_offset, site)
        opp_elo = to_maia(opp_raw if opp_raw is not None else my_raw,
                          tclass, a.elo_map, a.elo_offset, site)
        link = h.get("Link") or h.get("Site", "")

        boards = [game.board()]
        moves = list(game.mainline_moves())
        for mv in moves:
            b = boards[-1].copy()
            b.push(mv)
            boards.append(b)

        recs = []  # my moves after the opening, in order
        for ply, mv in enumerate(moves):
            bb = boards[ply]
            if bb.turn != me or ply < a.skip_plies:
                continue
            stats["my_moves"] += 1
            before = sf.analyse(bb, a.depth)
            after = sf.analyse(boards[ply + 1], a.depth)
            rec = {"game": gi, "ply": ply, "move": mv, "board": bb, "mate": False}
            if not before or not before[0].pv:
                rec["mate"] = True
                recs.append(rec)
                continue
            b0 = before[0]
            if after:
                ev_after = after[0].pov(me)
                mate_after = after[0].cp is None
            else:  # my move ended the game
                ev_after = MATE if boards[ply + 1].is_checkmate() else 0
                mate_after = boards[ply + 1].is_checkmate()
            rec.update(
                best=b0.pv[0], pv=b0.pv, ev_before=b0.pov(me), ev_after=ev_after,
                mate=b0.cp is None or mate_after,
                after_board=boards[ply + 1],
                refutation=after[0].pv if after else [],  # opponent's best reply line
            )
            rec["cp_loss"] = rec["ev_before"] - rec["ev_after"]
            recs.append(rec)

        def evaluate(rec, cp_min, cp_max):
            """Fill every filter result (for diagnostics) and return the list of failures."""
            if "forcing" not in rec:
                bb = rec["board"]
                rec["forcing"] = forcing_count(bb, rec["pv"], a.forcing_plies)
                rec["ref_forcing"] = forcing_count(rec["after_board"], rec["refutation"],
                                                   a.forcing_plies)
                rec["material_lost"] = material_lost(bb, rec["after_board"], rec["refutation"],
                                                     a.forcing_plies)
                sh = sf.analyse(bb, a.shallow_depth, a.shallow_multipv)
                rec["shallow_rank"] = next((i + 1 for i, l in enumerate(sh)
                                            if l.pv and l.pv[0] == rec["best"]), None)
                hist = boards[max(0, rec["ply"] - 7): rec["ply"] + 1]
                p_lo, p_hi = maia.policy(hist, [my_elo, my_elo + a.elo_delta], opp_elo)
                rec.update(p_best=p_lo.get(rec["best"], 0.0), p_my=p_lo.get(rec["move"], 0.0),
                           p_best_hi=p_hi.get(rec["best"], 0.0), p_my_hi=p_hi.get(rec["move"], 0.0))
                # 1 = my move was Maia's top prediction at my Elo
                rec["my_rank"] = 1 + sum(p > rec["p_my"] for p in p_lo.values())
            r = {
                "cp_range": cp_min <= rec["cp_loss"] <= cp_max,
                "eval_bound": abs(rec["ev_before"]) <= a.max_eval,
                "forcing": rec["forcing"] <= a.max_forcing,
                # Big losses only count when the punishment doesn't simply win material
                # (a hanging piece, a fork): the loss must come from the position.
                "quiet_punishment": (rec["cp_loss"] <= a.quiet_above
                                     or rec["material_lost"] <= a.max_material_lost),
                "shallow": rec["shallow_rank"] is not None,
                # Easy miss: the best move is easy at my level (p > --p-best-max).
                # Typical: my move was Maia's top choice at my level, so the minimum
                # p(best) doesn't apply (the engine move may be rare at my rating).
                "p_best_range": (a.p_best_min <= rec["p_best"] <= a.p_best_max
                                 or (a.easy_miss and rec["p_best"] > a.p_best_max)
                                 or (a.typical and rec["my_rank"] == 1)),
                # Stronger players (my Elo + elo-delta, default +500) must find the best move
                # at least sometimes; otherwise it's deep calculation or an engine-only move.
                "p_best_strong": rec["p_best_hi"] >= a.p_best_strong_min,
                # Off by default; --p-gain-min N re-enables it (skipped for easy misses).
                "p_best_gain": (a.p_gain_min is None
                                or (a.easy_miss and rec["p_best"] > a.p_best_max)
                                or rec["p_best_hi"] - rec["p_best"] >= a.p_gain_min),
                "natural": (not a.natural) or rec["p_my"] >= rec["p_best"],
            }
            rec["res"] = r
            return [k for k, _ in FILTERS if not r[k]]

        # ---- single-move problems
        chosen = set()
        for rec in recs:
            if rec["mate"]:
                stats["removed_mate_score"] += 1
                continue
            if rec["move"] == rec["best"]:
                stats["removed_played_best"] += 1
                continue
            # Only pay for Maia / shallow search where cp loss is anywhere near interesting.
            if rec["cp_loss"] < min(a.cp_min, a.drift_cp_min):
                stats["removed_cp_range"] += 1
                fails_any["cp_range"] += 1
                continue
            fails = evaluate(rec, a.cp_min, a.cp_max)
            for k in fails:
                fails_any[k] += 1
            features.append(rec)
            if fails:
                stats["removed_" + fails[0]] += 1
            else:
                kind = ("easy_miss" if rec["p_best"] > a.p_best_max
                        else "typical" if rec["my_rank"] == 1 else "single")
                stats["kept_" + kind] += 1
                chosen.add(rec["ply"])
                problems.append((rec, kind, game, link, my_elo, opp_elo, tclass))

        # ---- drift windows
        if a.drift:
            seen = set()
            for i in range(len(recs) - a.drift_window + 1):
                win = recs[i:i + a.drift_window]
                if any(r["mate"] for r in win):
                    continue
                losses = [max(0, r["cp_loss"]) for r in win]
                if sum(losses) < a.drift_total or max(losses) > a.drift_max_single:
                    continue
                drift_stats["windows"] += 1
                worst = max(win, key=lambda r: r["cp_loss"])
                if worst["ply"] in seen:
                    continue
                seen.add(worst["ply"])
                drift_stats["unique_worst_moves"] += 1
                if worst["ply"] in chosen:
                    drift_stats["already_single"] += 1
                    continue
                if worst["move"] == worst["best"]:
                    drift_stats["removed_played_best"] += 1
                    continue
                worst.pop("res", None)
                fails = evaluate(worst, a.drift_cp_min, a.cp_max)
                if fails:
                    drift_stats["removed_" + fails[0]] += 1
                    for k in fails:
                        drift_fails[k] += 1
                else:
                    drift_stats["kept_drift"] += 1
                    chosen.add(worst["ply"])
                    worst["drift_total"] = sum(losses)
                    problems.append((worst, "drift", game, link, my_elo, opp_elo, tclass))
        print(f"  game {gi}/{len(games)} {tclass} {'W' if me else 'B'} "
              f"plies={len(moves)} problems so far={len(problems)}", file=sys.stderr, flush=True)

    sf.save()
    problems.sort(key=lambda p: (p[0]["game"], p[0]["ply"]))
    write_outputs(a, problems)
    if a.features:
        write_features(a.features, features)
    report(stats, fails_any, drift_stats, drift_fails, len(problems), a)
    return problems


def fmt_p(x):
    return f"{100 * x:.1f}"


def write_outputs(a, problems):
    rows = []
    with open(a.out_pgn, "w", encoding="utf-8") as fp, \
            open(a.out_quiz, "w", encoding="utf-8") as fq:
        for n, (rec, kind, game, link, my_elo, opp_elo, tclass) in enumerate(problems, 1):
            bb = rec["board"]
            best_san = bb.san(rec["best"])
            my_san = bb.san(rec["move"])
            line = san_line(bb, rec["pv"])
            row = {
                "id": n, "type": kind, "fen": bb.fen(),
                "side": "white" if bb.turn else "black",
                "move_number": bb.fullmove_number,
                "my_move": my_san, "best_move": best_san, "best_line": line,
                "cp_loss": rec["cp_loss"], "eval_before": rec["ev_before"],
                "eval_after": rec["ev_after"],
                "p_my": fmt_p(rec["p_my"]), "maia_rank_my": rec["my_rank"],
                "p_best": fmt_p(rec["p_best"]),
                "p_best_plus": fmt_p(rec["p_best_hi"]), "p_my_plus": fmt_p(rec["p_my_hi"]),
                "forcing_in_line": rec["forcing"], "forcing_in_punishment": rec["ref_forcing"],
                "material_lost": rec["material_lost"],
                "shallow_rank": rec["shallow_rank"],
                "drift_total": rec.get("drift_total", ""),
                "maia_elo": my_elo, "opp_maia_elo": opp_elo, "time_class": tclass,
                "time_control": game.headers.get("TimeControl", ""),
                "game": link, "date": game.headers.get("Date", ""),
                "white": game.headers.get("White", ""), "black": game.headers.get("Black", ""),
            }
            rows.append(row)

            for out, with_moves in ((fp, True), (fq, False)):
                g = chess.pgn.Game()
                g.setup(bb)
                g.headers["Event"] = f"Strategic problem {n}" + (f" ({kind})" if with_moves else "")
                g.headers["Site"] = link
                g.headers["Date"] = game.headers.get("Date", "????.??.??")
                g.headers["White"] = game.headers.get("White", "?")
                g.headers["Black"] = game.headers.get("Black", "?")
                g.headers["Round"] = str(n)
                g.headers["MaiaElo"] = str(my_elo)
                if with_moves:
                    g.headers["Result"] = "*"
                    node = g
                    for mv in rec["pv"]:
                        node = node.add_main_variation(mv)
                    g.variations[0].comment = (
                        f"Best (depth {a.depth}): eval {rec['ev_before']:+d}")
                    v = g.add_variation(rec["move"])
                    v.comment = (f"Played: {my_san}, eval {rec['ev_after']:+d}, "
                                 f"loss {rec['cp_loss']}cp")
                    g.comment = (
                        f"{kind}. Maia@{my_elo}: p({my_san})={fmt_p(rec['p_my'])}% "
                        f"p({best_san})={fmt_p(rec['p_best'])}%; "
                        f"@{my_elo + a.elo_delta}: p({best_san})={fmt_p(rec['p_best_hi'])}%"
                        + (f"; drift window loss {rec['drift_total']}cp" if kind == "drift" else ""))
                else:
                    g.comment = f"{'White' if bb.turn else 'Black'} to move. Enter your line."
                print(g, file=out, end="\n\n")
    with open(a.out_csv, "w", newline="", encoding="utf-8") as f:
        if rows:
            w = csv.DictWriter(f, fieldnames=list(rows[0]))
            w.writeheader()
            w.writerows(rows)
    # Thresholds used for this run, so tools (e.g. the trainer) can show why each problem passed.
    cfg = {k: v for k, v in vars(a).items()
           if isinstance(v, (int, float, str, bool, type(None))) and k not in ("hash", "threads")}
    with open(os.path.splitext(a.out_csv)[0] + "_config.json", "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=1)


def write_features(path, recs):
    keys = ["game", "ply", "cp_loss", "ev_before", "ev_after", "forcing", "ref_forcing", "material_lost", "shallow_rank",
            "p_my", "my_rank", "p_best", "p_best_hi"]
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(keys + ["my_move", "best", "fen"])
        for r in recs:
            w.writerow([r[k] for k in keys] + [r["move"].uci(), r["best"].uci(), r["board"].fen()])


def report(stats, fails_any, drift_stats, drift_fails, n_problems, a):
    p = lambda *x: print(*x, file=sys.stderr)
    p("\n=== mine: filter report ===")
    p(f"games analysed: {stats['games']}  (chess.com {stats['games_chesscom']}, "
      f"lichess {stats['games_lichess']}; skipped without user: {stats['games_without_user']}, "
      f"non-standard: {stats['games_nonstandard']})")
    p(f"my moves after ply {a.skip_plies}: {stats['my_moves']}")
    p("single-move pipeline (sequential: each move counted at the first filter it fails):")
    p(f"  {'mate score before/after':42s} -{stats['removed_mate_score']}")
    p(f"  {'played the engine move':42s} -{stats['removed_played_best']}")
    for k, desc in FILTERS:
        p(f"  {desc:42s} -{stats['removed_' + k]:<5d}  (fails in total: {fails_any[k]})")
    p(f"  kept: single {stats['kept_single']}, typical (my move = Maia's top) "
      f"{stats['kept_typical']}, easy_miss (p(best) > {a.p_best_max:.0%}) "
      f"{stats['kept_easy_miss']}")
    if a.drift:
        p("drift pipeline:")
        p(f"  qualifying windows {drift_stats['windows']}, unique worst moves "
          f"{drift_stats['unique_worst_moves']}, already single {drift_stats['already_single']}, "
          f"played best {drift_stats['removed_played_best']}")
        for k, desc in FILTERS:
            if drift_stats["removed_" + k] or drift_fails[k]:
                p(f"  {desc:42s} -{drift_stats['removed_' + k]:<5d}  (fails in total: {drift_fails[k]})")
        p(f"  kept drift: {drift_stats['kept_drift']}")
    games = max(1, stats["games"])
    p(f"TOTAL problems: {n_problems}  ({n_problems / games:.2f} per game)")
