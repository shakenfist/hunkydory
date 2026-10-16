/**
 * Tests for the recounter.
 *
 * Most of the interesting cases here were found by running an equivalent
 * implementation over a real corpus of several hundred OpenStack patches, so
 * they correspond to something that actually went wrong rather than something
 * that theoretically could.
 *
 * The line-endings block is the exception, and is the argument for not relying
 * on a corpus alone: that patch set is entirely LF, so it could never have
 * shown that a CRLF patch was being ignored outright. A push audit found that
 * by reading the expression rather than by running anything.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { formatRange, parseHunks, splitPatch } from '../src/diff';
import { checkHeaders, computeFixes, looksLikeDiff, recountText } from '../src/recount';

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
    const patch = ['--- /dev/null', '+++ b/new.txt', '@@ -0,0 +9,9 @@', '+alpha', '+beta', ''].join(
      '\n',
    );
    assert.match(recountText(patch), /^@@ -0,0 \+1,2 @@$/m);
  });

  test('deleting a file starts the new side at 0', () => {
    const patch = [
      '--- a/gone.txt',
      '+++ /dev/null',
      '@@ -1,9 +1,9 @@',
      '-alpha',
      '-beta',
      '',
    ].join('\n');
    assert.match(recountText(patch), /^@@ -1,2 \+0,0 @@$/m);
  });

  // git diff -U0 output: with no context, a side is empty in the middle of a
  // file too, not only at its ends. An empty range names the line before it.
  // The same hunks as test/fixtures/empty-sides-u0.patch, which git generated.
  const unidiffZero = [
    '--- a/lines.txt',
    '+++ b/lines.txt',
    '@@ -3,0 +4,2 @@ three',
    '+inserted-a',
    '+inserted-b',
    '@@ -8 +9,0 @@ seven',
    '-eight',
    '@@ -12,0 +14 @@ twelve',
    '+appended',
    '',
  ].join('\n');

  test('starts the new side one later after an empty old side', () => {
    const out = recountText(scramble(unidiffZero));
    assert.match(out, /^@@ -3,0 \+4,2 @@ three$/m);
    assert.match(out, /^@@ -12,0 \+14 @@ twelve$/m);
  });

  test('starts an empty new side one earlier', () => {
    assert.match(recountText(scramble(unidiffZero)), /^@@ -8 \+9,0 @@ seven$/m);
  });

  test('computes empty-side starts rather than keeping the declared ones', () => {
    // scramble keeps each declared start, so this gives every hunk a wrong one.
    const wrong = unidiffZero.replace(/\+\d+(,\d+)? @@/g, '+1,9 @@');
    const out = recountText(wrong);
    assert.match(out, /^@@ -3,0 \+4,2 @@ three$/m);
    assert.match(out, /^@@ -8 \+9,0 @@ seven$/m);
    assert.match(out, /^@@ -12,0 \+14 @@ twelve$/m);
  });

  test('leaves a correct patch with empty sides untouched', () => {
    assert.equal(recountText(unidiffZero), unidiffZero);
  });

  test('does not count the git format-patch signature as a deletion', () => {
    const patch = ['@@ -1,1 +1,1 @@', '-alpha', '+beta', '-- ', '2.47.3', ''].join('\n');
    assert.match(recountText(patch), /^@@ -1 \+1 @@$/m);
  });

  test('does not count the no-newline marker on either side', () => {
    const patch = ['@@ -1,9 +1,9 @@', '-alpha', '\\ No newline at end of file', '+beta', ''].join(
      '\n',
    );
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
    const patch = [
      '@@ -7,99 +7,99 @@',
      ' alpha',
      '+inserted',
      ' beta',
      ' ',
      'diff --git a/b b/b',
      '',
    ].join('\n');
    // Falls back to counting the trailing blank, which is the safe direction:
    // an over-large count is rejected loudly, an under-large one truncates.
    assert.match(recountText(patch), /^@@ -7,3 \+7,4 @@$/m);
  });
});

describe('a blank before the next hunk', () => {
  // git reads everything up to the next @@ as part of the hunk before it, so
  // a trailing blank there is not ambiguous: leaving it out makes git reject
  // the patch with "patch fragment without header".
  const patch = (header: string) =>
    [
      '--- a/f',
      '+++ b/f',
      header,
      ' alpha',
      '-beta',
      '+gamma',
      ' ',
      '@@ -20,2 +20,2 @@',
      ' delta',
      '-epsilon',
      '+zeta',
      '',
    ].join('\n');

  test('counts a blank typed at the end of the hunk', () => {
    // The header from before the blank was typed matches if it is ignored.
    assert.match(recountText(patch('@@ -1,2 +1,2 @@')), /^@@ -1,3 \+1,3 @@$/m);
  });

  test('counts several blanks of either kind', () => {
    const text = recountText(patch('@@ -1,2 +1,2 @@').replace(' \n@@', '\n \n@@'));
    assert.match(text, /^@@ -1,4 \+1,4 @@$/m);
  });

  test('leaves a blank out of a hunk with no other context', () => {
    // Counted in, the blank would be all git had to place the insertion by,
    // and it would apply it silently at the first blank line in the file.
    // Left out, git rejects the patch, which is the better way to be wrong.
    const u0 = ['--- a/f', '+++ b/f', '@@ -5 +5 @@', '-a', '+x', '', '@@ -30 +30 @@', '-b', '+y'];
    const text = `${u0.join('\n')}\n`;
    assert.equal(recountText(text), text);
  });

  test('leaves a blank out of a hunk whose only context is blank', () => {
    // git diff -U1 inserting between two blank lines: the blanks anchor
    // nothing, and git would apply the hunk at any other pair of them.
    const u1 = [
      '--- a/f',
      '+++ b/f',
      '@@ -5,2 +5,3 @@',
      ' ',
      '+x',
      ' ',
      ' ',
      '@@ -35 +36 @@',
      '-a',
      '+b',
    ];
    const text = `${u1.join('\n')}\n`;
    assert.equal(recountText(text), text);
  });

  test('leaves a header that already counts it alone', () => {
    const correct = patch('@@ -1,3 +1,3 @@');
    assert.equal(recountText(correct), correct);
  });
});

describe('line endings', () => {
  // A CRLF patch used to be a total silent no-op: recountText split on '\n'
  // alone, so every line kept its CR, '@@ ... @@\r' matched no header, and the
  // file came back byte for byte as it arrived with nothing reported. The
  // regression corpus could never have caught it -- a no-op round trips
  // perfectly -- so the coverage has to live here.
  const crlf = (lines: string[]) => lines.join('\r\n');

  test('corrects a header in a CRLF patch', () => {
    const patch = crlf(['@@ -1,2 +1,2 @@', ' alpha', '-beta', '+gamma', ' delta', '']);
    assert.equal(
      recountText(patch),
      crlf(['@@ -1,3 +1,3 @@', ' alpha', '-beta', '+gamma', ' delta', '']),
      'the header should be corrected and every CRLF left alone',
    );
  });

  test('leaves a correct CRLF patch byte identical', () => {
    const patch = crlf(['@@ -1,3 +1,3 @@', ' alpha', '-beta', '+gamma', ' delta', '']);
    assert.equal(recountText(patch), patch);
  });

  test('counts a blank context line in a CRLF patch', () => {
    // The CRLF form of the line whose leading space was stripped. Read as
    // content, a lone CR would end the body here and the header would be
    // recounted too small, which is the direction git truncates silently.
    const patch = crlf(['@@ -1,9 +1,9 @@', ' alpha', '', '-beta', '+gamma', ' delta', '']);
    assert.match(recountText(patch), /^@@ -1,4 \+1,4 @@\r$/m);
  });

  test('preserves a CRLF patch with no final terminator', () => {
    const patch = crlf(['@@ -1,9 +1,9 @@', '-a', '+b']);
    assert.equal(recountText(patch), crlf(['@@ -1 +1 @@', '-a', '+b']));
  });

  test('preserves mixed line endings rather than choosing one', () => {
    // A patch assembled by hand from two sources. Rejoining with a single
    // detected ending would rewrite every line in the file to fix one header.
    const patch = '@@ -1,9 +1,9 @@\n alpha\r\n-beta\r\n+gamma\r\n delta\r\n';
    assert.equal(recountText(patch), '@@ -1,3 +1,3 @@\n alpha\r\n-beta\r\n+gamma\r\n delta\r\n');
  });

  test('looksLikeDiff recognises a CRLF patch', () => {
    assert.ok(looksLikeDiff(crlf(['@@ -1 +1 @@', '-a', '+b'])));
  });

  // The rules also have to cope with a caller that splits on '\n' itself and
  // hands us lines that still carry their CR. Recognising the header but
  // rewriting it without the CR would leave the file with mixed endings, which
  // is worse than the no-op it replaced.
  test('recognises a header that still carries its CR, and keeps it', () => {
    const lines = ['@@ -1,9 +1,9 @@\r', ' alpha\r', '-beta\r', '+gamma\r', ' delta\r'];
    const fixes = computeFixes(lines);
    assert.equal(fixes.length, 1);
    assert.equal(fixes[0].corrected, '@@ -1,3 +1,3 @@\r');
  });

  test('counts a lone CR as the blank context line it is', () => {
    const lines = ['@@ -1,9 +1,9 @@\r', ' alpha\r', '\r', '-beta\r', '+gamma\r', ' delta\r'];
    assert.equal(computeFixes(lines)[0].corrected, '@@ -1,4 +1,4 @@\r');
  });
});

describe('splitPatch', () => {
  test('splits on CRLF, LF and a bare CR', () => {
    const { lines, endings } = splitPatch('a\r\nb\nc\rd');
    assert.deepEqual(lines, ['a', 'b', 'c', 'd']);
    assert.deepEqual(endings, ['\r\n', '\n', '\r', '']);
  });

  test('does not invent a line after a final terminator', () => {
    // The phantom element a bare split() leaves behind counts as a blank
    // context line, which silently adds one to both sides of the last hunk.
    assert.deepEqual(splitPatch('a\n').lines, ['a']);
  });

  test('round trips any text it is given', () => {
    const text = 'a\r\n\r\nb\nc\r\n';
    const { lines, endings } = splitPatch(text);
    assert.equal(lines.map((line, i) => line + endings[i]).join(''), text);
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

// The shape of issue #80: a file creation as the last hunk of a patch with no
// format-patch signature, edited so its header no longer matches.
const creationAtEnd = [
  'diff --git a/notes.yaml b/notes.yaml',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/notes.yaml',
  '@@ -0,0 +1,8 @@',
  '+---',
  '+fixes:',
  '+  - |',
  '+    Shorter now.',
];

describe('checkHeaders', () => {
  test('recounts a file creation at the end of a patch', () => {
    const text = `${creationAtEnd.join('\n')}\n`;
    assert.match(recountText(text), /^@@ -0,0 \+1,4 @@$/m);
  });

  // Counting every line is the usual fallback, but here it would give an old
  // side starting at 0 a line, which git rejects as a corrupt patch.
  test('leaves trailing blanks out of a creation rather than make it invalid', () => {
    const text = `${creationAtEnd.join('\n')}\n\n`;
    const fixed = recountText(text);
    assert.match(fixed, /^@@ -0,0 \+1,4 @@$/m);
    assert.ok(fixed.endsWith('Shorter now.\n\n'));
  });

  // A caller that reads an editor's lines with lineAt(0..lineCount) hands us
  // an empty line after the final newline. It must be read as the gap after
  // the hunk, not as part of it, or the header becomes `-0 +1,5`.
  test('reads a phantom final empty line as outside a creation', () => {
    const check = checkHeaders([...creationAtEnd, '']);
    assert.equal(check.fixes[0].corrected, '@@ -0,0 +1,4 @@');
    assert.deepEqual(check.refused, []);
  });

  test('repairs a header that is already impossible', () => {
    // Before, the tie-break preserved this: ignoring no trailing blanks
    // reproduces its counts exactly.
    const lines = [...creationAtEnd.slice(0, 4), '@@ -0 +1,5 @@', ...creationAtEnd.slice(5), ''];
    assert.equal(checkHeaders(lines).fixes[0].corrected, '@@ -0,0 +1,4 @@');
  });

  test('refuses to give an old side starting at 0 any lines', () => {
    const lines = [...creationAtEnd.slice(0, 6), ' context', ...creationAtEnd.slice(6)];
    const check = checkHeaders(lines);
    assert.deepEqual(check.fixes, []);
    assert.equal(check.refused.length, 1);
    assert.equal(check.refused[0].line, 4);
    assert.equal(check.refused[0].current, '@@ -0,0 +1,8 @@');
  });

  test('leaves trailing blanks out of a deletion rather than make it invalid', () => {
    const text = ['--- a/gone.txt', '+++ /dev/null', '@@ -1,9 +0,0 @@', '-a', '-b', '-c', '', ''];
    assert.match(recountText(text.join('\n')), /^@@ -1,3 \+0,0 @@$/m);
  });

  test('refuses to give a new side starting at 0 any lines', () => {
    const lines = ['--- a/gone.txt', '+++ /dev/null', '@@ -1,9 +0,0 @@', '-a', '+b'];
    const check = checkHeaders(lines);
    assert.deepEqual(check.fixes, []);
    assert.equal(check.refused[0].line, 2);
  });

  test('refuses a start before the first line, as hunks out of order give', () => {
    // As written, git applies this. The running offset assumes hunks in
    // order, and would put the second one's insertion at the top of the file.
    const lines = ['--- a/f', '+++ b/f', '@@ -10,5 +10,0 @@', '-a', '-b', '-c', '-d', '-e'];
    const check = checkHeaders([...lines, '@@ -4,0 +5 @@', '+y']);
    assert.deepEqual(
      check.fixes.map((fix) => fix.corrected),
      ['@@ -10,5 +9,0 @@'],
    );
    assert.equal(check.refused.length, 1);
    assert.equal(check.refused[0].line, 8);
  });

  test('refuses a hunk with no lines on either side', () => {
    const check = checkHeaders(['--- a/f', '+++ b/f', '@@ -5,0 +9,0 @@', 'diff --git a/g b/g']);
    assert.deepEqual(check.fixes, []);
    assert.equal(check.refused[0].line, 2);
  });

  test('still fixes the other hunks in a document with a refusal', () => {
    const lines = [
      '@@ -1,9 +1,9 @@',
      ' alpha',
      '-beta',
      '+gamma',
      ' delta',
      ...creationAtEnd.slice(0, 6),
      ' context',
      ...creationAtEnd.slice(6),
    ];
    const check = checkHeaders(lines);
    assert.equal(check.fixes.length, 1);
    assert.equal(check.fixes[0].corrected, '@@ -1,3 +1,3 @@');
    assert.equal(check.refused.length, 1);
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
