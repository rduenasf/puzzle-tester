"""Stockfish wrapper with a JSON cache keyed by (FEN, depth, multipv)."""

import json
import os

import chess
import chess.engine

MATE = 100000


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
        self.cache_path = cache_path
        self.cache = {}
        if cache_path and os.path.exists(cache_path):
            with open(cache_path, encoding="utf-8") as f:
                self.cache = json.load(f)
        self._dirty = 0

    def _engine(self):
        if self._eng is None:
            self._eng = chess.engine.SimpleEngine.popen_uci(self.path)
            self._eng.configure({"Threads": self.threads, "Hash": self.hash_mb})
        return self._eng

    def analyse(self, board, depth, multipv=1):
        """Returns a list of Analysis (best first). Empty list for game-over positions."""
        key = f"{board.fen()}|{depth}|{multipv}"
        if key not in self.cache:
            if board.is_game_over():
                self.cache[key] = []
            else:
                infos = self._engine().analyse(board, chess.engine.Limit(depth=depth),
                                               multipv=multipv, game=object())
                lines = []
                for info in infos:
                    s = info["score"].white()
                    lines.append({"cp": s.score(), "mate": s.mate(),
                                  "pv": [m.uci() for m in info.get("pv", [])]})
                self.cache[key] = lines
            self._dirty += 1
            if self._dirty >= 50:
                self.save()
        return [Analysis(d) for d in self.cache[key]]

    def save(self):
        if self.cache_path and self._dirty:
            tmp = self.cache_path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(self.cache, f)
            os.replace(tmp, self.cache_path)
            self._dirty = 0

    def close(self):
        self.save()
        if self._eng is not None:
            self._eng.quit()
            self._eng = None
