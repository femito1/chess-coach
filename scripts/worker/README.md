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

> **Running it automatically on Cloud Run?** Skip to
> [Automatic: scheduled Cloud Run job](#automatic-scheduled-cloud-run-job). The
> section below is the manual path, and worth reading first because the scheduled
> setup runs the same verification steps.

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

## Automatic: scheduled Cloud Run job

```bash
npm run worker:deploy -- --dry-run    # prints every command, changes nothing
npm run worker:deploy
```

One command stands the whole thing up. Then the loop needs no human in it:

```
   app (any device)  ──▶  cloud_games          uploads new PGNs on sign-in and
          ▲                    │                whenever the analysis queue goes
          │                    ▼                idle — already automatic, no button
          │             Cloud Scheduler
          │                    │  nightly
          │                    ▼
          │             Cloud Run job  ──▶  cloud_analyses
          └────────────────────────────────────┘
                     results arrive on the next app open
```

### Why Cloud Run jobs

The workload is a burst: CPU-bound, no inbound ports, resumable, idle most of the
time. Cloud Run jobs scale to zero and bill by the second, and the free tier
(~200 000 vCPU-seconds/month) covers a full-library NNUE re-analysis with room
over — this work costs roughly **32 vCPU-seconds per game**, so ~1 800 games is
~58 000. There is also no VM to remember to destroy, which is the usual way the
"just rent a box for an hour" approach turns into a monthly bill.

### What the script creates

| # | resource | notes |
|---|---|---|
| 1 | four APIs enabled | run, artifactregistry, secretmanager, cloudscheduler |
| 2 | Artifact Registry repo | `chess-coach` |
| 3 | the worker image | built `--platform linux/amd64` and pushed |
| 4 | Secret Manager secret | the Supabase `service_role` key |
| 5 | service account | exactly two roles (see below) |
| 6 | two Cloud Run jobs | `chess-coach-analysis` and `…-verify` |
| 7 | Cloud Scheduler trigger | **created paused** — see below |

Idempotent: re-running is how you ship a new image or change the schedule.

### Configuration

Reads `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` and `USER_ID` from the same
`worker.env` the manual path uses, or from the environment. Useful flags:

```bash
npm run worker:deploy -- --region=us-central1
npm run worker:deploy -- --schedule="17 4 * * *"   # cron, off the hour on purpose
npm run worker:deploy -- --cpu=4 --memory=8Gi
npm run worker:deploy -- --no-schedule             # job only, no trigger
```

### Six decisions worth understanding before you change them

**`--tasks=1`, always.** The worker has no lease or claiming — it selects every
candidate game itself — so *N* parallel tasks would each analyze the same games
and burn *N* times the compute for identical results. Parallelism belongs inside
the task, via `CONCURRENCY` engine processes.

**`CONCURRENCY` is pinned, not inferred.** The worker defaults it to
`os.cpus().length - 1`, and inside a container `os.cpus()` reports the **host's**
core count rather than the cgroup limit. Left to guess, an 8-vCPU job could spawn
dozens of Stockfish processes and thrash. The script sets it to `cpu - 1`.

**`--task-timeout=2h`, deliberately short.** The worker is resumable by
construction — every analysis is written the moment it finishes — so a task that
times out loses nothing and the next execution continues. That makes a short
timeout *safer* than a long one: a hung engine on 8 vCPU burns 28 800
vCPU-seconds an hour against a ~200 000/month free tier, so a 24-hour timeout (the
Cloud Run maximum) would let one stuck run blow the budget where two hours cannot.
Two hours is also roughly what a ~1 800-game backlog needs, so the normal case
finishes in one go anyway.

**The schedule is created paused.** An unpaused trigger would run an unverified
backlog overnight, and the whole point of `worker:verify` is that a wrong binary
produces numbers which are not comparable with the rest of your library. Resume it
once you have verified.

**The verify job gets no credentials.** Verified by running it: the verifier reads
only `STOCKFISH_PATH` and never touches the database, so binding an
RLS-bypassing key to it would be gratuitous. It is a separate job rather than an
execution override because `gcloud run jobs execute` can override env vars and
args but *not* the container command.

**Two IAM roles, no more.** `secretmanager.secretAccessor` scoped to that one
secret, and `run.invoker` so Cloud Scheduler can start the job.

### Bring it up in this order

```bash
# 1. prove the engine agrees with the browser
gcloud run jobs execute chess-coach-analysis-verify --region=europe-west1 --wait

# 2. see the plan without running an engine
gcloud run jobs execute chess-coach-analysis --update-env-vars=DRY_RUN=1 --region=europe-west1 --wait

# 3. a real throughput number on 20 games
gcloud run jobs execute chess-coach-analysis --update-env-vars=LIMIT=20 --region=europe-west1 --wait

# 4. the backlog
gcloud run jobs execute chess-coach-analysis --region=europe-west1

# 5. hand it over to the schedule
gcloud scheduler jobs resume chess-coach-analysis-nightly --location=europe-west1
```

`--update-env-vars` on `execute` is an **execution override** — it does not mutate
the deployed job, so these smoke tests leave the nightly config alone.

Logs: `gcloud beta run jobs logs tail chess-coach-analysis --region=europe-west1`.

### Then turn off analysis on your laptop

This is the switch that actually stops your laptop working:
**Settings → "Analyze new games automatically" → off.**

Without it the laptop still analyzes every new game itself, racing the server for
the same work. Nothing breaks — cloud sync prefers the server's NNUE analysis over
a local classical one even at lower depth — but the fans stay on, which was the
thing you were trying to avoid.

### Cost, and a guard

A nightly run that finds nothing costs a few vCPU-seconds. The one-time backlog is
~58 000 of a ~200 000 monthly allowance. So this should be $0 indefinitely.

Set a budget alert anyway (`console.cloud.google.com/billing`) so a surprise is an
email rather than an invoice. Note that Cloud Run needs a billing account attached
even to use the free tier.

## After it finishes

Sync from the app (**Settings → Cloud sync → Sync now**) to pull the analyses
down. Because they are NNUE and your local ones are classical, sync will replace
the local copies — which is the upgrade you asked for.
