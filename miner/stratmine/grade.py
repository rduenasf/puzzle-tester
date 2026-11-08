"""`grade`: score my answers (a line of moves from a FEN) against Stockfish."""

import chess
import chess.pgn

from .elo import to_maia

LABELS = [(10, "Best", 3), (30, "Good", 2), (75, "Inaccuracy", 1), (150, "Mistake", 0)]


def label(cp_loss):
    for limit, name, pts in LABELS:
        if cp_loss <= limit:
            return name, pts
    return "Blunder", 0


def fmt_eval(v):
    from .sf import MATE
    if abs(v) > MATE - 1000:
        n = MATE - abs(v)
        return f"{'+' if v > 0 else '-'}M{n}"
    return f"{v:+d}"


def grade(a, sf, maia):
    total = maxpts = 0
    with open(a.pgn, encoding="utf-8-sig") as f:
        gi = 0
        while (g := chess.pgn.read_game(f)) is not None:
            gi += 1
            if "FEN" not in g.headers:
                print(f"[{gi}] skipped: no FEN header")
                continue
            board = g.board()
            me = board.turn
            elo = int(g.headers.get("MaiaElo")
                      or to_maia(a.elo, a.time_class, a.elo_map, a.elo_offset))
            moves = list(g.mainline_moves())
            print(f"\n[{gi}] {g.headers.get('Event', '')}  {'White' if me else 'Black'} to move"
                  f"  (Maia Elo {elo})\n    {board.fen()}")
            if not moves:
                print("    no moves entered")
                continue
            history = [board.copy()]
            gpts = gmax = 0
            for i, mv in enumerate(moves):
                if board.turn == me:
                    lines = sf.analyse(board, a.depth, a.multipv)
                    if not lines:
                        break
                    best = lines[0].pov(me)
                    mine_line = next((l for l in lines if l.pv and l.pv[0] == mv), None)
                    if mine_line is not None:
                        my_ev = mine_line.pov(me)
                    else:
                        nb = board.copy()
                        nb.push(mv)
                        after = sf.analyse(nb, a.depth)
                        if after:
                            my_ev = after[0].pov(me)
                        else:
                            from .sf import MATE
                            my_ev = MATE if nb.is_checkmate() else 0
                    loss = max(0, best - my_ev)
                    name, pts = label(loss)
                    p = maia.policy(history[-8:], [elo], elo)[0].get(mv, 0.0)
                    alts = ", ".join(f"{board.san(l.pv[0])} {fmt_eval(l.pov(me))}"
                                     for l in lines if l.pv)
                    print(f"    {board.fullmove_number}{'.' if me else '...'} {board.san(mv):7s} "
                          f"{name:10s} loss {loss:4d}cp  eval {fmt_eval(my_ev):>6s}  "
                          f"Maia {100 * p:5.1f}%  +{pts}   [engine: {alts}]")
                    gpts += pts
                    gmax += 3
                board.push(mv)
                history.append(board.copy())
            print(f"    score {gpts}/{gmax}")
            total += gpts
            maxpts += gmax
    print(f"\nTOTAL {total}/{maxpts}" + (f"  ({100 * total / maxpts:.0f}%)" if maxpts else ""))
    return total, maxpts
