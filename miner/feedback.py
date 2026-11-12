"""Turn Review-mode ratings into evidence for tuning the miner.

Export the ratings from the trainer (Review > problem list > Export feedback), then:

  python feedback.py review-feedback-2026-11-08.json [more.json ...] [--csv work/feedback.csv]

Prints:
  1. counts by rating and by reason tag,
  2. good/bad rate per category, verdict, time class,
  3. for every mining value (cp loss, p(best), ...), the medians for good vs bad problems
     and the single threshold that would drop the most bad problems for the fewest good ones,
  4. which miner flag each reason tag points at.

Each entry carries a snapshot of the problem's mining values taken when it was rated, so the
file works even after a re-export renumbers the problems. Entries are keyed by game link + FEN;
export_site.py --feedback uses the same key to leave out problems rated bad.
"""
import argparse
import csv
import json
import os
import statistics
import sys
from collections import Counter, defaultdict

sys.path.insert(0, os.path.dirname(__file__))
from stratmine.flags import rating_flags  # noqa: E402

# Reason tag -> the check(s) it most likely points at (see MINING-DECISIONS.md §5).
TAG_HINTS = {
    "tactical": "check 3 (--max-forcing / --forcing-plies) or check 4 (--max-material-lost)",
    "noise": "engine noise, §6.5: raise --cp-min or require mining and re-score to agree",
    "deep": "Maia checks (--p-best-strong-min / --p-best-min); the quick-search check was dropped 2026-11-11",
    "obvious": "upper p(best) bound (--p-best-max) / the easy_miss category",
    "unclear": "explanation side (explain.py / whatchanged.py), or the line is too long",
    "engine_move": "check 7 (--p-best-strong-min / --elo-delta) or --p-best-min",
    "decided": "check 2 (--max-eval); for blunder_check problems, --blunder-max",
    "time": "clock: consider a minimum clock left / time spent (gameClock)",
    "wrong_verdict": "explain.py material rule (§9.3)",
    "duplicate": "dedupe by structure/plan (not implemented)",
    "instructive": "(positive)",
    "habit": "(positive) the 'typical' category",
}

# Numeric features: name -> function of the snapshot
FEATURES = {
    "cp loss (mining)": lambda p: p["checks"]["cpLoss"],
    "cp loss now (re-score)": lambda p: p.get("playedLossNow"),
    "|eval before|": lambda p: abs(p["checks"]["evalBefore"]),
    "forcing moves in best line": lambda p: p["checks"]["forcing"],
    "material lost": lambda p: p["checks"].get("materialLost"),
    "quick-search rank of best (runs before 2026-11-11)": lambda p: p["checks"].get("shallowRank"),
    "Maia rank of my move": lambda p: p["checks"].get("myRank"),
    "p(best) %": lambda p: p["pBest"],
    "p(best) at +delta %": lambda p: p["pBestPlus"],
    "p(best) gain at +delta": lambda p: p["pBestPlus"] - p["pBest"],
    "p(my move) %": lambda p: p["pPlayed"],
    "best differs from mining (0/1)": lambda p: int(bool(p.get("minedBest")) and p["minedBest"] != p["best"]),
    "clock left (s)": lambda p: (p.get("gameClock") or {}).get("left"),
    "time spent (s)": lambda p: (p.get("gameClock") or {}).get("spent"),
}



def trend_of(p):
    """The problem's rating-trend flag; recomputed (default thresholds) for older snapshots."""
    flags = p.get("flags")
    if flags is None and p.get("pBest") is not None and p.get("pBestPlus") is not None:
        top = p.get("pBestTop")
        flags = rating_flags(p["pBest"] / 100, p["pBestPlus"] / 100, None if top is None else top / 100)
    return (flags or ["none"])[0]
def load(paths):
    entries = {}
    for path in paths:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        if data.get("format") != "review-feedback":
            raise SystemExit(f"{path}: not a review-feedback export")
        for k, v in data["entries"].items():
            if k not in entries or v.get("at", "") > entries[k].get("at", ""):
                entries[k] = v
    return entries


def best_cut(good, bad):
    """Threshold t and side that drops the most bad for the fewest good: max(bad_dropped - good_dropped)."""
    best = None
    for t in sorted(set(good) | set(bad)):
        for side in (">", "<"):
            drop = (lambda x: x > t) if side == ">" else (lambda x: x < t)
            b = sum(map(drop, bad))
            g = sum(map(drop, good))
            score = b / len(bad) - g / len(good)
            if best is None or score > best[0]:
                best = (score, side, t, b, g)
    return best


