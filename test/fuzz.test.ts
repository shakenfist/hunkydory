/**
 * A fixed slice of the edit fuzzer, so every run of `npm test` edits real
 * patches and has git judge the recount. docs/testing.md has what is checked.
 *
 * The seed is fixed: a failure here must be one the next run reproduces, not
 * a flake that turns an unrelated change red. `npm run fuzz` is the open-ended
 * version, over the corpus as well, with a fresh seed every run.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { describeFailure, FIXTURES, fuzz, loadSeeds } from './fuzz';
import { checkFile, coverage, judge } from './fuzz/judge';
import { type HunkItem, readPatch, render } from './fuzz/patch';

const SEED = 1;
const CASES = 400;

test('recounting an edited fixture gives headers git agrees with', () => {
  const { seeds, rejected } = loadSeeds(FIXTURES);
  assert.deepEqual(rejected, [], 'every fixture can seed the fuzzer');
  const failures = fuzz(seeds, SEED, CASES);
  assert.equal(failures.length, 0, failures.map(describeFailure).join('\n\n'));

  // The git checks stand aside where git has nothing true to say. If that
  // grew to everywhere, this test would pass having checked nothing; about
  // 85% of cases reach git today.
  assert.ok(coverage.byGit >= CASES / 2, `only ${coverage.byGit} of ${CASES} cases reached git`);
  assert.ok(coverage.filesApplied >= CASES / 2, `git applied only ${coverage.filesApplied} files`);
  assert.ok(coverage.ambiguous <= CASES / 10, `${coverage.ambiguous} cases set aside as ambiguous`);
});

test('the judge sets aside a diff -u hunk that ends like a file header', () => {
  // diff -U0 replacing `-- old` with `++ new`, after an edit. With no
  // diff --git line the hunk's last two lines read as a file header by design
  // (docs/ambiguity.md); with one, they are body, and git can judge them.
  const lines = [
    '--- a/f',
    '+++ b/f',
    '@@ -2 +2 @@',
    '--- old',
    '+++ new',
    '@@ -5 +5 @@',
    '-e',
    '+E',
  ];
  const edited = (text: string) => {
    const patch = readPatch(text);
    patch.items
      .find((item): item is HunkItem => item.kind === 'hunk')
      ?.body.unshift({ text: '+added', ending: '\n' });
    return patch;
  };
  const before = { ...coverage };
  const bare = edited(`${lines.join('\n')}\n`);
  assert.deepEqual(judge(bare, render(bare)), []);
  assert.equal(coverage.ambiguous, before.ambiguous + 1);

  const git = edited(`diff --git a/f b/f\n${lines.join('\n')}\n`);
  assert.deepEqual(judge(git, render(git)), []);
  assert.equal(coverage.ambiguous, before.ambiguous + 1, 'a git patch is judged');
  assert.equal(coverage.byGit, before.byGit + 1);
});

test('the judge notices a hunk git finds away from its header', () => {
  // Context for lines 9 to 11, but a new side that claims they are at 12.
  const patch = readPatch(
    [
      '--- a/target',
      '+++ b/target',
      '@@ -9,3 +12,4 @@',
      ' line 9',
      '+new',
      ' line 10',
      ' line 11',
      '',
    ].join('\n'),
  );
  const hunks = patch.items.filter((item): item is HunkItem => item.kind === 'hunk');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hunkydory-fuzz-test-'));
  try {
    const result = checkFile(hunks, patch.files[0], dir);
    assert.ok(Array.isArray(result) && result.some((f) => f.includes('away from')), String(result));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
