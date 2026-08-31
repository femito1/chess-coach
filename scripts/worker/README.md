# Off-laptop analysis worker

Analyzes your games on a server instead of your laptop, and delivers the results
through the cloud sync you already have. The worker is just another device that
only ever produces analyses.

```
    laptop  ──sync──▶  cloud_games          your PGNs
                           │
    server  ──────────────▶│  native Stockfish 16, N processes
                           ▼
                       cloud_analyses
                           │
    laptop  ◀──sync────────┘               results come back
```

It reuses `analyzeGamePgn` from `src/` verbatim, so classifications, motifs,
phases, accuracies and book detection are computed by exactly the same code the
browser runs. Only the engine transport differs.

Per game it writes two rows, not one: the analysis into `cloud_analyses`, and a
summary back onto `cloud_games` (`analysis_status: 'done'`, `accuracy`,
`brilliantCount`). The second is what lets a laptop that never analyzed the game
see it as analyzed after a sync.

---

## Why this exists, and the thing it fixes

The browser's bundled Stockfish ships with **`Use NNUE` off** and no network file
(a 575 KB `.wasm` against a 40 MB net), so every analysis the app has ever
produced came from Stockfish 16's **classical** evaluator. On tactics that is
fine — search finds a forced mate regardless of who is evaluating. On quiet
positions it is not:

| position | classical | NNUE |
|---|---|---|
| rook endgame | **+0.53** ("equal") | **+3.77** ("winning") |
| queenless middlegame | −1.13 | −2.96 |

For a tool that tells you whether you converted an endgame well, that gap is the
difference between useful and misleading. A server has no 40 MB download to
worry about, so it runs the real thing — which is why the default here is
`EVALUATOR=nnue`.

Analyses record which evaluator produced them (`Analysis.engine`), and cloud sync
prefers NNUE over classical for the same game **even at lower depth**, so a
laptop re-analysis can never silently overwrite the server's better work.

---

## Setup

### 1. Prerequisites

- A Linux box with a few cores. Any provider; nothing here is
  provider-specific. It does not need to stay up — this is a burst job.
- Your Supabase **service_role** key: dashboard → Project Settings → API →
  `service_role`.
- Your Clerk user id: it is the `user_id` in `cloud_sync_allowlist`.

> **The service_role key bypasses Row-Level Security entirely.** It must never be
> committed, shipped to a browser, or pasted anywhere public — it is strictly an
> env var on a machine you control. Because RLS is bypassed, `USER_ID` is
> required and every query filters on it explicitly, so a typo cannot touch
> another account's rows.

### 2. Get your games into the cloud

The worker reads from `cloud_games`, so sync once from the app first:
**Settings → Cloud sync → Sync now**. That uploads your PGNs (a couple of MB).
If you skip this the worker will tell you it found no games.

### 3. Configure

Create `worker.env` (gitignored — do not commit it):

```sh
SUPABASE_URL=https://xxxxxxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJhbGci...        # secret
USER_ID=user_xxxxxxxxxxxxxxxxxxxxxx

DEPTH=18                # search depth
EVALUATOR=nnue          # nnue | classical
CONCURRENCY=8           # defaults to (cores - 1)
```

### 4. Run

**Docker (any provider):**

```sh
docker build -f scripts/worker/Dockerfile -t chess-coach-worker .
docker run --rm --env-file worker.env chess-coach-worker \
  node dist-worker/verify.mjs          # prove the engine first
docker run --rm --env-file worker.env chess-coach-worker
```

**Bare VM (Ubuntu/Debian):**

```sh
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs
curl -fsSL -o sf.tar https://github.com/official-stockfish/Stockfish/releases/download/sf_16/stockfish-ubuntu-x86-64-avx2.tar
tar -xf sf.tar && sudo mv stockfish/stockfish-ubuntu-x86-64-avx2 /usr/local/bin/stockfish

git clone <your repo> && cd chess-coach && npm ci
npm run worker:build
set -a && . ./worker.env && set +a
npm run worker:verify        # then:
npm run worker:run
```

---

## Verify before you commit hours of compute

```sh
npm run worker:verify
```

This is not a formality. It checks three things:

1. **With `Use NNUE false`, does this binary reproduce the browser?** If yes, a
   classical-configured worker can extend the existing library seamlessly. On
   the reference machine both positions matched to the centipawn (delta 0).
2. **With `Use NNUE true`, do the numbers actually change?** This catches a
   binary silently failing to load its network and falling back to classical.
3. **Does `analyzeGamePgn` run end to end under Node?** It analyzes a short
   mating game at depth 12 through the real `WorkerPool` backend and checks the
   move count, the recorded `engine` id, finite accuracies, and that the final
   move classifies as mate. This is the check that catches a break in the
   browser/Node seam rather than in the engine.

If it fails, do not run a bulk analysis: the output would not be comparable with
the rest of your library.

---

## Options

| env var | default | meaning |
|---|---|---|
| `SUPABASE_URL` | — | required |
| `SUPABASE_SERVICE_ROLE_KEY` | — | required, secret |
| `USER_ID` | — | required, your Clerk user id |
| `DEPTH` | `18` | search depth |
| `EVALUATOR` | `nnue` | `nnue` or `classical` |
| `CONCURRENCY` | cores − 1 | engine processes, each single-threaded |
| `STOCKFISH_PATH` | `stockfish` | path to the binary |
| `LIMIT` | — | stop after N games — use for a smoke test |
| `FORCE` | — | `1` re-analyzes even adequate games |
| `DRY_RUN` | — | `1` reports what it would do, runs no engine |

Start with `DRY_RUN=1` to see the plan, then `LIMIT=5` to confirm results land,
then the full run.

---

## What it picks up

An existing analysis is good enough only if its evaluator is at least as strong
**and** its depth at least as deep. So switching from classical to NNUE makes
every previously-analyzed game a candidate — that is the intent, not a bug: it is
how the library becomes uniformly NNUE. `DRY_RUN=1` shows the breakdown
(`missing`, `weaker-evaluator`, `shallower`, and `forced` under `FORCE=1`).

The worker never downgrades: running with `EVALUATOR=classical` leaves existing
NNUE analyses alone.

## Resuming, and stopping

Every analysis is written the moment it finishes, so the job is resumable by
construction — Ctrl-C or kill it and re-run, and it continues from where it got
to. `SIGINT`/`SIGTERM` finish the in-flight game first. There is no lease or
checkpoint state to corrupt.

A single failing game (unparseable PGN, say) is logged and skipped rather than
ending the run; the next invocation retries it. A run that is failing more than
it is succeeding does stop, though: past 50 failures, once failures outnumber
completions, it breaks out rather than burning the rest of the compute — so a
short run that ends early is telling you something is wrong with the setup, not
with one game.

## Cost and duration

Rough shape on 8 cores at depth 18 with NNUE: on the order of a few seconds of
wall clock per game, so a ~1 800-game backlog lands in a couple of hours and a
full-library re-analysis scales from there. Time it with `LIMIT=20` first — the
worker prints a running estimate — rather than trusting this paragraph.

That is pennies of compute on any hourly VM, and the box can be destroyed the
moment it finishes.

## After it finishes

Sync from the app (**Settings → Cloud sync → Sync now**) to pull the analyses
down. Because they are NNUE and your local ones are classical, sync will replace
the local copies — which is the upgrade you asked for.
