# Changelog

What changed in each release of Hunky Dory, newest first.

## 0.2.0 -- 2026-10-17

Most of this release fixes recounts that produced a header `git apply`
would accept and then apply wrongly, which is the worst way for a recount
to go wrong. Most were found by a new edit fuzzer, which edits real patches
the way a person would and asks git whether the recounted result applies
where it should.

### Added

- A hunk header that cannot be recounted is now reported, as a warning in
  the Problems panel and when **Hunky Dory: Recount hunk headers** is run,
  rather than being left as it was without a word. That happens when an
  edit has given a file creation or deletion lines on its empty side, has
  left a hunk with no lines at all, or has put hunks out of order so that
  one would start before the first line.

### Fixed

- Editing the end of a file no longer produces a header that git rejects
  as a corrupt patch: the empty line after a file's final newline was
  being counted as part of the last hunk.
  ([#80](https://github.com/shakenfist/hunkydory/issues/80))
- Undo now takes back an edit and the header recount it caused together.
  Before, undo reverted only the header, which was promptly recounted
  again, so you could never undo past it.
  ([#79](https://github.com/shakenfist/hunkydory/issues/79))
- Hunks from `git diff -U0` keep the right new-side start. They were
  recounted a line out, and `git apply --unidiff-zero` applied them a line
  early. ([#83](https://github.com/shakenfist/hunkydory/issues/83))
- A blank line typed at the end of a hunk, right before the next hunk, is
  now counted into it, where before git rejected the patch.
  ([#87](https://github.com/shakenfist/hunkydory/issues/87))
- A deleted SQL, Lua, Haskell or Ada comment (`-- like this`) is read as a
  deleted line, not as the start of the next file. Before, the hunk was
  recounted short and git dropped the deletion.
  ([#85](https://github.com/shakenfist/hunkydory/issues/85))
- An edited hunk from a `-U0` patch no longer counts a following blank
  line in. That blank became all git had to place the hunk by, and git put
  the hunk at the first blank line in the file. A blank line between such
  a hunk and the next one belongs to neither, and is now reported in the
  Problems panel.
  ([#86](https://github.com/shakenfist/hunkydory/issues/86))

## 0.1.0 -- 2026-09-22

The first release: `@@` hunk headers in unified diffs are recounted as you
type, on save, or on demand with **Hunky Dory: Recount hunk headers**, and a
stale header can be reported in the Problems panel.
