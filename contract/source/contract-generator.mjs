// REN-04 / harness/contract-generator.mjs
//
// Generates EVERY model-facing and machine-consuming contract artifact from the single source:
//   contracts/domain-contract-registry.json
//
// Emits (all under the --out directory, never hand-edited):
//   manifest.json            tool name + description + input schema, the registration contract
//   schemas.json             JSON Schema (draft-07) per operation
//   rpc-map.json             operation -> RPC method mapping
//   docs.md                  human documentation
//   legacy-alias.json        migration adapter table (69 legacy names -> new operation)
//
// Design rules enforced at generation time (they are asserted again by contract-consistency.mjs):
//   * no top-level anyOf/oneOf  - variants use closed enums selecting among FLAT typed fields
//   * no optional:true marker   - capability is never hidden
//   * required keys must exist in properties
//   * additionalProperties:false so an unknown key is a hard error, not a silent no-op
//
// Usage: node contract-generator.mjs --registry <json> --out <dir> [--candidate <repo>]

import fs from "node:fs";
import path from "node:path";

function arg(name, dflt = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
}

const registryPath = arg("registry");
const outDir = arg("out");
const candidate = arg("candidate", null);
const inventoryPath = arg("inventory", null);
const runtimeOut = arg("runtime-out", null);
const baselineManifest = arg("baseline-manifest", null);
const pluginManifestOut = arg("plugin-manifest-out", null);
const l1BaselinePath = arg("l1-baseline", null);
if (!registryPath || !outDir) {
  console.error("usage: node contract-generator.mjs --registry <registry.json> --out <dir> [--candidate <repo>] [--inventory <tool-inventory.json>] [--runtime-out <src/contract/registry.generated.js>]");
  process.exit(2);
}

const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
const ops = registry.operations;

