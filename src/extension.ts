/**
 * Zarr Metadata extension: structural diagnostics for Zarr metadata files.
 *
 * The declarative layer (contributes.jsonValidation in package.json) already
 * gives schema-based validation, hover docs, and completions through VS
 * Code's built-in JSON language service. This module adds the checks JSON
 * Schema cannot express — cross-field rules like "one dimension_names entry
 * per dimension of shape" — by running the zarr-metadata validators (a port
 * of the Python reference implementation) and mapping each loc-addressed
 * problem to a precise text range.
 */
import { findNodeAtLocation, parseTree, type Node } from "jsonc-parser";
import * as vscode from "vscode";
import {
  flattenTree,
  validateArrayMetadataV2,
  validateConsolidatedMetadataV2,
  validateGroupMetadataV2,
  validateMetadataV3,
  type ErrorTree,
  type PathedIssue,
} from "zarr-metadata";

type Validator = (value: unknown) => ErrorTree;

/** Which validator handles a metadata file, keyed by basename. */
const VALIDATORS: ReadonlyMap<string, Validator> = new Map([
  ["zarr.json", validateMetadataV3],
  [".zarray", validateArrayMetadataV2],
  [".zgroup", validateGroupMetadataV2],
  [".zmetadata", validateConsolidatedMetadataV2],
]);

const DEBOUNCE_MS = 300;

function validatorFor(document: vscode.TextDocument): Validator | undefined {
  if (document.languageId !== "json" && document.languageId !== "jsonc") return undefined;
  const basename = document.uri.path.split("/").pop() ?? "";
  return VALIDATORS.get(basename);
}

/**
 * The text range for a problem: the node at `loc`, or — when the loc points
 * at something absent, like a missing key — the nearest existing ancestor,
 * clamped to its first line so a fallback on the root object doesn't paint
 * the whole document red.
 */
function rangeFor(
  document: vscode.TextDocument,
  root: Node,
  issue: PathedIssue,
): { range: vscode.Range; fellBack: boolean } {
  for (let end = issue.path.length; end >= 0; end--) {
    const node =
      end === 0 ? root : findNodeAtLocation(root, issue.path.slice(0, end) as (string | number)[]);
    if (node === undefined) continue;
    const fellBack = end < issue.path.length;
    let start = document.positionAt(node.offset);
    let stop = document.positionAt(node.offset + node.length);
    if (fellBack && stop.line > start.line) {
      stop = document.lineAt(start.line).range.end;
    }
    return { range: new vscode.Range(start, stop), fellBack };
  }
  return { range: new vscode.Range(0, 0, 0, 0), fellBack: true };
}

function toDiagnostic(
  document: vscode.TextDocument,
  root: Node,
  issue: PathedIssue,
): vscode.Diagnostic {
  const { range, fellBack } = rangeFor(document, root, issue);
  let message = issue.message;
  if (fellBack && issue.path.length > 0) {
    // The range no longer identifies the offending path, so the message must.
    message =
      issue.kind === "missing_key"
        ? `missing required key: ${issue.path.join(".")}`
        : `${issue.path.join(".")}: ${issue.message}`;
  }
  const diagnostic = new vscode.Diagnostic(range, message, vscode.DiagnosticSeverity.Error);
  diagnostic.source = "zarr";
  diagnostic.code = issue.kind;
  return diagnostic;
}

function refresh(document: vscode.TextDocument, diagnostics: vscode.DiagnosticCollection): void {
  const validator = validatorFor(document);
  if (validator === undefined) return;
  const text = document.getText();
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    // Not parseable JSON: the built-in JSON language service already reports
    // the syntax error; stale structural diagnostics would only add noise.
    diagnostics.delete(document.uri);
    return;
  }
  const root = parseTree(text);
  if (root === undefined) {
    diagnostics.delete(document.uri);
    return;
  }
  diagnostics.set(
    document.uri,
    flattenTree(validator(value)).map((issue) => toDiagnostic(document, root, issue)),
  );
}

export function activate(context: vscode.ExtensionContext): void {
  const diagnostics = vscode.languages.createDiagnosticCollection("zarr");
  context.subscriptions.push(diagnostics);

  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const scheduleRefresh = (document: vscode.TextDocument) => {
    if (validatorFor(document) === undefined) return;
    const key = document.uri.toString();
    const pending = timers.get(key);
    if (pending !== undefined) clearTimeout(pending);
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key);
        refresh(document, diagnostics);
      }, DEBOUNCE_MS),
    );
  };

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((document) => refresh(document, diagnostics)),
    vscode.workspace.onDidChangeTextDocument((event) => scheduleRefresh(event.document)),
    vscode.workspace.onDidCloseTextDocument((document) => {
      const key = document.uri.toString();
      const pending = timers.get(key);
      if (pending !== undefined) {
        clearTimeout(pending);
        timers.delete(key);
      }
      diagnostics.delete(document.uri);
    }),
  );

  for (const document of vscode.workspace.textDocuments) {
    refresh(document, diagnostics);
  }
}

export function deactivate(): void {}
