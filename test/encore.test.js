'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { encore, MAX_LOG_BYTES } = require('../src/encore.js');
const {
  LOST_COMMUNICATION,
  GENUINE,
  CANCELED,
  CONTEXT,
  job,
  httpError,
  fakeGithub,
  fakeCore,
} = require('./helpers.js');

const completedRun = (attempt = 1, extra = {}) => ({
  id: 42,
  name: 'CI',
  status: 'completed',
  conclusion: 'failure',
  run_attempt: attempt,
  ...extra,
});

const lost = { annotation_level: 'failure', message: LOST_COMMUNICATION };

async function invoke(spec, inputs = {}) {
  const { github, calls } = fakeGithub(spec);
  const { core, logged, outputs } = fakeCore();
  const result = await encore({
    github,
    context: CONTEXT,
    core,
    inputs: { run_id: '42', ...inputs },
  });
  return { result, calls, logged, outputs };
}

const jobLines = (logged) => logged.info.filter((line) => line.startsWith('job='));

// Acceptance criterion 1: a job killed mid-run is re-run, as attempt 2.
test('retries when the only failed job lost communication', async () => {
  const { result, calls, outputs } = await invoke({
    run: completedRun(1),
    jobs: [job(1, 'build', 'failure')],
    annotations: { 1: [lost] },
  });

  assert.equal(result.decision, 'retried');
  assert.equal(result.retried, true);
  assert.deepEqual(calls.rerun, [{ owner: 'myorg', repo: 'app', run_id: 42 }]);
  assert.deepEqual(outputs, {
    decision: 'retried',
    retried: 'true',
    examined_attempt: '1',
    next_attempt: '2',
    candidate_jobs: '1',
    infra_jobs: '1',
  });
});

// Acceptance criterion 2: a genuine non-zero exit is not re-run.
test('does not retry a genuine failure', async () => {
  const { result, calls, logged, outputs } = await invoke({
    run: completedRun(1),
    jobs: [job(1, 'test', 'failure')],
    annotations: { 1: [{ message: GENUINE }] },
  });

  assert.equal(result.decision, 'genuine_failure');
  assert.equal(result.retried, false);
  assert.deepEqual(calls.rerun, []);
  assert.equal(outputs.examined_attempt, '1');
  assert.equal(outputs.next_attempt, '');
  assert.match(logged.notice.join('\n'), /not retrying/);
});

// Acceptance criterion 3: one genuine failure alongside one lost runner is not re-run.
test('does not retry a run that mixes infra and genuine failures', async () => {
  const { result, calls } = await invoke({
    run: completedRun(1),
    jobs: [job(1, 'build', 'failure'), job(2, 'test', 'failure')],
    annotations: { 1: [lost], 2: [{ message: GENUINE }] },
  });

  assert.equal(result.decision, 'genuine_failure');
  assert.deepEqual(calls.rerun, []);
  assert.deepEqual(
    result.verdicts.map((verdict) => [verdict.name, verdict.verdict]),
    [
      ['build', 'infra'],
      ['test', 'genuine'],
    ],
  );
});

// Acceptance criterion 4: passing jobs are left alone. rerun-failed-jobs is the
// primitive that preserves them, and we never even look at their annotations.
test('examines only failed and cancelled jobs, and uses rerun-failed-jobs', async () => {
  const { calls } = await invoke({
    run: completedRun(1),
    jobs: [
      job(1, 'lint', 'success'),
      job(2, 'build', 'failure'),
      job(3, 'docs', 'skipped'),
      job(4, 'shard-2', 'cancelled'),
      job(5, 'flaky', 'neutral'),
    ],
    annotations: { 2: [lost], 4: [lost] },
  });

  assert.deepEqual(calls.annotations.sort(), [2, 4]);
  assert.equal(calls.rerun.length, 1);
});

// Acceptance criterion 5: repeated preemption stops at the cap instead of looping.
test('stops at the attempt cap', async () => {
  const { result, calls, logged } = await invoke({
    run: completedRun(3),
    jobs: [job(1, 'build', 'failure')],
    annotations: { 1: [lost] },
  });

  assert.equal(result.decision, 'attempt_cap');
  assert.deepEqual(calls.rerun, []);
  assert.deepEqual(calls.annotations, []);
  assert.match(logged.notice.join('\n'), /attempt 3 >= max_attempts 3/);
});

test('retries the last attempt allowed by the cap', async () => {
  const { result, outputs } = await invoke({
    run: completedRun(2),
    jobs: [job(1, 'build', 'failure')],
    annotations: { 1: [lost] },
  });

  assert.equal(result.decision, 'retried');
  assert.equal(outputs.examined_attempt, '2');
  assert.equal(outputs.next_attempt, '3');
});

