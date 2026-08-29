/**
 * Extension-point configuration validation: the Spectral-style layer.
 *
 * The zarr-metadata validators are structural — they never interpret what a
 * codec, chunk grid, chunk key encoding, or data type NAMES. This module
 * closes that gap by validating each recognized named configuration against
 * the schemas in schemas/extension-registry.json (the zarr-extensions
 * registry vendored at a pinned commit, plus hand-written core-spec
 * schemas), through an embedded Ajv — and emits plain pathed issues so
 * everything flows out of the one diagnostics pipeline.
 *
 * Only the `configuration` subtree of each registry schema is applied: the
 * name is the lookup key, and registry schemas' top-level
 * `additionalProperties: false` would false-positive on the spec-legal
 * `must_understand` member. A top-level `required` including
 * `configuration` is honored as "this extension needs a configuration".
 * Unknown names produce nothing — extension names are an open set.
 */
import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import type { IssueKind, PathedIssue } from "zarr-metadata";

import registry from "../schemas/extension-registry.json";

type Point = "codecs" | "data_type" | "chunk_grid" | "chunk_key_encoding";

/** A registry issue; `suggestion` marks heuristic did-you-mean warnings. */
export type RegistryIssue = PathedIssue & {
  readonly suggestion?: boolean;
  /** Per-extension documentation URL for the diagnostic's code link. */
  readonly documentation?: string;
};

const POINT_NOUNS: Record<Point, string> = {
  codecs: "codec",
  data_type: "data type",
  chunk_grid: "chunk grid",
  chunk_key_encoding: "chunk key encoding",
};

type PipelineStage = "array_to_array" | "array_to_bytes" | "bytes_to_bytes";

const STAGE_LABELS: Record<PipelineStage, string> = {
  array_to_array: "array -> array",
  array_to_bytes: "array -> bytes",
  bytes_to_bytes: "bytes -> bytes",
};

interface RegistrySchema {
  properties?: { configuration?: ConfigSchema };
  required?: string[];
  documentation?: string;
  pipelineStage?: PipelineStage;
}

interface ConfigSchema {
  examples?: unknown[];
  default?: unknown;
  const?: unknown;
  enum?: unknown[];
  type?: string | string[];
  minimum?: number;
  properties?: Record<string, ConfigSchema>;
  required?: string[];
  items?: ConfigSchema;
}

// Extensions whose configurations embed further codec pipelines to recurse into.
const NESTED_PIPELINES: ReadonlyMap<string, ReadonlyArray<string>> = new Map([
  ["sharding_indexed", ["codecs", "index_codecs"]],
]);

// strict:false — registry schemas may carry unknown annotations (e.g. the
// nonstandard "range" in zarr-extensions' transpose schema).
const ajv = new Ajv2020({ strict: false, allErrors: true });
const compiled = new Map<string, ValidateFunction>();

function configValidatorFor(point: Point, name: string): ValidateFunction | undefined {
  const key = `${point}/${name}`;
  const cached = compiled.get(key);
  if (cached !== undefined) return cached;
  const schema = (registry[point] as Record<string, RegistrySchema | undefined>)[name];
  const configSchema = schema?.properties?.configuration;
  if (configSchema === undefined) return undefined;
  const validator = ajv.compile(configSchema);
  compiled.set(key, validator);
  return validator;
}

function configRequiredFor(point: Point, name: string): boolean {
  const schema = (registry[point] as Record<string, RegistrySchema | undefined>)[name];
  return schema?.required?.includes("configuration") ?? false;
}

function documentationFor(point: Point, name: string): string | undefined {
  return (registry[point] as Record<string, RegistrySchema | undefined>)[name]?.documentation;
}

function stageFor(name: string): PipelineStage | undefined {
  return (registry.codecs as Record<string, RegistrySchema | undefined>)[name]?.pipelineStage;
}

function codecName(field: unknown): string | undefined {
  if (typeof field === "string") return field;
  if (isPlainObject(field) && typeof field["name"] === "string") return field["name"];
  return undefined;
}

/**
 * Enforce the core spec's pipeline composition: zero or more array -> array
 * codecs, exactly one array -> bytes codec, zero or more bytes -> bytes
 * codecs, in that order. A pipeline containing any codec with an unknown
 * stage is skipped wholesale — its unknown members could legitimately fill
 * any role, so every check here would risk a false positive.
 */
