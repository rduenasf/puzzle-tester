"""Game clocks for a mined position, read from the source PGN's [%clk] comments.

Both chess.com and Lichess write the mover's remaining time after each move
(increment already added), so the time spent on a move is
  clock after my previous move - clock after this move + increment.
Before my first move the "previous" clock is the base time from TimeControl.
"""
import chess.pgn


def parse_tc(tc):
    """'180+2' -> (180, 2); '600' -> (600, 0); daily ('1/86400'), '-' or missing -> None."""
    if not tc or tc == "-" or "/" in tc:
        return None
    base, _, inc = tc.partition("+")
    try:
        return int(base), int(inc or 0)
    except ValueError:
        return None


def game_key(headers):
    """The game's URL: chess.com's Link header, or Lichess's Site header."""
    return headers.get("Link") or headers.get("Site", "")


def clock_at(game, fen):
    """{'left': s, 'spent': s} for the move played from `fen` in `game`, or None.

    `left` is the mover's clock when the position appeared (before thinking),
    `spent` the time used on the move. Seconds, rounded to 0.1.
    """
    tc = parse_tc(game.headers.get("TimeControl"))
    if tc is None:
        return None
    base, inc = tc
    last = {True: float(base), False: float(base)}  # each side's clock after its last move
    node = game
    while node.variations:
        nxt = node.variations[0]
        mover = node.board().turn
        if node.board().fen() == fen:
            after = nxt.clock()
            if after is None:
                return None
            left = last[mover]
            return {"left": round(left, 1), "spent": round(max(0.0, left - after + inc), 1)}
        c = nxt.clock()
        if c is not None:
            last[mover] = c
        node = nxt
    return None


class GameIndex:
    """Find source games by URL. Scans headers only and parses a game when it's asked for."""

    def __init__(self, paths):
        self.where = {}
        for path in paths:
            with open(path, encoding="utf-8-sig") as f:
                while True:
                    pos = f.tell()
                    h = chess.pgn.read_headers(f)
                    if h is None:
                        break
                    self.where[game_key(h)] = (path, pos)
        self.cache = {}

    def get(self, url):
        if url not in self.cache:
            loc = self.where.get(url)
            game = None
            if loc:
                with open(loc[0], encoding="utf-8-sig") as f:
                    f.seek(loc[1])
                    game = chess.pgn.read_game(f)
            self.cache[url] = game
        return self.cache[url]

    def clock(self, url, fen):
        game = self.get(url)
        return clock_at(game, fen) if game else None
