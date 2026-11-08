# stratmine

Mines quiet strategic mistakes from chess.com games (Stockfish + Maia-3) and grades your answers.

```
uv venv --python 3.12 .venv
uv pip install --python .venv/Scripts/python.exe torch --index-url https://download.pytorch.org/whl/cu124
uv pip install --python .venv/Scripts/python.exe chess "git+https://github.com/CSSLab/maia3"
.venv/Scripts/maia3-cache --model maia3-23m

python -m stratmine mine games.pgn <username> --features feat.csv   # -> problems.pgn/.csv, problems_quiz.pgn
python -m stratmine grade problems_quiz.pgn                          # after filling in your lines
```

`--help` on each subcommand lists every threshold. `--checkpoint file.pt` loads local Maia weights
(architecture taken from `--maia-model`). Stockfish results are cached in `sf_cache.json`, so a re-run
that only changes thresholds takes seconds.

Rating conversion (`stratmine/elo.py`): chess.com ratings are mapped to Lichess blitz using the
ChessGoals tables (July 2026). `--elo-map offset --elo-offset N` uses a constant offset instead.
