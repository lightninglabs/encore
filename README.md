# encore

Re-runs GitHub Actions jobs that were **lost to infrastructure** — spot preemption, OOM-kill,
node-pressure eviction — and leaves genuine failures alone.

Built for self-hosted runners under [Actions Runner Controller][arc] on spot instances. When a
spot node is reclaimed the runner pod is killed mid-job, GitHub marks the job `failure`, and
attaches an annotation reading:

> The self-hosted runner: `<name>` lost communication with the server. Verify the machine is
> running and has a healthy network connection. […]

encore watches for completed runs, reads that annotation, and calls `rerun-failed-jobs` when at
least one failed job was lost that way and none of them looks genuine. Opt in per repo with one file.

## Why it has to work this way

- **There is no native retry key.** GitHub Actions has no `jobs.<id>.retry` or `max-retries`,
  whatever the blog posts say. `continue-on-error`, `timeout-minutes` and `strategy.fail-fast`
  cannot help: the runner process is gone, so nothing inside the job can react.
- **A run cannot re-run itself.** `POST /actions/runs/{run_id}/rerun-failed-jobs` is rejected
  while the run is in progress, so a `needs: […] / if: failure()` job in the same workflow is not
  an option. The retry has to come from a separate run, after completion.
- **`workflow_run` workflows must live on the default branch** and are per-repo — there is no
  org-level `workflow_run`. Hence a tiny per-repo caller plus one shared implementation.

