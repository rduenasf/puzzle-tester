"""Full Maia-3 policy over legal moves.

Maia3UCIEngine.score_moves only reports the top-k moves, so we reuse the engine
object (model loading, move vocabulary, mirroring) and compute the softmax over all
legal moves ourselves, the same way score_moves does internally.
"""

from collections import deque

import chess
import torch
from torch.amp import autocast

from maia3.dataset import get_legal_moves_mask, tokenize_board
from maia3.uci import Maia3UCIEngine, parse_args


class MaiaPolicy:
    def __init__(self, model="maia3-23m", checkpoint=None, device=None):
        argv = ["--model", model]
        if checkpoint:
            # --model applies the architecture preset; --checkpoint skips the HF download.
            argv += ["--checkpoint", checkpoint]
        if device:
            argv += ["--device", device]
        self.cfg = parse_args(argv)
        self.engine = Maia3UCIEngine(self.cfg)
        self.engine.ensure_model_loaded()
        self.hist_len = self.cfg.history

    @torch.no_grad()
    def policy(self, boards, self_elos, oppo_elo):
        """boards: list of past positions, oldest first, last = position to move in
        (only the last `history` are used). Returns one {Move: prob} dict per entry
        of self_elos, all evaluated in a single batch."""
        eng, cfg = self.engine, self.cfg
        board = boards[-1]
        history = deque((tokenize_board(b) for b in boards[-self.hist_len:]),
                        maxlen=self.hist_len)
        tokens = eng._tokens_from_history(history)
        n = len(self_elos)
        tokens = tokens.unsqueeze(0).expand(n, -1, -1).to(cfg.device)
        se = torch.tensor(list(self_elos), dtype=torch.long, device=cfg.device)
        oe = torch.full((n,), int(oppo_elo), dtype=torch.long, device=cfg.device)
        use_amp = cfg.use_amp and cfg.device.startswith("cuda")
        with autocast("cuda", enabled=use_amp):
            logits_move, _, _ = eng.model(tokens, se, oe)

        mask = get_legal_moves_mask(board, eng.all_moves_dict).to(cfg.device)
        logits = logits_move.float().masked_fill(~mask, float("-inf"))
        probs = torch.softmax(logits, dim=-1).cpu()
        idxs = torch.nonzero(mask.cpu()).flatten().tolist()

        # _move_from_index un-mirrors using engine.board.turn.
        eng.board = board
        out = []
        for row in probs:
            d = {}
            for i in idxs:
                mv = eng._move_from_index(i)
                if mv is not None:
                    d[mv] = float(row[i])
            out.append(d)
        return out
