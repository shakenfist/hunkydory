# Merging and releasing

How a change reaches `develop`, and how a release decides that a commit
on `develop` is fit to ship. [Testing](testing.md) covers what the checks
themselves run.

## The CI workflows

| Workflow | Runs on | What it does |
|----------|---------|--------------|
| `ci.yml` | Pull requests, merge queue entries, dispatch | The build, unit tests and Biome; the pre-commit hooks; the editor tests; the automated reviewer on pull requests; and the "Can enqueue" and "Can merge" checks the merge queue requires. |
| `secret-scan.yml` | Pull requests, merge queue entries, pushes to `develop`, dispatch | gitleaks over the history. |
| `codeql-analysis.yml` | Pull requests, merge queue entries, pushes, weekly | CodeQL. |
| `release.yml` | A `v*` tag, dispatch | The release, as below. |

On a pull request, `ci.yml`'s jobs skip a change that touches only review
marks, and skip a pull request from a fork altogether. A merge queue entry
skips nothing.

## Merging

Pull requests merge through a merge queue on `develop`, not with the
merge button directly. A pull request can be queued once its "Can
enqueue" check passes. The queue then runs `ci.yml` again on the commit
it is about to merge, and merges only when "Can merge" passes, which
requires every job to have run and succeeded. That second run is the one
a release counts (see below), so a change merged around the queue, by an
administrator bypassing it, cannot be released until a later commit has
gone through the queue.

The queue builds one entry at a time (`max_entries_to_build: 1` in the
`develop` ruleset). The concurrency groups in `ci.yml`,
`secret-scan.yml` and `codeql-analysis.yml` depend on that: a queue run
shares a group with whatever the queue builds next, so that a superseded
run is cancelled. Raising the setting would make each entry cancel the
one ahead of it, so revisit those groups first.

A new job in `ci.yml` goes in the `needs:` of both "Can enqueue" and
"Can merge", or the queue will merge without it.

Enqueueing a fork's pull request is the point at which its code first
runs here. On the pull request itself `ci.yml` skips a fork, but a merge
queue entry is not a pull request event, so the queued commit runs all of
its own code -- workflows, `package-lock.json`, the pre-commit config and
the tests -- on the persistent static runners. Review the whole diff with
that in mind before enqueueing it; changes under `.github/` and `tools/`
deserve the closest reading.

## Releasing

Pushing a `v*` tag triggers `release.yml`. Its first job, `ci-gate`,
checks that `ci.yml` succeeded on the tagged commit in its merge queue
run, and nothing is built or published unless it did. How the gate
decides is documented with the action, as
[`require-ci-success`](https://github.com/shakenfist/actions/blob/main/docs/actions.md#require-ci-success).
It has no override.

So tag the merge commit the queue made, after its `ci.yml` run has
finished. A run started by hand, as `pr-retest.yml` does with
`workflow_dispatch`, does not count, so to recover from a flaky queue
run, use "Re-run jobs" on that merge queue run itself, then re-run
`ci-gate`. A gate failure means nothing was published, so every failure
is recoverable; the template's
[recovery table](https://github.com/shakenfist/development/blob/main/templates/release-automation/README.md#recovering-from-a-gate-failure)
says what to do for each cause.

Running `release.yml` by hand with `workflow_dispatch` skips the gate
and the publishing jobs, and only builds the `.vsix`.

The one-time setup, the jobs after the gate, and how to cut a release
step by step are in
[RELEASE-SETUP.md](https://github.com/shakenfist/hunkydory/blob/develop/RELEASE-SETUP.md).