test('honours a custom max_attempts', async () => {
  const spec = {
    run: completedRun(1),
    jobs: [job(1, 'build', 'failure')],
    annotations: { 1: [lost] },
  };

  assert.equal((await invoke(spec, { max_attempts: '1' })).result.decision, 'attempt_cap');
  assert.equal((await invoke(spec, { max_attempts: 5 })).result.decision, 'retried');
});

// Acceptance criterion 6: one line per candidate job, with name, runner and verdict.
test('logs one line per examined job', async () => {
  const { logged } = await invoke({
    run: completedRun(1),
    jobs: [job(1, 'build', 'failure', 'arc-spot-aaa'), job(2, 'test', 'failure', 'arc-spot-bbb')],
    annotations: { 1: [lost], 2: [{ message: GENUINE }] },
  });

  assert.deepEqual(jobLines(logged), [
    'job="build" conclusion=failure runner="arc-spot-aaa" verdict=infra source=annotations',
    'job="test" conclusion=failure runner="arc-spot-bbb" verdict=genuine source=annotations',
  ]);
});

test('reports an unknown runner rather than null', async () => {
  const { logged } = await invoke({
    run: completedRun(1),
    jobs: [{ id: 1, name: 'build', conclusion: 'failure', runner_name: null }],
    annotations: { 1: [lost] },
  });

  assert.match(logged.info.join('\n'), /job="build" conclusion=failure runner="unknown"/);
});

test('does nothing when nothing in the attempt failed or was cancelled', async () => {
  const { result, calls, outputs } = await invoke({
    run: completedRun(1, { conclusion: 'startup_failure' }),
    jobs: [job(1, 'build', 'success'), job(2, 'docs', 'skipped')],
  });

  assert.equal(result.decision, 'no_candidate_jobs');
  assert.deepEqual(calls.rerun, []);
  assert.equal(outputs.candidate_jobs, '0');
});

test('inspects the attempt that just finished', async () => {
  const { calls } = await invoke(
    {
      run: completedRun(2),
      jobs: [job(1, 'build', 'failure')],
      annotations: { 1: [lost] },
    },
    { max_attempts: 4 },
  );

  assert.equal(calls.jobs[0].attempt_number, 2);
  assert.equal(calls.jobs[0].run_id, 42);
});

test('dry_run reports the verdict without re-running', async () => {
  const { result, calls, logged } = await invoke(
    {
      run: completedRun(1),
      jobs: [job(1, 'build', 'failure')],
      annotations: { 1: [lost] },
    },
    { dry_run: 'true' },
  );

  assert.equal(result.decision, 'dry_run');
  assert.equal(result.retried, false);
  assert.deepEqual(calls.rerun, []);
  assert.match(logged.notice.join('\n'), /would retry 1 job/);
});

test('will not re-run a run that is still in progress', async () => {
  const { result, calls, logged } = await invoke({
    run: completedRun(1, { status: 'in_progress', conclusion: null }),
    jobs: [job(1, 'build', 'failure')],
  });

  assert.equal(result.decision, 'run_incomplete');
  assert.deepEqual(calls.rerun, []);
  assert.match(logged.warning.join('\n'), /is in_progress, not completed/);
});

test('matches the annotation title as well as its message', async () => {
  const { result } = await invoke({
    run: completedRun(1),
    jobs: [job(1, 'build', 'failure')],
    annotations: { 1: [{ title: LOST_COMMUNICATION, message: null }] },
  });

  assert.equal(result.decision, 'retried');
});

test('scans every annotation on a job, not just the first', async () => {
  const { result } = await invoke({
    run: completedRun(1),
    jobs: [job(1, 'build', 'failure')],
    annotations: { 1: [{ message: 'Node.js 16 actions are deprecated.' }, lost] },
  });

  assert.equal(result.decision, 'retried');
});

test('treats a failed job with no annotations as a genuine failure', async () => {
  const { result, calls } = await invoke({
    run: completedRun(1),
    jobs: [job(1, 'build', 'failure')],
    annotations: {},
  });

  assert.equal(result.decision, 'genuine_failure');
  assert.deepEqual(calls.logs, []);
});

test('retries a cancelled job that lost communication', async () => {
  const { result, logged } = await invoke({
    run: completedRun(1),
    jobs: [job(1, 'shard-1', 'cancelled')],
    annotations: { 1: [lost] },
  });

  assert.equal(result.decision, 'retried');
  assert.match(jobLines(logged).join('\n'), /conclusion=cancelled runner=.* verdict=infra/);
});

