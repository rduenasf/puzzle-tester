"""Sanity checks for MaiaPolicy: normalisation, black-to-move handling, Elo trend."""
import sys

import chess

from stratmine.maia import MaiaPolicy

model = sys.argv[1] if len(sys.argv) > 1 else "maia3-23m"
m = MaiaPolicy(model)


def top(d, k=5):
    return ", ".join(f"{mv.uci()} {p:.3f}" for mv, p in sorted(d.items(), key=lambda x: -x[1])[:k])


fail = 0
# 1. sums to 1 over legal moves, covers every legal move
for fen in [chess.STARTING_FEN,
            "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
            "r3k2r/pPppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R b KQkq - 0 1",  # black, castling, promo-free
            "8/1P6/8/8/8/8/5kp1/7K b - - 0 1",  # black promotion g2g1
            ]:
    b = chess.Board(fen)
    d = m.policy([b], [1500], 1500)[0]
    s = sum(d.values())
    ok = abs(s - 1) < 1e-4 and len(d) == b.legal_moves.count()
    fail += not ok
    print(f"{'OK ' if ok else 'BAD'} sum={s:.6f} moves={len(d)}/{b.legal_moves.count()} "
          f"{'w' if b.turn else 'b'}: {top(d)}")

# 2. black-to-move == colour-flipped white-to-move (same history, mirrored)
b = chess.Board()
boards = [b.copy()]
for san in ["e4", "c5", "Nf3", "d6", "d4", "cxd4", "Nxd4", "Nf6", "Nc3"]:
    b.push_san(san)
    boards.append(b.copy())
assert b.turn == chess.BLACK
pb = m.policy(boards, [1500], 1600)[0]
pw = m.policy([x.mirror() for x in boards], [1500], 1600)[0]
maxdiff = max(abs(p - pw[chess.Move(chess.square_mirror(mv.from_square),
                                    chess.square_mirror(mv.to_square), mv.promotion)])
              for mv, p in pb.items())
ok = maxdiff < 1e-3
fail += not ok
print(f"{'OK ' if ok else 'BAD'} black vs mirrored white max |dp| = {maxdiff:.2e}")
print("    Najdorf/Sicilian, black to move:", top(pb))

# 3. history matters (pad-with-current vs real history) and Elo trend
p_nohist = m.policy([boards[-1]], [1500], 1600)[0]
print("    same position, no history:   ", top(p_nohist))
for elo in (800, 1200, 1600, 2000, 2400):
    d = m.policy(boards, [elo], elo)[0]
    print(f"    elo {elo}: {top(d, 3)}")
print("FAIL" if fail else "ALL OK")
