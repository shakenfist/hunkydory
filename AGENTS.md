# AGENTS.md

Guidance for agents working in this repository. See
[ARCHITECTURE.md](ARCHITECTURE.md) for how the code fits together and
[docs/](docs/) for detail.

## Conventions

- `src/diff.ts` and `src/recount.ts` must never import `vscode`. That is what
  lets the test suite run under plain node. Anything needing the editor API
  goes in `src/extension.ts`.
- Wrap at 100 characters. Two-space indent, single quotes, semicolons.
- TypeScript runs with `strict`, `noUnusedLocals` and `noImplicitReturns`. Do
  not loosen these to make something compile.

## Testing

```bash
npm test                                         # unit tests
HUNKYDORY_CORPUS=/path/to/_patches npm run corpus # real-world regression
```

Both must pass before a commit. `pre-commit run --all-files` covers the first
(via `tools/check-node.sh`, which also runs the build and Biome) but not the
corpus check, which depends on a sibling checkout — run it by hand.

Before pushing a pull request, work through [PUSH-AUDIT.md](PUSH-AUDIT.md),
the pre-push review runbook.

The corpus check is the important one and is easy to under-value: it runs the
recounter over a directory of real patches and requires every one to round
trip **byte identically**. Most of the edge cases in `diff.ts` were found that
way rather than by reasoning. If you change counting behaviour, run it against
a real patch set — the OpenStack set in `shakenfist/kerbside-patches/_patches`
is what it was developed against.

## The thing that will catch you out

Counting a hunk body is not simply "lines starting with - or +". The rules that
are easy to miss, each of which broke a real patch:

- git's `-- ` signature before the version trailer starts with `-` but is not a
  deletion.
- A bare empty line is a context line that lost its leading space.
- `\ No newline at end of file` counts on neither side.
- A count of exactly 1 is elided: `-1,1` is written `-1`.
- File creation is `-0,0 +1,N`; deletion is `-1,N +0,0`.
- One case is genuinely ambiguous. Read [docs/ambiguity.md](docs/ambiguity.md)
  before touching `resolveCounts`.

A header that is too large makes git reject a patch loudly. One that is too
small makes git *silently truncate the hunk* and apply the wrong content. When
in doubt, over-count.
