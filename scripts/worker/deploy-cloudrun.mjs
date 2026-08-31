#!/usr/bin/env node
/**
 * Deploy the analysis worker as a **scheduled Cloud Run job**, so games get
 * analyzed off-laptop and without anyone pressing anything.
 *
 * ── Why Cloud Run jobs ───────────────────────────────────────────────────
 *
 * The workload is a burst: CPU-bound, no inbound ports, resumable, and idle most
 * of the time. Cloud Run jobs fit that exactly — scale to zero, pay by the
 * second, and the free tier (~200 000 vCPU-seconds/month) comfortably covers a
 * full-library NNUE re-analysis, which costs roughly 32 vCPU-seconds per game.
 * There is also no VM to remember to destroy, which is the failure mode of the
 * "just rent a box for an hour" alternative.
 *
 * ── The whole automatic loop ─────────────────────────────────────────────
 *
 *   app (any device)  ──▶ cloud_games        uploads new PGNs
 *          ▲                   │                on sign-in and whenever the
 *          │                   ▼                analysis queue goes idle
 *          │            Cloud Scheduler          (useCloudSync — already
 *          │                   │                  automatic, no button)
 *          │                   ▼
 *          │            Cloud Run job  ──▶ cloud_analyses
 *          └───────────────────────────────────┘
 *                    results arrive on the next app open
 *
 * So the only human action is opening the app, which you would do anyway to look
 * at your games. **To actually stop your laptop analyzing, turn off
 * Settings → "Analyze new games automatically"** — otherwise the laptop races the
 * server for the same games. Nothing breaks if you don't (sync prefers the
 * server's NNUE analysis over a local classical one), but the laptop keeps
 * burning CPU, which is the thing you were trying to avoid.
 *
 * ── What this script does, idempotently ──────────────────────────────────
 *
 *   1. enable the four APIs it needs
 *   2. create an Artifact Registry docker repo
 *   3. build the worker image for linux/amd64 and push it
 *   4. put the Supabase service_role key in Secret Manager
 *   5. create a service account and grant it exactly two roles
 *   6. deploy the Cloud Run job
 *   7. create a Cloud Scheduler trigger — **paused**
 *
 * Step 7 is paused on purpose. `scripts/worker/README.md` is emphatic that you
 * verify the engine before committing hours of compute, and an unpaused schedule
 * would run an unverified backlog overnight. The script prints the verify →
 * dry-run → smoke-test → resume sequence at the end.
 *
 * ── Usage ────────────────────────────────────────────────────────────────
 *
 *   npm run worker:deploy -- --dry-run     # print every command, change nothing
 *   npm run worker:deploy
 *   npm run worker:deploy -- --region=us-central1 --schedule="17 4 * * *"
 *
 * Reads `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` and `USER_ID` from
 * `worker.env` (the file scripts/worker/README.md already documents) or from the
 * environment. The service_role key is passed to gcloud on **stdin**, never in
 * argv, because argv is visible to every process on the machine via `ps`.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/* ------------------------------------------------------------- defaults --- */

const DEFAULTS = {
  region: 'europe-west1',
  job: 'chess-coach-analysis',
  repo: 'chess-coach',
  secret: 'chess-coach-supabase-service-role',
  serviceAccount: 'chess-coach-worker',
  /** Off the hour on purpose: :00 is where every cron in the world piles up. */
  schedule: '17 4 * * *',
  /**
   * Cloud Scheduler defaults to UTC, which quietly makes "run at 04:17" mean
   * something else wherever you live — 06:17 in Rome in summer, and a different
   * offset in winter, so the job also drifts across the DST boundary. Detected
   * from the host so the schedule means what it reads.
   */
  timeZone:
    process.env.TZ ||
    (() => {
      try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Etc/UTC';
      } catch {
        return 'Etc/UTC';
      }
    })(),
  cpu: '8',
  memory: '16Gi',
  depth: '18',
  evaluator: 'nnue',
  /**
   * Bounded deliberately, and shorter than you might expect.
   *
   * The worker is resumable by construction — every analysis is written as it
   * finishes — so a task that times out loses nothing; the next execution
   * continues. That makes a SHORT timeout strictly safer than a long one: a hung
   * engine on 8 vCPU burns 28 800 vCPU-seconds per hour, and the whole monthly
   * free tier is ~200 000. A 24-hour timeout (the Cloud Run maximum) would let
   * one stuck run blow the budget; two hours cannot.
   *
   * Two hours is also about what a ~1 800-game backlog needs, so the normal case
   * finishes in one execution anyway.
   */
  taskTimeout: '2h',
  /** Retries are safe for the same reason: a retry resumes rather than repeats. */
  maxRetries: '1',
};

