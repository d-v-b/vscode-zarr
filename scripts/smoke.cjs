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
const settings = {}; // mutable stub for workspace configuration
let quickFixProvider;
class WorkspaceEdit {
  constructor() { this.edits = []; }
  replace(uri, range, newText) { this.edits.push({ range, newText }); }
}
class CodeAction {
  constructor(title, kind) { this.title = title; this.kind = kind; }
}
const vscode = {
  languages: {
    createDiagnosticCollection: () => ({
      set: (uri, items) => captured.set(uri.toString(), items),
      delete: () => {}, dispose: () => {},
    }),
    registerCodeActionsProvider: (selector, provider) => {
      quickFixProvider = provider;
      return { dispose() {} };
    },
  },
  workspace: {
    onDidOpenTextDocument: () => ({ dispose() {} }),
    onDidChangeTextDocument: () => ({ dispose() {} }),
    onDidCloseTextDocument: () => ({ dispose() {} }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
    getConfiguration: (section) => ({
      get: (key, fallback) => settings[`${section}.${key}`] ?? fallback,
    }),
    textDocuments: [],
  },
  Position, Range, Diagnostic, WorkspaceEdit, CodeAction,
  CodeActionKind: { QuickFix: "quickfix" },
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

/**
 * Run one test fixture through the pipeline; return its diagnostics + lines.
 * Fixtures live in scripts/fixtures/, NOT example/ — the example documents
 * are a playground the user is free to edit in the dev host.
 */
function run(fixture) {
  const file = path.join(__dirname, "fixtures", `${fixture}.zarr.json`);
  const text = readFileSync(file, "utf-8");
  const lines = text.split("\n");
  const offsets = [0];
  for (const line of lines) offsets.push(offsets[offsets.length - 1] + line.length + 1);
  const uri = `file:///example/${fixture}/zarr.json`;
  const document = {
    uri: { path: `/example/${fixture}/zarr.json`, toString: () => uri },
    languageId: "json",
    getText: (range) =>
      range === undefined
        ? text
        : text.slice(document.offsetAt(range.start), document.offsetAt(range.end)),
    offsetAt: (position) => offsets[position.line] + position.character,
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
  return { diagnostics: captured.get(uri) ?? [], lines, document, text };
}

/** Apply a stub WorkspaceEdit's replacements to `text`, last-to-first. */
function applyEdit(document, text, workspaceEdit) {
  const edits = workspaceEdit.edits
    .map((e) => ({
      start: document.offsetAt(e.range.start),
      end: document.offsetAt(e.range.end),
      newText: e.newText,
    }))
    .sort((a, b) => b.start - a.start);
  let out = text;
  for (const e of edits) out = out.slice(0, e.start) + e.newText + out.slice(e.end);
  return out;
}

/** All quick-fix actions for one diagnostic. */
function actionsFor(document, diagnostic) {
  return quickFixProvider.provideCodeActions(document, diagnostic.range, {
    diagnostics: [diagnostic],
  });
}

// --- broken_array: structural errors + the must_understand warning -------
{
  const { diagnostics, lines } = run("broken_array");
  const errors = diagnostics.filter((d) => d.severity === 0);
  const warnings = diagnostics.filter((d) => d.severity === 1);
  // 6 errors: five structural plus the semantic chunk-arity finding (the
  // fixture's shape is 3-D while its regular chunk_shape is 2-D).
  if (errors.length !== 6 || warnings.length !== 1) {
    console.error(diagnostics.map((d) => `${d.severity}: ${d.message}`));
    throw new Error(`broken_array: expected 6 errors + 1 warning, got ${errors.length}/${warnings.length}`);
  }
  if (!errors.some((d) => d.message === "expected one length per dimension of shape (3)")) {
    throw new Error("broken_array: missing the semantic chunk-arity diagnostic");
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
  expect((m) => m.includes('did you mean "bytes"'), "near-miss codec name suggestion");
  expect(
    (m) => m === '"gzip" requires a configuration, e.g. "configuration": {"level":5}',
    "bare codec needing a configuration, with an example",
  );
  const gzip = diagnostics.find((d) => d.message.includes('"gzip" requires'));
  if (!String(gzip.code.target).includes("codecs/gzip")) {
    throw new Error(`gzip diagnostic should link to the gzip spec, got ${gzip.code.target}`);
  }
  const clevel = diagnostics.find((d) => d.message === "must be <= 9");
  if (!String(clevel.code.target).includes("codecs/blosc")) {
    throw new Error(`blosc config diagnostic should link to the blosc spec, got ${clevel.code.target}`);
  }
  expect((m) => m === "missing required key: blocksize", "fallback names only the unresolved suffix");
  const suggestion = diagnostics.find((d) => d.message.includes("did you mean"));
  if (suggestion.severity !== 1) {
    throw new Error("bad_codecs: the did-you-mean suggestion must be a warning, not an error");
  }
  expect(
    (m) => m === '"blosc" (bytes -> bytes) must come after the array -> bytes codec',
    "bytes->bytes codec before the array->bytes stage",
  );
  expect(
    (m) => m === 'expected exactly one array -> bytes codec in the pipeline (e.g. "bytes")',
    "sharding inner pipeline missing its array->bytes codec",
  );
  if (diagnostics.length !== 11) {
    console.error(messages);
    throw new Error(`bad_codecs: expected exactly 11 diagnostics, got ${diagnostics.length}`);
  }
}

// --- bad_pipeline: codec composition rule ---------------------------------
{
  const { diagnostics } = run("bad_pipeline");
  const messages = diagnostics.map((d) => d.message);
  if (
    messages.length !== 1 ||
    messages[0] !== '"transpose" (array -> array) must come before the array -> bytes codec'
  ) {
    console.error(messages);
    throw new Error("bad_pipeline: expected exactly the transpose-after-bytes diagnostic");
  }
}

// --- bad_semantics: the library's cross-field semantic layer --------------
{
  const { diagnostics } = run("bad_semantics");
  const messages = diagnostics.map((d) => d.message).sort();
  const expected = [
    'expected [4,4] to evenly divide the outer chunk shape [5,12]',
    'expected a permutation of the integers 0..1',
    'expected an integer in [-2147483648, 2147483647] for data type "int32"',
  ];
  if (JSON.stringify(messages) !== JSON.stringify(expected)) {
    console.error(messages);
    throw new Error("bad_semantics: semantic diagnostics did not match expectations");
  }
}

// --- extensions_opt_in: the zarr.extensionSchemas setting -----------------
{
  // Default (core-spec only): registry-known-but-disabled names warn and
  // point at the setting; nothing else fires (no configuration validation,
  // no pipeline checks over unknown stages).
  delete settings["zarr.extensionSchemas"];
  const before = run("extensions_opt_in").diagnostics;
  const pointers = before.filter((d) => d.message.includes('setting: "zarr.extensionSchemas"'));
  if (before.length !== 2 || pointers.length !== 2 || !before.every((d) => d.severity === 1)) {
    console.error(before.map((d) => `${d.severity}: ${d.message}`));
    throw new Error("extensions_opt_in: expected exactly two setting-pointer warnings by default");
  }
  // Opted in: int2 and packbits are recognized and valid.
  settings["zarr.extensionSchemas"] = "zarr-extensions";
  const after = run("extensions_opt_in").diagnostics;
  if (after.length !== 0) {
    console.error(after.map((d) => d.message));
    throw new Error("extensions_opt_in: expected no diagnostics once zarr-extensions is enabled");
  }
  delete settings["zarr.extensionSchemas"];
}

// --- quick fixes ----------------------------------------------------------
{
  // "Change to \"bytes\"" on the did-you-mean warning repairs the name.
  const { diagnostics, document, text } = run("bad_codecs");
  const suggestion = diagnostics.find((d) => d.message.includes("did you mean"));
  const actions = actionsFor(document, suggestion);
  if (actions.length !== 1 || actions[0].title !== 'Change to "bytes"') {
    throw new Error(`quick fix: expected one Change to "bytes" action, got ${JSON.stringify(actions.map((a) => a.title))}`);
  }
  const repaired = JSON.parse(applyEdit(document, text, actions[0].edit));
  const fixed = repaired.codecs[1].configuration.index_codecs[0];
  if (fixed !== "bytes") {
    throw new Error(`quick fix: expected index_codecs[0] === "bytes" after fix, got ${JSON.stringify(fixed)}`);
  }
}
{
  // "Mark as ignorable" inserts the must_understand waiver, and the
  // repaired document no longer carries the warning.
  const { diagnostics, document, text } = run("broken_array");
  const warning = diagnostics.find((d) => d.message.includes("must_understand"));
  const actions = actionsFor(document, warning);
  if (actions.length !== 1 || !actions[0].title.includes('"custom_thing"')) {
    throw new Error(`quick fix: expected one waiver action for custom_thing, got ${JSON.stringify(actions.map((a) => a.title))}`);
  }
  const repaired = JSON.parse(applyEdit(document, text, actions[0].edit));
  if (repaired.custom_thing.must_understand !== false) {
    throw new Error("quick fix: waiver was not inserted");
  }
}

console.log("smoke OK: activation, diagnostics (3 layers), and quick fixes verified");
