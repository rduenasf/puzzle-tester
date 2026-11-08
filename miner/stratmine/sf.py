"""Stockfish wrapper with a JSON cache keyed by (FEN, depth, multipv)."""

import json
import os
import queue
import sys
import threading
import time

import chess
import chess.engine

MATE = 100000


def _lines(infos):
    out = []
    for info in infos:
        s = info["score"].white()
        out.append({"cp": s.score(), "mate": s.mate(),
                    "pv": [m.uci() for m in info.get("pv", [])]})
    return out


class Analysis:
    """One multipv line. cp is from White's point of view; None when mate."""

    def __init__(self, d):
        self.cp = d["cp"]
        self.mate = d["mate"]
        self.pv = [chess.Move.from_uci(u) for u in d["pv"]]

    def pov(self, color):
        """Score from `color`'s point of view; mates mapped to +/-MATE."""
        if self.cp is not None:
            v = self.cp
        else:
            v = MATE - abs(self.mate) if self.mate > 0 else -MATE + abs(self.mate)
        return v if color == chess.WHITE else -v


class Stockfish:
    def __init__(self, path, cache_path=None, threads=None, hash_mb=256):
        self.path = path
        self.threads = threads or max(1, (os.cpu_count() or 2) - 2)
        self.hash_mb = hash_mb
        self._eng = None
        self._shallow = None
        self.cache_path = cache_path
        self.cache = {}
        if cache_path and os.path.exists(cache_path):
            with open(cache_path, encoding="utf-8") as f:
                self.cache = json.load(f)
        self._dirty = 0
        self._saved_at = time.time()

    def _engine(self):
        if self._eng is None:
            self._eng = chess.engine.SimpleEngine.popen_uci(self.path)
            self._eng.configure({"Threads": self.threads, "Hash": self.hash_mb})
        return self._eng

    def _shallow_engine(self):
        # Separate single-thread process for shallow searches, so the deep search's
        # hash table cannot leak into them and results are deterministic.
        if self._shallow is None:
            self._shallow = chess.engine.SimpleEngine.popen_uci(self.path)
            self._shallow.configure({"Threads": 1, "Hash": 16})
        return self._shallow

    def analyse(self, board, depth, multipv=1):
        """Returns a list of Analysis (best first). Empty list for game-over positions."""
        key = f"{board.fen()}|{depth}|{multipv}"
        if key not in self.cache:
            if board.is_game_over():
                self.cache[key] = []
            else:
                if depth <= 8:
                    infos = self._shallow_engine().analyse(
                        board, chess.engine.Limit(depth=depth), multipv=multipv, game=object())
                else:
                    infos = self._engine().analyse(
                        board, chess.engine.Limit(depth=depth), multipv=multipv)
                self.cache[key] = _lines(infos)
            self._dirty += 1
            if time.time() - self._saved_at > 120:
                self.save()
        return [Analysis(d) for d in self.cache[key]]

    def analyse_many(self, groups, depth, workers, threads_each=1, hash_each=64):
        """Fill the cache for many positions using `workers` single-thread Stockfish
        processes. groups: list of lists of boards; a group (one game) stays on one worker."""
        todo = []
        for grp in groups:
            g = [b for b in grp if f"{b.fen()}|{depth}|1" not in self.cache]
            if g:
                todo.append(g)
        total = sum(len(g) for g in todo)
        if not total:
            return
        workers = min(workers, len(todo))
        print(f"stockfish: {total} positions to analyse at depth {depth} "
              f"on {workers} processes", file=sys.stderr, flush=True)
        q = queue.Queue()
        for g in todo:
            q.put(g)
        results = queue.Queue()

        def worker():
            eng = chess.engine.SimpleEngine.popen_uci(self.path)
            try:
                eng.configure({"Threads": threads_each, "Hash": hash_each})
                while True:
                    try:
                        grp = q.get_nowait()
                    except queue.Empty:
                        return
                    for b in grp:
                        if b.is_game_over():
                            results.put((b.fen(), []))
                        else:
                            infos = eng.analyse(b, chess.engine.Limit(depth=depth), multipv=1)
                            results.put((b.fen(), _lines(infos)))
            finally:
                eng.quit()

        threads = [threading.Thread(target=worker, daemon=True) for _ in range(workers)]
        for t in threads:
            t.start()
        done, t0, last = 0, time.time(), 0
        while done < total:
            try:
                fen, lines = results.get(timeout=5)
            except queue.Empty:
                if not any(t.is_alive() for t in threads) and results.empty():
                    break  # a worker died; remaining positions fall back to analyse()
                continue
            self.cache[f"{fen}|{depth}|1"] = lines
            self._dirty += 1
            done += 1
            now = time.time()
            if now - last > 10 or done == total:
                last = now
                rate = done / max(now - t0, 1e-9)
                print(f"  {done}/{total}  {rate:.1f} pos/s  eta {(total - done) / rate / 60:.1f} min",
                      file=sys.stderr, flush=True)
            if now - self._saved_at > 120:
                self.save()
        for t in threads:
            t.join()
        self.save()

    def save(self):
        if self.cache_path and self._dirty:
            tmp = self.cache_path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(self.cache, f)
            os.replace(tmp, self.cache_path)
            self._dirty = 0
        self._saved_at = time.time()

    def close(self):
        self.save()
        if self._eng is not None:
            self._eng.quit()
            self._eng = None
        if self._shallow is not None:
            self._shallow.quit()
            self._shallow = None
