'use strict';

const LOST_COMMUNICATION =
  'The self-hosted runner: arc-spot-abc123 lost communication with the server. ' +
  'Verify the machine is running and has a healthy network connection.';

const GENUINE = 'Process completed with exit code 1.';

const CANCELED = 'The operation was canceled.';

const CONTEXT = { repo: { owner: 'myorg', repo: 'app' } };

function job(id, name, conclusion, runner = 'arc-spot-abc123') {
  return { id, name, conclusion, runner_name: runner };
}

function httpError(status, message = 'request failed') {
  const error = new Error(message);
  error.status = status;
  return error;
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Minimal stand-in for the Octokit that actions/github-script injects. Each
 * fake endpoint returns a single page, which is all `paginate` needs here.
 * Annotation reads yield to the event loop so concurrency is observable.
 */
function fakeGithub({
  run,
  jobs = [],
  annotations = {},
  logs = {},
  rerunError = null,
  rerunAllError = null,
}) {
  const calls = { annotations: [], logs: [], rerun: [], rerunAll: [], jobs: [], peakConcurrency: 0 };
  let inFlight = 0;

  const resolve = (table, key) => {
    const entry = table[key];
    if (entry instanceof Error) throw entry;
    return entry;
  };

  const github = {
    rest: {
      actions: {
        getWorkflowRun: async () => ({ data: run }),
        listJobsForWorkflowRunAttempt: async (params) => {
          calls.jobs.push(params);
          return { data: jobs };
        },
        downloadJobLogsForWorkflowRun: async ({ job_id: jobId }) => {
          calls.logs.push(jobId);
          const body = resolve(logs, jobId);
          if (body === undefined) throw httpError(404, 'no logs');
          return { data: body };
        },
        reRunWorkflowFailedJobs: async (params) => {
          calls.rerun.push(params);
          if (rerunError) throw rerunError;
          return { status: 201, data: {} };
        },
        reRunWorkflow: async (params) => {
          calls.rerunAll.push(params);
          if (rerunAllError) throw rerunAllError;
          return { status: 201, data: {} };
        },
      },
      checks: {
        listAnnotations: async ({ check_run_id: checkRunId }) => {
          calls.annotations.push(checkRunId);
          inFlight += 1;
          calls.peakConcurrency = Math.max(calls.peakConcurrency, inFlight);
          await tick();
          inFlight -= 1;
          return { data: resolve(annotations, checkRunId) ?? [] };
        },
      },
    },
    paginate: async (endpoint, params) => (await endpoint(params)).data,
  };

  return { github, calls };
}

function fakeCore() {
  const logged = { info: [], notice: [], warning: [] };
  const outputs = {};
  const core = {
    info: (message) => logged.info.push(message),
    notice: (message) => logged.notice.push(message),
    warning: (message) => logged.warning.push(message),
    setOutput: (name, value) => {
      outputs[name] = value;
    },
  };
  return { core, logged, outputs };
}

module.exports = {
  LOST_COMMUNICATION,
  GENUINE,
  CANCELED,
  CONTEXT,
  job,
  httpError,
  fakeGithub,
  fakeCore,
};