/* ---------------------------------------------------------------- utils --- */

let dryRun = false;
const fail = (m) => {
  console.error(`\n[deploy] ✗ ${m}`);
  process.exit(1);
};
const ok = (m) => console.log(`[deploy] ✓ ${m}`);
const info = (m) => console.log(`[deploy]   ${m}`);
const step = (m) => console.log(`\n[deploy] ── ${m}`);

/**
 * Run a command.
 *
 * `stdin` feeds data without it ever appearing in argv — the only safe way to
 * hand gcloud a secret. `tolerate` is a regex of stderr meaning "already in the
 * desired state", which is what makes the whole script re-runnable.
 */
function run(cmd, args, { capture = false, tolerate = null, stdin = null, label, redact = false, readOnly = false } = {}) {
  const shown = redact ? `${cmd} ${args.join(' ')} <secret on stdin>` : `${cmd} ${args.join(' ')}`;
  // `readOnly` commands run even under --dry-run. They change nothing, and the
  // dry run is far more useful when it reports the project and account it would
  // actually act on rather than blanks.
  if (dryRun && !readOnly) {
    info(`would run: ${shown}`);
    return { dryRun: true, stdout: '' };
  }
  const res = spawnSync(cmd, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    input: stdin ?? undefined,
    stdio: [stdin ? 'pipe' : 'inherit', capture ? 'pipe' : 'inherit', 'pipe'],
  });
  if (res.error) fail(`could not run ${cmd} (${res.error.message})`);
  const err = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  if (res.status !== 0) {
    if (tolerate && tolerate.test(err)) return { tolerated: true, stdout: res.stdout ?? '' };
    if (/invalid_grant|refreshing your current auth tokens/i.test(err)) {
      fail(
        `${label ?? shown} failed because the gcloud credential expired mid-run.\n` +
          '  Run `gcloud auth login`, then re-run this script — it is idempotent, so\n' +
          '  whatever already succeeded is left alone.',
      );
    }
    if (/PERMISSION_DENIED|does not have permission/i.test(err)) {
      fail(
        `${label ?? shown} was denied.\n` +
          '  The signed-in account needs Owner, or Editor plus Project IAM Admin, on\n' +
          '  this project. Check `gcloud auth list` and `gcloud config get-value project`.',
      );
    }
    if (/billing/i.test(err) && /enable|disabled|required/i.test(err)) {
      fail(
        `${label ?? shown} failed because billing is not enabled on this project.\n` +
          '  Cloud Run needs a billing account attached even to use the free tier:\n' +
          '    console.cloud.google.com/billing\n' +
          '  The free allowance still applies; you are not charged unless you exceed it.',
      );
    }
    if (err.trim()) console.error(err.trim());
    fail(`${label ?? shown} failed (exit ${res.status})`);
  }
  return { stdout: res.stdout ?? '' };
}

const gcloud = (args, opts) => run('gcloud', args, opts);

/* ----------------------------------------------------------------- args --- */

const cfg = { ...DEFAULTS };
let makeSchedule = true;

for (const a of process.argv.slice(2)) {
  if (a === '--dry-run') dryRun = true;
  else if (a === '--no-schedule') makeSchedule = false;
  else if (a === '-h' || a === '--help') {
    console.log(
      'Usage: npm run worker:deploy [-- flags]\n\n' +
        Object.entries(DEFAULTS)
          .map(([k, v]) => `  --${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}=…`.padEnd(26) + `default ${v}`)
          .join('\n') +
        '\n  --project=ID              default: gcloud config get-value project' +
        '\n  --no-schedule             deploy the job without a Cloud Scheduler trigger' +
        '\n  --dry-run                 print every command and change nothing\n',
    );
    process.exit(0);
  } else if (a.startsWith('--')) {
    const [rawKey, ...rest] = a.slice(2).split('=');
    const key = rawKey.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (rest.length === 0) fail(`${a} needs a value, e.g. --${rawKey}=…`);
    cfg[key] = rest.join('=');
  } else fail(`unknown argument ${a}`);
}

/* --------------------------------------------------------------- config --- */

/** `worker.env` is the file scripts/worker/README.md already documents; reusing
 *  it means there is one place to put these values, not two. Process env wins so
 *  CI or a one-off override works. */
