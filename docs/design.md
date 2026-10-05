<!--
Design record. This is the original implementation spec, kept verbatim so the
reasoning behind the design — in particular §3.1, why step-level retry actions
cannot solve this — survives the parts of it the README absorbed.

Where the implementation went further than the spec, see "§9 Implementation
notes" at the foot of this file. The README is the user-facing doc.
-->

# Auto-retry GitHub Actions jobs lost to spot preemption

Implementation spec. Target: self-hosted runners via Actions Runner Controller (ARC) on
Kubernetes, backed by spot instances.

---

## 1. Problem

When a spot node is reclaimed, the ARC runner pod is killed mid-job. GitHub marks the job
`failure` and attaches an annotation reading:

> The self-hosted runner: `<name>` lost communication with the server. Verify the machine is
> running and has a healthy network connection. Anything in your workflow that terminates the
> runner process, starves it for CPU/Memory, or blocks its network access can cause this error.

This is currently identified by a human eyeballing the run. We want it handled automatically,
and we want the mechanism to be opt-in via a few lines of YAML in any repo.

## 2. Constraints discovered during research

These shaped the design; do not "simplify" past them.

- **There is no native retry key.** GitHub Actions has no `jobs.<id>.retry` / `max-retries`.
  Several blog posts and AI-generated guides claim it exists. It does not. Only
  `continue-on-error`, `timeout-minutes`, and `strategy.fail-fast` exist, none of which help
  here — the runner process is gone, so nothing inside the job can react.
- **A run cannot re-run itself.** `POST .../actions/runs/{run_id}/rerun-failed-jobs` is rejected
  while the run is in progress. A `needs: [...] / if: failure()` job in the same workflow will
  not work. The retry logic must live in a separate run triggered after completion.
- **`workflow_run` workflows must live on the default branch** and are per-repo (no org-level
  `workflow_run`). Hence: a tiny per-repo caller + one shared reusable workflow.