function validatePipeline(
  pipeline: unknown[],
  path: ReadonlyArray<string | number>,
): RegistryIssue[] {
  if (pipeline.length === 0) return []; // the structural layer already reports empty codecs
  const stages: (PipelineStage | undefined)[] = pipeline.map((field) => {
    const name = codecName(field);
    return name === undefined ? undefined : stageFor(name);
  });
  if (stages.some((stage) => stage === undefined)) return [];
  const issues: RegistryIssue[] = [];
  let seenArrayToBytes = false;
  let seenBytesToBytes = false;
  // One ordering diagnostic per pipeline: a single misplaced codec makes
  // every later codec "misplaced" relative to it, and reporting the cascade
  // buries the root cause.
  let orderingReported = false;
  const report = (issue: RegistryIssue): void => {
    if (!orderingReported) issues.push(issue);
    orderingReported = true;
  };
  pipeline.forEach((field, index) => {
    const stage = stages[index] as PipelineStage;
    const name = codecName(field) as string;
    if (stage === "array_to_array" && (seenArrayToBytes || seenBytesToBytes)) {
      report({
        path: [...path, index],
        message: `${JSON.stringify(name)} (array -> array) must come before the array -> bytes codec`,
        kind: "invalid_value",
      });
    } else if (stage === "array_to_bytes" && (seenArrayToBytes || seenBytesToBytes)) {
      report({
        path: [...path, index],
        message: seenArrayToBytes
          ? `second array -> bytes codec (a pipeline has exactly one)`
          : `${JSON.stringify(name)} (array -> bytes) must come before the bytes -> bytes codecs`,
        kind: "invalid_value",
      });
    } else if (stage === "bytes_to_bytes" && !seenArrayToBytes) {
      report({
        path: [...path, index],
        message: `${JSON.stringify(name)} (bytes -> bytes) must come after the array -> bytes codec`,
        kind: "invalid_value",
      });
    }
    if (stage === "array_to_bytes") seenArrayToBytes = true;
    if (stage === "bytes_to_bytes") seenBytesToBytes = true;
  });
  if (!seenArrayToBytes) {
    issues.push({
      path: [...path],
      message: 'expected exactly one array -> bytes codec in the pipeline (e.g. "bytes")',
      kind: "invalid_value",
    });
  }
  return issues;
}

const UNDERIVABLE = Symbol("underivable");

/** A sample value for `schema`, or UNDERIVABLE when no clean sample exists. */
function sampleFor(schema: ConfigSchema | undefined): unknown {
  if (schema === undefined) return UNDERIVABLE;
  if (schema.examples !== undefined && schema.examples.length > 0) return schema.examples[0];
  if (schema.default !== undefined) return schema.default;
  if (schema.const !== undefined) return schema.const;
  if (schema.enum !== undefined && schema.enum.length > 0) return schema.enum[0];
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  switch (type) {
    case "integer":
    case "number":
      return schema.minimum ?? 0;
    case "boolean":
      return false;
    case "string":
      return "";
    case "array": {
      const item = sampleFor(schema.items);
      return item === UNDERIVABLE ? UNDERIVABLE : [item];
    }
    case "object": {
      const out: Record<string, unknown> = {};
      for (const key of schema.required ?? []) {
        const item = sampleFor(schema.properties?.[key]);
        if (item === UNDERIVABLE) return UNDERIVABLE;
        out[key] = item;
      }
      return out;
    }
    default:
      return UNDERIVABLE;
  }
}

