import argparse
import os
import shutil
import subprocess
import sys

# Stockfish 19 for all searches. Stockfish 14.1 only for whatchanged.py: it needs the classical
# evaluation's term-by-term `eval` output, which Stockfish 16+ no longer has.
SF19 = os.path.expanduser(r"~\.stockfish\sf19\stockfish\stockfish-windows-x86-64-universal.exe")
SF14 = os.path.expanduser(r"~\.forwardchess\stockfish\stockfish-14-win\stockfish-14-x64.exe")
DEFAULT_SF = [
    os.environ.get("STOCKFISH", ""),
    shutil.which("stockfish") or "",
    SF19,
]


def default_stockfish():
    return next((x for x in DEFAULT_SF if x and os.path.exists(x)), None)


def engine_name(path):
    """The engine's UCI `id name`, e.g. "Stockfish 19"."""
    out = subprocess.run([path], input="uci\nquit\n", capture_output=True, text=True, timeout=30).stdout
    return next((l[len("id name "):].strip() for l in out.splitlines() if l.startswith("id name ")), "")


def cache_for(path):
    """Cache file name for this engine. The cache keys hold no engine version, so each engine
    gets its own file; Stockfish 14.x keeps the original sf_cache.json."""
    name = engine_name(path)
    if name.startswith("Stockfish 14"):
        return "sf_cache.json"
    return "sf_cache-" + "".join(c if c.isalnum() else "-" for c in name.lower()).strip("-") + ".json"


def common(p):
    p.add_argument("--stockfish", default=default_stockfish(),
                   help="Stockfish binary (default: $STOCKFISH, PATH, or Stockfish 19 in ~/.stockfish)")
    p.add_argument("--threads", type=int, default=None)
    p.add_argument("--hash", type=int, default=256, help="Stockfish hash MB")
    p.add_argument("--cache", default=None,
                   help="Stockfish result cache (default: one file per engine, see cache_for)")
    p.add_argument("--depth", type=int, default=20,
                   help="Single-line search depth for every decision (was 16 until 2026-11-11)")
    p.add_argument("--maia-model", default="maia3-23m", help="maia3-5m | maia3-23m | maia3-79m")
    p.add_argument("--checkpoint", default=None,
                   help="Local Maia-3 .pt file (architecture from --maia-model; skips Hugging Face)")
    p.add_argument("--device", default=None)
    p.add_argument("--elo-map", choices=["chessgoals", "offset"], default="chessgoals",
                   help="chess.com -> Lichess-blitz conversion: ChessGoals tables, or a constant")
    p.add_argument("--elo-offset", type=int, default=150,
                   help="Constant added to chess.com ratings when --elo-map offset")


