/**
 * Entry point for --extensionTestsPath: every test that needs a real editor.
 *
 * Run by tools/editor-test.sh, never by `npm test`: these need the vscode
 * module, which only exists inside an extension host. No file here ends in
 * .test.ts, so node's own runner never picks one up. A rejection fails the run.
 */

import * as vscode from 'vscode';

import { editorMatchesRecountText } from './recount';
import { liveFixJoinsTheEditsUndoStep, undoNeverRecounts } from './undo';

export async function run(): Promise<void> {
  const tests: Array<[string, () => Promise<void>]> = [
    ['a live fix joins the undo step of the edit that prompted it', liveFixJoinsTheEditsUndoStep],
    ['undo never prompts a recount', undoNeverRecounts],
    ['the editor recounts an edited patch as recountText does', editorMatchesRecountText],
  ];
  for (const [name, test] of tests) {
    try {
      await test();
      console.log(`ok   ${name}`);
    } finally {
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    }
  }
}
