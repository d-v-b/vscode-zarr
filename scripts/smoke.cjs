/**
 * Activation smoke test: load the built bundle with a stubbed `vscode`
 * module, activate it, and run real example documents through the
 * diagnostics pipeline. Catches bundling regressions (unresolved requires
 * smuggled into dist/) and pins the diagnostics each fixture must produce —
 * things typecheck and packaging dry-runs cannot see.
 */
const Module = require("module");
const { readFileSync } = require("fs");
const path = require("path");

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
const captured = new Map();
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
  Uri: { parse: (value) => ({ toString: () => value }) },
  DiagnosticSeverity: { Error: 0, Warning: 1 },
};

const orig = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === "vscode") return "vscode";
  return orig.call(this, request, ...args);
};
Module._cache["vscode"] = { exports: vscode, loaded: true };

const ext = require(path.join(__dirname, "..", "dist", "extension.js"));

/** Run one example fixture through the pipeline; return its diagnostics + lines. */
function run(fixture) {
  const file = path.join(__dirname, "..", "example", fixture, "zarr.json");
  const text = readFileSync(file, "utf-8");
  const lines = text.split("\n");
  const offsets = [0];
  for (const line of lines) offsets.push(offsets[offsets.length - 1] + line.length + 1);
  const uri = `file:///example/${fixture}/zarr.json`;
  const document = {
    uri: { path: `/example/${fixture}/zarr.json`, toString: () => uri },
    languageId: "json",
    getText: () => text,
    positionAt(offset) {
      let line = offsets.findIndex((o) => o > offset) - 1;
      if (line < 0) line = lines.length - 1;
      return new Position(line, offset - offsets[line]);
    },
    lineAt: (line) => ({ range: new Range(line, 0, line, lines[line].length) }),
  };
  vscode.workspace.textDocuments.length = 0;
  vscode.workspace.textDocuments.push(document);
  ext.activate({ subscriptions: [] });
  return { diagnostics: captured.get(uri) ?? [], lines };
}

// --- broken_array: structural errors + the must_understand warning -------
{
  const { diagnostics, lines } = run("broken_array");
  const errors = diagnostics.filter((d) => d.severity === 0);
  const warnings = diagnostics.filter((d) => d.severity === 1);
  if (errors.length !== 5 || warnings.length !== 1) {
    console.error(diagnostics.map((d) => `${d.severity}: ${d.message}`));
    throw new Error(`broken_array: expected 5 errors + 1 warning, got ${errors.length}/${warnings.length}`);
  }
  // Diagnostics on a property's value must widen to cover the property
  // name, so hovering the name surfaces them.
  const codecs = errors.find((d) => d.message.includes("at least one codec"));
  const codecsStart = lines[codecs.range.start.line].slice(codecs.range.start.character);
  if (!codecsStart.startsWith('"codecs"')) {
    throw new Error(`codecs diagnostic should start on the property name, got: ${codecsStart.slice(0, 30)}`);
  }
}

// --- bad_codecs: registry-layer configuration validation -----------------
{
  const { diagnostics } = run("bad_codecs");
  const messages = diagnostics.map((d) => d.message);
  const expect = (predicate, label) => {
    if (!messages.some(predicate)) {
      console.error(messages);
      throw new Error(`bad_codecs: missing expected diagnostic: ${label}`);
    }
  };
  expect((m) => m.includes('"lz4"'), "blosc cname enum");
  expect((m) => m.includes("<= 9"), "blosc clevel maximum");
  expect((m) => m.includes("missing required key") && messages.length > 0, "blosc missing blocksize");
  expect((m) => m.includes("<= 9") || m.includes("<= 22"), "nested gzip level (through sharding)");
  expect((m) => m.includes('"start", "end"'), "sharding index_location enum");
  expect((m) => m.includes('"/", "."'), "chunk_key_encoding separator enum");
  if (diagnostics.length !== 6) {
    console.error(messages);
    throw new Error(`bad_codecs: expected exactly 6 diagnostics, got ${diagnostics.length}`);
  }
}

console.log("smoke OK: activation, structural + must_understand + registry layers verified");
