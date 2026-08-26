'use strict';

// The reusable workflow ships a copy of src/encore.js inlined into a
// `script:` block. These tests keep that copy honest: it must be in sync, it
// must compile the way actions/github-script compiles it, and it must behave
// like the module.

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const { LOST_COMMUNICATION, CONTEXT, job, fakeGithub, fakeCore } = require('./helpers.js');

const root = join(__dirname, '..');
const WORKFLOW = join(root, '.github', 'workflows', 'retry.yml');

/** Pull the `script: |` block body out of the generated workflow. */
function inlinedScript() {
  const lines = readFileSync(WORKFLOW, 'utf8').split('\n');
  const start = lines.findIndex((line) => line.trim() === 'script: |');
  assert.notEqual(start, -1, 'the workflow should contain a script block');
  const indent = ' '.repeat(lines[start].search(/\S/) + 2);
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (line !== '' && !line.startsWith(indent)) break;
    body.push(line.slice(indent.length));
  }
  return body.join('\n');
}

test('the generated workflow is in sync with src/encore.js', () => {
  execFileSync(process.execPath, [join(root, 'scripts', 'build-workflow.mjs'), '--check'], {
    cwd: root,
    stdio: 'pipe',
  });
});

test('the inlined script runs the same logic as the module', async () => {
  // actions/github-script compiles the block as an async function body, so the
  // body sees globals and its declared parameters — not `module`, which is why
  // the export at the foot of src/encore.js is guarded.
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  const compiled = new AsyncFunction('require', 'github', 'context', 'core', inlinedScript());

  const { github, calls } = fakeGithub({
    run: { id: 42, name: 'CI', status: 'completed', conclusion: 'failure', run_attempt: 1 },
    jobs: [job(1, 'build', 'failure')],
    annotations: { 1: [{ message: LOST_COMMUNICATION }] },
  });
  const { core, logged } = fakeCore();

  const previous = { ...process.env };
  process.env.ENCORE_RUN_ID = '42';
  process.env.ENCORE_MAX_ATTEMPTS = '3';
  process.env.ENCORE_DRY_RUN = 'false';
  process.env.ENCORE_EXTRA_PATTERNS = '';
  process.env.ENCORE_RERUN_ALL_FALLBACK = 'false';
  let result;
  try {
    result = await compiled(require, github, CONTEXT, core);
  } finally {
    process.env = previous;
  }

  assert.equal(result.decision, 'retried');
  assert.equal(result.next_attempt, 2);
  assert.deepEqual(calls.rerun, [{ owner: 'myorg', repo: 'app', run_id: 42 }]);
  assert.match(logged.info.join('\n'), /job="build" .*verdict=infra/);
});

test('the workflow keeps the retrier off the spot pool', () => {
  const workflow = readFileSync(WORKFLOW, 'utf8');
  assert.match(workflow, /^ {4}runs-on: ubuntu-latest$/m);
  assert.match(workflow, /^ {2}actions: write/m);
  assert.match(workflow, /^ {2}checks: read/m);
});
