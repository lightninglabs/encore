'use strict';

/**
 * encore — re-runs GitHub Actions jobs that were lost to infrastructure rather
 * than to a real failure (spot preemption, OOM-kill, node-pressure eviction).
 *
 * Runs after a workflow run completes, from a *different* run on a
 * non-preemptible runner. Nothing inside a preempted job can retry itself: the
 * kernel takes the runner agent and any in-process retry loop together, and the
 * job's lease with GitHub is already broken.
 *
 * Zero dependencies on purpose. `github` (an authenticated Octokit), `context`
 * and `core` are supplied by actions/github-script. The file is loadable three
 * ways, all exercising the same code:
 *   - `require`d by the composite action in action.yml
 *   - inlined verbatim into .github/workflows/retry.yml by
 *     scripts/build-workflow.mjs (where `module` does not exist, hence the
 *     guarded export at the bottom)
 *   - `require`d by test/encore.test.js
 */

/**
 * The annotation GitHub attaches when the runner stops answering:
 *
 *   The self-hosted runner: <name> lost communication with the server. [...]
 *
 * Deliberately broad. It also matches OOM-kill and node-pressure eviction,
 * which the design accepts as retryable so that no Kubernetes-side signal is
 * needed. Callers can add their own patterns via the `extra_patterns` input
 * without forking.
 */
const DEFAULT_INFRA_PATTERNS = [/lost communication with the server/i];

/**
 * Conclusions worth examining. `cancelled` is included because a preempted job
 * does not always land as `failure` — fail-fast siblings and some ARC
 * preemptions land as `cancelled` — and a candidate we never look at is a
 * silent decline, the worst outcome. Cancellation on its own is not evidence of
 * anything, so it is scored differently: see classifyJob.
 */
const CANDIDATE_CONCLUSIONS = ['failure', 'cancelled'];

/** Statuses from checks.listAnnotations that mean "ask the logs instead". */
const ANNOTATIONS_UNAVAILABLE = [403, 404, 410];

/**
 * Statuses from rerun-failed-jobs that mean "this run is not re-runnable":
 * someone hit Re-run manually in the window since the status check, the run has
 * aged out of the retention window, or — unconfirmed, see docs/design.md — the
 * run has no *failed* jobs to re-run because every candidate ended `cancelled`.
 * None of those is our bug, and none is worth a red X on the orchestrator, but
 * the last one has a different fix, so it gets a different message.
 */
const RERUN_REJECTED = [403, 404, 409, 422];

/** A 60-shard matrix should not open 60 concurrent log downloads. */
const MAX_CONCURRENCY = 8;

/** Job logs are scanned from the end: that is where the runner's death lands. */
const MAX_LOG_BYTES = 256 * 1024;

const DEFAULT_MAX_ATTEMPTS = 3;

