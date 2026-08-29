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

interface RegistrySchema {
  properties?: { configuration?: object };
  required?: string[];
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
): PathedIssue[] {
  let name: string;
  let configuration: unknown;
  if (typeof field === "string") {
    name = field;
    configuration = undefined;
  } else if (isPlainObject(field) && typeof field["name"] === "string") {
    name = field["name"];
    configuration = field["configuration"];
  } else {
    return []; // structurally invalid; the structural layer already reported it
  }
  const issues: PathedIssue[] = [];
  if (configuration === undefined) {
    if (configRequiredFor(point, name)) {
      issues.push({
        path: [...path, "configuration"],
        message: `missing required key ("${name}" requires a configuration)`,
        kind: "missing_key",
      });
    }
    return issues;
  }
  if (!isPlainObject(configuration)) return issues; // structural layer's problem
  const validator = configValidatorFor(point, name);
  if (validator !== undefined && !validator(configuration)) {
    issues.push(...prefix([...path, "configuration"], (validator.errors ?? []).map(toIssue)));
  }
  const nested = NESTED_PIPELINES.get(name);
  if (nested !== undefined) {
    for (const key of nested) {
      const pipeline = configuration[key];
      if (!Array.isArray(pipeline)) continue;
      pipeline.forEach((entry, index) => {
        issues.push(...validateField("codecs", entry, [...path, "configuration", key, index]));
      });
    }
  }
  return issues;
}

/**
 * Every configuration problem in a v3 array document's extension points,
 * as pathed issues ready for the shared diagnostics pipeline. Documents
 * that are not v3 arrays yield nothing.
 */
export function validateExtensionConfigurations(value: unknown): PathedIssue[] {
  if (!isPlainObject(value) || value["node_type"] !== "array") return [];
  const issues: PathedIssue[] = [];
  for (const point of ["data_type", "chunk_grid", "chunk_key_encoding"] as const) {
    if (point in value) issues.push(...validateField(point, value[point], [point]));
  }
  const codecs = value["codecs"];
  if (Array.isArray(codecs)) {
    codecs.forEach((entry, index) => {
      issues.push(...validateField("codecs", entry, ["codecs", index]));
    });
  }
  return issues;
}