def pct(n, d):
    return f"{100 * n / d:.0f}%" if d else "-"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("json", nargs="+")
    ap.add_argument("--csv", help="Also write one row per rated problem (all values + tags)")
    ap.add_argument("--min-n", type=int, default=5, help="Skip cut suggestions with fewer good or bad samples")
    a = ap.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")  # Windows console defaults to cp1252

    entries = load(a.json)
    rated = [e for e in entries.values() if e.get("rating")]
    print(f"{len(entries)} entries, {len(rated)} rated")
    rc = Counter(e["rating"] for e in rated)
    print("  " + ", ".join(f"{k} {rc[k]}" for k in ("good", "meh", "bad")))

    print("\nReason tags (by rating):")
    tags = defaultdict(Counter)
    for e in entries.values():
        for t in e.get("tags", []):
            tags[t][e.get("rating") or "unrated"] += 1
    for t, c in sorted(tags.items(), key=lambda kv: -sum(kv[1].values())):
        split = ", ".join(f"{k} {v}" for k, v in c.most_common())
        print(f"  {t:14} {sum(c.values()):4}  ({split})  -> {TAG_HINTS.get(t, '?')}")

    print("\nRating by group (good / meh / bad, bad rate):")
    for name, of in (("category", lambda p: p["kind"]), ("verdict", lambda p: p.get("nature")),
                     ("time class", lambda p: p["timeClass"]), ("what changed", lambda p: p.get("changedTop")),
                     ("rating trend", trend_of)):
        g = defaultdict(Counter)
        for e in rated:
            g[of(e["problem"])][e["rating"]] += 1
        print(f"  {name}:")
        for v, c in sorted(g.items(), key=lambda kv: -sum(kv[1].values())):
            n = sum(c.values())
            print(f"    {str(v):26} {c['good']:3} / {c['meh']:3} / {c['bad']:3}   bad {pct(c['bad'], n)}")

    good = [e["problem"] for e in rated if e["rating"] == "good"]
    bad = [e["problem"] for e in rated if e["rating"] == "bad"]
    print(f"\nMining values, good ({len(good)}) vs bad ({len(bad)}):")
    print(f"  {'value':32} {'med good':>9} {'med bad':>9}   best single cut")
    for name, f in FEATURES.items():
        gv = [x for x in map(f, good) if x is not None]
        bv = [x for x in map(f, bad) if x is not None]
        if not gv or not bv:
            continue
        line = f"  {name:32} {statistics.median(gv):9.1f} {statistics.median(bv):9.1f}"
        if len(gv) >= a.min_n and len(bv) >= a.min_n:
            score, side, t, b, g = best_cut(gv, bv)
            if score > 0:
                line += (f"   drop {side} {t:g}: removes {b}/{len(bv)} bad ({pct(b, len(bv))}), "
                         f"{g}/{len(gv)} good ({pct(g, len(gv))})")
            else:
                line += "   (no cut helps)"
        print(line)
    if len(good) < a.min_n or len(bad) < a.min_n:
        print(f"  Need at least {a.min_n} good and {a.min_n} bad ratings for cut suggestions.")
    print("\nCuts are fitted on your ratings only: treat them as leads, and re-check on the volume table.")

    notes = [(e["problem"].get("num"), e["rating"], e["note"].strip()) for e in entries.values() if e.get("note", "").strip()]
    if notes:
        print(f"\nNotes ({len(notes)}):")
        for num, r, n in sorted(notes, key=lambda x: x[0] or 0):
            print(f"  #{num} [{r or '-'}] {n}")

    if a.csv:
        cols = ["key", "num", "id", "rating", "tags", "note", "at", "kind", "nature", "timeClass",
                "timeControl", "date", "link", "fen", "played", "best", "minedBest", *FEATURES]
        with open(a.csv, "w", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            w.writerow(cols)
            for k, e in entries.items():
                p = e["problem"]
                w.writerow([k, p.get("num"), p.get("id"), e.get("rating"), ";".join(e.get("tags", [])),
                            e.get("note", ""), e.get("at"), p["kind"], p.get("nature"), p["timeClass"],
                            p.get("timeControl"), p["date"], p.get("link"), p["fen"], p["played"],
                            p["best"], p.get("minedBest"), *(fn(p) for fn in FEATURES.values())])
        print(f"\nwrote {len(entries)} rows -> {a.csv}")


if __name__ == "__main__":
    main()
