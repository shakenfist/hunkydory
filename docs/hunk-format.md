# The hunk header format

```
@@ -86,11 +86,12 @@ jpeg_compression = {{ nova_spice_jpeg_compression }}
    │   │    │  │  └── function hint: decorative, never verified
    │   │    │  └───── lines this hunk occupies in the new file
    │   │    └──────── first line number in the new file
    │   └───────────── lines this hunk occupies in the old file
    └───────────────── first line number in the old file
```

The old count is context lines plus `-` lines. The new count is context lines
plus `+` lines. The text after the closing `@@` is a hint git adds for
readability and is not checked by anything.

## The rules that bite

Every one of these broke a real patch during development.

**A count of exactly 1 is elided.** `-1,1` is written `-1`. A recounter that
always emits the long form produces diffs that are correct but not byte
identical to git's, which makes round-trip testing useless.

**File creation is `-0,0 +1,N`.** The new side starts at 1, not at
`oldStart + delta`. Deletion is the mirror image, `-1,N +0,0`: the new side
starts at 0 because it is empty.

**git's signature is not a deletion.** `git format-patch` ends its output with:

```
-- 
2.47.3
```

That `-- ` starts with a `-`, and a naive counter reads it as a deleted line.

**A bare empty line is a context line.** git writes a blank context line as a
single space, but editors and mail paths strip trailing whitespace, so patches
in the wild contain genuinely empty lines in the middle of a hunk body. They
count on both sides.

**`\ No newline at end of file` counts on neither side.** It annotates the
line above it.

**Offsets accumulate within a file and reset between files.** The new-side
start of each hunk is its old-side start plus the running total of
`(additions - deletions)` from earlier hunks in the same file. That total must
reset at each `--- ` line or the second file in a patch comes out shifted.

## Why the direction of an error matters

A header whose counts are **too large** makes git refuse the patch:

```
error: corrupt patch at line 25
```

Loud, immediate, easy to fix.

A header whose counts are **too small** is the dangerous one. git reads exactly
as many lines as the header declares and ignores the rest, so the hunk is
quietly truncated and the patch applies with the wrong content. Nothing warns
you.

This asymmetry is why `resolveCounts` falls back to counting *every* line when
it cannot tell: over-counting fails safe.
