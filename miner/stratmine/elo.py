"""chess.com rating -> Lichess-blitz-equivalent rating (the scale fed to Maia-3).

Source: chessgoals.com/rating-comparison (page "Updated July 2026"), read 2026-11-07.
  * chess.com blitz -> Lichess blitz: Lichess table, 1150..1800 rows.
  * chess.com bullet / rapid -> chess.com blitz: only three rows of the chess.com-internal
    table were captured (blitz 1300/1500/1650), so those two conversions are thin.
Outside the tabulated range we extrapolate linearly from the end segments.
Cross-check: chessxray.com (Oct 2026, 2,276 matched blitz pairs) gives chess.com blitz
1500-1599 -> Lichess blitz median 1801, i.e. within ~50 of this table.
"""

import bisect

# chess.com blitz -> Lichess blitz
_BLITZ_TO_LI = [(1150, 1525), (1200, 1555), (1250, 1590), (1300, 1620), (1350, 1655),
                (1400, 1685), (1450, 1720), (1500, 1755), (1550, 1785), (1600, 1820),
                (1650, 1850), (1700, 1885), (1800, 1950)]
# chess.com bullet -> chess.com blitz, chess.com rapid -> chess.com blitz
_BULLET_TO_BLITZ = [(1195, 1300), (1385, 1500), (1540, 1650)]
_RAPID_TO_BLITZ = [(1500, 1300), (1655, 1500), (1765, 1650)]


# Lichess bullet / rapid / classical -> Lichess blitz (same ChessGoals Lichess table)
_LI_BLITZ = [1525, 1555, 1590, 1620, 1655, 1685, 1720, 1755, 1785, 1820, 1850, 1885, 1950]
_LI_BULLET_TO_BLITZ = list(zip([1480, 1515, 1550, 1585, 1625, 1660, 1700, 1735, 1775, 1815,
                                1855, 1890, 1970], _LI_BLITZ))
_LI_RAPID_TO_BLITZ = list(zip([1710, 1740, 1765, 1795, 1825, 1850, 1880, 1905, 1935, 1960,
                               1990, 2015, 2065], _LI_BLITZ))
_LI_CLASSICAL_TO_BLITZ = list(zip([1750, 1770, 1795, 1815, 1835, 1860, 1880, 1900, 1925, 1945,
                                   1970, 1990, 2035], _LI_BLITZ))


def _interp(table, x):
    xs = [p[0] for p in table]
    i = min(max(bisect.bisect_left(xs, x), 1), len(table) - 1)
    (x0, y0), (x1, y1) = table[i - 1], table[i]
    return y0 + (y1 - y0) * (x - x0) / (x1 - x0)


def to_maia(rating, tclass, mode="chessgoals", offset=150, site="chesscom"):
    """mode 'chessgoals' uses the tables above; 'offset' adds a constant (chess.com only)."""
    if site == "lichess":
        if mode == "offset":
            return int(rating)
        table = {"bullet": _LI_BULLET_TO_BLITZ, "rapid": _LI_RAPID_TO_BLITZ,
                 "classical": _LI_CLASSICAL_TO_BLITZ, "daily": _LI_CLASSICAL_TO_BLITZ}.get(tclass)
        return int(round(_interp(table, rating))) if table else int(rating)
    if mode == "offset":
        return int(round(rating + offset))
    blitz = {"bullet": lambda r: _interp(_BULLET_TO_BLITZ, r),
             "rapid": lambda r: _interp(_RAPID_TO_BLITZ, r),
             "daily": lambda r: _interp(_RAPID_TO_BLITZ, r)}.get(tclass, lambda r: r)(rating)
    return int(round(_interp(_BLITZ_TO_LI, blitz)))


if __name__ == "__main__":
    for tc, r in (("bullet", 1300), ("blitz", 1500), ("rapid", 1650)):
        print(tc, r, "->", to_maia(r, tc))