Step-level retry actions (`nick-fields/retry`, `Wandalen/wretry.action`, duplicated steps guarded
on `outcome == 'failure'`, matrix re-attempts) cannot substitute for this, for a structural
reason: they are supervisors living *inside the thing being supervised*. The retry loop is a
process in the runner's process tree on the spot node and the attempt counter is in that process's
memory. When the node goes, the kernel takes the runner agent and the retry loop together, and the
job's lease with GitHub is already broken. They target failures the retrier *outlives*; preemption
inverts that. The full evaluation is in [docs/design.md §3.1](docs/design.md); they are still
worth adopting one layer down, see [Complementary, not alternative](#complementary-not-alternative).

## Install

encore lives at [github.com/lightninglabs/encore](https://github.com/lightninglabs/encore). Pin a
tag — `@v1` below — and pick one of two entry points.

This repo is public, so any caller can reference it as-is — including private repos — with nothing
to configure. (Were it made private, callers in the same org would need a one-time grant here:
Settings → Actions → General → Access → *Accessible from repositories in the `lightninglabs`
organization*.)

### Reusable workflow (recommended)

`.github/workflows/retry.yml` is a `workflow_call` workflow with the logic inlined, so it needs no
checkout and no dependencies:

```yaml
uses: lightninglabs/encore/.github/workflows/retry.yml@v1
```

If you would rather serve it from your org-default repo, copy that one file to
`myorg/.github/.github/workflows/retry.yml` — the doubled `.github` is correct there — and point
callers at that path instead. Copy it, don't hand-edit it: it is generated from `src/encore.js`
(see [Development](#development)).

### Composite action

`uses: lightninglabs/encore@v1` inside a job you write yourself. Same logic, more control over the
surrounding job.

## Adopt in a repo

1. Copy [`templates/retry.yml`](templates/retry.yml) to `.github/workflows/encore.yml` (or
   [`templates/retry-action.yml`](templates/retry-action.yml) for the action form).
2. Pin `@v1` to the ref you want. If your Actions policy requires immutable references, use a full
   commit SHA instead — `…/retry.yml@<sha>` — and bump it by hand.
3. Edit the `workflows:` list. These are the **`name:` values** of the workflows to cover, not
   filenames. Omitting the list matches every workflow in the repo *including this one*; if you go
   that route add `github.event.workflow_run.name != github.workflow` to the `if:` guard.
4. **Merge it to the default branch.** `workflow_run` triggers are only honoured there. Nothing
   happens while the file sits on a feature branch.

```yaml
name: encore

on:
  workflow_run:
    workflows: ["CI", "Integration Tests"]
    types: [completed]

permissions:
  actions: write   # rerun-failed-jobs
  checks: read     # list annotations

concurrency:
  group: encore-${{ github.event.workflow_run.id }}
  cancel-in-progress: false

jobs:
  retry:
    if: >-
      github.event.workflow_run.conclusion == 'failure' ||
      github.event.workflow_run.conclusion == 'cancelled'
    uses: lightninglabs/encore/.github/workflows/retry.yml@v1
    with:
      run_id: ${{ github.event.workflow_run.id }}
      max_attempts: 3
```

Cancelled runs are in the gate as well as failed ones: a preemption does not always land as
`failure`, and a run encore never sees is a hole it cannot report on. That is safe because a
human-cancelled run carries no infra evidence on any job and declines itself as
`no_infra_evidence` — it costs a runner-minute per cancelled run to close the hole.

Declare `permissions` in the caller as well as the implementation: a called workflow can only
narrow the caller's token scope, never widen it. If your org pins `GITHUB_TOKEN` to read-only and
you cannot grant `actions: write`, pass a PAT as the optional `token` secret.

Roll out with `dry_run: true` first if you want to watch the verdicts before spending any compute
on re-runs.

## Inputs

| Input | Default | |
|---|---|---|
| `run_id` | — | The completed run to examine. Required. |
| `max_attempts` | `3` | Total attempts, not extra ones: `3` is the original run plus two retries. |
| `dry_run` | `false` | Classify and log, never re-run. |
| `extra_patterns` | `''` | Extra case-insensitive regexes, one per line, that also mark a job as infrastructure. Matched against the job's annotations, and — for a job that *failed* — its log. Blank lines and `#` comments ignored. |
| `rerun_all_fallback` | `false` | If `rerun-failed-jobs` is refused because no candidate ended `failure`, re-run the whole run instead — passed jobs included. See [Cancelled jobs and re-runnability](#cancelled-jobs-and-re-runnability). |
| `token` (secret) / `github_token` (action) | `GITHUB_TOKEN` | Needs `actions: write` and `checks: read`. |

Outputs: `decision`, `retried`, `examined_attempt`, `next_attempt`, and — on the action —
`candidate_jobs`, `infra_jobs`.

## What gets retried

Candidates are the jobs of the finished attempt that ended `failure` or `cancelled`. Each gets one
of three verdicts:

| Verdict | Meaning | Effect |
|---|---|---|
| `infra` | Matched `lost communication with the server`, or one of your `extra_patterns` | Retryable |
| `genuine` | **Failed** with no infra evidence | Blocks the whole run |
| `inconclusive` | **Cancelled** with no infra evidence | Neither — see below |

The run is re-run when at least one candidate is `infra` and none is `genuine`:

| `decision` | |
|---|---|
| `retried` | `rerun-failed-jobs` accepted. `next_attempt` is the attempt that started. |
| `retried_all` | `rerun_all_fallback` fired: the whole run was re-run, passed jobs included. |
| `genuine_failure` | At least one real failure. Retrying would fail identically at double the compute. |
| `no_infra_evidence` | Every candidate was an unexplained cancellation. Logged as a **warning** — see below. |
| `no_candidate_jobs` | Nothing failed or was cancelled in the attempt. |
| `attempt_cap` | `run_attempt` has reached `max_attempts`. |
| `rerun_rejected` | GitHub refused the re-run — already re-run by hand, aged out of the retention window, or no failed job to re-run. Warned, not failed. |
| `run_incomplete` | The run is not `completed`, so it is not re-runnable. |

### Annotations first, then the log

Annotations are checked first: they are one cheap call and the preemption signature lands there
verbatim. But they are a summary of the job, not its output. A step that exits nonzero annotates
`Process completed with exit code 2.` and nothing else, so a signature that only ever appears in
step output — a registry flake, an OOM line — is invisible there.

That matters because of the all-or-nothing rule. A job called `genuine` on the strength of
`exit code 2` withdraws the retry every preempted job in the same run had earned. So before a
**failed** job is called genuine, its log is downloaded and matched too. One extra call, on the
path that was about to decline anyway.

Cancelled jobs are deliberately left out of this. A fail-fast sibling's log is full of the
cancellation text that `extra_patterns` most often carries, and reading it back would let the
cancellation argue for a retry it is supposed to be neutral about.

Up to 8 MiB of each log is scanned. If a log is larger, the budget is split between its head and
its tail and the middle is dropped — the runner's last words are at the end, but a flake is
printed wherever the step died, which in a 12 MB integration-test log was 120 KB in.

Cancellations are deliberately neutral. `fail-fast` cancels the siblings of a preempted job, and
those cancellations say nothing about why the run died — so they must not veto the retry the
preemption earns, and must not cause one on their own. But a cancelled job *is* examined, and if
every candidate is an unexplained cancellation you get a warning rather than silence:

```
Warning: 2 cancelled job(s) with no infra evidence; not retrying. If preemptions land as
cancelled in this environment, add the message they carry to the extra_patterns input.
```

That is the line to look for when you confirm which conclusion your ARC preemptions actually
produce — it varies, and the cancelled variant tends to carry `The operation was canceled` rather
than the lost-communication string. If that is what you see, add it:

```yaml
with:
  extra_patterns: |
    the operation was canceled
    the runner has received a shutdown signal
```

OOM-kill and node-pressure eviction produce the same annotation as preemption and are therefore
retried too. That is an accepted trade for v1 — it is what lets this work with no
Kubernetes-side signal. The [exact-signal follow-up](#follow-ups) removes it.

Only the candidates of the attempt that just finished are examined, and `rerun-failed-jobs` is the
primitive that re-runs them: jobs that already passed are preserved, not re-executed.

## Bounds

- At most **8 jobs are classified concurrently**, so a 60-shard matrix does not open 60 paginated
  API reads at once.
- Classification **stops at the first `genuine` verdict** — the answer cannot change after that,
  and a real test failure is the common case. The number of unexamined candidates is logged.
- On the log fallback, only the **last 256 KiB** of a job log is decoded and scanned. The runner's
  last words are at the end; a message buried megabytes above it is out of scope. Note this bounds
  the string and the regex, *not* the download — Octokit has already buffered the whole response
  by then. Capping that needs a `Range` header or a streamed fetch of the redirect target;
  concurrency is what keeps the buffers from piling up meanwhile.

## The attempt cap

`max_attempts` (default 3) is compared against `run_attempt`, so it counts total attempts, not
extra ones. It is also the infinite-loop guard — a re-run emits another `workflow_run: completed`
event, which lands right back here, and the cap is what stops that recurring.

## Seeing it happen

- In the Actions UI a retried run shows an **attempt selector** at the top and `Attempt #2` in its
  URL. `run_attempt > 1` on a run nobody re-ran by hand means encore fired.
- The orchestrator's own run logs the decision. One line per examined job:

  ```
  run 1234567890 "CI" status=completed conclusion=failure attempt=1 max_attempts=3
  job="build (amd64)" conclusion=failure runner="arc-spot-fp6zx" verdict=infra source=annotations
  job="unit-tests" conclusion=failure runner="arc-spot-k29jd" verdict=genuine source=annotations
  Notice: 1 of 2 candidate job(s) look genuine (unit-tests); not retrying
  ```

  `source` says where the verdict came from: `annotations` if they settled it, `logs` if the
  evidence was in the job log, `annotations+logs` if both were read and neither matched, and
  `unreadable` if nothing could be read.

## Companion change: escalate retries to on-demand

Retrying onto the same spot pool often just gets preempted again. `runs-on` takes expressions, so
adopting workflows can escalate on the second attempt:

```yaml
runs-on: ${{ fromJSON(github.run_attempt) > 1 && 'arc-ondemand' || 'arc-spot' }}
```

`fromJSON` because `github.run_attempt` is a string. This needs a second ARC scale set on an
on-demand node pool with the `arc-ondemand` label. Worth landing alongside encore — without it the
first retry has exactly the same preemption probability as the original run.

## Complementary, not alternative

`nick-fields/retry` is still worth adopting, at a different layer. Spot runners in Kubernetes have
flakier egress than GitHub-hosted ones (NAT gateway churn, registry pulls, DNS). Wrapping package
installs and artifact fetches with it lowers the overall infra-failure rate, and every failure
absorbed in-process is one that never reaches encore.

## Known limits

- **Detection is a text match, not a signal.** Anything producing the "lost communication"
  annotation is treated as retryable, including OOM-kills. `extra_patterns` widens it; only the
  registry in [Follow-ups](#follow-ups) makes it exact.
- **The ARC/JIT success race.** [actions/runner#4309][race]: the broker health monitor can see the
  TCP disconnect before the pipeline service records completion, flagging a job that *passed* as
  lost. encore will occasionally re-run such a job. Cost only, not correctness.
- **Job id as check-run id.** The annotations endpoint is reached with the job id, an
  undocumented-but-stable correspondence. If it breaks, `checks.listAnnotations` starts 404ing;
  encore warns and classifies from the job log alone (`source=logs`).
- **The log scan has a middle it cannot see.** Both ends of an oversized log are scanned, but a
  signature more than 4 MiB from either end is missed. Raising `MAX_LOG_BYTES` is the lever; it
  is bounded because Octokit buffers the whole log before encore sees it.
- **Whether a cancelled job is re-runnable at all.** `rerun-failed-jobs` may refuse a run whose
  only candidates ended `cancelled`, on the grounds that it has no failed jobs. encore reports
  that case with its own message rather than blaming the retention window, and
  `rerun_all_fallback` covers it — see below. Unconfirmed against the live API.
- **Whether re-runs re-trigger `workflow_run` is worth confirming empirically** in your org. The
  `run_attempt` cap makes the design safe either way, but if re-runs do not emit the event then
  attempts beyond the second never fire and the effective cap is 2.

## Cancelled jobs and re-runnability

Classifying `cancelled` jobs is only half the job: something then has to re-run them.
`rerun-failed-jobs` is the primitive the design calls for, and whether GitHub considers a
*cancelled* job one of the "failed jobs" it re-runs is **not confirmed**. If it refuses a run whose
candidates were all cancelled, encore says exactly that:

```
Warning: rerun-failed-jobs was rejected for run 42 (HTTP 403: …). No candidate job ended
"failure" — every one was cancelled — so this run may have no failed jobs for GitHub to re-run
at all. That is not the same as the run being expired or already re-run: see the
rerun_all_fallback input.
```

To check on your own installation: kill a runner pod mid-job, watch which conclusion the job lands
with, and read the orchestrator's log. If cancelled-only runs are refused, set:

```yaml
with:
  rerun_all_fallback: true
```

That falls back to `rerun` (the whole run) for that case only, which **re-executes jobs that
passed** — more expensive, but it does start an attempt when GitHub sees no failed job to re-run.
It is off by default, never fires when any candidate ended `failure`, and reports `retried_all`
when it does. (Re-running those cancelled jobs individually via `actions/jobs/{job_id}/rerun` may
also work and would be cheaper; untested, and this path has never fired.)

## Follow-ups

- **Exact preemption signal.** Whatever already consumes interruption notices (Karpenter's
  interruption queue, AWS Node Termination Handler, GCP metadata `preempted`, Azure Scheduled
  Events) can, on node condemnation, list the ARC pods on that node and record
  `{runner_name, timestamp}` in a short-TTL store. `runner_name` is the join key — it is in the
  jobs API response and in the `workflow_job.completed` webhook, and encore already logs it.
  Swapping pattern matching for a registry lookup makes the signal authoritative and stops
  OOM-kills being retried silently.
- **Zero-YAML variant.** With that registry plus a `workflow_job.completed` webhook receiver, this
  can run server-side with no per-repo file at all.
- **Cordon on interruption notice.** A bigger win than retrying: cordon and taint the node the
  moment the notice arrives and no *new* runners land on a doomed node. Verify it is configured.
- **`terminationGracePeriodSeconds` ≈ 90–110s** on runner pods lets short jobs finish inside the
  AWS two-minute notice window. GCP's ~30s notice is too short to help much.
- **Instrument the retry rate.** A counter per firing. A high rate means the real fix is spot
  diversification — more instance types, `capacity-optimized-prioritized` allocation — not more
  re-runs.

## Development

```
src/encore.js                    the logic; zero dependencies
action.yml                       composite action — requires src/encore.js
templates/retry.yml.tmpl         template for the reusable workflow
scripts/build-workflow.mjs       inlines src/encore.js into the workflow
.github/workflows/retry.yml      GENERATED — run `npm run build`
templates/retry.yml              per-repo caller, for adopters to copy
templates/retry-action.yml       same, via the composite action
docs/design.md                   design record: the original spec + what changed
test/                            node:test suite, no install needed
```

```sh
npm test          # run the suite
npm run build     # regenerate .github/workflows/retry.yml
npm run verify    # fail if the generated workflow is stale (also a CI step)
```

The reusable workflow inlines the logic rather than `uses:`-ing the action because a called
reusable workflow resolves relative `uses: ./…` paths against the *caller's* repo — it cannot load
an action from the repo it lives in without hardcoding that repo's slug. Inlining keeps the file
portable to any org and dependency-free. `src/encore.js` stays the single source of truth;
`npm run verify` fails if the copy drifts, and the suite compiles the inlined copy the same way
`actions/github-script` does and runs it against fakes, so both distribution paths are covered by
the same tests.

Every acceptance criterion in [docs/design.md §6](docs/design.md) has a test naming it in
`test/encore.test.js`.

[arc]: https://github.com/actions/actions-runner-controller
[race]: https://github.com/actions/runner/issues/4309