/** A rendered example configuration for the extension, when one can be built. */
function exampleFor(point: Point, name: string): string | undefined {
  const schema = (registry[point] as Record<string, RegistrySchema | undefined>)[name];
  const sample = sampleFor(schema?.properties?.configuration);
  return sample === UNDERIVABLE ? undefined : JSON.stringify(sample);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function levenshtein(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const previous = new Array<number>(cols);
  const current = new Array<number>(cols);
  for (let j = 0; j < cols; j++) previous[j] = j;
  for (let i = 1; i < rows; i++) {
    current[0] = i;
    for (let j = 1; j < cols; j++) {
      const substitution = (previous[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min((previous[j] as number) + 1, (current[j - 1] as number) + 1, substitution);
    }
    for (let j = 0; j < cols; j++) previous[j] = current[j] as number;
  }
  return previous[cols - 1] as number;
}

/**
 * The registered names an unknown `name` was probably a typo of: within
 * edit distance 1, or 2 when either side is longer than four characters
 * (so the truncation typo "byt" still reaches "bytes"), compared
 * case-insensitively. Names far from everything registered are respected
 * as intentionally novel — the extension name space is open.
 */
function nearMisses(point: Point, name: string): string[] {
  const known = Object.keys(registry[point]);
  let best = Number.POSITIVE_INFINITY;
  let matches: string[] = [];
  for (const candidate of known) {
    const budget = Math.max(name.length, candidate.length) > 4 ? 2 : 1;
    if (Math.abs(candidate.length - name.length) > budget) continue;
    const distance = levenshtein(name.toLowerCase(), candidate.toLowerCase());
    if (distance > budget) continue;
    if (distance < best) {
      best = distance;
      matches = [candidate];
    } else if (distance === best) {
      matches.push(candidate);
    }
  }
  return matches;
}

/** Map one Ajv error to our issue vocabulary, path-relative to the configuration. */
function toIssue(error: ErrorObject): PathedIssue {
  const path: (string | number)[] = error.instancePath
    .split("/")
    .filter((part) => part !== "")
    .map((part) => (/^\d+$/.test(part) ? Number(part) : part.replace(/~1/g, "/").replace(/~0/g, "~")));
  let message = error.message ?? "invalid value";
  let kind: IssueKind = "invalid_value";
  if (error.keyword === "required") {
    path.push((error.params as { missingProperty: string }).missingProperty);
    message = "missing required key";
    kind = "missing_key";
  } else if (error.keyword === "additionalProperties") {
    path.push((error.params as { additionalProperty: string }).additionalProperty);
    message = "unexpected configuration member";
  } else if (error.keyword === "type") {
    message = `expected ${String((error.params as { type: string }).type)}`;
    kind = "invalid_type";
  } else if (error.keyword === "enum") {
    const allowed = (error.params as { allowedValues: unknown[] }).allowedValues;
    message = `expected one of ${allowed.map((v) => JSON.stringify(v)).join(", ")}`;
  } else if (error.keyword === "const") {
    message = `expected ${JSON.stringify((error.params as { allowedValue: unknown }).allowedValue)}`;
  }
  return { path, message, kind };
}

function prefix(head: ReadonlyArray<string | number>, issues: PathedIssue[]): PathedIssue[] {
  return issues.map((issue) => ({ ...issue, path: [...head, ...issue.path] }));
}

/** Validate one metadata field's configuration; recurse into nested pipelines. */
function validateField(
  point: Point,
  field: unknown,
  path: ReadonlyArray<string | number>,
): RegistryIssue[] {
  let name: string;
  let namePath: ReadonlyArray<string | number>;
  let configuration: unknown;
  if (typeof field === "string") {
    name = field;
    namePath = path;
    configuration = undefined;
  } else if (isPlainObject(field) && typeof field["name"] === "string") {
    name = field["name"];
    namePath = [...path, "name"];
    configuration = field["configuration"];
  } else {
    return []; // structurally invalid; the structural layer already reported it
  }
  const issues: RegistryIssue[] = [];
  if (!(name in registry[point])) {
    // The core spec's raw-bits data types are a pattern (r8, r16, ...), not
    // enumerable registry entries — recognized, nothing to validate.
    if (point === "data_type" && /^r[1-9][0-9]*$/.test(name)) return issues;
    const suggestions = nearMisses(point, name);
    if (suggestions.length > 0) {
      issues.push({
        path: namePath,
        message: `unknown ${POINT_NOUNS[point]} ${JSON.stringify(name)} — did you mean ${suggestions
          .map((s) => JSON.stringify(s))
          .join(" or ")}?`,
        kind: "invalid_value",
        suggestion: true,
      });
    }
    return issues; // nothing further to validate against
  }
  if (configuration === undefined) {
    if (configRequiredFor(point, name)) {
      // Anchored on the field itself (which exists) rather than the absent
      // configuration key, so the message stays specific instead of being
      // rewritten by the range-fallback machinery.
      const example = exampleFor(point, name);
      issues.push({
        path,
        message:
          `${JSON.stringify(name)} requires a configuration` +
          (example === undefined ? "" : `, e.g. "configuration": ${example}`),
        kind: "missing_key",
        documentation: documentationFor(point, name),
      });
    }
    return issues;
  }
  if (!isPlainObject(configuration)) return issues; // structural layer's problem
  const validator = configValidatorFor(point, name);
  if (validator !== undefined && !validator(configuration)) {
    const documentation = documentationFor(point, name);
    issues.push(
      ...prefix([...path, "configuration"], (validator.errors ?? []).map(toIssue)).map(
        (issue): RegistryIssue => ({ ...issue, documentation }),
      ),
    );
  }
  const nested = NESTED_PIPELINES.get(name);
  if (nested !== undefined) {
    for (const key of nested) {
      const pipeline = configuration[key];
      if (!Array.isArray(pipeline)) continue;
      pipeline.forEach((entry, index) => {
        issues.push(...validateField("codecs", entry, [...path, "configuration", key, index]));
      });
      issues.push(...validatePipeline(pipeline, [...path, "configuration", key]));
    }
  }
  return issues;
}

/**
 * Every configuration problem in a v3 array document's extension points,
 * as pathed issues ready for the shared diagnostics pipeline. Documents
 * that are not v3 arrays yield nothing.
 */
export function validateExtensionConfigurations(value: unknown): RegistryIssue[] {
  if (!isPlainObject(value) || value["node_type"] !== "array") return [];
  const issues: RegistryIssue[] = [];
  for (const point of ["data_type", "chunk_grid", "chunk_key_encoding"] as const) {
    if (point in value) issues.push(...validateField(point, value[point], [point]));
  }
  const codecs = value["codecs"];
  if (Array.isArray(codecs)) {
    codecs.forEach((entry, index) => {
      issues.push(...validateField("codecs", entry, ["codecs", index]));
    });
    issues.push(...validatePipeline(codecs, ["codecs"]));
  }
  return issues;
}
