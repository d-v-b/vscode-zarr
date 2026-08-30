/**
 * Quick fixes for the diagnostics this extension owns.
 *
 * - `unknown_name` (did-you-mean warnings): one "Change to ..." action per
 *   suggested registered name, rewriting just the name token.
 * - `must_understand` (obligated extension fields): "Mark as ignorable",
 *   inserting `"must_understand": false` into the field's object via
 *   jsonc-parser's `modify`, which respects the document's formatting.
 *
 * The provider works from the diagnostics themselves (message + range), so
 * it needs no side-channel state and survives VS Code cloning diagnostic
 * objects between publish and code-action time.
 */
import { applyEdits, findNodeAtOffset, getNodePath, modify, parseTree } from "jsonc-parser";
import * as vscode from "vscode";

function codeValue(diagnostic: vscode.Diagnostic): string | undefined {
  const code = diagnostic.code;
  if (typeof code === "string") return code;
  if (typeof code === "object" && code !== null) return String(code.value);
  return undefined;
}

/** Every JSON-quoted token in `message`, decoded. */
function quotedNames(message: string): string[] {
  return [...message.matchAll(/"(?:[^"\\]|\\.)*"/g)].map(
    (match) => JSON.parse(match[0]) as string,
  );
}

function renameActions(
  document: vscode.TextDocument,
  diagnostic: vscode.Diagnostic,
): vscode.CodeAction[] {
  // Message shape (ours): unknown <noun> "<old>" — did you mean "<a>" or "<b>"?
  const [oldName, ...suggestions] = quotedNames(diagnostic.message);
  if (oldName === undefined || suggestions.length === 0) return [];
  const slice = document.getText(diagnostic.range);
  const oldToken = JSON.stringify(oldName);
  const sliceIndex = slice.lastIndexOf(oldToken);
  if (sliceIndex < 0) return [];
  const start = document.offsetAt(diagnostic.range.start) + sliceIndex;
  const tokenRange = new vscode.Range(
    document.positionAt(start),
    document.positionAt(start + oldToken.length),
  );
  return suggestions.map((suggestion, index) => {
    const action = new vscode.CodeAction(
      `Change to ${JSON.stringify(suggestion)}`,
      vscode.CodeActionKind.QuickFix,
    );
    action.edit = new vscode.WorkspaceEdit();
    action.edit.replace(document.uri, tokenRange, JSON.stringify(suggestion));
    action.diagnostics = [diagnostic];
    action.isPreferred = index === 0 && suggestions.length === 1;
    return action;
  });
}

function waiverAction(
  document: vscode.TextDocument,
  diagnostic: vscode.Diagnostic,
): vscode.CodeAction[] {
  // The diagnostic range covers the field's key token; resolve the actual
  // node there so the fix lands at the right depth (the field may live
  // inside a consolidated metadata entry, not at the document's top level).
  const text = document.getText();
  const root = parseTree(text);
  if (root === undefined) return [];
  const keyNode = findNodeAtOffset(root, document.offsetAt(diagnostic.range.start));
  if (keyNode?.type !== "string" || keyNode.parent?.type !== "property") return [];
  const key = keyNode.value as string;
  const valueNode = keyNode.parent.children?.[1];
  // Only an object value can carry the waiver member.
  if (valueNode?.type !== "object") return [];
  const edits = modify(text, [...getNodePath(valueNode), "must_understand"], false, {
    formattingOptions: { insertSpaces: true, tabSize: 2 },
  });
  if (edits.length === 0) return [];
  const action = new vscode.CodeAction(
    `Mark ${JSON.stringify(key)} as ignorable ("must_understand": false)`,
    vscode.CodeActionKind.QuickFix,
  );
  action.edit = new vscode.WorkspaceEdit();
  for (const edit of edits) {
    action.edit.replace(
      document.uri,
      new vscode.Range(
        document.positionAt(edit.offset),
        document.positionAt(edit.offset + edit.length),
      ),
      edit.content,
    );
  }
  action.diagnostics = [diagnostic];
  action.isPreferred = true;
  // Sanity: the produced document must still parse.
  try {
    JSON.parse(applyEdits(text, edits));
  } catch {
    return [];
  }
  return [action];
}

export class ZarrQuickFixProvider implements vscode.CodeActionProvider {
  static readonly metadata: vscode.CodeActionProviderMetadata = {
    providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
  };

  provideCodeActions(
    document: vscode.TextDocument,
    _range: vscode.Range,
    context: vscode.CodeActionContext,
  ): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = [];
    for (const diagnostic of context.diagnostics) {
      if (diagnostic.source !== "zarr") continue;
      const code = codeValue(diagnostic);
      if (code === "unknown_name") {
        actions.push(...renameActions(document, diagnostic));
      } else if (code === "must_understand") {
        actions.push(...waiverAction(document, diagnostic));
      }
    }
    return actions;
  }
}