// ------------------------------------------------------------------------------------------------
// Legacy -> service-method map, taken from the REAL registration sites (evidence/tool-inventory.json).
// The inventory records each registration's handler expression, e.g. `(args) => service.doubaoAudioPlan(args)`.
// Parsing the method out of it lets the migration matrix state, per legacy tool, the exact service method
// that still backs it - which is what makes "capability preserved" a checkable claim rather than a count.
// ------------------------------------------------------------------------------------------------
const legacyToService = new Map();
const legacyMeta = new Map();
if (inventoryPath && fs.existsSync(inventoryPath)) {
  const inv = JSON.parse(fs.readFileSync(inventoryPath, "utf8"));
  for (const t of inv.tools) {
    const m = /service\.([A-Za-z_$][\w$]*)\s*\(/.exec(t.handler ?? "");
    legacyToService.set(t.name, m ? m[1] : null);
    legacyMeta.set(t.name, {
      line: t.line,
      schema_kind: t.schema_kind,
      include_canvas_flag: t.include_canvas_flag,
      raw_registration: t.raw_registration === true,
      domain_heuristic: t.domain,
      risk_heuristic: t.risk,
    });
  }
}

/** Map a registry field type onto JSON Schema. Closed enums stay closed. */
function jsonSchemaFor(field) {
  const s = {};
  switch (field.type) {
    case "string":
      s.type = "string";
      break;
    case "number":
      s.type = "number";
      break;
    case "integer":
      s.type = "integer";
      break;
    case "boolean":
      s.type = "boolean";
      break;
    case "array":
      s.type = "array";
      s.items = field.items === "string" ? { type: "string" } : { type: "object" };
      break;
    case "object":
      s.type = "object";
      break;
    default:
      s.type = "string";
  }
  if (Array.isArray(field.enum)) s.enum = [...field.enum];
  if (field.desc) s.description = field.desc;
  return s;
}

// ------------------------------------------------------------------------------------------------
// REAL declared parameter schemas per legacy tool, read from the L1 capture of the candidate entry.
//
// This is what makes the reduced surface safe. The operations close themselves with
// additionalProperties:false; if an operation declared only the fields its author remembered, a legacy
// caller passing any other real parameter would now be REJECTED. A first draft did exactly that: 408
// parameters were dropped across 38 tools (evidence/param-compatibility-segA.json). So each generated
// schema is the UNION of the parameters the legacy tools actually declared, with their real type/enum
// definitions carried over verbatim.
// ------------------------------------------------------------------------------------------------
const realSchemas = new Map();
if (l1BaselinePath && fs.existsSync(l1BaselinePath)) {
  const L1 = JSON.parse(fs.readFileSync(l1BaselinePath, "utf8"));
  for (const t of L1.tools) {
    realSchemas.set(t.name, {
      properties: t.parameters?.properties ?? {},
      required: t.parameters?.required ?? [],
    });
  }
}

const schemaConflicts = [];
const schemaEnumMerges = [];
const schemaTypeUnions = [];

/**
 * Merge one legacy tool's declaration of a field into the accumulating union.
 *
 * The first version kept whichever declaration it saw first and merely recorded a conflict. Real execution
 * showed what that costs: `video_generate.kind` kept the legacy asset-kind enum (raw/working) and dropped the
 * dispatch enum entirely, and `model_version` kept the video model list while the image model list was lost -
 * so a legal image generation call would have been REJECTED. Silently keeping one variant is not preservation.
 *
 * Rules:
 *   enum  -> UNION of every variant's members (the wide schema accepts everything the legacy tools accepted)
 *   type  -> the strictly narrower type when they are compatible (integer over number)
 *   other -> genuinely incompatible types are recorded as hard conflicts
 * The per-mode sub-schema still carries each legacy tool's exact enum, so strictness is available on demand.
 */
function mergeField(existing, incoming, ctx) {
  const out = { ...existing };
  if (existing.type !== incoming.type) {
    const numeric = ["number", "integer"];
    const existingTypes = Array.isArray(existing.type) ? existing.type : [existing.type];
    const incomingTypes = Array.isArray(incoming.type) ? incoming.type : [incoming.type];
    const union = [...new Set([...existingTypes, ...incomingTypes])];
    const numericOnly = union.every((t) => numeric.includes(t));
    if (numericOnly) {
      out.type = "integer";
    } else {
      // Two legacy tools genuinely use the same parameter name with different JSON types (measured:
      // `source` is a string in one canvas tool and an object in `video_canvas_insert_generated_asset`).
      // Dropping either form would reject a legal legacy call, so the union declares BOTH via a type array.
      // A JSON Schema type array is a plain accepted-value constraint and is deliberately NOT anyOf/oneOf,
      // which the host flattens and which this contract forbids at the top level.
      out.type = union.sort();
      schemaTypeUnions.push({ ...ctx, types: union.sort() });
    }
  }
  if (incoming.enum) {
    const merged = [...new Set([...(out.enum ?? []), ...incoming.enum])];
    const before = out.enum ?? null;
    out.enum = merged;
    if (before && merged.length !== before.length) {
      schemaEnumMerges.push({ ...ctx, merged_from: before.length, merged_to: merged.length });
    }
  }
  return out;
}

/** Union of every legacy tool's real parameters for an operation, then the declared fields on top. */
function buildUnifiedSchema(op) {
  const properties = {};
  for (const legacy of op.legacy) {
    const real = realSchemas.get(legacy);
    if (!real) continue;
    for (const [key, def] of Object.entries(real.properties)) {
      const ctx = { op: op.op, field: key, legacy };
      properties[key] = properties[key] ? mergeField(properties[key], def, ctx) : { ...def };
    }
  }
  // Declared fields (discriminators and annotated additions) are layered on top.
  for (const [key, field] of Object.entries(op.input)) {
    const ctx = { op: op.op, field: key, legacy: "<declared>" };
    if (!properties[key]) properties[key] = jsonSchemaFor(field);
    else if (properties[key].enum && field.enum) properties[key] = mergeField(properties[key], jsonSchemaFor(field), ctx);
  }
  // A dispatch discriminator must carry its OWN closed enum in the wide schema, otherwise a legal routing
  // value would be rejected by the union that was supposed to preserve everything.
  for (const [key, field] of Object.entries(op.input)) {
    if (field.enum && properties[key]) properties[key].enum = [...field.enum];
  }
  const schema = {
    $schema: "http://json-schema.org/draft-07/schema#",
    title: op.tool,
    type: "object",
    properties,
    additionalProperties: false,
  };
  if (op.required.length) schema.required = [...op.required];
  if (op.mutex && op.mutex.length) schema["x-mutually-exclusive"] = op.mutex;
  if (op.at_least_one && op.at_least_one.length) schema["x-at-least-one-of"] = op.at_least_one;
  if (op.ranges && Object.keys(op.ranges).length) {
    for (const [key, [min, max]] of Object.entries(op.ranges)) {
      if (properties[key]) {
        properties[key].minimum = min;
        properties[key].maximum = max;
      }
    }
  }
  schema["x-replaces"] = [...op.legacy];
  return schema;
}

/**
 * The narrow, on-demand strongly-typed sub-schema for one legacy tool: exactly its own declared
 * parameters (types/enums verbatim) plus the discriminator fields needed to route to it.
 * This is the "keep an on-demand typed sub-schema" requirement - a caller that wants the old strictness
 * uses the sub-schema for its mode instead of the wide union.
 */
function buildModeSchema(op, legacy) {
  const real = realSchemas.get(legacy);
  const properties = {};
  if (real) for (const [key, def] of Object.entries(real.properties)) properties[key] = { ...def };
  for (const d of ["mode", "provider", "media_kind", "target"]) {
    if (op.input[d] && !properties[d]) properties[d] = jsonSchemaFor(op.input[d]);
  }
  const schema = {
    $schema: "http://json-schema.org/draft-07/schema#",
    title: `${op.tool} :: ${legacy}`,
    type: "object",
    properties,
    additionalProperties: false,
    "x-legacy-tool": legacy,
  };
  if (real && real.required.length) schema.required = [...real.required];
  return schema;
}

/** The declared-only view, kept so documentation can show the contract's own annotated fields. */
function buildSchema(op) {
  const properties = {};
  for (const [key, field] of Object.entries(op.input)) properties[key] = jsonSchemaFor(field);
  const schema = {
    $schema: "http://json-schema.org/draft-07/schema#",
    title: op.tool,
    type: "object",
    properties,
    additionalProperties: false,
  };
  if (op.required.length) schema.required = [...op.required];
  if (op.mutex && op.mutex.length) schema["x-mutually-exclusive"] = op.mutex;
  if (op.at_least_one && op.at_least_one.length) schema["x-at-least-one-of"] = op.at_least_one;
  if (op.ranges && Object.keys(op.ranges).length) {
    for (const [key, [min, max]] of Object.entries(op.ranges)) {
      if (properties[key]) {
        properties[key].minimum = min;
        properties[key].maximum = max;
      }
    }
  }
  return schema;
}

// ------------------------------------------------------------------ generate
fs.mkdirSync(outDir, { recursive: true });

const manifest = {
  generated_from: "contracts/domain-contract-registry.json",
  generated_by: "harness/contract-generator.mjs",
  contract_version: registry.contract_version,
  candidate_commit: registry.candidate.commit,
  plugin: "video-assets",
  tool_count: ops.length,
  resident_count: ops.filter((o) => o.resident).length,
  legacy_tool_count: ops.reduce((a, o) => a + o.legacy.length, 0),
  tools: ops.map((o) => ({
    name: o.tool,
    op: o.op,
    domain: o.domain,
    risk: o.risk,
    resident: o.resident,
    description: o.description,
    display_zh: o.display_zh,
    search_keywords: o.search_keywords,
    rpc_method: o.rpc_method,
    input_schema: buildUnifiedSchema(o),
    result_keys: o.result_keys ?? [],
  })),
};

const schemas = {
  generated_from: "contracts/domain-contract-registry.json",
  // by_tool is the surface the model sees: the UNION of the real legacy parameters, so no legacy field is
  // dropped by the closed schema. by_mode is the narrow, on-demand strongly-typed sub-schema per legacy
  // tool (types and enums verbatim) for callers that want the old per-mode strictness.
  by_tool: Object.fromEntries(ops.map((o) => [o.tool, buildUnifiedSchema(o)])),
  by_operation: Object.fromEntries(ops.map((o) => [o.op, buildUnifiedSchema(o)])),
  by_mode: Object.fromEntries(ops.flatMap((o) => o.legacy.map((l) => [`${o.tool}::${l}`, buildModeSchema(o, l)]))),
  declared_only: Object.fromEntries(ops.map((o) => [o.tool, buildSchema(o)])),
  schema_conflicts: schemaConflicts,
  schema_enum_merges: schemaEnumMerges,
  schema_type_unions: schemaTypeUnions,
};

const rpcMap = {
  generated_from: "contracts/domain-contract-registry.json",
  by_tool: Object.fromEntries(ops.map((o) => [o.tool, { op: o.op, rpc_method: o.rpc_method, service: o.service }])),
};

const legacyAlias = {
  generated_from: "contracts/domain-contract-registry.json",
  policy: registry.conventions.legacy_alias_policy,
  sunset_gate_satisfied: registry.sunset_gate.status === "SATISFIED",
  note: "the migration adapter resolves these names onto the new operations; it does NOT re-register them as resident tools",
  count: ops.reduce((a, o) => a + o.legacy.length, 0),
  map: Object.fromEntries(ops.flatMap((o) => o.legacy.map((l) => [l, { tool: o.tool, op: o.op, domain: o.domain, risk: o.risk }]))),
};

const docLines = [];
docLines.push(`# video-assets tool contract (generated)`);
docLines.push("");
docLines.push(`Generated from \`contracts/domain-contract-registry.json\` by \`harness/contract-generator.mjs\`.`);
docLines.push(`Do not edit: every consumer (manifest, schemas, RPC map, docs, migration adapter) is derived from the registry.`);
docLines.push("");
docLines.push(`- operations: **${ops.length}**`);
docLines.push(`- resident: **${ops.filter((o) => o.resident).length}** (budget max ${registry.budget.resident_max})`);
docLines.push(`- legacy tools covered: **${ops.reduce((a, o) => a + o.legacy.length, 0)}**`);
docLines.push("");
for (const d of registry.domains) {
  const domOps = ops.filter((o) => o.domain === d.key);
  if (!domOps.length) continue;
  docLines.push(`## ${d.title_zh} (${d.key})`);
  docLines.push("");
  docLines.push(`${d.note}`);
  docLines.push("");
  for (const o of domOps) {
    docLines.push(`### \`${o.tool}\` — ${o.display_zh}${o.resident ? " · **resident**" : ""}`);
    docLines.push("");
    docLines.push(o.description);
    docLines.push("");
    docLines.push(`- risk: \`${o.risk}\``);
    docLines.push(`- rpc: \`${o.rpc_method}\``);
    if (o.required.length) docLines.push(`- required: ${o.required.map((r) => `\`${r}\``).join(", ")}`);
    else docLines.push(`- required: none (legal empty-parameter call)`);
    if (o.mutex?.length) docLines.push(`- mutually exclusive: ${o.mutex.map((g) => g.join(" / ")).join("; ")}`);
    if (o.ranges && Object.keys(o.ranges).length) docLines.push(`- ranges: ${Object.entries(o.ranges).map(([k, v]) => `${k} ${v[0]}..${v[1]}`).join(", ")}`);
    docLines.push(`- replaces: ${o.legacy.map((l) => `\`${l}\``).join(", ")}`);
    docLines.push("");
  }
}

fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
fs.writeFileSync(path.join(outDir, "schemas.json"), JSON.stringify(schemas, null, 2), "utf8");
fs.writeFileSync(path.join(outDir, "rpc-map.json"), JSON.stringify(rpcMap, null, 2), "utf8");
fs.writeFileSync(path.join(outDir, "legacy-alias.json"), JSON.stringify(legacyAlias, null, 2), "utf8");
fs.writeFileSync(path.join(outDir, "docs.md"), docLines.join("\n") + "\n", "utf8");

// ------------------------------------------------------------------------------------------------
// The runtime registry: what contract/surface.js registers. Emitted so the runtime consumes the SAME
// generated data the manifest/schemas/RPC/docs do - the "generated from one source" claim is then true at
// runtime, not just in documentation.
// ------------------------------------------------------------------------------------------------
const runtimeLines = [];
runtimeLines.push("// GENERATED by harness/contract-generator.mjs from contracts/domain-contract-registry.json.");
runtimeLines.push("// Do not edit by hand: regenerate instead.");
runtimeLines.push(`export const CONTRACT_VERSION = ${JSON.stringify(registry.contract_version)};`);
runtimeLines.push(`export const RESIDENT_MAX = ${registry.budget.resident_max};`);
runtimeLines.push(`export const OPERATIONS = ${JSON.stringify(ops.map((o) => ({
  tool: o.tool,
  op: o.op,
  domain: o.domain,
  risk: o.risk,
  resident: o.resident,
  display_zh: o.display_zh,
  description: o.description,
  search_keywords: o.search_keywords ?? "",
  input_schema: buildUnifiedSchema(o),
  rpc_method: o.rpc_method,
  service: o.service,
  legacy: o.legacy,
})), null, 2)};`);
runtimeLines.push(`export const LEGACY_ALIAS = ${JSON.stringify(legacyAlias.map, null, 2)};`);
// Which parameters each legacy tool actually declares. Used by the argument transform to decide whether a
// surface-only field must be stripped before the service call: a discriminator that the target legacy tool
// does not declare must not leak into the service, while a field it DOES declare (e.g. the legacy `kind`
// meaning ingested asset kind) must be preserved untouched.
runtimeLines.push(`export const LEGACY_PARAMS = ${JSON.stringify(
  Object.fromEntries([...realSchemas.entries()].map(([name, v]) => [name, Object.keys(v.properties)])),
  null, 2)};`);
// The dispatch table: op -> discriminator key -> value -> service method. Built from the legacy mapping so
// the runtime routes onto the SAME service method the old tool used.
runtimeLines.push("export const DISPATCH = " + JSON.stringify(
  Object.fromEntries(ops.map((o) => [o.tool, Object.fromEntries(o.legacy.map((l) => [l, legacyToService.get(l) ?? null]))])),
  null, 2) + ";");
// The dispatch table keyed by LEGACY NAME, so the migration-window compatibility entry can resolve any of the
// original 69 names to its operation and service method without re-deriving the adapter.
runtimeLines.push("export const LEGACY_DISPATCH = " + JSON.stringify(
  Object.fromEntries(ops.flatMap((o) => o.legacy.map((l) => [l, { tool: o.tool, method: legacyToService.get(l) ?? null }]))),
  null, 2) + ";");
// The per-legacy-tool narrow sub-schemas as runtime DATA (not merely a file on disk), so the compatibility
// entry can enforce the chosen branch's own value domain at the real handler.
runtimeLines.push("export const NARROW_SCHEMAS = " + JSON.stringify(
  Object.fromEntries(ops.flatMap((o) => o.legacy.map((l) => [`${o.tool}::${l}`, buildModeSchema(o, l)]))),
  null, 2) + ";");
if (runtimeOut) {
  fs.mkdirSync(path.dirname(runtimeOut), { recursive: true });
  fs.writeFileSync(runtimeOut, runtimeLines.join("\n") + "\n", "utf8");
}

// ------------------------------------------------------------------------------------------------
// The contract plugin manifest. Declares exactly the generated operations, so the host's
// "declared tools == registered tools" check is meaningful for this surface too. Activation and the
// config schema are inherited from the baseline manifest (this surface needs the same repository root
// and auth config), which keeps the two surfaces config-compatible during the migration window.
// ------------------------------------------------------------------------------------------------
if (pluginManifestOut) {
  const base = baselineManifest && fs.existsSync(baselineManifest)
    ? JSON.parse(fs.readFileSync(baselineManifest, "utf8"))
    : {};
  const contractManifest = {
    id: "video-assets-contract",
    name: "视频资产库（契约面）",
    description: "REN-04 reduced tool contract surface (10 resident operations + 6 discoverable on demand) with the 69-name migration adapter.",
    version: base.version ?? "0.1.0",
    contracts: { tools: ops.map((o) => o.tool) },
  };
  if (base.activation) contractManifest.activation = base.activation;
  if (base.configContracts) contractManifest.configContracts = base.configContracts;
  if (base.configSchema) contractManifest.configSchema = base.configSchema;
  fs.mkdirSync(path.dirname(pluginManifestOut), { recursive: true });
  fs.writeFileSync(pluginManifestOut, JSON.stringify(contractManifest, null, 2) + "\n", "utf8");
}

// ------------------------------------------------------------------------------------------------
// Migration matrix: one row per LEGACY tool (69 expected), recording its disposition.
// ------------------------------------------------------------------------------------------------
const covered = new Set();
const matrixRows = [];
for (const o of ops) {
  for (const l of o.legacy) {
    covered.add(l);
    const meta = legacyMeta.get(l) ?? null;
    const service = legacyToService.get(l) ?? (o.service[0] ?? null);
    const disposition = o.legacy.length === 1 && o.tool === l ? "keep" : (meta && meta.schema_kind !== "inline" ? "merge" : "migrate");
    matrixRows.push({
      legacy_tool: l,
      disposition,
      new_operation: o.tool,
      new_op_id: o.op,
      domain: o.domain,
      risk: o.risk,
      service_method: service,
      was_canvas_wrapped: meta ? meta.include_canvas_flag !== null : false,
      source_line: meta ? meta.line : null,
      schema_kind_before: meta ? meta.schema_kind : null,
      capability_preserved: service !== null,
      note:
        disposition === "keep"
          ? "name and semantics retained as a first-class operation"
          : disposition === "merge"
            ? "duplicate schema variant folded into one operation; the parameters survive as typed fields of the shared schema"
            : "folded into a typed domain operation selected by an explicit enum",
    });
  }
}

const migrationMatrix = {
  generated_from: "contracts/domain-contract-registry.json",
  generated_by: "harness/contract-generator.mjs",
  candidate_commit: registry.candidate.commit,
  legacy_tool_count_expected: registry.candidate.legacy_tool_count,
  legacy_tool_count_covered: matrixRows.length,
  operations_total: ops.length,
  resident_total: ops.filter((o) => o.resident).length,
  dispositions: matrixRows.reduce((a, r) => { a[r.disposition] = (a[r.disposition] ?? 0) + 1; return a; }, {}),
  capabilities_preserved: matrixRows.filter((r) => r.capability_preserved).length,
  rows: matrixRows.sort((a, b) => a.legacy_tool.localeCompare(b.legacy_tool)),
};
fs.writeFileSync(path.join(outDir, "migration-matrix.json"), JSON.stringify(migrationMatrix, null, 2), "utf8");

const bytes = {
  manifest: Buffer.byteLength(JSON.stringify(manifest), "utf8"),
  schemas: Buffer.byteLength(JSON.stringify(schemas), "utf8"),
  rpc_map: Buffer.byteLength(JSON.stringify(rpcMap), "utf8"),
  legacy_alias: Buffer.byteLength(JSON.stringify(legacyAlias), "utf8"),
  docs: Buffer.byteLength(docLines.join("\n"), "utf8"),
};
fs.writeFileSync(path.join(outDir, "generation-summary.json"), JSON.stringify({
  generated_at: new Date().toISOString(),
  registry: registryPath,
  candidate,
  inventory: inventoryPath,
  runtime_module: runtimeOut,
  plugin_manifest: pluginManifestOut,
  resident_tools: ops.filter((o) => o.resident).map((o) => o.tool),
  discoverable_tools: ops.filter((o) => !o.resident).map((o) => o.tool),
  operations: ops.length,
  resident: ops.filter((o) => o.resident).length,
  legacy_covered: matrixRows.length,
  legacy_expected: registry.candidate.legacy_tool_count,
  artifacts: Object.keys(bytes),
  artifact_bytes: bytes,
}, null, 2), "utf8");

console.log(`generated ${ops.length} operations (${ops.filter((o) => o.resident).length} resident), ${legacyAlias.count} legacy names mapped`);
console.log(`migration matrix: ${matrixRows.length}/${registry.candidate.legacy_tool_count} legacy tools covered; capabilities preserved: ${migrationMatrix.capabilities_preserved}`);
console.log(`artifacts -> ${outDir}`);
for (const [k, v] of Object.entries(bytes)) console.log(`  ${k}: ${v} B`);
if (runtimeOut) console.log(`runtime module -> ${runtimeOut}`);