test('a cancelled job with no evidence neither blocks nor triggers a retry', async () => {
  // fail-fast cancels the siblings of the preempted job: those cancellations
  // say nothing, so they must not veto the retry the preemption earns.
  const { result, logged } = await invoke({
    run: completedRun(1),
    jobs: [job(1, 'shard-1', 'failure'), job(2, 'shard-2', 'cancelled')],
    annotations: { 1: [lost], 2: [{ message: CANCELED }] },
  });

  assert.equal(result.decision, 'retried');
  assert.deepEqual(
    result.verdicts.map((verdict) => verdict.verdict),
    ['infra', 'inconclusive'],
  );
  assert.match(jobLines(logged).join('\n'), /conclusion=cancelled runner=.* verdict=inconclusive/);
});

test('says so loudly when every candidate is an unexplained cancellation', async () => {
  const { result, calls, logged } = await invoke({
    run: completedRun(1),
    jobs: [job(1, 'shard-1', 'cancelled'), job(2, 'shard-2', 'cancelled')],
    annotations: { 1: [{ message: CANCELED }], 2: [{ message: CANCELED }] },
  });

  assert.equal(result.decision, 'no_infra_evidence');
  assert.deepEqual(calls.rerun, []);
  assert.equal(jobLines(logged).length, 2, 'both cancelled jobs should be visible in the log');
  assert.match(logged.warning.join('\n'), /2 cancelled job\(s\) with no infra evidence/);
  assert.match(logged.warning.join('\n'), /extra_patterns/);
});

test('a cancelled job cannot rescue a genuine failure', async () => {
  const { result } = await invoke({
    run: completedRun(1),
    jobs: [job(1, 'test', 'failure'), job(2, 'shard-2', 'cancelled')],
    annotations: { 1: [{ message: GENUINE }], 2: [lost] },
  });

  assert.equal(result.decision, 'genuine_failure');
});

test('extra_patterns widens detection without a fork', async () => {
  const spec = {
    run: completedRun(1),
    jobs: [job(1, 'build', 'cancelled')],
    annotations: { 1: [{ message: 'The runner has received a shutdown signal.' }] },
  };

  assert.equal((await invoke(spec)).result.decision, 'no_infra_evidence');
  const { result } = await invoke(spec, {
    extra_patterns: '# spot reclaim\n\nreceived a shutdown signal\nnode was drained\n',
  });
  assert.equal(result.decision, 'retried');
});

test('rejects an unparseable extra_pattern instead of silently ignoring it', async () => {
  await assert.rejects(
    invoke({ run: completedRun(1), jobs: [] }, { extra_patterns: 'oops(' }),
    /extra_patterns contains an invalid regex "oops\(":/,
  );
});

// §8: if the job-id-as-check-run-id correspondence ever breaks, the same string
// is still in the logs.
for (const status of [403, 404, 410]) {
  test(`falls back to job logs when annotations return ${status}`, async () => {
    const { result, calls, logged } = await invoke({
      run: completedRun(1),
      jobs: [job(1, 'build', 'failure')],
      annotations: { 1: httpError(status, 'nope') },
      logs: { 1: Buffer.from(`2026-08-26T00:00:00Z ##[error]${LOST_COMMUNICATION}\n`) },
    });

    assert.equal(result.decision, 'retried');
    assert.equal(result.verdicts[0].source, 'logs');
    assert.deepEqual(calls.logs, [1]);
    assert.match(logged.warning.join('\n'), new RegExp(`HTTP ${status}`));
  });
}

test('reads logs delivered as an ArrayBuffer', async () => {
  const bytes = new TextEncoder().encode(LOST_COMMUNICATION);
  const { result } = await invoke({
    run: completedRun(1),
    jobs: [job(1, 'build', 'failure')],
    annotations: { 1: httpError(404) },
    logs: { 1: bytes.buffer },
  });

  assert.equal(result.decision, 'retried');
});

test('scans the tail of a very large log', async () => {
  const filler = 'x'.repeat(4 * MAX_LOG_BYTES);
  const { result } = await invoke({
    run: completedRun(1),
    jobs: [job(1, 'build', 'failure')],
    annotations: { 1: httpError(404) },
    logs: { 1: Buffer.from(`${filler}\n##[error]${LOST_COMMUNICATION}\n`) },
  });

  assert.equal(result.decision, 'retried');
});

