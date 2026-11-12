# Decision record: mining strategic problems from my games

Status: living document. Last updated 2026-11-10.
Owner: Rodrigo (chess.com `real_Holimion`, Lichess `rduenasf`).

This records what the miner (`miner/`, git-ignored, local only) and the trainer's
Strategy/Review modes do, why, and what was tried and rejected. Numbers come from runs on
my last 30 days of games (2026-10-08 to 2026-11-08: 730 games, 711 chess.com, 19 Lichess).

## 1. Goal

A complement to tactics trainers: quiet positional or planning mistakes from my own games
that a player at my level could plausibly avoid. Not blunders, and not deep calculation.
Target volume: about 1 problem per game.

My ratings when this started: chess.com bullet ~1300, blitz ~1500, rapid ~1650.

## 2. Tooling

| Piece | Choice | Notes |
|---|---|---|
| Python | 3.12 in `miner/.venv`, installed with `uv` (winget) | No system Python on this PC |
| Engine | Stockfish 14.1, `~/.forwardchess/stockfish/stockfish-14-win/stockfish-14-x64.exe` | Override with `--stockfish` or `$STOCKFISH`. SF14 still has the classical (non-NNUE) eval, used in §9.4 |
| Human model | Maia-3 23M (`--maia-model`), weights from Hugging Face `UofTCSSLab/Maia3-23M` | Runs on the RTX 3080 Ti. `--checkpoint file.pt` for a local file |
| Maia policy | Full softmax over legal moves, computed by `stratmine/maia.py` reusing `Maia3UCIEngine` | The UCI output only gives the top-k. Uses the game's real last 8 positions as history |

Verified (`miner/tests/check_maia.py`): probabilities sum to 1.000000 over legal moves;
black-to-move moves un-mirror correctly, including black promotions (g2g1q); history and
Elo change the output as expected.

## 3. Getting games

- chess.com: the Published-Data API (`/pub/player/{user}/games/archives`, then one PGN per
  month). Checked 2026-11-08: no newer games API exists. The only newer item is an
  OAuth / Connected Board program behind an application form. Requests must be serial
  (parallel ones get HTTP 429).
- Lichess: `/api/games/user/{user}` streams all games as PGN.
- `miner/fetch_games.py --chesscom real_Holimion --lichess rduenasf --out work`.
  Git Bash's curl failed on every monthly request with `-w`, hence the script.
- Download on 2026-11-08: 17,198 chess.com games (Feb 2014 to Nov 2026; 81% bullet) and
  214 Lichess games.

## 4. Rating conversion (chess.com to Maia's scale)

Maia-3 takes an Elo on the Lichess-blitz scale (stated in the original brief; **not
verified** in the maia3 source).

- Rejected: a constant +150. Evidence says it's too low, and the gap depends on time class
  and rating level.
- Chosen (`--elo-map chessgoals`, `stratmine/elo.py`): ChessGoals tables (July 2026).
  chess.com blitz to Lichess blitz from 13 rows (1150-1800). chess.com bullet/rapid are
  first converted to chess.com blitz, from only **3 rows** (thin). Lichess bullet/rapid/
  classical are converted to Lichess blitz with the ChessGoals Lichess table.
- Cross-check: Chess X-Ray (Oct 2026, 2,276 matched blitz pairs) gives a Lichess median of
  1801 for chess.com blitz 1500-1599, within ~50 of ChessGoals.
- My Maia Elos: bullet 1300 to 1692, blitz 1500 to 1755, rapid 1650 to 1750.
- My Elo per game: fixed per time class by default (`--elo-bullet/blitz/rapid`);
  `--my-elo header` uses the game header instead. Lichess games always use the header.
  Opponent: header rating, same conversion.
- Known oddity: my Lichess bullet rating (1267, few games) converts to ~1342, far below my
  chess.com-based ~1700. Probably an unreliable rating.
