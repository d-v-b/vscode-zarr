/**
 * Zarr Metadata extension: structural diagnostics for Zarr metadata files.
 *
 * This module is the ONLY source of validation diagnostics: it runs the
 * zarr-metadata validators (a port of the Python reference implementation)
 * plus the registry layer (src/registry.ts — extension-point configuration
 * schemas through an embedded Ajv) and maps each pathed issue to a precise
 * text range, so every problem has one voice, one range convention, and a
 * spec-linked code. The schemas the
 * extension contributes (contributes.jsonValidation) are deliberately
 * docs-only — stripped of assertion keywords at generation time — and exist
 * purely to power completions and hover documentation through VS Code's
 * built-in JSON language service.
 */
import { findNodeAtLocation, parseTree, type Node } from "jsonc-parser";
import * as vscode from "vscode";

import { ZarrQuickFixProvider } from "./quickfix.js";
import { validateExtensionConfigurations } from "./registry.js";
import {
  flattenTree,
  mustUnderstandExtensionFieldsV3,
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

/** The spec section a diagnostic's code links to, keyed by basename. */
const SPEC_URLS: ReadonlyMap<string, string> = new Map([
  ["zarr.json", "https://zarr-specs.readthedocs.io/en/latest/v3/core/index.html"],
  [".zarray", "https://zarr-specs.readthedocs.io/en/latest/v2/v2.0.html"],
  [".zgroup", "https://zarr-specs.readthedocs.io/en/latest/v2/v2.0.html"],
  [".zattrs", "https://zarr-specs.readthedocs.io/en/latest/v2/v2.0.html"],
  [".zmetadata", "https://zarr-specs.readthedocs.io/en/latest/v2/v2.0.html"],
]);

function codeFor(kind: string, basename: string): vscode.Diagnostic["code"] {
  const url = SPEC_URLS.get(basename);
  return url === undefined ? kind : { value: kind, target: vscode.Uri.parse(url) };
}

function validatorFor(document: vscode.TextDocument): Validator | undefined {
  if (document.languageId !== "json" && document.languageId !== "jsonc") return undefined;
  const basename = document.uri.path.split("/").pop() ?? "";
  return VALIDATORS.get(basename);
}

/**
 * The text range for a problem: the node at the issue's path, or — when the
 * path points at something absent, like a missing key — the nearest existing
 * ancestor, clamped to its first line so a fallback on the root object
 * doesn't paint the whole document red.
 *
 * A node that is a property's value widens to the whole property (people
 * hover the NAME of a field at least as often as its value); when the value
 * spans multiple lines, just the name is used so a large object or array
 * isn't underlined wholesale.
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
    let target = node;
    if (!fellBack && node.parent?.type === "property") {
      const key = node.parent.children?.[0];
      const multiline =
        document.positionAt(node.offset).line !==
        document.positionAt(node.offset + node.length).line;
      target = (multiline ? key : node.parent) ?? node.parent;
    }
    const start = document.positionAt(target.offset);
    let stop = document.positionAt(target.offset + target.length);
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
  basename: string,
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
  diagnostic.code = codeFor(issue.kind, basename);
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
  const basename = document.uri.path.split("/").pop() ?? "";
  const items = flattenTree(validator(value)).map((issue) =>
    toDiagnostic(document, root, issue, basename),
  );
  if (basename === "zarr.json") {
    // Registry layer: recognized extension-point configurations (codecs,
    // chunk grid, chunk key encoding, data type) validated against the
    // vendored zarr-extensions + core-spec schemas, through the same
    // pipeline so every diagnostic keeps one voice.
    items.push(
      ...validateExtensionConfigurations(value).map((issue) => {
        const diagnostic = toDiagnostic(document, root, issue, basename);
        if (issue.suggestion) {
          // A near-miss of a registered name is probably a typo, but the
          // extension name space is open — warn, don't condemn, and link
          // the registry (the fix path if the name is genuinely new).
          diagnostic.severity = vscode.DiagnosticSeverity.Warning;
          diagnostic.code = {
            value: "unknown_name",
            target: vscode.Uri.parse("https://github.com/zarr-developers/zarr-extensions"),
          };
        }
        return diagnostic;
      }),
    );
    // Structurally valid, but most readers will refuse it: per the v3 spec
    // an unrecognized extension field must carry "must_understand": false
    // to be ignorable, so obligated extras get a warning on the key.
    for (const key of mustUnderstandExtensionFieldsV3(value)) {
      const valueNode = findNodeAtLocation(root, [key]);
      const keyNode = valueNode?.parent?.children?.[0] ?? valueNode;
      if (keyNode === undefined) continue;
      const range = new vscode.Range(
        document.positionAt(keyNode.offset),
        document.positionAt(keyNode.offset + keyNode.length),
      );
      // Kept to one clause so it reads as a sibling of other hover entries;
      // the linked code carries the spec rationale (readers that do not
      // recognize an unwaived extension field must refuse the node).
      const diagnostic = new vscode.Diagnostic(
        range,
        'unrecognized extension field without a "must_understand": false waiver',
        vscode.DiagnosticSeverity.Warning,
      );
      diagnostic.source = "zarr";
      diagnostic.code = codeFor("must_understand", basename);
      items.push(diagnostic);
    }
  }
  diagnostics.set(document.uri, items);
}

export function activate(context: vscode.ExtensionContext): void {
  const diagnostics = vscode.languages.createDiagnosticCollection("zarr");
  context.subscriptions.push(diagnostics);
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      [{ language: "json" }, { language: "jsonc" }],
      new ZarrQuickFixProvider(),
      ZarrQuickFixProvider.metadata,
    ),
  );

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
