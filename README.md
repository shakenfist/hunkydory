# Hunky Dory

A VS Code extension that keeps the `@@` hunk headers in a patch file correct
while you edit it.

If you maintain patches as source — a `_patches/` directory, a quilt series, a
distribution package — then editing one means updating arithmetic by hand:

```diff
@@ -86,11 +86,12 @@ jpeg_compression = {{ nova_spice_jpeg_compression }}
                 ^^
                 add a line to the body and this has to change too
```

Get it wrong in one direction and git rejects the patch. Get it wrong in the
other and **git silently truncates the hunk and applies the wrong content**,
which is the failure that costs an afternoon. Hunky Dory does the arithmetic
for you as you type.

Emacs has had this in `diff-mode` for decades. VS Code did not, so here it is.

## Install

```bash
git clone https://github.com/shakenfist/hunkydory
cd hunkydory
npm install && npm run package
code --install-extension hunkydory-0.1.0.vsix
```

## Use

Open any `.patch` or `.diff` file and edit it. Headers correct themselves
about 200ms after you stop typing, except the one your cursor is sitting on —
that one is left alone until you move away, so it never fights you.

- **Hunky Dory: Recount hunk headers** fixes the whole file, cursor line
  included.
- Stale headers show up in the Problems panel.
- The status bar shows which hunk you are in and its line counts.

| Setting | Default | Meaning |
|---|---|---|
| `hunkydory.mode` | `live` | `live`, `onSave`, or `manual`. |
| `hunkydory.diagnostics` | `true` | Report stale headers as warnings. |
| `hunkydory.statusBar` | `true` | Show the current hunk's counts. |

## Correctness

The counting rules have more edge cases than they look like they do: file
creation and deletion, the elided `,1`, git's `-- ` signature line, missing
trailing newlines, blank context lines that lost their leading space, and one
case that is genuinely ambiguous.

So the test suite uses git itself as the oracle. It builds throwaway
repositories, has git generate canonical patches, scrambles every count, and
requires the recounted result to match git's own output byte for byte. On top
of that, `npm run corpus` runs the recounter over a directory of real patches
and requires all of them to round trip unchanged — 175/175 on the OpenStack
patch set it was developed against.

```bash
npm test                                         # unit tests
HUNKYDORY_CORPUS=/path/to/patches npm run corpus # regression corpus
```

## Documentation

- [Hunk header format](docs/hunk-format.md) — what the numbers mean and every
  rule that turned out to matter.
- [The ambiguous case](docs/ambiguity.md) — why one blank line cannot be
  resolved from the body alone, and what we do about it.
- [Architecture](ARCHITECTURE.md) — how the pieces fit together.

## Related

`patchutils` solves the same problem from a shell: `recountdiff` recomputes
counts, `editdiff` fixes up after `$EDITOR`, and `rediff` uses the pre-edit
patch as a reference — which lets it detect a deleted *context* line, the one
thing no after-the-fact recounter can see.

## License

Apache 2.0.