- Time class: estimated duration = base + 40 x increment (chess.com's rule). chess.com:
  bullet < 180s, blitz < 600s. Lichess: bullet < 180, blitz < 480, rapid < 1500.

## 5. The mining pipeline (current defaults)

Stockfish pass: one depth-16 analysis per position after the opening, cached.
cp loss = eval before my move minus eval after it, from my side.

Skipped before any check: the first 10 plies (12 until 2026-11-11, §6.10); positions with a mate score before or after
my move; moves where I played the engine's best move; non-standard games.

| # | Check | Current rule | Flag(s) | History |
|---|---|---|---|---|
| 1 | cp loss | 30-350; 350-1000 as blunder_check | `--cp-min --cp-max --blunder-max` | Was 30-150. Raised so 20...Qb5 (318cp) qualifies. See §6.7 |
| 2 | Balanced position | \|eval before\| <= 150 | `--max-eval` | Unchanged |
| 3 | Best line is quiet | <= 2 checks/captures/promotions in the first 6 plies of the best line | `--max-forcing --forcing-plies` | Unchanged |
| 4 | Big loss isn't just dropped material | For losses > 150: after 6 plies of the opponent's best reply I'm down at most 1 pawn vs before my move | `--quiet-above --max-material-lost` | New. See §6.3 |
| 5 | No deep calculation | A depth-4 multipv-3 search has the engine's move in its top 3 | `--shallow-depth --shallow-multipv` | Was depth 3 until 2026-11-10. See §6.6 |
| 6 | Best move findable at my level | Maia p(best) at my Elo in 20-65%, **or** an exception below | `--p-best-min --p-best-max` | Exceptions added |
| 7 | Stronger players find it | Maia p(best) at my Elo + 500 >= 10% | `--elo-delta --p-best-strong-min` | New |
| off | p(best) rises at +delta | p(best) at +delta >= p(best) + 5 points | `--p-gain-min 0.05` re-enables | Removed. See §6.2 |
| off | Natural but wrong | p(my move) >= p(best) | `--natural` re-enables | Removed. See §6.1 |

Categories (tag in the outputs, in this order):

- **easy_miss**: p(best) > 65%. Most players at my rating find it; I missed it.
- **typical**: my move was Maia's #1 prediction at my Elo. The 20% minimum is waived
  (the engine move may be rare at my level), but check 7 still applies.
- **single** (shown as "regular"): p(best) in 20-65%.
- **blunder_check**: cp loss above 350 (up to 1000) that passes every other check. Checked
  first, so it wins over easy_miss and typical. `--no-blunder` drops it. See §6.7.
- **drift**: windows of 4 consecutive moves of mine losing >= 80cp in total, none
  losing > 75; flags the worst move (floor 15cp) and runs it through the same checks.
  Has produced 0-1 problems on 730 games. Not tuned.

Rating-trend flags (tags on top of the category; they never keep or drop a problem; §6.8):

- **rating_sensitive** (shown as "rating-sensitive"): p(best) rises >= 10 points at my Elo
  + 500 **and** >= 20 points at 2600. `--sensitive-plus --sensitive-top`.
- **engine_move** (shown as "engine move?"): p(best) falls >= 10 points at 2600 **or** >= 5
  points at + 500. `--engine-drop-top --engine-drop-plus`.

The Lichess games produced no problems in any run.

### Volume history (730 games)

| Settings | Problems | Per game |
|---|---|---|
| Original brief | 41 | 0.06 |
| Natural check off | 213 | 0.29 |
| + cp-max 350, material rule, easy_miss | 368 | 0.50 |
| + gain check off, typical category | 1,091 | 1.49 |
| + p(best) at +500 >= 10% | 861 | 1.18 |
| + shallow search depth 3 -> 4 | 939 | 1.29 |
| + blunder_check 350-1000cp (**current**, v6) | 1,011 | 1.38 |

Current split: 456 regular, 389 typical, 94 easy miss, 72 blunder check (v6; the bullet/blitz
split below is v5); 852 bullet (all 2+1), 83 blitz
(3+2 x67, 5+0 x16), 4 rapid.

## 6. Decisions and the reasoning behind them

### 6.1 Removed "p(my move) >= p(best)" (natural but wrong)

It kept only mistakes Maia expects from players at my level. Arguments against it, which
won: Maia models the average player at an Elo, not me, so my own repeated habits get thrown
out; the level calibration is already done by the p(best) checks; and comparing two
probabilities is arbitrary at the margin (30% vs 31%). Data: it cut 213 candidates to 41,
and the dropped moves weren't mostly slips (median p(my move) 11.9%, only 13 under 2%).

### 6.2 Removed "p(best) rises 5+ points at +300 Elo"

My argument: stronger players usually find the best move at least as often, so the check
adds little. What it actually removed: decisions where p(best) is flat (rating doesn't
matter; often taste) or falls with rating (a possible "engine move" strong humans avoid).
Of 642 problems it had blocked, p(best) rose by less than 5 points in 374, was flat or
dropped slightly in 213, and **dropped 5+ points in 55**. Those 55 are worth watching.
Replaced by check 7, which targets the real concern (moves even much stronger players
rarely find).

### 6.3 Big losses: material rule, not a forcing count

The motivating example (below) loses 318cp with no tactic. To allow losses above 150cp
without letting in hanging pieces and forks:

- Rejected: limiting checks/captures in the opponent's punishment line. Qb5's punishment
  (21.Qh7 Rg8 22.Qf5+ Rd7 23.axb7+ Qxb7) has 3 but wins no material, and pawn trades count
  the same as winning a piece.
- Chosen: material actually lost after 6 plies of the punishment (pawn units N/B 3, R 5,
  Q 9), at most 1 pawn. On the 75 extra big-loss moves it rejected the 5 that lose a piece
  or the exchange and kept structural trades and pawn drops.

### 6.4 Easy-miss and typical categories

Qb5 failed both Maia checks because 20...b6 is easy at my level (83%), and the +Elo check
can't pass when p(best) has no room to rise. Rather than widening the regular range,
these became their own tagged categories so they can be reviewed separately. "Typical" was
my request: when my move is what a typical player at my rating plays but it's wrong, I want
to see it even if the engine move is rare at my level.

### 6.5 Engine noise (open issue)

Depth-16 evaluations vary between runs and thread counts: on 120 positions, 1 engine x 10
threads vs 12 engines x 1 thread agreed on the best move in only 88/120, median eval
difference 23cp. The 30cp minimum is about the size of that noise. In the exported 861,
the trainer's fresh depth-16 re-score picked a different best move in 162 (19%), and in 93
my game move now scores within 30cp. Not fixed. Options: raise `--cp-min`, re-check
candidates deeper, or require the mining and re-score runs to agree.

### 6.6 Shallow search depth 3 -> 4 (2026-11-10)

Check 5 asks whether a quick Stockfish search (multipv 3) already has the depth-16 best move
in its top 3. It only checks that rank: it ignores evals and my move.

- Depth 16 for the quick search was measured and rejected: the main search is also depth 16,
  so the check becomes "does Stockfish agree with itself". Of the 1,209 v4 candidates passing
  every other check, depth 3 kept 861 and depth 16 kept 1,192 (the 17 it dropped were
  multipv noise).
- A 10-position sample of what depth 3 drops but depth 16 keeps (`miner/depthcompare.py`
  adds both searches' lines to an exported file; it was shown in a temporary trainer
  section, since removed) split in two: near misses where depth 3
  had the best move at #3-#8 with a similar eval, and positions where depth 3's evals were
  off by 5-10 pawns (it thought the best move lost material, or my move won some).
- Chosen: depth 4, my call: I should be able to calculate 4 plies. Result: 939 problems
  (was 861); 795 in both runs, 141 new, 64 dropped (depth 4 doesn't keep everything depth 3
  kept: its top 3 can differ).
- Idea not done: compare evals instead of rank, e.g. reject when the quick search rates my
  move above the best move by more than X (best move's eval minus my move's, at the quick depth).

### 6.7 Blunder-check category for losses above 350cp (2026-11-10)

The 350cp cap was never a measured boundary: it was set just above Qb5 (318cp), when the
material rule (check 4) was added. Since then the material rule is what separates tactical
losses from strategic ones, and a big loss can still be strategic.

- Measured on `v5_features.csv` (re-applying the other checks): moves losing more than 350cp
  that pass everything else: 33 at 350-500, 26 at 500-700, 13 at 700-1000, 3 above 1000.
- Chosen: keep them as their own category, `blunder_check` (my call, by analogy with
  easy_miss), so they can be rated and filtered separately. Capped at 1000cp
  (`--blunder-max`): above that the position is usually decided.
- Watch: the material rule only looks 6 plies ahead, so a big loss with no material lost may
  be a slower tactic (a mating attack, material won on ply 8). Rate these with the
  `tactical` / `decided` tags.

### 6.8 Rating-trend flags (2026-11-10)

My request: flag problems where p(best) at my Elo differs a lot from p(best) at +500 and at
2600. Rising = a skill stronger players have (the best kind to drill); falling = the §6.2
concern, a move strong humans avoid. Tags, not checks, so they can be rated and filtered
before anything is decided.

- Measured on v6 (1,011 problems), gap = p(best) at the higher Elo minus at mine, in points:
  +500 median +8.0 (10th/75th/90th pct -3.8 / +15.2 / +23.1); 2600 median +12.3
  (-6.6 / +24.1 / +34.1).
- Chosen thresholds: about the top quarter of both gaps. rating_sensitive needs both (a steady
  rise, not just a jump at 2600): 291 problems (141 regular, 115 typical, 26 blunder check,
  9 easy miss). engine_move takes either drop: 108 (63 regular, 22 typical, 16 easy miss,
  7 blunder check). Gaps are compared at 0.1 point, as the files store them.
- Rejected for now: a log-odds gap (>= 1.0, plus >= 10 points). It counts rare-but-learnable
  moves better (4% -> 20%) and flags 341, more of them typical, but is harder to read.
  Revisit if rating the flagged problems shows misses.
- Rule in `stratmine/flags.py`, shared by `mine` (CSV `flags` column, PGN comment, report
  counts), `export_site.py` (recomputes for CSVs mined before it), `addflags.py` (patches an
  exported file in place) and `feedback.py` (a "rating trend" group).
- Trainer: a second badge next to the category, a "Rating trend" filter in Review, and a
  line in "Why this problem" with this problem's gaps.

### 6.10 Repeated positions and opening mistakes (2026-11-11)

Trigger: two Review problems with the same position from different games (move 8 after Nf6+,
gxf6 both times). On v7 (1,101 problems, positions compared ignoring move counters): 3 positions
were problems twice. Two were the same opening mistake in different games (plies 13 and 15);
one came up twice in one game (plies 26 and 28, same move).

- `--skip-plies` 12 -> 10: plies 11-12 (1-based) are now mined too.
- Same game, same position, same move: only the first is kept (the later one teaches nothing
  new). Same position with a different move: both are kept.
- Each problem records `reached_games` (games where I was to move in that position after
  `--skip-plies`) and `puzzle_games` (games where it became a problem, in any category). The
  trainer shows "Problem in M of N games (x%)" when N > 1. A mistake means "would be a
  problem", not "lost cp": a bad move rejected by a filter (e.g. the material rule) doesn't count.
- A position that was a problem in 2+ games gets a label (not a category; it keeps its own):
  `common_opening_mistake` within the first `--opening-plies` (16) plies, `repeated_position`
  after. Both problems are kept: a repeated mistake is a habit, the most useful thing to drill.
- Counts cover only the games in the run, so labels can change when games are added.
- Problem ids hash link + FEN, so a dropped repeat's id (and its trainer progress) goes away.

## 7. Reference example: 20...Qb5

Bullet 2+1, 2026-11-08, WackyCard vs real_Holimion, game 186787187866. Position (Black to
move): `2krr3/pp3pp1/P1p4p/3pP3/1q6/3Q3P/1PP2PP1/R3R1K1 b - - 0 20`. I played 20...Qb5;
the engine move is 20...b6 (keeps the a-pawn from opening my king).

| Measure | Value |
|---|---|
| cp loss / eval before | 318 (later re-score 288) / -129 |
| Forcing moves in best line | 0 |
| Material lost after 6 plies of punishment | 0 |
| Depth-3 rank of b6 | 1 |
| Maia p(b6) at 1692 / +300 / +500 | 83.1% / 82.8% / ~80% |
| Maia p(Qb5) | 0.3% (rank 10) |
| Category now | easy_miss |
| Verdict (§9.3) | positional, then material: a quick look sees the damage after 21.Qh7; a pawn is lost for good from 25.Qxg7 |
| Classical eval (§9.4) | does not explain it (total +0.27 vs a 2.88 loss) |

It was the case that drove the cp range, the material rule and the easy-miss category.

## 8. Performance and caching

- Stockfish runs as 12 single-thread processes in parallel (`--workers 12`), with each
  game's positions kept on one process. Measured: 1 x 10 threads 4.0 pos/s; 6 x 1 8.2;
  12 x 1 9.7 (19 pos/s on bullet games). About 7s per game; all 17k games would take ~1.5
  days.
- Shallow (depth-4) searches use a separate single-thread process with a cleared hash,
  so the deep search's hash can't make them deeper.
- Cache: `miner/work/sf_cache.json`, keyed by full FEN + depth + multipv. Keying by
  position only (ignoring move counters) was measured and rejected: repeats after ply 12
  are 0.3-1.7% of positions.
- The PC slept overnight during one run; long runs now request keep-awake.

## 9. Explaining a mistake (trainer "What went wrong")

### 9.1 Punishment line

My game move followed by Stockfish's depth-16 line from the mining cache, 12 plies.
"Show punishment" and "Show best line" play them on the board.

### 9.2 Quick-look eval trace

- Rejected: re-evaluating at depth 16 along the line. Along the engine's own line it's flat
  by construction and says nothing about timing.
- Chosen: a shallow eval = median of Stockfish's scores at depths 1-5 from one search
  (a single depth-3 score was off by 900cp in one position), taken only at my turns. With
  the opponent to move, a quick search sees threats against me I can still parry, which
  caused 500-900cp swings. Single spikes remain.
- "Shows up" row (was "To spot: Easy/Hard", changed 2026-11-11): the first of my turns where
  the gap between the two traces reaches `max(30, min(half the loss, 200))` cp
  (`--critical-share`, `--critical-cap`). It says when a quick *engine* search sees the
  damage, not how hard the move is for me: on 1,101 problems Easy and Hard had the same
  median Maia p(best) (31% vs 28%), so Maia stays the human measure. Labels: right away /
  later (names the move) / deep (never within the line).
- Why the 200cp cap: with half the loss alone, an 854cp loss whose gap was 386cp at my next
  turn (epic-straw-dowitcher) read "Hard, 4 moves later"; my rating notes called these
  clear endgame transitions. The cap moved 11 problems to "right away" (662 right away,
  280 later, 19 deep, 140 marginal).
- From my notes on 11 of them: "deep" matched my own "deep" tag 2 of 3 times; the
  delayed ones were mostly trapped pieces, which the material rule (§9.3) can miss when the
  trap closes at the end of the 12 plies (sly-snow-vireo: "positional").

### 9.3 Positional or concrete: decided by material

- Rejected: classifying by when the quick-look eval drops. NNUE already scores king
  safety, structure and activity, so even a 1-ply look "sees" positional damage. Results
  were the same at depths 1-2, 1-3 and 1-5.
- Chosen: does the punishment win material compared with the best line, at my turns?
  The loss must hold for at least 2 of my turns through the end of the line (so a capture
  before my recapture, or one at the end of the line, doesn't count), and the size reported
  is the lasting loss, not a mid-exchange peak.
- Labels: positional (no lasting material loss in 6 turns), positional then material
  (lasting loss from turn 4 on), concrete (within 3 turns), marginal (re-score loss <= 30).
- Current 861: 623 positional, 73 positional then material, 72 concrete, 93 marginal.

### 9.4 "What changed" from the classical eval

Stockfish 14 with `Use NNUE false` prints classical eval terms (mobility, king safety,
threats, pawns, ...). Validation on 200 problems: the classical positional terms agreed
the move was worse only 60-71% of the time, correlation with the real loss +0.2 to +0.25
(about 0 on my very next turn). So it is shown only when the classical total is positive
and at least 25% of the loss, averaged over quiet positions at my turns 2-4. Result: 426 of
861 explained. Most common terms: threats 121, piece mobility 89, king safety 89. Treat it
as a hint, not the engine's actual reasoning.

### 9.5 Ideas not done

Rule-based highlighting of changed features (weak squares, open files, pawn structure)
was proposed and deferred in favour of engine-backed evidence.

### 9.6 Endgame tag (2026-11-11)

9 of my 11 notes on "shows up later / deep" problems were endgames. Definition: 6 or fewer
pieces besides kings and pawns, both sides together (Lichess's game-phase rule), computed in
the trainer from the FEN (Phase filter, "endgame" in the list). Measured on 1,101 problems:

| Definition | Problems | My 11 notes |
|---|---|---|
| <= 4 pieces | 134 | 9 |
| **<= 6 pieces (chosen)** | 227 | 9 |
| <= 6 pieces, no queens | 159 | 9 |
| Stockfish phase < 50% | 241 | 9 |
| Stockfish strict endgame (non-pawn material <= 3915) | 71 | 5 |

The two notes it misses are middlegames with queens on.

### 9.7 Trapped pieces (2026-11-11)

Trigger: sly-snow-vireo, perky-copper-rook and regal-claret-starling ("piece trapped" in my
notes). The material rule (§9.3) called sly-snow-vireo positional: the knight falls at the
last of my turns, so the loss doesn't hold for 2 turns.

- Rule (`explain.py`): at each of my turns, a knight/bishop/rook/queen is trapped when it can
  be won where it stands (attacked by a cheaper piece, or attacked and undefended) and every
  move of it lands on such a square (a capture worth at least the piece counts as an escape).
  Flagged only if it happens in the punishment line earlier than any trap in the best line,
  the problem isn't marginal, and I end the line >= 2 pawns down (`--trap-gap`).
- Prototype on the 2026-11-11 export: the bare rule fired on 46 problems, many of them
  momentary (mid-exchange, recaptured); the end-of-line gap leaves 11, including all three
  named ones. "The piece is captured later in the line" was tried as the filter instead and
  dropped: it keeps exchanges and misses regal-claret-starling.
- Trainer: the Cost row names the piece and the move after which it is trapped; it replaces
  "no material lost" for positional problems. Not yet checked by me one by one.

## 10. Trainer (the site)

- Modes: Mate (original), Strategy (the first 41 problems), Review (current 861, browsable).
- Strategy and Review problems are one move. Every legal move is pre-scored by Stockfish at
  depth 16, so grading needs no engine in the browser: Best <= 10cp, Good <= 30cp count
  as solved; Inaccuracy <= 75, Mistake <= 150, Blunder above.
- Review: numbered list (#1-#861 in export order; **a re-export renumbers**), filters by
  category, verdict, what changed, time format and status, and Go to #. On screens >= 1200px
  the list is a sticky left column.
- "Why this problem" (always visible) lists each check's value and threshold from the
  mining run; move names stay hidden until solved or revealed. "What went wrong" appears
  after solving or revealing.
- Engine-noise disclosure: when the re-score's best move differs from the mining run's,
  the panel says so.

The `grade` subcommand (CLI) uses the same labels with CT-Art-style points 3/2/1/0/0 and
multipv 3 for alternatives.

### 10.1 Feedback loop (added 2026-11-08)

- Review mode has a "Rate this problem" panel: Good / Meh / Bad, reason tags, and a note.
  Saved in the browser (`localStorage` `review-feedback-v1`); "Export feedback" in the problem
  list downloads a JSON file, "Import" merges one (newer rating wins), e.g. from the phone.
- Keyed by game link + FEN, not #number or id, so ratings survive a re-export. Each entry
  stores a snapshot of the problem's mining values at rating time.
- Tag keys (`tactical`, `noise`, `deep`, `obvious`, `unclear`, `engine_move`, `decided`,
  `time`, `wrong_verdict`, `duplicate`, `instructive`, `habit`) are read by
  `miner/feedback.py`, which maps each to the check it most likely implicates.
- `feedback.py` reports good/bad rates per category/verdict/time class and, for each mining
  value, the single cut that drops the most bad for the fewest good. These are fitted on my
  ratings only: leads to test against the volume table, not thresholds to adopt blindly.
- `export_site.py --feedback file.json` leaves out problems rated bad.

## 11. Unverified or open

- Maia-3's Elo scale being Lichess blitz (from the brief, not the source or model card).
- The ChessGoals bullet/rapid rows (3 rows) and transcription (read via a helper agent).
- Engine noise vs the 30cp minimum (§6.5).
- Whether the 55 problems where p(best) drops at higher Elo are good problems (§6.2).
- Drift mode is effectively untested.
- No Maia history in `grade` (FEN only), so its probabilities lack context.

## 12. Regenerating

From `miner/` (Windows, Git Bash):

```bash
.venv/Scripts/python.exe fetch_games.py --chesscom real_Holimion --lichess rduenasf --out work
cd work && PYTHONPATH=.. ../.venv/Scripts/python.exe -m stratmine mine chesscom.pgn,lichess.pgn real_Holimion,rduenasf --since 2026-10-08 --out-pgn v5_problems.pgn --out-csv v5_problems.csv --out-quiz v5_quiz.pgn --features v5_features.csv
cd .. && .venv/Scripts/python.exe export_site.py work/v5_problems.csv --out work/review.js --var STRATEGIC_REVIEW --id-prefix r --config work/v5_problems_config.json
.venv/Scripts/python.exe explain.py work/review.js
.venv/Scripts/python.exe whatchanged.py work/review.js
cp work/review.js ../strategic_review.js
```

`mine` writes `*_config.json` with the thresholds used. `export_site.py` scores every legal
move (~40 min for 861 problems); `explain.py` and `whatchanged.py` take a few minutes each.
After changing site files, bump `VERSION` in `sw.js`.

`mine` also reports Maia p(best) at a fixed 2600 Elo (`--elo-top`, info only, not a check).
For an export made before that existed, `addtop.py ../strategic_review.js --csv work/v4_problems.csv`
fills it in (Maia only, about a minute).

`mine` and `export_site.py` add the rating-trend flags (§6.8). For an export made before
them, `addflags.py ../strategic_review.js` adds them in place (no engine, instant).

With ratings exported from the trainer:

```bash
.venv/Scripts/python.exe feedback.py work/review-feedback-2026-11-08.json --csv work/feedback.csv
# then add --feedback work/review-feedback-2026-11-08.json to the export_site.py line above
```