function readWorkerEnv() {
  const out = {};
  const path = join(repoRoot, 'worker.env');
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (/^\s*#/.test(line) || !line.includes('=')) continue;
    const i = line.indexOf('=');
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    if (k) out[k] = v;
  }
  return out;
}

const fileEnv = readWorkerEnv();
const pick = (k) => (process.env[k] ?? '').trim() || (fileEnv[k] ?? '').trim() || null;

const project =
  cfg.project ??
  gcloud(['config', 'get-value', 'project'], { capture: true, readOnly: true }).stdout.trim();
if (!project || project === '(unset)') {
  fail('no GCP project set. Run `gcloud config set project <id>` or pass --project=<id>.');
}

const supabaseUrl = pick('SUPABASE_URL');
let userId = pick('USER_ID');
const serviceRoleKey = pick('SUPABASE_SERVICE_ROLE_KEY');

const missing = [
  !supabaseUrl && 'SUPABASE_URL',
  !serviceRoleKey && 'SUPABASE_SERVICE_ROLE_KEY',
].filter(Boolean);

if (missing.length && !dryRun) {
  fail(
    `missing ${missing.join(', ')}.\n` +
      '  Put them in `worker.env` at the repo root (gitignored), or export them:\n' +
      '\n' +
      '    SUPABASE_URL=https://xxxxxxxx.supabase.co\n' +
      '    SUPABASE_SERVICE_ROLE_KEY=eyJhbGci...     # Supabase → Project Settings → API\n' +
      '\n' +
      '  USER_ID is optional: left empty, it is looked up from cloud_sync_allowlist.\n' +
      '\n' +
      '  SUPABASE_URL is also inlined in the deployed bundle if you need to recover it:\n' +
      "    curl -s https://chess-coach-bip.pages.dev/assets/index-*.js | grep -o 'https://[a-z0-9]*\\.supabase\\.co'\n" +
      '\n' +
      '  The service_role key bypasses Row-Level Security entirely — it goes into\n' +
      '  Secret Manager here and must never be committed or sent to a browser.',
  );
}

/**
 * Resolve and validate `USER_ID` against `cloud_sync_allowlist`.
 *
 * This is not convenience, it is a guard against a silent failure with no
 * symptom. Every worker query filters on `USER_ID` explicitly (it must — the
 * service_role key bypasses RLS), so a wrong or stale id makes the worker find
 * zero candidate games, print "No games found", and exit **0**. On a nightly
 * schedule that is a job which succeeds forever while doing nothing, and the only
 * way you would notice is that your library never improves.
 *
 * So: look the id up when it is absent, and when it is supplied, check it is real
 * before wiring it into a scheduled job. Also reports how many games are waiting,
 * which is the honest answer to "how long will the backlog take".
 */