def main(argv=None):
    ap = argparse.ArgumentParser(prog="stratmine",
                                 formatter_class=argparse.ArgumentDefaultsHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    m = sub.add_parser("mine", formatter_class=argparse.ArgumentDefaultsHelpFormatter,
                       help="Mine strategic mistakes from a chess.com PGN export")
    m.add_argument("pgn", help="PGN file(s), comma-separated (chess.com and/or Lichess)")
    m.add_argument("user", help="Your username(s), comma-separated")
    m.add_argument("--since", default=None, help="Only games on/after this UTC date, YYYY-MM-DD")
    m.add_argument("--my-elo", choices=["fixed", "header"], default="fixed",
                   help="chess.com games: your --elo-* per time class, or your rating in the "
                        "game header (Lichess games always use the header)")
    common(m)
    m.add_argument("--out-pgn", default="problems.pgn")
    m.add_argument("--out-csv", default="problems.csv")
    m.add_argument("--out-quiz", default="problems_quiz.pgn",
                   help="Problems without solutions, to fill in and pass to `grade`")
    m.add_argument("--features", default=None, help="Optional CSV of every candidate move")
    m.add_argument("--max-games", type=int, default=0,
                   help="Use only the last N games (after --time-classes)")
    m.add_argument("--time-classes", default=None,
                   help="Comma list to keep, e.g. blitz,rapid (bullet, blitz, rapid, daily)")
    m.add_argument("--workers", type=int, default=12,
                   help="Parallel single-thread Stockfish processes for the deep pass (1 = off)")
    m.add_argument("--elo-bullet", type=int, default=1300)
    m.add_argument("--elo-blitz", type=int, default=1500)
    m.add_argument("--elo-rapid", type=int, default=1650, help="Also used for daily games")
    m.add_argument("--inc-weight", type=float, default=40,
                   help="Time class from base + W*increment (chess.com uses 40; 0 = base only)")
    m.add_argument("--skip-plies", type=int, default=10,
                   help="Ignore the first N plies (half-moves) of every game")
    m.add_argument("--opening-plies", type=int, default=16,
                   help="Problems in the first N plies whose position was a problem in 2+ games are "
                        "labelled common_opening_mistake; later ones repeated_position")
    m.add_argument("--cp-min", type=int, default=30)
    m.add_argument("--cp-max", type=int, default=350,
                   help="Top of the normal range; losses above it up to --blunder-max are the "
                        "blunder_check category")
    m.add_argument("--blunder-max", type=int, default=1000,
                   help="Max cp loss for the blunder_check category (all other checks still apply)")
    m.add_argument("--no-blunder", dest="blunder", action="store_false",
                   help="Drop the blunder_check category (cp loss capped at --cp-max)")
    m.add_argument("--quiet-above", type=int, default=150,
                   help="Losses above this must not simply drop material: after --forcing-plies "
                        "of the opponent's best line you may be down at most --max-material-lost")
    m.add_argument("--max-material-lost", type=int, default=1,
                   help="In pawns (N/B=3, R=5, Q=9)")
    m.add_argument("--max-eval", type=int, default=150, help="Max |eval| before my move")
    m.add_argument("--forcing-plies", type=int, default=6)
    m.add_argument("--max-forcing", type=int, default=2,
                   help="Max checks/captures/promotions in the first forcing-plies of the best line")
    m.add_argument("--p-best-min", type=float, default=0.20)
    m.add_argument("--p-best-max", type=float, default=0.65)
    m.add_argument("--elo-delta", type=int, default=500,
                   help="Stronger-player Elo offset for --p-best-strong-min (and --p-gain-min)")
    m.add_argument("--elo-top", type=int, default=2600,
                   help="Fixed strong Elo whose Maia p(best) is reported (info, not a check)")
    m.add_argument("--p-best-strong-min", type=float, default=0.10,
                   help="Min Maia p(best) at my Elo + elo-delta")
    m.add_argument("--sensitive-plus", type=float, default=0.10,
                   help="rating_sensitive flag: p(best) rises at least this much at +elo-delta ...")
    m.add_argument("--sensitive-top", type=float, default=0.20,
                   help="... and at least this much at --elo-top (a tag, not a check)")
    m.add_argument("--engine-drop-top", type=float, default=0.10,
                   help="engine_move flag: p(best) falls at least this much at --elo-top ...")
    m.add_argument("--engine-drop-plus", type=float, default=0.05,
                   help="... or at least this much at +elo-delta (a tag, not a check)")
    m.add_argument("--p-gain-min", type=float, default=None,
                   help="Re-enable the check that p(best) rises by this much at +elo-delta (off by default)")
    m.add_argument("--no-typical", dest="typical", action="store_false",
                   help="Drop the typical category (my move = Maia top choice; skips --p-best-min)")
    m.add_argument("--no-easy-miss", dest="easy_miss", action="store_false",
                   help="Drop the easy_miss category (best move above --p-best-max at my Elo; "
                        "the Elo-gain check is skipped for it)")
    m.add_argument("--natural", dest="natural", action="store_true", default=False,
                   help="Re-enable the p(my move) >= p(best) filter (off by default)")
    m.add_argument("--no-drift", dest="drift", action="store_false")
    m.add_argument("--drift-window", type=int, default=4)
    m.add_argument("--drift-total", type=int, default=80)
    m.add_argument("--drift-max-single", type=int, default=75,
                   help="No move in a drift window may lose more than this")
    m.add_argument("--drift-cp-min", type=int, default=15,
                   help="cp-loss floor for the flagged worst move of a drift window")

    g = sub.add_parser("grade", formatter_class=argparse.ArgumentDefaultsHelpFormatter,
                       help="Grade answer lines (PGN with FEN headers)")
    g.add_argument("pgn")
    common(g)
    g.add_argument("--multipv", type=int, default=3)
    g.add_argument("--elo", type=int, default=1650,
                   help="chess.com Elo for Maia probabilities (a MaiaElo header overrides)")
    g.add_argument("--time-class", default="rapid", choices=["bullet", "blitz", "rapid"],
                   help="Time class of --elo, for the rating conversion")

    a = ap.parse_args(argv)
    if not a.stockfish:
        ap.error("no Stockfish found; pass --stockfish")
    if a.cache is None:
        a.cache = cache_for(a.stockfish)
    print(f"stockfish: {engine_name(a.stockfish)} ({a.stockfish}), cache {a.cache}", flush=True)

    from .maia import MaiaPolicy
    from .sf import Stockfish
    sf = Stockfish(a.stockfish, a.cache, a.threads, a.hash)
    maia = MaiaPolicy(a.maia_model, a.checkpoint, a.device)
    try:
        if a.cmd == "mine":
            from .mine import mine
            mine(a, sf, maia)
        else:
            from .grade import grade
            grade(a, sf, maia)
    finally:
        sf.close()


if __name__ == "__main__":
    sys.exit(main())
