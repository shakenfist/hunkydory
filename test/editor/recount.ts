/**
 * The editor's recount against the pure one, over edited patches.
 *
 * Every unit test, the corpus check and the fuzzer read a patch with
 * splitPatch. The extension reads it from a TextDocument, and when that went
 * through lineAt it saw a phantom empty line after the final newline, which
 * corrupted the last hunk of a file (#80) where no test could see it. So this
 * opens the fuzzer's edited patches as real documents, runs the Recount
 * command, and requires exactly what recountText makes of the same text.
 */

import assert from 'node:assert/strict';

import * as vscode from 'vscode';

import { recountText } from '../../src/recount';
import { editedPatches, FIXTURES, loadSeeds } from '../fuzz';

const SEED = 1;
const CASES = 60;

export async function editorMatchesRecountText(): Promise<void> {
  const { seeds } = loadSeeds(FIXTURES);
  assert.ok(seeds.length > 0, 'the fixtures seed the fuzzer');

  let changed = 0;
  for (const [index, content] of editedPatches(seeds, SEED, CASES).entries()) {
    const document = await vscode.workspace.openTextDocument({ language: 'diff', content });
    await vscode.window.showTextDocument(document);
    // The editor settles a document's line endings on one terminator, so the
    // comparison starts from what it holds rather than from what it was given.
    const before = document.getText();
    try {
      await vscode.commands.executeCommand('hunkydory.recount');
      changed += document.getText() === before ? 0 : 1;
      assert.equal(
        document.getText(),
        recountText(before),
        `edited patch ${index} (HUNKYDORY_FUZZ_SEED=${SEED}) recounts differently in the editor`,
      );
    } finally {
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    }
  }
  // A command that did nothing would match every patch it left correct.
  assert.ok(changed > CASES / 4, `the command changed only ${changed} of ${CASES} patches`);
}
