/**
 * Run the recounter over patches that must round trip byte identically.
 *
 * Two sources, doing two different jobs.
 *
 * `test/fixtures/` is committed here and always runs. It holds the cases a
 * real patch set does not supply: today that is CRLF line endings, which the
 * OpenStack corpus has none of and which were a total silent no-op until a
 * push audit found them. Each fixture is checked twice -- it must come back
 * unchanged, and it must also come back unchanged after every count in it has
 * been scrambled. The second check is the one that has teeth, because a
 * recounter that does not recognise a file at all passes the first one
 * perfectly. That is also a constraint on what belongs here: a fixture must
 * contain no trailing-blank ambiguity (docs/ambiguity.md), because scrambling
 * destroys the declared counts that ambiguity is resolved from, and such a
 * fixture would fail for a reason that is not a bug.
 *
 * The external corpus is a directory of real patches, and is where most of the
 * edge cases the unit tests now cover were found -- file creations, deletions,
 * format-patch signatures, missing trailing newlines and blank context lines,
 * without anyone having to think of them first. Only the round-trip check runs
 * against it, precisely because a real patch set does contain the ambiguity.
 *
 * Usage:
 *     npm run corpus
 *     HUNKYDORY_CORPUS=/path/to/patches npm run corpus
 */

import fs from 'node:fs';
import path from 'node:path';

import { recountText } from '../src/recount';

const FIXTURES = path.join(__dirname, '..', '..', 'test', 'fixtures');
const DEFAULT_CORPUS = path.join(__dirname, '..', '..', '..', 'kerbside-patches', '_patches');

function patchesIn(dir: string): string[] {
  return fs
    .readdirSync(dir)
    .filter((n) => n.endsWith('.patch'))
    .sort();
}

/** Break every count in a patch, leaving the bodies alone. */
function scramble(patch: string): string {
  return patch.replace(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/g, '@@ -$1,99 +$2,99 @@');
}

/**
 * Recount every named patch and return the ones that did not come back
 * identical to the file on disk.
 */
function roundTrip(dir: string, names: string[], prepare: (text: string) => string): string[] {
  const changed: string[] = [];
  for (const name of names) {
    const original = fs.readFileSync(path.join(dir, name), 'utf8');
    let recounted: string;
    try {
      recounted = recountText(prepare(original));
    } catch (e) {
      changed.push(`${name} (${String(e)})`);
      continue;
    }
    if (recounted !== original) {
      changed.push(name);
    }
  }
  return changed;
}

function report(label: string, changed: string[], names: string[]): boolean {
  const passed = names.length - changed.length;
  if (changed.length === 0) {
    console.log(`ok   ${label}: ${passed} of ${names.length}`);
    return true;
  }
  console.log(`FAIL ${label}: ${passed} of ${names.length}. These did not:`);
  for (const name of changed) {
    console.log(`       ${name}`);
  }
  return false;
}

function checkFixtures(): boolean {
  const names = patchesIn(FIXTURES);
  console.log(`Fixtures: ${FIXTURES}`);
  if (names.length === 0) {
    console.log('FAIL no fixtures found; this directory is committed and should not be empty');
    return false;
  }

  const unchanged = report(
    'round trip unchanged',
    roundTrip(FIXTURES, names, (text) => text),
    names,
  );
  const restored = report('restored after scrambling', roundTrip(FIXTURES, names, scramble), names);
  if (!restored) {
    console.log('');
    console.log('A fixture that round trips but is not restored after scrambling is one we are');
    console.log('not reading at all -- check that its line endings and headers are recognised,');
    console.log('rather than that its counts are right.');
  }
  return unchanged && restored;
}

function checkCorpus(): boolean {
  const dir = process.env.HUNKYDORY_CORPUS ?? DEFAULT_CORPUS;
  if (!fs.existsSync(dir)) {
    console.log(`No corpus at ${dir}, skipping.`);
    console.log('Set HUNKYDORY_CORPUS to a directory of .patch files to run this check.');
    return true;
  }

  const names = patchesIn(dir);
  console.log(`Corpus: ${dir}`);
  const ok = report(
    'round trip unchanged',
    roundTrip(dir, names, (text) => text),
    names,
  );
  if (!ok) {
    console.log('');
    console.log('A patch is rewritten either because we recount it wrongly, which is a');
    console.log('regression, or because its header genuinely disagrees with its body. Check');
    console.log('the patch with "git apply --check" before assuming the former; note that the');
    console.log('corpus is a working tree, so its branch decides which patches you get.');
  }
  return ok;
}

function main(): number {
  // Both run even if the first fails, so one command says everything that is
  // wrong rather than only the first thing.
  const fixtures = checkFixtures();
  const corpus = checkCorpus();
  return fixtures && corpus ? 0 : 1;
}

process.exit(main());
