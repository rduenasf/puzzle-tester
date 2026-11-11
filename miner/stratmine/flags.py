"""Rating-trend flags: how Maia p(best) changes from my Elo to my Elo + delta and to --elo-top.

Tags only: they never keep or drop a problem. Probabilities are fractions (0-1).

- rating_sensitive: p(best) rises a lot with rating (a learnable skill, not taste).
- engine_move: p(best) falls with rating (strong humans avoid it; maybe an engine-only move).
"""

DEFAULTS = {"sensitive_plus": 0.10, "sensitive_top": 0.20, "engine_drop_top": 0.10,
            "engine_drop_plus": 0.05}


def rating_flags(p_best, p_plus, p_top, sensitive_plus=0.10, sensitive_top=0.20,
                 engine_drop_top=0.10, engine_drop_plus=0.05):
    # Round to 0.1 point, as the CSV and exported files store them, so the miner and the
    # in-place patch (addflags.py) agree at the boundary (e.g. a drop of exactly 5.0 points).
    p_best, p_plus = round(p_best, 3), round(p_plus, 3)
    p_top = None if p_top is None else round(p_top, 3)
    gap = lambda hi, lo: round(hi - lo, 3)  # noqa: E731
    flags = []
    if (gap(p_plus, p_best) >= sensitive_plus
            and p_top is not None and gap(p_top, p_best) >= sensitive_top):
        flags.append("rating_sensitive")
    if ((p_top is not None and gap(p_best, p_top) >= engine_drop_top)
            or gap(p_best, p_plus) >= engine_drop_plus):
        flags.append("engine_move")
    return flags


def flags_from_args(a, p_best, p_plus, p_top):
    return rating_flags(p_best, p_plus, p_top, a.sensitive_plus, a.sensitive_top,
                        a.engine_drop_top, a.engine_drop_plus)
