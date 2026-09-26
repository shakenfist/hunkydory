Thanks for your work on this. I appreciate it. Some final
checks before I push.

## How to use this runbook

Hunky Dory is a VS Code extension with no runtime dependencies. It has no
server and holds no data of its own, but it runs inside the editor with
access to whatever the user has open, and it is meant to be installed by
people who are not us — so a defect here either corrupts someone's patch
file silently (see AGENTS.md's "thing that will catch you out") or ships
broken code to the Marketplace. The briefs below are written for that
blast radius.

The audit splits into two waves:

**Wave 1 -- mechanical.** `pre-commit run --all-files`, then the
grep-level checks on the diff. Always run wave 1 first; wave 2 is only
worth spending on if wave 1 passes.

**Wave 2 -- judgment.** Four independent sub-agents that read code and
apply judgment. They can be spawned in parallel.

The management session reviews all findings, fixes any issues, and
confirms the push.

The default branch is `develop`, not `main`, so every diff command below
is against `develop...HEAD`.

## Wave 1: Mechanical checks

```
pre-commit run --all-files
```

That one command is `tools/check-node.sh check` (build with `tsc`, unit
tests with `node --test`, and `biome check`), plus shellcheck over
`tools/`, gitleaks, and skillsaw. There is no CI workflow yet, so this
local run is the only gate a pull request gets until that lands.

Then, separately, the corpus regression (not part of `pre-commit` because
it depends on a sibling checkout that will not exist on every machine —
see the note in `docs/index.md`'s neighbour `test/corpus.ts`):

```bash
HUNKYDORY_CORPUS=/path/to/kerbside-patches/_patches npm run corpus
```

Skip this only if you have no such checkout to hand; say so explicitly
rather than silently omitting it, since it is what would have caught most
regressions in `diff.ts` historically.

Then the grep-level checks on the diff:

```bash
# Lines over 100 characters in new TypeScript -- Biome already enforces
# this at commit time, so a hit here means pre-commit was bypassed or the
# line is inside a string/comment Biome does not rewrap
git diff develop...HEAD -- '*.ts' | grep -nE '^\+[^+].{100,}'

# A new runtime dependency. Hunky Dory has none by design (D2 in the
# fleet's TypeScript onboarding plan): everything it needs is either a
# devDependency (typescript, @biomejs/biome, @types/*) or provided by the
# extension host (vscode) or node itself
git diff develop...HEAD -- package.json | grep -nE '^\+\s*"dependencies"'

# TODO / FIXME / HACK / XXX, and new lint suppressions
git diff develop...HEAD -- '*.ts' | grep -nE '^\+.*\b(TODO|FIXME|HACK|XXX)\b'
git diff develop...HEAD -- '*.ts' | grep -nE '^\+.*(biome-ignore|@ts-ignore|@ts-expect-error)'

# A relative link added to README.md, or one in docs/ that leaves docs/.
# Both must be absolute https://github.com/shakenfist/hunkydory/blob/develop/...
# URLs -- see the readme-absolute-links and docs-external-links criteria
git diff develop...HEAD -- README.md docs/ | grep -nP '^\+.*\]\((?!https?://|#)[^)]+\)'

# Build output or the packaged extension staged by mistake. out/,
# node_modules/ and *.vsix are gitignored; a hit here means something
# was force-added
git diff develop...HEAD --name-only -- out/ node_modules/ '*.vsix'

# Documentation touched at all (warns if none)
git diff develop...HEAD --name-only -- 'docs/*' '*.md'
```

Exit condition: wave 1 passes when `pre-commit` and the corpus check are
clean and each grep has either no hits or hits the management session has
looked at and accepted. The greps report; they do not block.

## Wave 2: Deeper review

Only run wave 2 after wave 1 passes.

### 2a. Code quality

| Setting | Value |
|---------|-------|
| Model | sonnet |
| Effort | medium |

**Brief for sub-agent:**

The mechanical sweep has already extracted TODO/FIXME comments, new lint
suppressions, and any new runtime dependency. Take that report as input,
and triage each: blocking or advisory, and why.

Then the judgment-level review of `git diff develop...HEAD`:

- **The vscode-free boundary.** `src/diff.ts` and `src/recount.ts` must
  never import `vscode` — that is what lets the test suite and the
  corpus check run under plain node. A change that leaks the editor API
  into either file, even transitively through a new import, is a
  regression in the thing that makes this codebase testable at all.
- **The minimal-edit invariant.** `computeFixes` returns only the header
  lines that disagree with their bodies, not a rewritten document. A
  change that widens what gets replaced reintroduces the cursor-jumping
  and undo-granularity problems `ARCHITECTURE.md` explains that split
  exists to avoid.
- **The safe-direction-under-ambiguity invariant.** Per
  `docs/ambiguity.md`, an unresolvable count must round up, never down —
  over-counting fails loudly in git, under-counting silently truncates a
  hunk. Any change to `resolveCounts` or its callers should be checked
  against that direction explicitly, not just against the corpus (a
  corpus of currently-correct patches cannot exercise every ambiguous
  case).
- **Biome and TypeScript strictness.** `strict`, `noUnusedLocals`,
  `noUnusedParameters` and `noImplicitReturns` are on in `tsconfig.json`
  and are not to be loosened to make something compile; the same goes
  for narrowing a Biome rule in `biome.json` to silence a real finding
  rather than fixing it.
- **`tools/check-node.sh` is the single source of truth** for build,
  test and lint, called from `pre-commit` today and from CI once that
  workflow exists. A fix applied to one caller instead of the script
  itself is the drift this file exists to prevent.
- **Packaging hygiene.** `.vscodeignore` excludes `src/`, `test/` and
  `docs/` from the published `.vsix`; a new top-level directory that
  should ship (or should not) needs a matching line there.

<!-- shared-block: comment-proportion v1 -->
Comment proportion (shared block; do not edit -- the canonical
copy lives in shakenfist/development at
`templates/shared-blocks/comment-proportion.md`):

- A comment or docstring earns its length by saying what the code
  cannot: the contract, the units, the failure modes, the reason a
  surprising choice is correct. Restating the code in prose is not
  documentation.
- Treat as candidates any added comment or docstring that is longer
  than the code it documents, and any comment block over roughly
  fifteen lines attached to a body under ten. These are candidates,
  not verdicts -- a subtle algorithm, a public API contract, or a
  hard-won bug explanation can justify the length.
- Where the length is not justified the finding is advisory, and
  the fix is to cut the restatement rather than delete the comment:
  keep the why, drop the line-by-line narration of the what.
- Prose that documents user-visible behaviour rather than the
  implementation usually belongs in `docs/`, with the comment
  reduced to a pointer.
<!-- shared-block-end -->

<!-- shared-block: source-file-size v1 -->
Source file size (shared block; do not edit -- the canonical
copy lives in shakenfist/development at
`templates/shared-blocks/source-file-size.md`):

- Where a repository tracks whole-file human review, a file's cost
  is its length times how often it is touched: every change
  discards the review of the whole file, and the next session
  re-reads all of it. That, rather than taste, is why length is
  worth raising in review at all.
- Treat a source file over roughly 800 lines as a candidate to
  split, and one over roughly 1,500 as wanting a stated reason to
  stay whole. These hold whether or not a repository tracks review
  per file: tracking is what makes the cost repeat and become
  measurable, not what makes a long file expensive to read. Both
  are advisory. Neither is a gate, there is no hard cap, and a
  reviewer who raises one is opening a question, not recording a
  defect.
- Generated files, vendored trees and protocol or data tables are
  exempt: they are not read the way source is, and a tool that
  counts them is measuring the wrong thing.
- Split along a seam that already exists -- one module's public
  entry point, one check, one subcommand, one endpoint -- so that
  a later change touches one of the pieces rather than all of
  them. A file split at a line number rather than at a seam is
  worse than the long file it replaced.
- Length is never reduced by deleting the comments and docstrings
  that explain why the code is the way it is. Those are what make
  a long file reviewable, and trading them for a line count makes
  the review worse while making the number better. Cut duplicated
  scaffolding first; see `comment-proportion` for what earns its
  length.
<!-- shared-block-end -->

<!-- shared-block: plan-references-in-code v1 -->
Plan references in code (shared block; do not edit -- the
canonical copy lives in shakenfist/development at
`templates/shared-blocks/plan-references-in-code.md`):

- Code, comments, docstrings, test names, fixture descriptions and
  configuration describe the software as it is now. Which plan,
  phase, step or decision produced a line is history, and the plan
  and the commit log already keep it. Do not write "added in phase
  5", "per decision 3", "pending step 5f" or "the phase-4 leaks
  pass": a reader of the code has not read the plan, and the
  number tells them nothing.
- Where a comment cites a plan to explain why the code is the way
  it is, the explanation belongs in the comment. Write the reason
  -- the constraint, the measurement, the failure it prevents --
  and drop the citation. A pointer standing in for the reasoning
  costs every reader a detour, and rots when the plan is archived
  or renumbered.
- A plan link is acceptable only for work that is not built yet: a
  deliberate gap or refusal whose lifting is planned, where
  "deferred; see `PLAN-foo.md`" tells the reader the gap is known.
  The link comes out when the work lands. Prefer an issue link
  where one exists, and write a plan in another repository as an
  absolute URL; the `plan-source-references` audit checks that
  these links resolve.
- Plan documents and commit messages may cite phases and decisions
  freely; recording that history is their job.
- "Phase" in its ordinary sense -- a two-phase commit, a compiler's
  link phase -- is not a plan reference.
- A plan reference a diff adds to code is a finding to fix before
  pushing. References on lines the diff does not touch are backlog,
  not findings against the change.
<!-- shared-block-end -->

<!-- shared-block: python-version-discipline v1 -->
Python version and typing (shared block; do not edit -- the
canonical copy lives in shakenfist/development at
`templates/shared-blocks/python-version-discipline.md`):

- No syntax or standard library API newer than the floor in
  `requires-python`. Structural pattern matching, `X | Y` unions in
  annotations evaluated at runtime, `tomllib`, and
  `datetime.UTC` each raise on an interpreter the package still
  claims to support, and none of them fail in CI when CI runs only
  the newest version. This is the finding to look for first: it is
  a real break on a real user's machine, not a style point.
- New and modified code carries type hints, and mypy is expected to
  be clean over it. A project part way through a staged rollout is
  held to the new code, not to the whole tree.
- Prefer the walrus operator and f-strings where they make the code
  read better, subject to the floor above.
- Raising the floor in `requires-python` is a supported-platforms
  decision, not a convenience: it drops users. If it is genuinely
  right, the platforms table, `requires-python` and
  `constraints.python` in `renovate.json` all move together.
<!-- shared-block-end -->

This repository has no `pyproject.toml` and this block is not applicable
to it -- it is embedded verbatim because the `push-audit` criterion
requires all of the fleet's current shared blocks regardless of
language. hunkydory's own equivalent, for what actually applies here:

- No syntax or standard library API newer than what node 20 (this
  project's floor per `engines.node` in `package.json`) supports.
- New and modified code carries explicit types where `strict` does not
  already infer them usefully; `tsc -p .` is expected to be clean, and
  it runs as part of `npm test` and `npm run build` so this is enforced
  rather than aspirational.
- Raising the node floor is a supported-platforms decision: it should
  move `engines.node`, `@types/node`'s major version, and this note
  together, with a stated reason, not as a side effect of an unrelated
  change.

Report findings as a bullet list. For each, state the file, line, and
whether it is blocking or advisory.

### 2b. Test review

| Setting | Value |
|---------|-------|
| Model | sonnet |
| Effort | medium |

**Brief for sub-agent:**

Review `git diff develop...HEAD` for test coverage. The suites are
`test/recount.test.ts` (`node --test`, exercised by `npm test`) and
`test/corpus.ts` (`npm run corpus`), the round-trip regression against a
directory of real patches described in `AGENTS.md`.

- Does a change to counting behaviour in `src/diff.ts` or
  `src/recount.ts` add a unit test case, not just rely on the corpus
  happening to contain an example?
- Does a new unit test build its patch fixture as a git-generated
  oracle (per `README.md`'s "Correctness" section) or scramble a known
  header, rather than asserting against a hand-typed expected string
  that could itself be wrong?
- `src/extension.ts` has almost no unit test coverage by design —
  `ARCHITECTURE.md` says the vscode-facing layer "has almost no
  branching worth testing" because the interesting logic is pushed into
  the two pure modules. A change that adds real branching to
  `extension.ts` (a new mode, a new condition on when to recount) is
  the point to question that premise, not to wave it through
  unreviewed.
- Was `npm run corpus` actually run against a real patch set for this
  change, per the wave 1 checklist, and not merely `npm test`? The
  corpus is what has historically caught edge cases reasoning did not.

<!-- shared-block: functional-test-coverage v1 -->
Functional test coverage (shared block; do not edit -- the
canonical copy lives in shakenfist/development at
`templates/shared-blocks/functional-test-coverage.md`):

- The standard is "do we run the code to do the real thing, and
  does it work as intended". Every subcommand exposed on the command
  line, and every endpoint exposed by an API, should have a test
  that exercises it for real rather than against a mock of itself.
- For a change that adds or alters user-visible behaviour, the
  question to answer is which functional test would have failed
  before it and passes after. If there is none, that is the finding,
  and it is a finding about this change rather than a note for
  later.
- Unit tests are held to no coverage percentage, but a branch that
  is reachable from outside the process and has no test is worth
  naming. Error paths and argument validation are where this bites:
  they are the code most often written once and never run again.
- Mocking the system under test proves nothing. Mock the boundary --
  the network, the clock, the hypervisor -- and let the code being
  tested actually run.
- Where a gap is real but out of scope for the change in hand, say
  so plainly and record it, rather than silently widening the
  change or silently leaving it unsaid.
<!-- shared-block-end -->

Report findings as a bullet list grouped by file.

### 2c. Documentation review

| Setting | Value |
|---------|-------|
| Model | sonnet |
| Effort | medium |

**Brief for sub-agent:**

Check that documentation matches the current code state. Read
`git diff develop...HEAD` and verify:

<!-- shared-block: readme-discipline v1 -->
README discipline (shared block; do not edit -- the canonical
copy lives in shakenfist/development at
`templates/shared-blocks/readme-discipline.md`):

- New user-visible features are documented in `docs/` (and
  `ARCHITECTURE.md` / `AGENTS.md` where appropriate), not by
  adding bullets to `README.md`.
- `README.md` is a pitch: what the project is, who it is for,
  minimal installation instructions, a small number of usage
  examples, and curated absolute links into `docs/`. It only
  changes when the pitch, the install story, or the
  documentation links change.
- README growth is itself a finding: if the diff adds README
  content that belongs in `docs/`, flag it as blocking and
  move it.
<!-- shared-block-end -->

<!-- shared-block: llm-doc-discipline v1 -->
AGENTS.md and ARCHITECTURE.md discipline (shared block; do not
edit -- the canonical copy lives in shakenfist/development at
`templates/shared-blocks/llm-doc-discipline.md`):

- `AGENTS.md` is a working guide: the conventions, invariants and
  gotchas an agent cannot infer by reading the code, plus curated
  links into `docs/`. It is loaded into every session, so every
  line costs context on every task.
- `ARCHITECTURE.md` is a map: the component inventory, how data
  moves between components, and why the shape is the way it is.
  A deep dive on one subsystem belongs in `docs/`, where humans
  benefit from it too.
- One canonical home per fact. If `docs/` covers it, link to it
  instead of restating it -- and the same rule applies between
  `AGENTS.md` and `ARCHITECTURE.md`.
- Neither file is a reference manual, a runbook, or a changelog.
  CLI flags, configuration keys, wire protocols, step-by-step
  procedures and plan history go to `docs/`.
- Growth in either file is itself a finding: if the diff adds
  content that belongs in `docs/`, flag it as blocking and move
  it.
<!-- shared-block-end -->

<!-- shared-block: diagram-discipline v1 -->
Diagram discipline (shared block; do not edit -- the canonical
copy lives in shakenfist/development at
`templates/shared-blocks/diagram-discipline.md`):

- A diagram of *structure or flow* -- components and the arrows
  between them, an ordered exchange of messages, a state machine
  -- is written as a fenced `mermaid` block, not drawn in ASCII.
  GitHub renders those natively and the mkdocs sites render them
  through `pymdownx.superfences`, so the same source is a picture
  in both places.
- Not every box of characters is a diagram. These stay as plain
  code fences, because mermaid cannot express them and would lose
  what they show: directory and file trees; memory maps, address
  space layouts and register or bit-field diagrams, where column
  alignment carries the meaning; wire-format and on-disk byte
  layouts; captured terminal output; and tables. The test is
  whether the picture is nodes and edges. Something that is a
  table with lines drawn on it is a table.
- Pick the diagram type that matches the claim: `flowchart` for
  components and data flow, `sequenceDiagram` for an ordered
  exchange between parties, `stateDiagram-v2` for a state
  machine, `erDiagram` for data relationships. A sequence drawn
  as a flowchart has thrown away the ordering it existed to show.
- A new ASCII box-and-arrow diagram in the diff is a finding.
  Converting one the diff already touches is in scope; converting
  every other diagram in the file is not, because a sweep is its
  own change and its own review.
<!-- shared-block-end -->

- In this project, the structure that reaches `ARCHITECTURE.md` is the
  module split (`diff.ts` / `recount.ts` / `extension.ts`) and the data
  flow between them; the conventions that reach `AGENTS.md` are the
  vscode-free boundary, the formatting rule, and the counting gotchas.
  Neither is the place for a full explanation of a single rule — that
  belongs in `docs/hunk-format.md` or `docs/ambiguity.md`, linked from
  wherever it is mentioned.
- Every link in `README.md` is absolute
  (`https://github.com/shakenfist/hunkydory/blob/develop/...`), and
  every link inside `docs/` either stays inside `docs/` or is also
  absolute — the `readme-absolute-links` and `docs-external-links`
  consistency-audit criteria enforce this fleet-wide, and a relative
  link added by this diff will fail them on the next daily run.

<!-- shared-block: plan-phase-references v1 -->
Plan phase references (shared block; do not edit -- the canonical
copy lives in shakenfist/development at
`templates/shared-blocks/plan-phase-references.md`):

- Documentation outside plans directories describes the current
  state of the software, not the history of how it was built. Do
  not write "implemented in phase 5" or "since phase 3 of the
  two-tier CI plan": a reader wants to know whether a feature
  exists, not which phase of which plan delivered it.
- If a documented behaviour is implemented, describe it plainly.
  If it is planned but not yet implemented, link to the master
  plan in `docs/plans/` instead of citing a phase number.
- Reserve the word "phase" for plan documents. A procedural
  document describing a live multi-stage process (a release
  runbook, say) should call its stages "steps" or "stages", so
  that a phase reference in `docs/` is always a plan smell.
- The consistency audit greps `README.md` and `docs/` (excluding
  plans directories) for "phase <number>". Append
  `<!-- audit-ok: phase-reference -->` to a line only when the
  reference is genuinely not about an implementation plan.
<!-- shared-block-end -->

- Hunky Dory has no `docs/plans/` of its own; its plan lives in
  `shakenfist/development`'s `docs/plans/PLAN-typescript-onboarding.md`.
  Do not write "phase 2" or similar into this repository's own `docs/`,
  `README.md`, `AGENTS.md` or `ARCHITECTURE.md` — describe the current
  state plainly and link to the plan in the other repository if history
  matters.

Report findings as a bullet list. "No documentation gaps found" is a
valid answer.

### 2d. Security review

| Setting | Value |
|---------|-------|
| Model | opus |
| Effort | high |

**Brief for sub-agent:**

Security review of `git diff develop...HEAD`. Read the actual code, not
just the diff summary.

The threat model here is specific to a published editor extension: this
repository has no server and holds no data of its own, but once
installed it runs inside every window the user has of every workspace,
activated on `onLanguage:diff`, and it is meant to be installed by
strangers off the Marketplace.

- **Activation scope.** Does the diff widen `activationEvents` beyond
  what the feature needs? A broader activation event runs this code in
  more windows than necessary, which matters more for an extension with
  no sandboxing than it would for a script invoked deliberately.
- **Regular expressions over untrusted input.** `HUNK_RE` and the other
  patterns in `src/diff.ts` run against the contents of whatever file
  the user has open, which the extension does not control. A new or
  modified regex should be checked for catastrophic backtracking
  (nested quantifiers over the same character class) rather than
  assumed safe because the existing ones are.
- **Scope of edits.** `applyFixes` and the `WorkspaceEdit` machinery in
  `src/extension.ts` should touch only the header lines `computeFixes`
  identified. A change that widens the edited range, or that starts
  writing to a document other than the one being recounted, is a
  critical finding — it is the difference between "wrong header" and
  "silently rewrote the user's file".
- **Supply chain.** Hunky Dory has zero runtime dependencies by design.
  A new *devDependency* still runs at build or test time with the
  developer's privileges via `npm install` lifecycle scripts; check
  whether it is actually needed and whether `package-lock.json` pins
  it (and its transitive tree) rather than floating.
- **Packaging.** `.vscodeignore` must keep `test/`, `src/`, `docs/` and
  `.vscode/` out of the published `.vsix` — shipping source or test
  fixtures is not a vulnerability in itself but widens what an
  installed extension's on-disk footprint exposes.
- **Workflow triggers.** There is no `.github/workflows/` in this
  repository yet. If this diff adds one, review it as though it will
  eventually run on the fleet's shared self-hosted runners: check
  authorisation before anything else runs, that `persist-credentials`
  is not left enabled where unnecessary, and that no secret is
  interpolated into a shell command built from PR-controlled text.

<!-- shared-block: path-traversal-review v1 -->
Path construction from outside data (shared block; do not edit --
the canonical copy lives in shakenfist/development at
`templates/shared-blocks/path-traversal-review.md`):

- Treat as a candidate any filesystem path built from a value the
  process did not choose: a request parameter, an image name, tag or
  digest, a layer path, an archive member name, a filename out of a
  configuration file or a database row.
- The question is not whether the value looks dangerous but whether
  the resulting path is *proved* to stay inside its intended base
  directory. Resolve the joined path with `os.path.realpath()` and
  verify it still starts with the base; a check on the untrusted
  component alone is defeated by symlinks and by encodings the
  check did not anticipate.
- Prefer a helper that cannot be forgotten at a call site --
  `safe_path_join()` in occystrap, or the framework's own
  (`send_from_directory` in Flask) -- over an inline guard repeated
  at each join.
- Archive extraction is the case most often missed: a member name
  inside a tarball or zip is attacker-controlled in exactly the same
  way as a request parameter.
- Where a bare join is correct because every component is
  process-chosen, say so in a comment rather than leaving the
  reader to re-derive it.
<!-- shared-block-end -->

`test/corpus.ts` is the one place in this repository that does build a
path from configuration (`HUNKYDORY_CORPUS`) and read from it, but that
value is developer-supplied at test time, never attacker-controlled, so
the shared block above is included for completeness rather than because
it currently applies.

Report findings with severity (critical / high / medium / low /
informational). For each, state the file, line, the vulnerability
class, and a recommended fix.

## Management session checklist

After all agents complete:

- [ ] Wave 1 passed (`pre-commit run --all-files` clean, `npm run
      corpus` run against a real patch set, greps reviewed).
- [ ] Wave 2 findings reviewed.
- [ ] Any blocking findings from 2a/2b/2c fixed and re-verified.
- [ ] Security findings assessed -- critical and high must be fixed
      before push.
- [ ] Any shared-block content copied from `shakenfist/development`
      that has since been updated there is noted, rather than silently
      going stale.
- [ ] Commit history is clean -- no fixups that should be squashed,
      no accidental files, no WIP messages.
- [ ] Branch is up to date with `develop`.
- [ ] Ready to push.
