/**
 * Run the recounter over a directory of real patches.
 *
 * Every patch in the corpus is expected to round trip byte identically: a
 * correct patch must never be rewritten. This is the check that caught most of
 * the edge cases the unit tests now cover, because a corpus of real OpenStack
 * patches contains file creations, deletions, format-patch signatures, missing
 * trailing newlines and blank context lines without anyone having to think of
 * them.
 *
 * Usage:
 *     npm run corpus
 *     HUNKYDORY_CORPUS=/path/to/patches npm run corpus
 */

import fs from 'node:fs';
import path from 'node:path';

import { recountText } from '../src/recount';

const DEFAULT_CORPUS = path.join(__dirname, '..', '..', '..', 'kerbside-patches', '_patches');

function main(): number {
  const dir = process.env.HUNKYDORY_CORPUS ?? DEFAULT_CORPUS;

  if (!fs.existsSync(dir)) {
    console.log(`No corpus at ${dir}, skipping.`);
    console.log('Set HUNKYDORY_CORPUS to a directory of .patch files to run this check.');
    return 0;
  }

  const names = fs
    .readdirSync(dir)
    .filter((n) => n.endsWith('.patch'))
    .sort();

  const changed: string[] = [];
  for (const name of names) {
    const original = fs.readFileSync(path.join(dir, name), 'utf8');
    let recounted: string;
    try {
      recounted = recountText(original);
    } catch (e) {
      changed.push(`${name} (${String(e)})`);
      continue;
    }
    if (recounted !== original) {
      changed.push(name);
    }
  }

  console.log(`Corpus: ${dir}`);
  if (changed.length > 0) {
    console.log(`FAIL ${changed.length} of ${names.length} patches were rewritten:`);
    for (const name of changed) {
      console.log(`       ${name}`);
    }
    console.log('');
    console.log('A patch is rewritten either because we recount it wrongly, which is a');
    console.log('regression, or because its header genuinely disagrees with its body. Check');
    console.log('the patch with "git apply --check" before assuming the former; note that the');
    console.log('corpus is a working tree, so its branch decides which patches you get.');
    return 1;
  }

  console.log(`ok   ${names.length} patches round trip unchanged`);
  return 0;
}

process.exit(main());
