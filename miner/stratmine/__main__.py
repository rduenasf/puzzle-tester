import argparse
import os
import shutil
import sys

DEFAULT_SF = [
    os.environ.get("STOCKFISH", ""),
    shutil.which("stockfish") or "",
    os.path.expanduser(r"~\.forwardchess\stockfish\stockfish-14-win\stockfish-14-x64.exe"),
]


def common(p):
    p.add_argument("--stockfish", default=next((x for x in DEFAULT_SF if x and os.path.exists(x)), None),
                   help="Stockfish binary (default: $STOCKFISH, PATH, or the forwardchess copy)")
    p.add_argument("--threads", type=int, default=None)
    p.add_argument("--hash", type=int, default=256, help="Stockfish hash MB")
    p.add_argument("--cache", default="sf_cache.json", help="Stockfish result cache")
    p.add_argument("--depth", type=int, default=16)
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
    m.add_argument("--skip-plies", type=int, default=12)
    m.add_argument("--cp-min", type=int, default=30)
    m.add_argument("--cp-max", type=int, default=350)
    m.add_argument("--quiet-above", type=int, default=150,
                   help="Losses above this must not simply drop material: after --forcing-plies "
                        "of the opponent's best line you may be down at most --max-material-lost")
    m.add_argument("--max-material-lost", type=int, default=1,
                   help="In pawns (N/B=3, R=5, Q=9)")
    m.add_argument("--max-eval", type=int, default=150, help="Max |eval| before my move")
    m.add_argument("--forcing-plies", type=int, default=6)
    m.add_argument("--max-forcing", type=int, default=2,
                   help="Max checks/captures/promotions in the first forcing-plies of the best line")
    m.add_argument("--shallow-depth", type=int, default=3)
    m.add_argument("--shallow-multipv", type=int, default=3)
    m.add_argument("--p-best-min", type=float, default=0.20)
    m.add_argument("--p-best-max", type=float, default=0.65)
    m.add_argument("--elo-delta", type=int, default=500,
                   help="Stronger-player Elo offset for --p-best-strong-min (and --p-gain-min)")
    m.add_argument("--p-best-strong-min", type=float, default=0.10,
                   help="Min Maia p(best) at my Elo + elo-delta")
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
