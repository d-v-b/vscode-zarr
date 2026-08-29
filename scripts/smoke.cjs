/**
 * Activation smoke test: load the built bundle with a stubbed `vscode`
 * module, activate it, and run one real document through the diagnostics
 * pipeline. Catches bundling regressions (e.g. a dependency's UMD wrapper
 * smuggling unresolved requires into dist/) that typecheck and packaging
 * dry-runs cannot.
 */
const Module = require("module");
const { readFileSync } = require("fs");
const path = require("path");

const captured = new Map();
class Position {
  constructor(line, character) { this.line = line; this.character = character; }
}
class Range {
  constructor(a, b, c, d) {
    this.start = typeof a === "number" ? new Position(a, b) : a;
    this.end = typeof a === "number" ? new Position(c, d) : b;
  }
}
class Diagnostic {
  constructor(range, message, severity) { this.range = range; this.message = message; this.severity = severity; }
}
const vscode = {
  languages: { createDiagnosticCollection: () => ({
    set: (uri, items) => captured.set(uri.toString(), items),
    delete: () => {}, dispose: () => {},
  }) },
  workspace: {
    onDidOpenTextDocument: () => ({ dispose() {} }),
    onDidChangeTextDocument: () => ({ dispose() {} }),
    onDidCloseTextDocument: () => ({ dispose() {} }),
    textDocuments: [],
  },
  Position, Range, Diagnostic,
  DiagnosticSeverity: { Error: 0, Warning: 1 },
};

const orig = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === "vscode") return "vscode";
  return orig.call(this, request, ...args);
};
Module._cache["vscode"] = { exports: vscode, loaded: true };

const ext = require(path.join(__dirname, "..", "dist", "extension.js"));
ext.activate({ subscriptions: [] });

// Feed the deliberately broken example through the open-document path.
const fixture = path.join(__dirname, "..", "example", "broken_array", "zarr.json");
const text = readFileSync(fixture, "utf-8");
const lines = text.split("\n");
const offsets = [0];
for (const line of lines) offsets.push(offsets[offsets.length - 1] + line.length + 1);
const document = {
  uri: { path: "/example/broken_array/zarr.json", toString: () => "file:///example/broken_array/zarr.json" },
  languageId: "json",
  getText: () => text,
  positionAt(offset) {
    let line = offsets.findIndex((o) => o > offset) - 1;
    if (line < 0) line = lines.length - 1;
    return new Position(line, offset - offsets[line]);
  },
  lineAt: (line) => ({ range: new Range(line, 0, line, lines[line].length) }),
};
vscode.workspace.textDocuments.push(document);
ext.activate({ subscriptions: [] });

const diagnostics = captured.get("file:///example/broken_array/zarr.json") ?? [];
const errors = diagnostics.filter((d) => d.severity === 0);
const warnings = diagnostics.filter((d) => d.severity === 1);
if (errors.length < 4 || warnings.length !== 1) {
  console.error("diagnostics:", diagnostics.map((d) => `${d.severity}: ${d.message}`));
  throw new Error(`expected >=4 errors and exactly 1 warning, got ${errors.length}/${warnings.length}`);
}
console.log(`smoke OK: activation + ${errors.length} errors + ${warnings.length} warning on the example fixture`);