function parseCount(value, fallback, label) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return fallback;
  }
  const parsed = Number(String(value).trim());
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer, got ${JSON.stringify(value)}`);
  }
  return parsed;
}

function parseFlag(value, fallback, label) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return fallback;
  }
  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  throw new Error(`${label} must be a boolean, got ${JSON.stringify(value)}`);
}

/** One case-insensitive regex per non-blank, non-comment line. */
function parsePatterns(value, label) {
  return String(value === undefined || value === null ? '' : value)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map((line) => {
      try {
        return new RegExp(line, 'i');
      } catch (error) {
        throw new Error(`${label} contains an invalid regex ${JSON.stringify(line)}: ${error.message}`);
      }
    });
}

function statusOf(error) {
  if (!error) return undefined;
  if (error.status !== undefined) return error.status;
  return error.response && error.response.status;
}

/**
 * Job logs arrive as a redirect body: string, Buffer or ArrayBuffer. Only the
 * tail is decoded — enough to hold the runner's last words.
 *
 * This bounds the string we hold and the regex we run over it, not the
 * download: Octokit has already buffered the whole response by the time we get
 * here. Capping that would need a Range header or a streamed fetch of the
 * redirect target. Job logs are rarely large enough for it to matter, and
 * MAX_CONCURRENCY bounds how many are in memory at once.
 */
function decodeTail(data, maxBytes = MAX_LOG_BYTES) {
  if (data === undefined || data === null) return '';
  if (typeof data === 'string') {
    return data.length > maxBytes ? data.slice(-maxBytes) : data;
  }
  if (typeof Buffer !== 'undefined') {
    let buffer = null;
    if (Buffer.isBuffer(data)) buffer = data;
    else if (data instanceof ArrayBuffer) buffer = Buffer.from(data);
    else if (ArrayBuffer.isView(data)) {
      buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    }
    if (buffer) {
      const tail = buffer.length > maxBytes ? buffer.subarray(buffer.length - maxBytes) : buffer;
      return tail.toString('utf8');
    }
  }
  return String(data);
}

/**
 * A job's id doubles as its check-run id, which is what makes its annotations
 * readable. Undocumented but stable; if it ever stops being true this call
 * 404s and we fall back to the logs.
 */
async function readAnnotations({ github, owner, repo, jobId }) {
  const annotations = await github.paginate(github.rest.checks.listAnnotations, {
    owner,
    repo,
    check_run_id: jobId,
    per_page: 100,
  });
  return annotations
    .map((annotation) => [annotation.title, annotation.message].filter(Boolean).join(' — '))
    .join('\n');
}

async function readLogs({ github, owner, repo, jobId }) {
  const response = await github.rest.actions.downloadJobLogsForWorkflowRun({
    owner,
    repo,
    job_id: jobId,
  });
  return decodeTail(response && response.data);
}

/**
 * Verdict for one candidate job:
 *   infra        — matched a pattern; retryable
 *   genuine      — failed with no infra evidence; blocks the whole run
 *   inconclusive — cancelled with no infra evidence; neither retryable nor
 *                  blocking, because a fail-fast cancellation says nothing
 *                  about why the run died
 *
 * Anything unreadable scores as if there were no evidence: the expensive
 * mistake is retrying a run that will fail again.
 */
async function classifyJob({ github, core, owner, repo, job, patterns }) {
  const matches = (text) => patterns.some((pattern) => pattern.test(text));
  const verdict = {
    id: job.id,
    name: job.name,
    conclusion: job.conclusion,
    runner: job.runner_name || 'unknown',
    infra: false,
    source: 'annotations',
  };

  let classified = false;
  try {
    verdict.infra = matches(await readAnnotations({ github, owner, repo, jobId: job.id }));
    classified = true;
  } catch (error) {
    const status = statusOf(error);
    if (!ANNOTATIONS_UNAVAILABLE.includes(status)) throw error;
    core.warning(
      `annotations unavailable for job "${job.name}" (HTTP ${status}); falling back to job logs`,
    );
  }

  if (!classified) {
    try {
      verdict.source = 'logs';
      verdict.infra = matches(await readLogs({ github, owner, repo, jobId: job.id }));
    } catch (error) {
      verdict.source = 'unreadable';
      verdict.infra = false;
      core.warning(
        `could not read annotations or logs for job "${job.name}" (${error.message}); ` +
          'assuming no infra evidence',
      );
    }
  }

  if (verdict.infra) verdict.verdict = 'infra';
  else if (job.conclusion === 'cancelled') verdict.verdict = 'inconclusive';
  else verdict.verdict = 'genuine';
  return verdict;
}

/**
 * Bounded-concurrency map that stops handing out work once `stopAfter` says a
 * result has settled the question. Returns a sparse array: holes are jobs that
 * were never examined because the answer was already known.
 */
async function mapBounded(items, limit, worker, stopAfter) {
  const results = new Array(items.length);
  let cursor = 0;
  let stopped = false;

  const drain = async () => {
    while (!stopped) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      const result = await worker(items[index], index);
      results[index] = result;
      if (stopAfter && stopAfter(result)) stopped = true;
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, drain));
  return results;
}

function finish(core, result) {
  const verdicts = result.verdicts || [];
  const outputs = {
    decision: result.decision,
    retried: String(result.retried === true),
    examined_attempt: String(result.examined_attempt === undefined ? '' : result.examined_attempt),
    next_attempt: String(result.next_attempt === undefined ? '' : result.next_attempt),
    candidate_jobs: String(result.candidate_jobs === undefined ? 0 : result.candidate_jobs),
    infra_jobs: String(verdicts.filter((verdict) => verdict.verdict === 'infra').length),
  };
  for (const [name, value] of Object.entries(outputs)) core.setOutput(name, value);
  return result;
}

/**
 * @returns {Promise<{decision: string, retried: boolean, examined_attempt: number,
 *   next_attempt?: number, candidate_jobs?: number, verdicts?: object[]}>}
 *   `decision` is one of `retried`, `retried_all`, `rerun_rejected`, `dry_run`,
 *   `attempt_cap`, `no_candidate_jobs`, `genuine_failure`, `no_infra_evidence`,
 *   `run_incomplete`.
 */
async function encore({ github, context, core, inputs = {} }) {
  const { owner, repo } = context.repo;
  const runId = parseCount(inputs.run_id, undefined, 'run_id');
  if (runId === undefined) throw new Error('run_id is required');
  const maxAttempts = parseCount(inputs.max_attempts, DEFAULT_MAX_ATTEMPTS, 'max_attempts');
  const dryRun = parseFlag(inputs.dry_run, false, 'dry_run');
  const rerunAllFallback = parseFlag(inputs.rerun_all_fallback, false, 'rerun_all_fallback');
  const extra = parsePatterns(inputs.extra_patterns, 'extra_patterns');
  const patterns = [...DEFAULT_INFRA_PATTERNS, ...extra];

  const run = (await github.rest.actions.getWorkflowRun({ owner, repo, run_id: runId })).data;
  const attempt = Number(run.run_attempt);
  core.info(
    `run ${runId} "${run.name}" status=${run.status} conclusion=${run.conclusion} ` +
      `attempt=${attempt} max_attempts=${maxAttempts}${dryRun ? ' dry_run=true' : ''}` +
      `${rerunAllFallback ? ' rerun_all_fallback=true' : ''}` +
      `${extra.length ? ` extra_patterns=${extra.length}` : ''}`,
  );

  // rerun-failed-jobs is rejected while a run is in progress, which is also why
  // this cannot live in the run it is retrying.
  if (run.status && run.status !== 'completed') {
    core.warning(`run ${runId} is ${run.status}, not completed; not retrying`);
    return finish(core, { decision: 'run_incomplete', retried: false, examined_attempt: attempt });
  }

  // Doubles as the infinite-loop guard: each re-run emits another
  // workflow_run:completed, which brings us straight back here.
  if (attempt >= maxAttempts) {
    core.notice(`attempt ${attempt} >= max_attempts ${maxAttempts}; not retrying`);
    return finish(core, { decision: 'attempt_cap', retried: false, examined_attempt: attempt });
  }

  const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRunAttempt, {
    owner,
    repo,
    run_id: runId,
    attempt_number: attempt,
    per_page: 100,
  });
  const candidates = jobs.filter((job) => CANDIDATE_CONCLUSIONS.includes(job.conclusion));
  const common = { examined_attempt: attempt, candidate_jobs: candidates.length };
  if (candidates.length === 0) {
    core.info(
      `no failed or cancelled jobs in attempt ${attempt} ` +
        `(${jobs.length} job(s) examined); nothing to do`,
    );
    return finish(core, { decision: 'no_candidate_jobs', retried: false, ...common, verdicts: [] });
  }

  // All or nothing, so the first genuine failure settles it — no point paying
  // for the rest of a 60-shard matrix once we know we are not retrying.
  const examined = (
    await mapBounded(
      candidates,
      MAX_CONCURRENCY,
      (job) => classifyJob({ github, core, owner, repo, job, patterns }),
      (result) => result.verdict === 'genuine',
    )
  ).filter(Boolean);

  for (const verdict of examined) {
    core.info(
      `job="${verdict.name}" conclusion=${verdict.conclusion} runner="${verdict.runner}" ` +
        `verdict=${verdict.verdict} source=${verdict.source}`,
    );
  }
  const unexamined = candidates.length - examined.length;
  if (unexamined > 0) {
    core.info(`${unexamined} candidate job(s) not examined: a genuine failure already settled it`);
  }

  const result = { ...common, verdicts: examined };
  const genuine = examined.filter((verdict) => verdict.verdict === 'genuine');
  if (genuine.length > 0) {
    core.notice(
      `${genuine.length} of ${candidates.length} candidate job(s) look genuine ` +
        `(${genuine.map((verdict) => verdict.name).join(', ')}); not retrying`,
    );
    return finish(core, { decision: 'genuine_failure', retried: false, ...result });
  }

  // Everything cancelled, nothing matched. Warn rather than shrug: if ARC
  // preemptions land as `cancelled` here, this is the line that says so.
  if (!examined.some((verdict) => verdict.verdict === 'infra')) {
    core.warning(
      `${examined.length} cancelled job(s) with no infra evidence; not retrying. ` +
        'If preemptions land as cancelled in this environment, add the message they ' +
        'carry to the extra_patterns input.',
    );
    return finish(core, { decision: 'no_infra_evidence', retried: false, ...result });
  }

  if (dryRun) {
    core.notice(
      `dry_run: would retry ${examined.length} job(s) as attempt ${attempt + 1}`,
    );
    return finish(core, { decision: 'dry_run', retried: false, ...result });
  }

  // Whether GitHub counts a `cancelled` job as re-runnable is unconfirmed. If
  // no candidate ended `failure`, a rejection here probably means "nothing to
  // re-run" rather than "already re-run", so it is reported differently.
  const noFailedJobs = !candidates.some((job) => job.conclusion === 'failure');

  // The cheap primitive, and the only one the spec calls for: it preserves jobs
  // that already passed.
  try {
    await github.rest.actions.reRunWorkflowFailedJobs({ owner, repo, run_id: runId });
    core.notice(`retrying ${examined.length} job(s) as attempt ${attempt + 1}`);
    return finish(core, {
      decision: 'retried',
      retried: true,
      next_attempt: attempt + 1,
      ...result,
    });
  } catch (error) {
    const status = statusOf(error);
    if (!RERUN_REJECTED.includes(status)) throw error;
    const rejection = `rerun-failed-jobs was rejected for run ${runId} (HTTP ${status}: ${error.message})`;

    if (!noFailedJobs) {
      // Someone re-ran it by hand, or it aged past the retention window.
      // Nothing to fix, so say what happened instead of going red.
      core.warning(
        `${rejection}; the run is no longer re-runnable — most likely it was already re-run, ` +
          'or it has aged out of the retention window',
      );
      return finish(core, { decision: 'rerun_rejected', retried: false, ...result });
    }

    core.warning(
      `${rejection}. No candidate job ended "failure" — every one was cancelled — so this run ` +
        'may have no failed jobs for GitHub to re-run at all. That is not the same as the run ' +
        'being expired or already re-run: see the rerun_all_fallback input.',
    );
    if (!rerunAllFallback) {
      return finish(core, { decision: 'rerun_rejected', retried: false, ...result });
    }
  }

  // Opt-in fallback for exactly that case: re-run the whole run, passed jobs
  // included. More expensive, but it is the only primitive that can start an
  // attempt when there is nothing GitHub calls a failed job.
  try {
    await github.rest.actions.reRunWorkflow({ owner, repo, run_id: runId });
  } catch (error) {
    const status = statusOf(error);
    if (!RERUN_REJECTED.includes(status)) throw error;
    core.warning(
      `rerun (whole run) was also rejected for run ${runId} (HTTP ${status}: ${error.message}); ` +
        'giving up',
    );
    return finish(core, { decision: 'rerun_rejected', retried: false, ...result });
  }

  core.notice(
    `re-running the whole of run ${runId} as attempt ${attempt + 1}, including jobs that ` +
      'passed: rerun_all_fallback is set and no job was re-runnable on its own',
  );
  return finish(core, {
    decision: 'retried_all',
    retried: true,
    next_attempt: attempt + 1,
    ...result,
  });
}

/* istanbul ignore else -- `module` is undefined when this file is inlined into a workflow. */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { encore, DEFAULT_INFRA_PATTERNS, DEFAULT_MAX_ATTEMPTS, MAX_LOG_BYTES };
}