async function resolveUserId() {
  const rest = async (path) => {
    const res = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        Prefer: 'count=exact',
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      if (res.status === 401 || res.status === 403) {
        fail(
          'Supabase rejected the service_role key (HTTP ' + res.status + ').\n' +
            '  Check you copied `service_role` and not `anon` from\n' +
            '  Project Settings → API. The anon key cannot read the allowlist.',
        );
      }
      fail(`Supabase ${path} → HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
    }
    return res;
  };

  const res = await rest('cloud_sync_allowlist?select=user_id');
  const rows = await res.json();

  if (!Array.isArray(rows) || rows.length === 0) {
    fail(
      'cloud_sync_allowlist is empty, so no account is enrolled in cloud sync.\n' +
        '  Enrol yourself first (see supabase/cloud-sync.sql), then sync once from\n' +
        '  the app so the worker has games to read.',
    );
  }

  if (userId) {
    if (!rows.some((r) => r.user_id === userId)) {
      fail(
        `USER_ID=${userId} is not in cloud_sync_allowlist.\n` +
          `  Enrolled ids: ${rows.map((r) => r.user_id).join(', ')}\n` +
          '  A worker with the wrong id finds zero games and exits 0 — it would look\n' +
          '  like a healthy nightly job doing nothing. Fix it or leave USER_ID empty\n' +
          '  and let this script fill it in.',
      );
    }
    ok(`USER_ID ${userId} is enrolled`);
    return userId;
  }

  if (rows.length > 1) {
    fail(
      'cloud_sync_allowlist has more than one enrolled id, so it is ambiguous:\n' +
        `    ${rows.map((r) => r.user_id).join('\n    ')}\n` +
        '  Set USER_ID in worker.env to the one you want analyzed.',
    );
  }

  const resolved = rows[0].user_id;
  ok(`USER_ID ${resolved} (the only id in cloud_sync_allowlist)`);

  // A real backlog number beats the README's worked example.
  const games = await rest(`cloud_games?select=game_id&user_id=eq.${encodeURIComponent(resolved)}&limit=1`);
  const total = games.headers.get('content-range')?.split('/')?.[1] ?? '?';
  if (total === '0') {
    info(
      'cloud_games has 0 games for this id — sync once from the app (it syncs on\n' +
        '            sign-in automatically) or the first run will have nothing to do.',
    );
  } else {
    info(`${total} games in cloud_games — at ~32 vCPU-seconds each that is the backlog`);
  }
  return resolved;
}

if (!dryRun) {
  step('resolving USER_ID against cloud_sync_allowlist');
  userId = await resolveUserId();
}

const saEmail = `${cfg.serviceAccount}@${project}.iam.gserviceaccount.com`;
const image = `${cfg.region}-docker.pkg.dev/${project}/${cfg.repo}/analysis-worker:latest`;
/** One core left for Node and the chess.js work, matching the worker's own
 *  default reasoning. Pinned rather than inferred: `os.cpus()` reports the HOST's
 *  core count inside a container, not the cgroup limit, so letting the worker
 *  guess risks dozens of engine processes on an 8-vCPU allocation. */
const concurrency = String(Math.max(1, Number(cfg.cpu) - 1));

console.log(`[deploy] project      ${project}`);
console.log(`[deploy] region       ${cfg.region}`);
console.log(`[deploy] job          ${cfg.job}`);
console.log(`[deploy] image        ${image}`);
console.log(`[deploy] resources    ${cfg.cpu} vCPU / ${cfg.memory}, CONCURRENCY=${concurrency}`);
console.log(`[deploy] engine       depth ${cfg.depth}, ${cfg.evaluator}`);
console.log(`[deploy] task timeout ${cfg.taskTimeout} (resumable; see the header)`);
console.log(
  `[deploy] schedule     ${
    makeSchedule ? `${cfg.schedule} ${cfg.timeZone} (created paused)` : 'none (--no-schedule)'
  }`,
);
if (dryRun) console.log('[deploy] DRY RUN — nothing will be created');

/* -------------------------------------------------------------- 0. auth --- */
step('checking gcloud auth');
{
  const who = gcloud(['auth', 'list', '--filter=status:ACTIVE', '--format=value(account)'], {
    capture: true,
    readOnly: true,
  });
  const account = who.stdout.trim();
  if (!account) fail('no active gcloud account. Run `gcloud auth login`.');

  // `auth list` is NOT sufficient, measured: it reports a stored account without
  // validating its refresh token, so an expired credential shows as ACTIVE and the
  // first real API call then dies with `invalid_grant` — after the script has
  // already started enabling APIs. Minting a token is the cheapest call that
  // actually proves the credential works.
  const token = spawnSync('gcloud', ['auth', 'print-access-token'], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['inherit', 'pipe', 'pipe'],
  });
  if (token.status !== 0) {
    const err = `${token.stdout ?? ''}${token.stderr ?? ''}`;
    fail(
      `the gcloud credential for ${account} is present but not usable.\n` +
        (/invalid_grant/i.test(err)
          ? '  The refresh token has expired or been revoked (invalid_grant).\n'
          : '') +
        '  Run `gcloud auth login`, then re-run this script.',
    );
  }
  ok(`authenticated as ${account}`);
}

/* -------------------------------------------------------------- 1. APIs --- */
step('enabling APIs');
gcloud([
  'services', 'enable',
  'run.googleapis.com',
  'artifactregistry.googleapis.com',
  'secretmanager.googleapis.com',
  'cloudscheduler.googleapis.com',
  `--project=${project}`,
], { capture: true, label: 'enabling APIs' });
ok('run, artifactregistry, secretmanager, cloudscheduler');

/* ---------------------------------------------------------- 2. registry --- */
step('creating the Artifact Registry repo');
gcloud([
  'artifacts', 'repositories', 'create', cfg.repo,
  '--repository-format=docker',
  `--location=${cfg.region}`,
  '--description=Chess Coach analysis worker images',
  `--project=${project}`,
], { capture: true, tolerate: /ALREADY_EXISTS|already exists/i, label: 'creating the repo' });
ok(`${cfg.region}-docker.pkg.dev/${project}/${cfg.repo}`);

/* ------------------------------------------------------------- 3. image --- */
step('building and pushing the image');
gcloud(['auth', 'configure-docker', `${cfg.region}-docker.pkg.dev`, '--quiet'], {
  capture: true, label: 'configuring docker auth',
});
// `--platform linux/amd64` is not decoration: Cloud Run runs x86, the Dockerfile
// installs the x86-64 AVX2 Stockfish, and a build on an ARM laptop would
// otherwise produce an image that fails at run time rather than at build time.
run('docker', [
  'build', '--platform', 'linux/amd64',
  '-f', 'scripts/worker/Dockerfile',
  '-t', image, '.',
], { label: 'docker build' });
run('docker', ['push', image], { label: 'docker push' });
ok('image pushed');

/* ------------------------------------------------------------ 4. secret --- */
step('storing the service_role key in Secret Manager');
gcloud([
  'secrets', 'create', cfg.secret,
  '--replication-policy=automatic',
  `--project=${project}`,
], { capture: true, tolerate: /ALREADY_EXISTS|already exists/i, label: 'creating the secret' });
// On stdin, never argv: anything on a command line is readable by every process
// on the machine through `ps`.
gcloud(['secrets', 'versions', 'add', cfg.secret, '--data-file=-', `--project=${project}`], {
  capture: true,
  stdin: serviceRoleKey ?? '',
  redact: true,
  label: 'adding a secret version',
});
ok(`${cfg.secret} (new version added)`);

/* ----------------------------------------------------------- 5. account --- */
step('creating the service account and granting two roles');
gcloud([
  'iam', 'service-accounts', 'create', cfg.serviceAccount,
  '--display-name=Chess Coach analysis worker',
  `--project=${project}`,
], { capture: true, tolerate: /ALREADY_EXISTS|already exists/i, label: 'creating the service account' });

// Exactly two roles, and no more: read this one secret, and invoke this job.
// `secretAccessor` is scoped to the single secret rather than the project.
gcloud([
  'secrets', 'add-iam-policy-binding', cfg.secret,
  `--member=serviceAccount:${saEmail}`,
  '--role=roles/secretmanager.secretAccessor',
  `--project=${project}`,
], { capture: true, label: 'granting secretAccessor' });
gcloud([
  'projects', 'add-iam-policy-binding', project,
  `--member=serviceAccount:${saEmail}`,
  '--role=roles/run.invoker',
], { capture: true, label: 'granting run.invoker' });
ok(`${saEmail} — secretAccessor (this secret only) + run.invoker`);

/* --------------------------------------------------------------- 6. job --- */
step('deploying the Cloud Run job');
gcloud([
  'run', 'jobs', 'deploy', cfg.job,
  `--image=${image}`,
  `--region=${cfg.region}`,
  `--project=${project}`,
  `--cpu=${cfg.cpu}`,
  `--memory=${cfg.memory}`,
  // ONE task. The worker has no lease or claiming — it selects every candidate
  // game itself — so N parallel tasks would each analyze the same games and burn
  // N times the compute for the same result. Concurrency happens INSIDE the task
  // via CONCURRENCY engine processes.
  '--tasks=1',
  '--parallelism=1',
  `--task-timeout=${cfg.taskTimeout}`,
  `--max-retries=${cfg.maxRetries}`,
  `--service-account=${saEmail}`,
  `--set-secrets=SUPABASE_SERVICE_ROLE_KEY=${cfg.secret}:latest`,
  `--set-env-vars=SUPABASE_URL=${supabaseUrl ?? ''},USER_ID=${userId ?? ''},DEPTH=${cfg.depth},EVALUATOR=${cfg.evaluator},CONCURRENCY=${concurrency}`,
], { capture: true, label: 'deploying the job' });
ok(`job ${cfg.job} deployed`);

// A second job from the SAME image, running the verifier instead of the worker.
//
// Why a separate job rather than an override at execution time: `gcloud run jobs
// execute` can override env vars and args but NOT the container command, and the
// image's CMD is `node dist-worker/worker.mjs` — so `--args` alone would drop the
// `node`. Two jobs cost nothing when idle and make "verify before you commit
// hours of compute" a single command instead of a redeploy.
gcloud([
  'run', 'jobs', 'deploy', `${cfg.job}-verify`,
  `--image=${image}`,
  `--region=${cfg.region}`,
  `--project=${project}`,
  // The verifier runs a handful of positions, single-threaded. It does not need
  // the worker's cores, and asking for fewer means it schedules faster.
  '--cpu=2',
  '--memory=4Gi',
  '--tasks=1',
  '--parallelism=1',
  '--task-timeout=15m',
  '--max-retries=0',
  '--command=node',
  '--args=dist-worker/verify.mjs',
  `--service-account=${saEmail}`,
  // NO secret and no Supabase config: verified by running it: the verifier only
  // reads STOCKFISH_PATH and touches the database not at all. Binding the
  // service_role key here would hand RLS-bypassing credentials to a job that has
  // no use for them.
  `--set-env-vars=DEPTH=${cfg.depth}`,
], { capture: true, label: 'deploying the verify job' });
ok(`job ${cfg.job}-verify deployed`);

/* --------------------------------------------------------- 7. scheduler --- */
if (makeSchedule) {
  step('creating the Cloud Scheduler trigger (paused)');
  const uri = `https://${cfg.region}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${project}/jobs/${cfg.job}:run`;
  const schedArgs = [
    'scheduler', 'jobs', 'create', 'http', `${cfg.job}-nightly`,
    `--location=${cfg.region}`,
    `--schedule=${cfg.schedule}`,
    `--time-zone=${cfg.timeZone}`,
    `--uri=${uri}`,
    '--http-method=POST',
    `--oauth-service-account-email=${saEmail}`,
    `--project=${project}`,
  ];
  const made = gcloud(schedArgs, {
    capture: true,
    tolerate: /ALREADY_EXISTS|already exists/i,
    label: 'creating the scheduler job',
  });
  if (made.tolerated) {
    gcloud([
      'scheduler', 'jobs', 'update', 'http', `${cfg.job}-nightly`,
      `--location=${cfg.region}`,
      `--schedule=${cfg.schedule}`,
      `--time-zone=${cfg.timeZone}`,
      `--uri=${uri}`,
      `--oauth-service-account-email=${saEmail}`,
      `--project=${project}`,
    ], { capture: true, label: 'updating the scheduler job' });
    info('scheduler job already existed — updated in place, leaving its paused/running state alone');
  } else {
    // Paused on purpose: an unverified backlog should not run overnight. The
    // README's verify step exists precisely because a wrong binary produces
    // numbers that are not comparable with the rest of the library.
    gcloud([
      'scheduler', 'jobs', 'pause', `${cfg.job}-nightly`,
      `--location=${cfg.region}`, `--project=${project}`,
    ], { capture: true, label: 'pausing the scheduler job' });
    ok(`${cfg.job}-nightly created PAUSED (${cfg.schedule} ${cfg.timeZone})`);
  }
}

/* ---------------------------------------------------------------- next --- */

const ex = `gcloud run jobs execute ${cfg.job} --region=${cfg.region} --project=${project}`;
console.log(
  `\n[deploy] ${dryRun ? 'dry run complete — re-run without --dry-run to apply.' : 'deployed.'}\n` +
    '\n' +
    'Next, in this order — the README is emphatic about not committing hours of\n' +
    'compute to an unverified engine:\n' +
    '\n' +
    `  1. prove the engine and the browser agree\n` +
    `     gcloud run jobs execute ${cfg.job}-verify --region=${cfg.region} --project=${project} --wait\n` +
    `  2. see the plan without running an engine\n` +
    `     ${ex} --update-env-vars=DRY_RUN=1 --wait\n` +
    `  3. get a real throughput number on 20 games\n` +
    `     ${ex} --update-env-vars=LIMIT=20 --wait\n` +
    `  4. let it run the backlog (or just wait for the schedule)\n` +
    `     ${ex}\n` +
    `  5. turn the schedule on\n` +
    `     gcloud scheduler jobs resume ${cfg.job}-nightly --location=${cfg.region} --project=${project}\n` +
    '\n' +
    'Logs:\n' +
    `  gcloud beta run jobs logs tail ${cfg.job} --region=${cfg.region} --project=${project}\n` +
    '\n' +
    'Then, to actually stop analyzing on your laptop, turn OFF\n' +
    'Settings → "Analyze new games automatically". Otherwise the laptop races the\n' +
    'server for the same games — harmless, since sync prefers the server\'s NNUE\n' +
    'result, but it keeps your fan on.\n' +
    '\n' +
    'Worth doing once: set a budget alert at console.cloud.google.com/billing so a\n' +
    'surprise is an email rather than an invoice.\n',
);