- **The annotation is not preemption-specific.** It also fires on OOM-kill, node-pressure
  eviction, and a known ARC/JIT-runner race where a *successful* job is flagged as lost because
  the broker health monitor sees the TCP disconnect before the pipeline service records
  completion (actions/runner#4309).

## 3. Decisions

| Decision | Rationale |
|---|---|
| Detect via check-run annotation text match | The job ID doubles as the check-run ID, so annotations are readable via the API. Good enough. |
| Treat OOM-kill and node-pressure eviction as retryable too | Accepted by the team. Means no Kubernetes-side signal is required for v1. |
| Retry the whole run's failed jobs, not individual jobs | `rerun-failed-jobs` is the only available primitive; it preserves already-passing jobs. [†] |
| Retry only if **every** failed job looks like infra | A run containing one real test failure and one preempted job should not be retried — the real failure will just fail again and we burn double the compute. |
| Cap with `run_attempt` | Also serves as the infinite-loop guard, since a re-run emits another `workflow_run: completed`. |
| Orchestrator job runs on GitHub-hosted (or on-demand) runners | The retrier must not itself be preemptible. |

[†] Factually wrong — corrected in §9, "Corrections to the spec". The decision stands; the
rationale does not.

**Out of scope for v1** (documented in §7 as a follow-up): a Kubernetes-side preemption registry
that would make the signal exact rather than heuristic.

## 3.1 Considered and rejected

**Do not reach for step-level retry actions to solve this.** They were evaluated and cannot work,
for a structural reason worth stating explicitly.

| Option | What it does | Verdict |
|---|---|---|
| `nick-fields/retry` | Node action replacing `run`. Spawns the command as a subprocess, polls for the result, respawns on error or timeout up to `max_attempts`. Has `retry_on: any\|timeout\|error`, `retry_on_exit_code`, `on_retry_command`, `new_command_on_retry`. | Rejected |
| `Wandalen/wretry.action` | Resolves a target action's `action.yml`, injects inputs, and re-invokes its `pre`/`main`/`post` stages in-process up to `attempt_limit`. Has a `retry_condition` expression field. | Rejected |
| Duplicated steps with `if: steps.<id>.outcome == 'failure'` | Manual step-level retry using `continue-on-error`. | Rejected |
| Matrix-based re-attempts with `fail-fast: false` | Runs N copies of the job in parallel and takes any success. | Rejected — wastes spot capacity and doesn't distinguish causes |

The first three are all supervisors that live **inside the thing being supervised**. The retry
loop is a process in the runner's process tree on the spot node, and the attempt counter is in
that process's memory. When the node is reclaimed, the kernel takes the runner agent and the
retry loop together — there is no surviving process to notice the failure or act on it. Even if
one somehow survived, the job's lease with GitHub is already broken and the server will not
accept further results for it.

These tools target failure modes where the *retrier outlives the failure* (non-zero exit, network
timeout, flaky test). Preemption inverts that: the retrier dies first. Only a supervisor running
on a different machine, after the run completes, can help — hence the `workflow_run` +
`rerun-failed-jobs` design.

**However**, `nick-fields/retry` is still worth adopting separately, at a different layer. Spot
runners in Kubernetes tend to have flakier egress than GitHub-hosted ones (NAT gateway churn,
registry pulls, DNS). Wrapping package installs and artifact fetches with it will reduce the
overall infra-failure rate, and every failure absorbed in-process is one that never reaches the
rerun orchestrator. Treat it as complementary, not as an alternative.

## 4. Deliverables

### 4.1 Shared reusable workflow

Path: `<org-shared-repo>/.github/workflows/spot-retry-impl.yml`
(e.g. `myorg/.github/.github/workflows/spot-retry-impl.yml` — note the doubled `.github`, that
is correct for the org-default repo.)

```yaml
name: spot-retry-impl

on:
  workflow_call:
    inputs:
      run_id:
        required: true
        type: string
      max_attempts:
        type: number
        default: 3

permissions:
  actions: write   # rerun-failed-jobs
  checks: read     # list annotations

jobs:
  maybe-retry:
    runs-on: ubuntu-latest      # deliberately NOT the spot pool
    steps:
      - uses: actions/github-script@v7
        env:
          RUN_ID: ${{ inputs.run_id }}
          MAX_ATTEMPTS: ${{ inputs.max_attempts }}
        with:
          script: |
            const run_id = Number(process.env.RUN_ID);
            const max    = Number(process.env.MAX_ATTEMPTS);
            const { owner, repo } = context.repo;

            const run = (await github.rest.actions.getWorkflowRun({ owner, repo, run_id })).data;
            if (run.run_attempt >= max) {
              core.notice(`attempt ${run.run_attempt} >= max ${max}; not retrying`);
              return;
            }

            const jobs = await github.paginate(
              github.rest.actions.listJobsForWorkflowRunAttempt,
              { owner, repo, run_id, attempt_number: run.run_attempt, per_page: 100 }
            );

            const failed = jobs.filter(j => j.conclusion === 'failure');
            if (failed.length === 0) {
              core.info('no failed jobs; nothing to do');
              return;
            }

            const LOST = /lost communication with the server/i;

            const verdicts = await Promise.all(failed.map(async (j) => {
              const anns = await github.paginate(
                github.rest.checks.listAnnotations,
                { owner, repo, check_run_id: j.id, per_page: 100 }
              );
              return {
                name: j.name,
                runner: j.runner_name,
                infra: anns.some(a => LOST.test(a.message ?? '')),
              };
            }));

            for (const v of verdicts) {
              core.info(`job="${v.name}" runner="${v.runner}" infra_failure=${v.infra}`);
            }

            if (!verdicts.every(v => v.infra)) {
              core.notice('at least one genuine failure present; not retrying');
              return;
            }

            core.notice(`retrying ${verdicts.length} infra-failed job(s), attempt ${run.run_attempt + 1}`);
            await github.rest.actions.reRunWorkflowFailedJobs({ owner, repo, run_id });
```

### 4.2 Per-repo opt-in caller

Path: `.github/workflows/spot-retry.yml` in each adopting repo. **Must be merged to the default
branch before it takes effect.**

```yaml
name: Spot retry

on:
  workflow_run:
    workflows: ["CI", "Integration Tests"]   # name: values of the workflows to cover
    types: [completed]

permissions:
  actions: write
  checks: read

jobs:
  retry:
    if: github.event.workflow_run.conclusion == 'failure'
    uses: myorg/.github/.github/workflows/spot-retry-impl.yml@v1
    with:
      run_id: ${{ github.event.workflow_run.id }}
      max_attempts: 3
```

Notes for the implementer:
- The `workflows:` list matches on the `name:` field of the target workflow, not the filename.
- If you omit `workflows:` it matches every workflow in the repo **including itself** — add
  `github.event.workflow_run.name != github.workflow` to the `if:` guard if you go that route.
- Declare `permissions` in the caller as well as the reusable workflow. A called workflow can
  only narrow the caller's token scope, never widen it.

### 4.3 Documentation

A short `README` / internal doc for developers covering: how to adopt (copy 4.2, edit the
`workflows:` list, merge to default branch), what gets retried, the attempt cap, and how to tell
from the Actions UI that a retry happened (`run_attempt` > 1).

## 5. Recommended companion change: escalate retries to on-demand

Retrying onto the same spot pool frequently just gets preempted again. `runs-on` accepts
expressions, so adopting workflows can escalate on the second attempt:

```yaml
runs-on: ${{ fromJSON(github.run_attempt) > 1 && 'arc-ondemand' || 'arc-spot' }}
```

`fromJSON` is used because `github.run_attempt` is a string. This requires a second ARC scale set
with an on-demand node pool and the `arc-ondemand` label. Worth landing alongside the retry
mechanism; without it the first retry has the same preemption probability as the original run.

## 6. Acceptance criteria

1. A workflow whose job is killed by deleting its runner pod mid-run is automatically re-run, and
   the re-run's `run_attempt` is 2.
2. A workflow failing on a genuine non-zero exit (e.g. `exit 1`) is **not** re-run.
3. A workflow with one genuine failure *and* one killed runner is **not** re-run.
4. Jobs that passed on attempt 1 are not re-executed on attempt 2.
5. A job that is preempted on every attempt stops after `max_attempts` and does not loop.
6. The orchestrator logs one line per failed job with its name, runner name, and verdict.

## 7. Follow-ups (not v1)

- **Exact preemption signal.** Whatever already consumes interruption notices (Karpenter's
  interruption queue, AWS Node Termination Handler, GCP metadata `preempted`, Azure Scheduled
  Events) can, on node condemnation, list the ARC pods on that node and record
  `{runner_name, timestamp}` into a short-TTL store. `runner_name` is the join key — it appears
  in the jobs API response (`job.runner_name`, already logged above) and in the
  `workflow_job.completed` webhook. Swapping the regex for a registry lookup makes the signal
  authoritative and stops OOM-kills being silently retried.
- **Per-job retry mode.** An opt-in mode that calls `actions/jobs/{job_id}/rerun` for each job
  classified `infra`, rather than `rerun-failed-jobs` for the whole run, so a mixed run recovers its
  infra jobs instead of being declined. Scope it to callers where the results stand alone
  (nightlies), settle the `run_attempt` question above first, and measure how often mixed runs
  actually occur before building it.
- **Zero-YAML variant.** With that registry plus a `workflow_job.completed` webhook receiver, the
  whole thing can run server-side with no per-repo file at all.
- **Cordon on interruption notice.** Larger win than retrying: if nodes are cordoned and tainted
  the moment the notice arrives, no *new* runners land on a doomed node and only in-flight jobs
  are lost. Verify this is configured.
- **`terminationGracePeriodSeconds` ~90–110s** on runner pods lets short jobs finish inside the
  AWS 2-minute notice window. (GCP's ~30s notice is too short to help much.)
- **Instrument the retry rate.** Emit a counter each time the orchestrator fires. A high rate
  means the real fix is spot diversification — more instance types,
  `capacity-optimized-prioritized` allocation — not more reruns.

## 8. Known risks

- The ARC/JIT "lost communication despite success" race (actions/runner#4309) will occasionally
  cause a re-run of a job that actually passed. Cost only, not correctness; the retry-rate metric
  in §7 will surface it if it becomes common.
- Using the job ID as a check-run ID for the annotations endpoint is an undocumented-but-stable
  correspondence. If `checks.listAnnotations` starts 404ing, that's the cause — fall back to
  scanning job logs via `actions.downloadJobLogsForWorkflowRun` for the same string.
- Confirm empirically that a `rerun-failed-jobs` re-run emits a fresh `workflow_run: completed`
  event. The `run_attempt` cap makes the design safe either way, but if re-runs *don't* emit the
  event, attempts beyond the second will never be triggered and the cap is effectively 2.

---

## 9. Implementation notes (added during implementation)

Deltas from the spec above. The spec is unchanged; this section is the diff.

### Corrections to the spec

**`rerun-failed-jobs` is not the only primitive.** Verified 2026-09-16 against the GitHub REST
documentation: `POST /repos/{owner}/{repo}/actions/jobs/{job_id}/rerun` re-runs a single job *and
its dependent jobs*. It backs the "Re-run this job" button in the Actions UI. §3's decisions table
asserts the opposite, and every downstream doc repeated it.

**The decision to re-run the whole run's failed jobs still holds, for a different reason.** Per-job
re-run would let encore re-run only the jobs it classified `infra` and leave a genuine failure
alone. On a merge-gating workflow that buys nothing: the run still ends `failure` because the
genuine job is still failed, the developer pushes a fix, and that push starts a fresh full run
which discards the re-run results. The retry is informational ("was anything else broken behind
those preemptions?"), not unblocking. And in the dominant case — every failed job is infra —
per-job is simply N API calls where `rerun-failed-jobs` is one, for an identical outcome.

**Where per-job would genuinely pay** is a nightly: independent long jobs, results that matter on
their own, and no follow-up push coming to re-run them. If `DST Soak` (180 minutes) is preempted
while `DST Version Skew` genuinely fails, today the soak result is lost until tomorrow.

**Verify before implementing it.** It is undocumented whether a single-job re-run increments
`run_attempt`. encore's only guard against unbounded spend is `run_attempt >= max_attempts`: if N
per-job calls create N attempts the cap trips immediately and "attempt" stops meaning anything; if
they create none, the loop guard disappears. The docs say only that subset re-runs count toward the
50-re-run-per-run limit.

### Naming and layout

The mechanism is called **encore**, and the file names follow:

| Spec | Implemented as |
|---|---|
| `<org>/.github/workflows/spot-retry-impl.yml` | `.github/workflows/retry.yml` in this repo — `uses: lightninglabs/encore/.github/workflows/retry.yml@v1` |
| `.github/workflows/spot-retry.yml` in each repo | `.github/workflows/encore.yml`, copied from `templates/retry.yml` |

There is also a composite action (`uses: lightninglabs/encore@v1`, `templates/retry-action.yml`) for
repos that would rather pin the action than route through a second workflow file.

The logic lives in `src/encore.js` and is inlined into the reusable workflow by
`scripts/build-workflow.mjs`. A called reusable workflow resolves relative `uses: ./…` paths
against the *caller's* repo, so it cannot load an action from the repo it lives in without
hardcoding that repo's slug; inlining keeps the workflow portable and dependency-free. `npm run
verify` fails if the generated copy drifts, and the test suite compiles the inlined copy the way
`actions/github-script` does and runs it against fakes.

### Behaviour beyond the spec

- **Cancelled jobs are examined, not ignored.** The spec filters `conclusion === 'failure'`. A
  preemption that lands as `cancelled` would then produce "no failed jobs" and a silent decline —
  no signal that encore looked and passed. Candidates are now `failure` **and** `cancelled`, and a
  third verdict is introduced so this stays safe:
  - `infra` — matched a pattern. Retryable.
  - `genuine` — failed with no infra evidence. Blocks the whole run, per §3's all-or-nothing rule.
  - `inconclusive` — *cancelled* with no infra evidence. Neither retryable nor blocking, because a
    fail-fast cancellation of a preempted job's sibling says nothing about why the run died, and
    must not veto the retry the preemption earns.

  The caller's gate is widened to match: `templates/retry.yml` fires on
  `conclusion == 'failure' || conclusion == 'cancelled'`. Classifying cancelled *jobs* while the
  *run* gate still excluded cancelled runs left the same silent-decline hole one layer up. It is
  safe for the same reason as above — a human-cancelled run has no infra evidence on any job and
  declines itself — and costs one runner-minute per cancelled run.

  If every candidate is `inconclusive`, the decision is `no_infra_evidence` and it is logged as a
  **warning** naming `extra_patterns`. That is the line to look for when confirming which
  conclusion ARC preemptions actually produce in a given environment — the spec's assumption that
  it is always `failure` is unverified.
- **The pattern list is an input.** `extra_patterns` takes one case-insensitive regex per line,
  added to the built-in `lost communication with the server`. The first team that needs to match a
  different runner-death message configures it instead of forking. This is also the seam where the
  §7 preemption registry lands: swap pattern matching for a registry lookup behind the same input.
- **A rejected rerun is a decision, not a crash.** `rerun-failed-jobs` returns 403/404/409/422
  when the run is no longer re-runnable — someone hit "Re-run all jobs" by hand in the window
  since the status check, or the run has aged out of the retention window. Left unhandled that
  throws, the orchestrator goes red, and developers conclude the retry mechanism is broken. It is
  caught, warned about, and reported as `rerun_rejected`. Other statuses still propagate.
- **A third reason for that rejection, and an opt-in answer to it.** Whether GitHub counts a
  `cancelled` job among the "failed jobs" that `rerun-failed-jobs` re-runs is unconfirmed. If it
  does not, a run whose candidates were all cancelled is refused — and reporting that as "already
  re-run, or aged out" would send someone debugging retention windows for an unrelated problem. So
  when no candidate ended `failure`, the rejection gets its own message naming the actual
  suspicion. The `rerun_all_fallback` input (default off) then falls back to `rerun` — the whole
  run, passed jobs included — for that case only, reporting `retried_all`. Off by default because
  it re-executes work that succeeded; it never fires when any candidate ended `failure`.
- **Bounded work.** Classification runs at most 8 jobs concurrently, so a 60-shard matrix does not
  open 60 paginated annotation reads (or, on the log fallback, 60 concurrent log downloads) at
  once. Only the last 256 KiB of a job log is decoded and scanned — the runner's last words are at
  the end. That bounds the string and the regex, not the download: Octokit has already buffered the
  response by then, and capping it would need a `Range` header or a streamed fetch of the redirect
  target. Concurrency is what keeps those buffers from piling up.
  And because the rule is all-or-nothing, classification stops as soon as one job scores
  `genuine`; the common case is a real test failure, and there is no reason to pay for the rest of
  the matrix. The count of unexamined candidates is logged rather than left implicit.
- **The annotation fallback from §8 is implemented, not deferred.** If `checks.listAnnotations`
  returns 403/404/410 the job log is scanned for the same string, and the verdict records which
  source answered (`annotations`, `logs`, or `unreadable`). Anything unreadable scores as no
  evidence: the expensive mistake is retrying a run that will fail again.
- **`dry_run`.** Logs the verdict and never calls `rerun-failed-jobs`, so a team can watch the
  decisions for a week before spending compute on them.
- **Two attempt fields, not one.** `examined_attempt` is the attempt that was classified,
  `next_attempt` the one that was started (empty when nothing was). One field meaning either
  depending on the decision was a trap for anyone consuming the outputs.
- **A `concurrency` group on the caller.** Keyed on `github.event.workflow_run.id`, so two events
  for the same run cannot both read a pre-retry state and race on the rerun call.
- **Inputs never reach the script as code.** Everything is passed through the environment rather
  than interpolated into the `script:` body.

### Acceptance criteria

All six in §6 have tests naming them in `test/encore.test.js`. Criterion 4 (jobs that passed are
not re-executed) is covered as far as it can be off GitHub: the suite asserts that only failed and
cancelled jobs are ever classified and that `rerun-failed-jobs` — the primitive that preserves
passing jobs — is the call made. The preservation itself is GitHub's behaviour and needs the live
check in §6.

### Still open

- ~~Which conclusion ARC preemption actually produces in this cluster.~~ **Confirmed 2026-08-27**
  against `lightninglabs/lightning-operator` run 33095003459 (`Docker`, ARC RunnerDeployment
  `lightninglabs-runnerdeploy-44c8q-wnl7z`): a reclaimed node produces
  `conclusion=failure`, and the annotation reads

  > The self-hosted runner lost communication with the server. Verify the machine is running and
  > has a healthy network connection. […]

  Note there is **no runner name in the message** — the spec above quotes it as "The self-hosted
  runner: `<name>` lost communication", but the live string omits the name entirely. The built-in
  pattern matches only `lost communication with the server`, so it catches both; a pattern anchored
  on the runner name would have missed every preemption. Do not "tighten" it. The runner name is
  read from `job.runner_name`, which is populated, so the §7 registry join key is unaffected.

  Whether a preemption can *also* land as `cancelled` is still unknown; the `cancelled` handling
  stays as insurance.
- **Whether `rerun-failed-jobs` will re-run a job that ended `cancelled`.** This is the
  load-bearing unknown: if it refuses, every preemption that lands as `cancelled` needs
  `rerun_all_fallback` (a full re-run) to be retried at all, which changes the cost of the whole
  mechanism. The same pod-deletion test answers it — if the job lands `cancelled` and the
  orchestrator logs `No candidate job ended "failure"`, the API refused, and the fallback is the
  only route. It cannot be settled against a mock.
- Whether a `rerun-failed-jobs` re-run emits a fresh `workflow_run: completed` event (§8). If it
  does not, the effective cap is 2 regardless of `max_attempts`.