test('does not read an unbounded log into memory', async () => {
  // The bound is the point, so the false negative it implies is asserted here
  // rather than discovered later: a message buried megabytes above the end of
  // the log is out of scope.
  const { result } = await invoke({
    run: completedRun(1),
    jobs: [job(1, 'build', 'failure')],
    annotations: { 1: httpError(404) },
    logs: { 1: Buffer.from(`${LOST_COMMUNICATION}\n${'x'.repeat(2 * MAX_LOG_BYTES)}`) },
  });

  assert.equal(result.decision, 'genuine_failure');
});

test('does not retry when neither annotations nor logs can be read', async () => {
  const { result, calls, logged } = await invoke({
    run: completedRun(1),
    jobs: [job(1, 'build', 'failure')],
    annotations: { 1: httpError(404) },
    logs: {},
  });

  assert.equal(result.decision, 'genuine_failure');
  assert.equal(result.verdicts[0].source, 'unreadable');
  assert.deepEqual(calls.rerun, []);
  assert.match(logged.warning.join('\n'), /assuming no infra evidence/);
});

test('propagates unexpected API errors instead of guessing', async () => {
  await assert.rejects(
    invoke({
      run: completedRun(1),
      jobs: [job(1, 'build', 'failure')],
      annotations: { 1: httpError(500, 'server error') },
    }),
    /server error/,
  );
});

// A rejected rerun is not a broken retrier: usually someone re-ran the run by
// hand between our status check and the call.
for (const status of [403, 404, 409, 422]) {
  test(`reports a ${status} from rerun-failed-jobs as rerun_rejected`, async () => {
    const { result, logged, outputs } = await invoke({
      run: completedRun(1),
      jobs: [job(1, 'build', 'failure')],
      annotations: { 1: [lost] },
      rerunError: httpError(status, 'Unable to retry this workflow run'),
    });

    assert.equal(result.decision, 'rerun_rejected');
    assert.equal(result.retried, false);
    assert.equal(outputs.retried, 'false');
    assert.equal(outputs.next_attempt, '');
    assert.match(logged.warning.join('\n'), new RegExp(`rejected for run 42 \\(HTTP ${status}`));
    assert.match(logged.warning.join('\n'), /already re-run|retention window/);
  });
}

test('propagates an unexpected rerun failure', async () => {
  await assert.rejects(
    invoke({
      run: completedRun(1),
      jobs: [job(1, 'build', 'failure')],
      annotations: { 1: [lost] },
      rerunError: httpError(502, 'bad gateway'),
    }),
    /bad gateway/,
  );
});

test('bounds concurrency across a wide matrix', async () => {
  const shards = Array.from({ length: 40 }, (_, index) => job(index + 1, `shard-${index}`, 'failure'));
  const annotations = Object.fromEntries(shards.map((shard) => [shard.id, [lost]]));

  const { result, calls } = await invoke({ run: completedRun(1), jobs: shards, annotations });

  assert.equal(result.decision, 'retried');
  assert.equal(calls.annotations.length, 40, 'every shard should still be classified');
  assert.ok(
    calls.peakConcurrency <= 8,
    `expected at most 8 concurrent reads, saw ${calls.peakConcurrency}`,
  );
  assert.ok(calls.peakConcurrency > 1, 'reads should still overlap');
});

test('stops classifying once a genuine failure settles it', async () => {
  const shards = Array.from({ length: 40 }, (_, index) => job(index + 1, `shard-${index}`, 'failure'));
  const annotations = Object.fromEntries(
    shards.map((shard) => [shard.id, [shard.id === 1 ? { message: GENUINE } : lost]]),
  );

  const { result, calls, logged } = await invoke({
    run: completedRun(1),
    jobs: shards,
    annotations,
  });

  assert.equal(result.decision, 'genuine_failure');
  assert.ok(
    calls.annotations.length <= 8,
    `expected to stop early, classified ${calls.annotations.length} of 40`,
  );
  assert.equal(result.candidate_jobs, 40);
  assert.match(logged.info.join('\n'), /candidate job\(s\) not examined/);
});

test('rejects malformed inputs', async () => {
  const spec = { run: completedRun(1), jobs: [] };

  await assert.rejects(invoke(spec, { run_id: '' }), /run_id is required/);
  await assert.rejects(invoke(spec, { run_id: 'abc' }), /run_id must be a positive integer/);
  await assert.rejects(invoke(spec, { max_attempts: '0' }), /max_attempts must be a positive integer/);
  await assert.rejects(invoke(spec, { max_attempts: '2.5' }), /max_attempts must be a positive integer/);
  await assert.rejects(invoke(spec, { dry_run: 'maybe' }), /dry_run must be a boolean/);
});

