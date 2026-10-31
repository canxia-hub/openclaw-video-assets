import { execFile } from "node:child_process";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { trustedContextOf } from "./provider-gateway.js";
import { CANVAS_COMMANDS } from "./cli-command-catalog.js";

const LEGACY_READS = ["help", "version", "user_credit", "query_result", "list_task", "session list", "session search"];
const LEGACY_WRITES = ["login", "login checklogin", "logout", "relogin", "session create", "session rename", "session delete"];
const LEGACY_PAID = ["text2image", "image2image", "image_upscale", "text2video", "image2video", "frames2video", "multiframe2video", "multimodal2video"];
const TYPES = new Set(["dreamina", "dreamina_canvas"]);
const SECRET_FLAGS = /^(?:access[-_]token|refresh[-_]token|api[-_]key|password|secret|device[-_]code|credit[-_]token)$/i;
const GLOBALS = new Set(["format", "non-interactive", "yes", "profile", "region"]);
const ID_KEYS = new Set(["projectId", "nodeId", "resourceId", "submitId", "operationRef", "operationId", "requestId", "submit_id", "updateId"]);
const SCHEMA = `CREATE TABLE IF NOT EXISTS cli_bridge_operations(
  operation_key TEXT PRIMARY KEY, actor_id TEXT NOT NULL, provider TEXT NOT NULL, command TEXT NOT NULL,
  request_hash TEXT NOT NULL, state TEXT NOT NULL, identities_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
)`;
function fail(code, message, details) { return Object.assign(new Error(message), { code, details }); }
function checkedArgs(input) {
  if (!Array.isArray(input ?? [])) throw fail("CLI_ARGS_INVALID", "argv must be an array of strings");
  if ((input ?? []).length > 256 || (input ?? []).some(s => typeof s !== "string" || s.includes("\0") || s.length > 100000)) throw fail("CLI_ARGS_INVALID", "argv contains an invalid or oversized token");
  return [...(input ?? [])];
}
function flagValues(argv, known = null) {
  const found = new Map();
  for (let i = 0; i < argv.length; i++) {
    const item = argv[i];
    if (item === "--") throw fail("CLI_ARGS_INVALID", "end-of-options is not accepted; use canonical named flags");
    if (!item.startsWith("-")) continue;
    if (item === "-h") { found.set("help", ["true"]); continue; }
    if (!item.startsWith("--")) throw fail("CLI_FLAG_INVALID", "use canonical long flags, not short aliases");
    const equal = item.indexOf("=");
    const key = item.slice(2, equal < 0 ? undefined : equal);
    if (!/^[a-zA-Z][\w-]*$/.test(key)) throw fail("CLI_FLAG_INVALID", "invalid flag name");
    const definition = known?.get(key);
    if (known && !definition && key !== "help") throw fail("CLI_FLAG_UNKNOWN", "flag not declared by current CLI schema: --" + key);
    let value = equal < 0 ? null : item.slice(equal + 1);
    const boolean = definition?.type === "boolean" || ["run", "dry-run", "wait", "help"].includes(key);
    if (value === null) {
      if (boolean) value = "true";
      else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) value = argv[++i];
      else value = "true";
    }
    if (boolean && !/^(true|false|1|0|t|f)$/i.test(value)) throw fail("CLI_FLAG_INVALID", "invalid boolean flag --" + key);
    const values = found.get(key) ?? [];
    if (known && values.length && !definition?.type?.endsWith("[]")) throw fail("CLI_FLAG_DUPLICATE", "duplicate singleton flag --" + key);
    values.push(value); found.set(key, values);
  }
  return found;
}
const enabled = (flags, key) => flags.has(key) && /^(true|1|t)$/i.test(flags.get(key).at(-1));
function identities(value, out = {}) {
  if (!value || typeof value !== "object") return out;
  for (const [k, v] of Object.entries(value)) {
    if (ID_KEYS.has(k) && typeof v === "string" && v.length <= 500) out[k] = v;
    else if (v && typeof v === "object") identities(v, out);
  }
  return out;
}
function jsonOutput(stdout) {
  try { return JSON.parse(stdout); } catch { return { text: stdout }; }
}
function safeError(message) {
  return String(message).replace(/((?:access_token|refresh_token|api_key|password|device_code)[=:\s]+)[^\s,"]+/gi, "$1[redacted]").slice(0, 2000);
}
export function runCliProcess(executable, argv, { timeoutMs = 30000, signal } = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "", http_proxy: "", https_proxy: "", all_proxy: "" };
    execFile(executable, argv, { timeout: timeoutMs, signal, maxBuffer: 2 * 1024 * 1024, windowsHide: true, env, shell: false }, (error, stdout, stderr) => {
      if (error) {
        const err = fail(error.killed || error.code === "ABORT_ERR" ? "CLI_OUTCOME_UNCERTAIN" : "CLI_PROCESS_FAILED", safeError(stderr || error.message), { exit_code: error.code, killed: error.killed === true });
        err.cliResult = jsonOutput(stdout); reject(err);
      } else resolve({ stdout, stderr, exit_code: 0 });
    });
  });
}
export class CliBridge {
  constructor({ service, pluginConfig = {}, runner = runCliProcess }) {
    this.service = service; this.config = pluginConfig.cli ?? {}; this.runner = runner; this.catalog = null;
    const bin = path.join(process.env.USERPROFILE || process.env.HOME || process.cwd(), "bin");
    this.executables = { dreamina: this.config.dreaminaPath || path.join(bin, process.platform === "win32" ? "dreamina.exe" : "dreamina"), dreamina_canvas: this.config.canvasPath || path.join(bin, process.platform === "win32" ? "dreamina-canvas.exe" : "dreamina-canvas") };
    this.service.db.exec(SCHEMA);
    service.providerGateway.registerAdapter("dreamina_bridge", payload => this.runner(this.executables.dreamina, payload.argv, { timeoutMs: payload.timeoutMs }));
    service.providerGateway.registerAdapter("dreamina_canvas_cli", payload => this.runner(this.executables.dreamina_canvas, payload.argv, { timeoutMs: payload.timeoutMs }));
  }
  async liveCatalog(timeoutMs) {
    const response = await this.runner(this.executables.dreamina_canvas, ["--format", "json", "schema"], { timeoutMs });
    const schema = jsonOutput(response.stdout);
    if (schema.ok !== true || !schema.data) throw fail("CLI_SCHEMA_INVALID", "official CLI did not return a valid schema");
    const catalog = new Map();
    function visit(node, parents = []) {
      const name = node.name ?? node.command;
      const parts = typeof name === "string" ? [...parents, name] : parents;
      if (!node.subcommands?.length || node.flags?.length) catalog.set(parts.slice(1).join(" "), node);
      if (node.subcommands?.length) for (const child of node.subcommands) visit(child, parts);
    }
    visit(schema.data);
    catalog.set("help", { reads: true, writes: false, flags: [] });
    // CLI supports 'model <canonical>' as well as model list/find.
    if (!catalog.has("model")) catalog.set("model", { reads: true, writes: false, flags: [] });
    this.catalog = catalog;
    return catalog;
  }
  classify(provider, command, argv, catalog) {
    if (!TYPES.has(provider)) throw fail("CLI_PROVIDER_INVALID", "unknown CLI provider");
    if (provider === "dreamina") {
      if (![...LEGACY_READS, ...LEGACY_WRITES, ...LEGACY_PAID].includes(command)) throw fail("CLI_COMMAND_UNKNOWN", "unknown legacy CLI command; discover with help");
      const flags = flagValues(argv);
      if (enabled(flags, "help")) return { kind: "read", flags };
      return { kind: LEGACY_PAID.includes(command) ? "paid" : LEGACY_READS.includes(command) ? "read" : /delete|logout|relogin/.test(command) ? "destructive" : "write", flags };
    }
    const node = catalog.get(command);
    if (!node) throw fail("CLI_COMMAND_UNKNOWN", "command is not in the installed official CLI schema");
    const known = new Map((node.flags ?? []).map(f => [f.name, f]));
    const flags = flagValues(argv, known);
    for (const k of flags.keys()) if (GLOBALS.has(k)) throw fail("CLI_FLAG_RESERVED", "global flags are owned by the bridge; use profile/region fields");
    if (enabled(flags, "help")) return { kind: "read", flags };
    if (enabled(flags, "dry-run")) return { kind: "local-plan", flags };
    const paid = command === "node run" || command === "node upscale image" || command === "node promote video-sample" || enabled(flags, "run");
    return { kind: paid ? "paid" : command === "node confirm" ? "approval" : /^(node delete(?: confirm)?|auth logout)$/.test(command) ? "destructive" : node.writes ? "write" : "read", flags };
  }
  async run(provider, input = {}) {
    const command = String(input.command ?? "").trim().replace(/\s+/g, " ");
    if (!command || command.length > 100 || !/^[a-z][a-z0-9_ -]*$/i.test(command)) throw fail("CLI_COMMAND_INVALID", "command must be a canonical CLI command path");
    const argv = checkedArgs(input.argv);
    const timeoutMs = Math.min(120000, Math.max(1000, Number(input.timeout_ms) || 30000));
    if (provider === "dreamina" && (input.profile || input.region)) throw fail("CLI_PROFILE_MISMATCH", "official canvas profiles cannot be passed to the legacy CLI");
    for (const value of [input.profile, input.region].filter(v => v !== undefined)) if (typeof value !== "string" || !/^[A-Za-z0-9_.-]{1,80}$/.test(value)) throw fail("CLI_PROFILE_INVALID", "invalid profile/region");
    const cached = new Map(CANVAS_COMMANDS.map(c => [c.command, c]));
    cached.set("help", { reads: true, writes: false, flags: [] }); if(!cached.has("model")) cached.set("model", { reads: true, writes: false, flags: [] });
    let classification = this.classify(provider, command, argv, cached);
    const prefix = provider === "dreamina_canvas" ? ["--format", "json", "--non-interactive", ...(input.profile ? ["--profile", input.profile] : []), ...(input.region ? ["--region", input.region] : [])] : [];
    const execArgv = [...prefix, ...command.split(" "), ...argv];
    const plan = { provider, command, argv: argv.map((v, i) => SECRET_FLAGS.test((argv[i - 1] ?? "").replace(/^--/, "")) || /^(--(?:device[-_]code|access[-_]token|password))=/.test(v) ? "[redacted]" : v), classification: classification.kind, dry_run: input.execute !== true, internal_canvas_required: false, frontend_required: false };
    if (input.execute !== true) return { status: "planned", ...plan, ...(command === "help" ? { commands: provider === "dreamina" ? [...LEGACY_READS, ...LEGACY_WRITES, ...LEGACY_PAID] : [...cached.keys()] } : {}) };
    const context = trustedContextOf(input);
    const mutates = !["read", "local-plan"].includes(classification.kind);
    if (mutates && (!context?.trusted || !context.actor_id)) throw fail("CLI_TRUSTED_ACTOR_REQUIRED", "CLI mutations require a host-provided trusted actor");
    if ((classification.kind === "paid" || classification.kind === "approval") && input.accept_credit_spend !== true) throw fail("CLI_CREDIT_CONFIRMATION_REQUIRED", "explicit credit acceptance is required");
    if (classification.kind === "destructive" && input.confirm_destructive !== true) throw fail("CLI_DESTRUCTIVE_CONFIRMATION_REQUIRED", "destructive provider operation requires explicit confirmation");
    let operationKey = null;
    let replay = null;
    const requestHash = createHash("sha256").update(JSON.stringify({ provider, command, argv, profile: input.profile ?? null, region: input.region ?? null })).digest("hex");
    if (mutates) {
      if (typeof input.operation_key !== "string" || !/^[\w:.-]{1,200}$/.test(input.operation_key)) throw fail("CLI_OPERATION_KEY_REQUIRED", "a stable operation_key is required for mutations");
      operationKey = provider + ":" + context.actor_id + ":" + input.operation_key;
      replay = this.service.db.prepare("SELECT * FROM cli_bridge_operations WHERE operation_key=?").get(operationKey);
      if (!replay) {
        const at = new Date().toISOString();
        const knownIds = Object.fromEntries([["project-id","projectId"],["node-id","nodeId"],["submit-id","submitId"],["submit_id","submit_id"]].filter(([flag])=>classification.flags.has(flag)).map(([flag,key])=>[key,classification.flags.get(flag).at(-1)]));
        const claim=this.service.db.prepare("INSERT OR IGNORE INTO cli_bridge_operations(operation_key,actor_id,provider,command,request_hash,state,identities_json,created_at,updated_at) VALUES(?,?,?,?,?,\'preparing\',?,?,?)").run(operationKey,context.actor_id,provider,command,requestHash,JSON.stringify(knownIds),at,at);
        if(!claim.changes) replay=this.service.db.prepare("SELECT * FROM cli_bridge_operations WHERE operation_key=?").get(operationKey);
      }
      if (replay) {
        if (replay.request_hash !== requestHash) throw fail("CLI_OPERATION_KEY_CONFLICT", "operation_key was already used with different parameters");
        return { status: replay.state, reused: true, operation_key: input.operation_key, identities: JSON.parse(replay.identities_json), next_action: replay.state === "succeeded" ? "read existing provider resources; do not resubmit" : "query the same submitId / operationRef; do not create a new key to retry" };
      }
    }
    let authorization = null;
    let dispatched = false;
    try {
    if (provider === "dreamina_canvas") {
      const catalog = await this.liveCatalog(timeoutMs);
      classification = this.classify(provider, command, argv, catalog);
      // A changed release may change command effects; never run under stale classification.
      if (classification.kind !== plan.classification) throw fail("CLI_SCHEMA_CHANGED", "CLI command effects changed; inspect the new schema and re-plan");
    }
    if (classification.kind === "paid") {
      if (provider === "dreamina") {
        const flags = classification.flags;
        if (flags.has("poll") && flags.get("poll").some(v => Number(v) !== 0)) throw fail("CLI_ASYNC_REQUIRED", "paid legacy submission must use --poll=0, then query_result");
        if (!flags.has("poll")) execArgv.push("--poll=0");
        // Credential/balance check before authorization reservation and paid dispatch.
        const credit = await this.runner(this.executables.dreamina, ["user_credit"], { timeoutMs });
        const balance = jsonOutput(credit.stdout);
        if (balance.ok === false || balance.error || balance.code && balance.code !== 0) throw fail("CLI_PREFLIGHT_FAILED", "legacy CLI credit preflight failed");
      } else if (!classification.flags.has("submit-id") && command !== "node confirm") {
        throw fail("CLI_SUBMIT_ID_REQUIRED", "official paid operations require explicit stable submit-id values for recovery");
      }
    }
    if (classification.kind === "paid") {
      authorization = this.service.beginGeneration({ entry: provider === "dreamina" ? "dreamina.cli.execute" : "dreamina.canvas.execute", input });
      if (!authorization.allowed) { if(operationKey) this.update(operationKey,"blocked",{}); return { status: "blocked", ...plan, dry_run: false, authorization: authorization.public }; }
    }
    if (operationKey) this.update(operationKey, "dispatching", {});
    dispatched = true;
      const response = authorization ? await this.service.callProvider({ audit: authorization, provider: provider === "dreamina" ? "dreamina_bridge" : "dreamina_canvas_cli", payload: { argv: execArgv, timeoutMs } }) : await this.runner(this.executables[provider], execArgv, { timeoutMs });
      const result = jsonOutput(response.stdout);
      const ids = identities(result);
      // Exit 0 is not a completion proof: preserve provider error/processing states.
      const state = result.ok === false || result.error || result.gen_status === "fail" || result.code && result.code !== 0 ? "provider_rejected" : "succeeded";
      if (operationKey) this.update(operationKey, state, ids);
      return { status: state === "succeeded" && classification.kind === "paid" ? "submitted" : state, provider, command, operation_key: input.operation_key ?? null, identities: ids, result, note: classification.kind === "paid" ? "Submission is not final delivery. Read this same operation/task to terminal state and inspect its resources." : undefined };
    } catch (error) {
      const ids = identities(error.cliResult);
      if (operationKey) this.update(operationKey, dispatched ? "uncertain" : "not_submitted", ids);
      error.details = { ...(error.details ?? {}), ...(error.cliResult?.error ? { provider_error:error.cliResult.error } : {}), operation_key: input.operation_key, identities: ids, retry_policy: mutates ? "do not resubmit; recover this same provider operation" : "read may be retried" };
      throw error;
    } finally { if (authorization) this.service.finishGeneration(authorization); }
  }
  update(key, state, ids) { const prior=this.service.db.prepare("SELECT identities_json FROM cli_bridge_operations WHERE operation_key=?").get(key); ids={...JSON.parse(prior?.identities_json??"{}"),...ids}; this.service.db.prepare("UPDATE cli_bridge_operations SET state=?,identities_json=?,updated_at=? WHERE operation_key=?").run(state, JSON.stringify(ids), new Date().toISOString(), key); }
}
