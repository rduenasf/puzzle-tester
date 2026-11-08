"""Download all games: python fetch_games.py --chesscom USER --lichess USER --out DIR

chess.com: Published-Data API, one request at a time (parallel requests get 429).
Lichess: /api/games/user streamed as PGN.
"""
import argparse
import json
import os
import sys
import time
import urllib.request

UA = {"User-Agent": "stratmine/0.1"}


def get(url, headers=None, retries=3):
    for attempt in range(retries):
        req = urllib.request.Request(url, headers={**UA, **(headers or {})})
        try:
            with urllib.request.urlopen(req, timeout=600) as r:
                return r.read().decode("utf-8")
        except Exception as e:  # noqa: BLE001
            code = getattr(e, "code", None)
            if attempt == retries - 1:
                raise
            time.sleep(60 if code == 429 else 3)


def chesscom(user, path):
    user = user.lower()
    archives = json.loads(get(f"https://api.chess.com/pub/player/{user}/games/archives"))["archives"]
    failed, chunks = [], []
    for url in archives:
        try:
            chunks.append(get(url + "/pgn").strip())
        except Exception as e:  # noqa: BLE001
            failed.append(f"{url}: {e}")
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n\n".join(c for c in chunks if c) + "\n")
    print(f"chess.com: {len(archives) - len(failed)}/{len(archives)} months -> {path}")
    for x in failed:
        print("  FAILED", x)
    return not failed


def lichess(user, path, token=None):
    h = {"Accept": "application/x-chess-pgn"}
    if token:
        h["Authorization"] = f"Bearer {token}"
    pgn = get(f"https://lichess.org/api/games/user/{user}?clocks=true&opening=true", h)
    with open(path, "w", encoding="utf-8") as f:
        f.write(pgn)
    print(f"lichess: -> {path}")
    return True


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--chesscom")
    ap.add_argument("--lichess")
    ap.add_argument("--out", default="work")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    ok = True
    if a.chesscom:
        ok &= chesscom(a.chesscom, os.path.join(a.out, "chesscom.pgn"))
    if a.lichess:
        ok &= lichess(a.lichess, os.path.join(a.out, "lichess.pgn"), os.environ.get("LICHESS_TOKEN"))
    sys.exit(0 if ok else 1)