test('applies defaults for blank optional inputs', async () => {
  const { result } = await invoke(
    {
      run: completedRun(3),
      jobs: [job(1, 'build', 'failure')],
      annotations: { 1: [lost] },
    },
    { max_attempts: '', dry_run: '', extra_patterns: '' },
  );

  assert.equal(result.decision, 'attempt_cap', 'blank max_attempts should fall back to 3');
});

// Whether GitHub will re-run a run whose only candidates ended `cancelled` is
// unconfirmed (docs/design.md, "Still open"). If it refuses, the rejection must
// not be reported as an expired or already-re-run run — that sends someone
// debugging retention windows for a different problem entirely.
test('a cancelled-only rejection is reported as such, not as an expired run', async () => {
  const { result, calls, logged } = await invoke({
    run: completedRun(1, { conclusion: 'cancelled' }),
    jobs: [job(1, 'shard-1', 'cancelled'), job(2, 'shard-2', 'cancelled')],
    annotations: { 1: [lost], 2: [lost] },
    rerunError: httpError(403, 'Unable to retry this workflow run'),
  });

  assert.equal(result.decision, 'rerun_rejected');
  const warnings = logged.warning.join('\n');
  assert.match(warnings, /No candidate job ended "failure"/);
  assert.match(warnings, /rerun_all_fallback/);
  // it may say what this is *not*, but never diagnose it as one of those
  assert.doesNotMatch(warnings, /most likely it was already re-run|aged out/);
  assert.deepEqual(calls.rerunAll, [], 'the whole-run fallback is opt-in');
});

test('rerun_all_fallback re-runs the whole run when nothing else can', async () => {
  const { result, calls, logged, outputs } = await invoke(
    {
      run: completedRun(1, { conclusion: 'cancelled' }),
      jobs: [job(1, 'shard-1', 'cancelled')],
      annotations: { 1: [lost] },
      rerunError: httpError(403, 'Unable to retry this workflow run'),
    },
    { rerun_all_fallback: 'true' },
  );

  assert.equal(result.decision, 'retried_all');
  assert.equal(result.retried, true);
  assert.deepEqual(calls.rerunAll, [{ owner: 'myorg', repo: 'app', run_id: 42 }]);
  assert.equal(outputs.next_attempt, '2');
  assert.match(logged.notice.join('\n'), /including jobs that\s+passed/);
});

test('rerun_all_fallback stays out of the way when a job did fail', async () => {
  const { result, calls, logged } = await invoke(
    {
      run: completedRun(1),
      jobs: [job(1, 'build', 'failure')],
      annotations: { 1: [lost] },
      rerunError: httpError(403, 'Unable to retry this workflow run'),
    },
    { rerun_all_fallback: 'true' },
  );

  assert.equal(result.decision, 'rerun_rejected');
  assert.deepEqual(calls.rerunAll, [], 'a failed job means rerun-failed-jobs was the right call');
  assert.match(logged.warning.join('\n'), /already re-run|retention window/);
});

test('gives up when the whole-run fallback is rejected too', async () => {
  const { result, calls, logged } = await invoke(
    {
      run: completedRun(1, { conclusion: 'cancelled' }),
      jobs: [job(1, 'shard-1', 'cancelled')],
      annotations: { 1: [lost] },
      rerunError: httpError(403, 'Unable to retry this workflow run'),
      rerunAllError: httpError(403, 'Unable to retry this workflow run'),
    },
    { rerun_all_fallback: 'true' },
  );

  assert.equal(result.decision, 'rerun_rejected');
  assert.equal(result.retried, false);
  assert.equal(calls.rerunAll.length, 1);
  assert.match(logged.warning.join('\n'), /whole run\) was also rejected/);
});

test('propagates an unexpected failure from the whole-run fallback', async () => {
  await assert.rejects(
    invoke(
      {
        run: completedRun(1, { conclusion: 'cancelled' }),
        jobs: [job(1, 'shard-1', 'cancelled')],
        annotations: { 1: [lost] },
        rerunError: httpError(403, 'Unable to retry this workflow run'),
        rerunAllError: httpError(500, 'server error'),
      },
      { rerun_all_fallback: 'true' },
    ),
    /server error/,
  );
});

test('rejects a malformed rerun_all_fallback', async () => {
  await assert.rejects(
    invoke({ run: completedRun(1), jobs: [] }, { rerun_all_fallback: 'sometimes' }),
    /rerun_all_fallback must be a boolean/,
  );
});
