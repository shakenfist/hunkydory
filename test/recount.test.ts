/**
 * Tests for the recounter.
 *
 * The interesting cases here were all found by running an equivalent
 * implementation over a real corpus of several hundred OpenStack patches, so
 * each one corresponds to something that actually went wrong rather than
 * something that theoretically could.
 */

import assert from 'node:assert/strict';
import { test, describe } from 'node:test';

import { formatRange, parseHunks } from '../src/diff';
import { computeFixes, recountText } from '../src/recount';

/** Break every count in a patch, leaving the bodies alone. */
function scramble(patch: string): string {
  return patch
    .split('\n')
    .map((line) => line.replace(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/, '@@ -$1,99 +$2,99 @@'))
    .join('\n');
}

describe('formatRange', () => {
  test('elides a count of one', () => {
    assert.equal(formatRange(4, 1), '4');
  });

  test('keeps every other count', () => {
    assert.equal(formatRange(4, 0), '4,0');
    assert.equal(formatRange(4, 2), '4,2');
  });
});

describe('recountText', () => {
  test('corrects a count that is too small', () => {
    const patch = ['@@ -1,2 +1,2 @@', ' alpha', '-beta', '+gamma', ' delta', ''].join('\n');
    assert.match(recountText(patch), /^@@ -1,3 \+1,3 @@$/m);
  });

  test('leaves a correct patch untouched', () => {
    const patch = ['@@ -1,3 +1,3 @@', ' alpha', '-beta', '+gamma', ' delta', ''].join('\n');
    assert.equal(recountText(patch), patch);
  });

  test('preserves a missing trailing newline', () => {
    const patch = ['@@ -1,1 +1,1 @@', '-a', '+b'].join('\n');
    assert.ok(!recountText(patch).endsWith('\n'));
  });

  test('preserves a present trailing newline', () => {
    const patch = ['@@ -1 +1 @@', '-a', '+b', ''].join('\n');
    assert.ok(recountText(patch).endsWith('\n'));
  });

  test('creating a file starts the new side at 1', () => {
    const patch = ['--- /dev/null', '+++ b/new.txt', '@@ -0,0 +9,9 @@', '+alpha', '+beta', ''].join('\n');
    assert.match(recountText(patch), /^@@ -0,0 \+1,2 @@$/m);
  });

  test('deleting a file starts the new side at 0', () => {
    const patch = ['--- a/gone.txt', '+++ /dev/null', '@@ -1,9 +1,9 @@', '-alpha', '-beta', ''].join('\n');
    assert.match(recountText(patch), /^@@ -1,2 \+0,0 @@$/m);
  });

  test('does not count the git format-patch signature as a deletion', () => {
    const patch = ['@@ -1,1 +1,1 @@', '-alpha', '+beta', '-- ', '2.47.3', ''].join('\n');
    assert.match(recountText(patch), /^@@ -1 \+1 @@$/m);
  });

  test('does not count the no-newline marker on either side', () => {
    const patch = ['@@ -1,9 +1,9 @@', '-alpha', '\\ No newline at end of file', '+beta', ''].join('\n');
    assert.match(recountText(patch), /^@@ -1 \+1 @@$/m);
  });

  test('treats a bare empty line as a context line', () => {
    // Some editors and mail paths strip the single leading space from a
    // context line that is otherwise blank.
    const patch = ['@@ -1,9 +1,9 @@', ' alpha', '', '-beta', '+gamma', ' delta', ''].join('\n');
    assert.match(recountText(patch), /^@@ -1,4 \+1,4 @@$/m);
  });

  test('propagates the offset to later hunks in the same file', () => {
    const patch = [
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1,9 +1,9 @@',
      ' alpha',
      '+inserted',
      ' beta',
      '@@ -20,9 +20,9 @@',
      ' gamma',
      ' delta',
      '',
    ].join('\n');
    const out = recountText(patch);
    assert.match(out, /^@@ -1,2 \+1,3 @@$/m);
    // The second hunk starts one line later on the new side.
    assert.match(out, /^@@ -20,2 \+21,2 @@$/m);
  });

  test('resets the offset at each new file', () => {
    const patch = [
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1,9 +1,9 @@',
      ' alpha',
      '+inserted',
      ' beta',
      '--- a/b.txt',
      '+++ b/b.txt',
      '@@ -5,9 +5,9 @@',
      ' gamma',
      ' delta',
      '',
    ].join('\n');
    const out = recountText(patch);
    assert.match(out, /^@@ -1,2 \+1,3 @@$/m);
    // Not +6: the running offset from a.txt must not leak into b.txt.
    assert.match(out, /^@@ -5,2 \+5,2 @@$/m);
  });

  test('scrambling then recounting is a round trip', () => {
    const patch = [
      'diff --git a/a.txt b/a.txt',
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1,3 +1,4 @@',
      ' alpha',
      '+inserted',
      ' beta',
      ' gamma',
      '',
    ].join('\n');
    assert.equal(recountText(scramble(patch)), patch);
  });
});

describe('trailing blank ambiguity', () => {
  // git reads a hunk by consuming exactly as many lines as the header
  // declares, so a blank line before the next file may or may not belong to
  // the hunk. We preserve whichever reading the existing header implies.
  const body = ['@@ -7,3 +7,4 @@', ' alpha', '+inserted', ' beta', ' ', 'diff --git a/b b/b', ''];

  test('preserves a header that excludes the trailing blank', () => {
    const patch = body.join('\n');
    assert.equal(recountText(patch), patch, 'a self-consistent header should not be rewritten');
  });

  test('counts every line once the header no longer matches', () => {
    const patch = ['@@ -7,99 +7,99 @@', ' alpha', '+inserted', ' beta', ' ', 'diff --git a/b b/b', ''].join('\n');
    // Falls back to counting the trailing blank, which is the safe direction:
    // an over-large count is rejected loudly, an under-large one truncates.
    assert.match(recountText(patch), /^@@ -7,3 \+7,4 @@$/m);
  });
});

describe('computeFixes', () => {
  test('reports nothing for a correct patch', () => {
    const lines = ['@@ -1,3 +1,3 @@', ' alpha', '-beta', '+gamma', ' delta'];
    assert.deepEqual(computeFixes(lines), []);
  });

  test('reports only the header line, so edits stay minimal', () => {
    const lines = ['@@ -1,9 +1,9 @@', ' alpha', '-beta', '+gamma', ' delta'];
    const fixes = computeFixes(lines);
    assert.equal(fixes.length, 1);
    assert.equal(fixes[0].line, 0);
    assert.equal(fixes[0].corrected, '@@ -1,3 +1,3 @@');
  });
});

describe('parseHunks', () => {
  test('records where each body begins and ends', () => {
    const lines = ['@@ -1,2 +1,2 @@', ' alpha', '-beta', '+gamma', 'diff --git a/b b/b'];
    const hunks = parseHunks(lines);
    assert.equal(hunks.length, 1);
    assert.equal(hunks[0].bodyStart, 1);
    assert.equal(hunks[0].bodyEnd, 4);
  });

  test('keeps the function heading after the closing @@', () => {
    const lines = ['@@ -1 +1 @@ def frobnicate(self):', '-a', '+b'];
    assert.equal(parseHunks(lines)[0].heading, ' def frobnicate(self):');
  });
});
