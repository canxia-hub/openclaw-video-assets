// Headless asset service; legacy board data remains in the database, not in the runtime API.
import { DatabaseSync } from "node:sqlite";
import { execFile } from "node:child_process";
import fs from "node:fs";

import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { CREATE_SCHEMA_SQL } from "./schema.js";
import { NarrativeService } from "./narrative-service.js";
import { resolveUploadPolicy } from "./upload-policy.js";
import { UploadStore } from "./upload-store.js";
import { TransferGate } from "./upload-gate.js";
import { probeMedia, probeMediaAsync } from "./media-probe.js";
import { ensureRepositoryLayoutSync, getObjectPath, resolveRepositoryRoot, storeObject } from "./storage.js";
import { QueueError, checkStorageAvailability, objectPathForVersion } from "./derivation-queue.js";
import { DerivationError, cacheDirectoryFor, generateDerivation, planDerivation } from "./media-transcode.js";
import { DOUBAO_AUDIO_GUIDE_SOURCE, doubaoAudioNextActions, normalizeDoubaoAudioRequest, runDoubaoAudioGeneration, validateDoubaoAudioRequest } from "./doubao-audio-adapter.js";
import { KIE_SUNO_GUIDE_SOURCE, kieSunoNextActions, normalizeKieSunoRequest, runKieSunoGeneration, validateKieSunoRequest } from "./kie-suno-adapter.js";
import { GENERATION_ENTRY_POLICY, createPersistentBudgetLedger, ledgerBudgetsFromPolicy } from "./generation-policy.js";
import { ProviderGateway, PROVIDER_IDS, trustedContextOf, withTrustedContext } from "./provider-gateway.js";


import { GenerationJobQueue } from "./generation-jobs.js";


function runDreaminaCli(args, { timeoutMs = 180000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(DEFAULT_DREAMINA_CLI_PATH || "dreamina", args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        // REN-11 fix round (D3): attach the raw channels structurally. The message keeps them for a
        // human reader, but a caller that has to decide "the provider refused these parameters" vs
        // "the call produced no answer (and may have been charged)" cannot parse a prose blob.
        error.provider_cli = {
          executable: DEFAULT_DREAMINA_CLI_PATH || "dreamina",
          argv: args,
          exit_code: typeof error.code === "number" ? error.code : null,
          killed: error.killed === true,
          signal: error.signal ?? null,
          timed_out: error.killed === true,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? "")
        };
        error.message = `${error.message}\nstdout:\n${stdout}\nstderr:\n${stderr}`;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function runSqlScript(db, sql) {
  // Comments are stripped BEFORE splitting, because splitting first is wrong in a way that is easy to
  // miss: a semicolon inside a comment (an ordinary thing to write in prose) would cut a statement in
  // half and produce a confusing syntax error somewhere else entirely. Stripping first means the schema
  // file can explain itself without the explanations becoming part of the SQL grammar.
  const withoutComments = sql.replace(/--[^\n]*/g, "");
  for (const statement of withoutComments.split(";")) {
    const trimmed = statement.trim();
    if (trimmed) db.prepare(trimmed).run();
  }
}

function boundedRequiredString(value, name, maxLength) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new Error(`${name} must not be empty`);
  if (normalized.length > maxLength) throw new Error(`${name} must not exceed ${maxLength} characters`);
  return normalized;
}

const ASSET_TITLE_MAX_LENGTH = 512;

function boundedNullableString(value, name, maxLength) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  if (normalized.length > maxLength) throw new Error(`${name} must not exceed ${maxLength} characters`);
  return normalized || null;
}

const ASSET_DESCRIPTION_MAX_LENGTH = 65536;

function normalizeStringArray(value, name, options = {}) {
  if (value === undefined && options.allowUndefined) return [];
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  const seen = new Set();
  const result = [];
  for (const item of value) {
    const normalized = String(item ?? "").trim();
    if (options.maxLength && normalized.length > options.maxLength) throw new Error(`${name} items must not exceed ${options.maxLength} characters`);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  if (options.maxItems && result.length > options.maxItems) throw new Error(`${name} must contain at most ${options.maxItems} items`);
  return result;
}

const ASSET_TAG_MAX_ITEMS = 64;

const ASSET_TAG_MAX_LENGTH = 128;

function id(prefix) {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

function jsonOrNull(value) {
  return value === undefined ? null : JSON.stringify(value);
}

function clampInteger(value, min, max, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return number;
}

function assetFromRow(row) {
  return { ...row, tags: JSON.parse(row.tags_json || "[]") };
}

function versionFromRow(row) {
  return { ...row, source_version_ids: JSON.parse(row.source_version_ids_json || "[]") };
}

function derivedFileFromRow(row) {
  return { ...row, metadata: JSON.parse(row.metadata_json || "{}") };
}

function pushIntegrityIssue(issues, level, code, subject, message) {
  issues.push({
    level,
    code,
    project_id: subject.project_id ?? null,
    reference_id: subject.reference_id ?? null,
    asset_id: subject.asset_id ?? null,
    asset_version_id: subject.asset_version_id ?? null,
    derived_file_id: subject.derived_file_id ?? null,
    message
  });
}

function hashFileSync(filePath) {
  const hash = createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function normalizeTargetPlatforms(value) {
  if (value === null) return [];
  if (!Array.isArray(value)) throw new Error("target_platforms must be an array");
  return [...new Set(value.map((item) => String(item).trim()).filter(Boolean))].slice(0, 24);
}

function normalizeAspectRatio(value) {
  if (value === null) return null;
  const normalized = String(value ?? "").trim();
  if (!normalized) return null;
  if (!/^\d+(?:\.\d+)?:\d+(?:\.\d+)?$/.test(normalized)) throw new Error("aspect_ratio must look like 16:9 or 9:16");
  return normalized;
}

function normalizeResolution(value) {
  if (value === null) return null;
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return null;
  if (!/^\d{2,5}x\d{2,5}$/.test(normalized)) throw new Error("resolution must look like 1920x1080");
  return normalized;
}

function normalizeFps(value) {
  if (value === null) return null;
  const fps = Number(value);
  if (!Number.isFinite(fps) || fps <= 0 || fps > 240) throw new Error("fps must be a number between 0 and 240");
  return fps;
}

function pickProjectSpec(project) {
  return {
    target_platforms: project.target_platforms ?? [],
    aspect_ratio: project.aspect_ratio ?? null,
    resolution: project.resolution ?? null,
    fps: project.fps ?? null
  };
}

function pushIssue(issues, level, code, ref, message) {
  issues.push({
    level,
    code,
    reference_id: ref.reference_id,
    asset_id: ref.asset_id,
    asset_version_id: ref.asset_version_id,
    message
  });
}

function pickConfigSecretString(config, pathParts = []) {
  let cursor = config;
  for (const part of pathParts) {
    if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) return "";
    cursor = cursor[part];
  }
  return typeof cursor === "string" ? cursor.trim() : "";
}

function resolveDoubaoAudioOutputDir(value, root = process.cwd()) {
  if (value) return path.resolve(String(value));
  const stamp = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  return path.join(root, "output", `doubao-audio-${stamp}`);
}

function summarizeDoubaoProviderResult(result = {}) {
  return {
    provider: result.provider ?? null,
    backend: result.backend ?? null,
    status: result.status ?? null,
    platform_review_status: result.platform_review_status ?? null,
    task_id: result.task_id ?? null,
    created_at: result.created_at ?? null,
    completed_at: result.completed_at ?? null,
    output_count: Array.isArray(result.outputs) ? result.outputs.length : 0,
    cost: result.cost ?? null
  };
}

function resolveKieSunoOutputDir(value, root = process.cwd()) {
  if (value) return path.resolve(String(value));
  const stamp = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  return path.join(root, "output", `kie-suno-${stamp}`);
}

function summarizeKieSunoProviderResult(result = {}) {
  return {
    provider: result.provider ?? null,
    backend: result.backend ?? null,
    endpoint: result.endpoint ?? null,
    status: result.status ?? null,
    task_id: result.task_id ?? null,
    audio_ids: result.audio_ids ?? [],
    remote_url_count: Array.isArray(result.remote_urls) ? result.remote_urls.length : 0,
    output_count: Array.isArray(result.outputs) ? result.outputs.length : 0,
    created_at: result.created_at ?? null,
    completed_at: result.completed_at ?? null,
    cost: result.cost ?? null
  };
}

const FILE_ROOTS = Object.freeze({
  "asset-raw": { label: "原始素材", relativePath: "asset-repo/raw", kind: "asset" },
  "asset-working": { label: "工作素材", relativePath: "asset-repo/working", kind: "asset" },
  "asset-derived": { label: "派生素材", relativePath: "asset-repo/derived", kind: "asset" },
  "asset-staging": { label: "上传暂存", relativePath: "asset-repo/staging", kind: "asset" },
  "asset-archive": { label: "素材归档", relativePath: "asset-repo/archive", kind: "asset" },
  "project-active": { label: "活动项目", relativePath: "project-repo/active", kind: "project" },
  "project-archived": { label: "项目归档", relativePath: "project-repo/archived", kind: "project" },
  "cache-thumbnails": { label: "缩略图缓存", relativePath: "cache/thumbnails", kind: "cache" },
  "cache-proxies": { label: "代理缓存", relativePath: "cache/proxies", kind: "cache" }
});

function sanitizeFileName(value) {
  const base = path.basename(String(value)).replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim();
  return base && base !== "." && base !== ".." ? base.slice(0, 160) : "upload.bin";
}

function uniqueStagingName(fileName) {
  const ext = path.extname(fileName);
  const stem = path.basename(fileName, ext).slice(0, 96) || "upload";
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return `${stamp}-${randomUUID().slice(0, 8)}-${stem}${ext}`;
}

function isInsidePath(parent, child) {
  const parentPath = path.resolve(parent);
  const childPath = path.resolve(child);
  const relative = path.relative(parentPath, childPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function normalizeRelativePath(value) {
  return String(value ?? "").replaceAll("\\", "/").replace(/^\/+/, "");
}

function commitFromRow(row) {
  return { ...row, changes: JSON.parse(row.changes_json || "{}") };
}

function linkFromRow(row) {
  return { ...row, aliases: JSON.parse(row.aliases_json || "[]") };
}

function entityFromRow(row) {
  return { ...row, aliases: JSON.parse(row.aliases_json || "[]") };
}

function annotationFromRow(row) {
  return { ...row, structured: row.structured_json ? JSON.parse(row.structured_json) : null };
}

const KEY_DOMAINS = new Set(["character", "scene", "costume", "prop"]);

function pushContinuityIssue(issues, level, code, ref, message) {
  issues.push(makeContinuityIssue(level, code, ref, message));
}

function requiredAnnotationForDomain(domain) {
  return {
    character: "character_profile",
    scene: "scene_concept",
    costume: "costume_spec",
    prop: "prop_function"
  }[domain] ?? null;
}

function extractStructuredValues(annotations, key) {
  const values = [];
  for (const annotation of annotations ?? []) {
    const value = annotation.structured?.[key];
    if (Array.isArray(value)) values.push(...value.filter(Boolean).map(String));
    else if (value) values.push(String(value));
  }
  return [...new Set(values)];
}

function filterWaivedIssues(issues, annotations) {
  const active = [];
  const waived = [];
  for (const issue of issues) {
    if (isIssueWaived(issue, annotations)) waived.push({ ...issue, waived: true });
    else active.push(issue);
  }
  return { active, waived };
}

function makeContinuityIssue(level, code, ref, message) {
  return {
    level,
    code,
    reference_id: ref.reference_id,
    asset_id: ref.asset_id,
    asset_version_id: ref.asset_version_id,
    message
  };
}

function isIssueWaived(issue, annotations) {
  return waiverCodesFromAnnotations(annotations).has(issue.code);
}

function projectFromRow(row) {
  return { ...row, target_platforms: JSON.parse(row.target_platforms_json || "[]") };
}

const DEFAULT_ACTOR = "agent:unknown";

const MEDIA_METADATA_FIELDS = ["width", "height", "duration_ms", "frame_rate", "sample_rate", "channels", "codec"];

const LAZY_REPROBE_VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".m4v"]);

const VIDEO_METADATA_FIELDS = ["width", "height", "duration_ms", "frame_rate", "codec"];

const LICENSE_STATUSES = new Set(["unknown", "cleared", "restricted", "rejected"]);

const RISK_LEVELS = new Set(["unknown", "low", "medium", "high"]);

const DOMAINS = new Set(["character", "scene", "costume", "prop", "audio", "reference", "prompt", "document", "delivery", "other"]);

const DERIVATIVE_TYPES = new Set(["thumbnail", "proxy", "transcode", "audio_proxy", "subtitle", "waveform", "contact_sheet", "metadata", "other"]);

function objectIdFromObjectPath(root, absolutePath) {
  const objectRoot = path.resolve(root, "asset-repo", "objects", "sha256");
  const resolved = path.resolve(absolutePath);
  if (!isInsidePath(objectRoot, resolved)) return null;
  const basename = path.basename(resolved);
  if (!/^[a-f0-9]{64}\.blob$/.test(basename)) return null;
  return `sha256:${basename.slice(0, 64)}`;
}

const VIDEO_ASSETS_WIDGET_URI = "ui://widget/video-assets/canvas.html";

const VIDEO_ASSETS_WORKBENCH_URL = "/__openclaw__/video-assets/workbench/";

const DEFAULT_DREAMINA_CLI_PATH = path.join(process.env.USERPROFILE ?? process.env.HOME ?? "", "bin", "dreamina.exe");

function waiverCodesFromAnnotations(annotations) {
  const codes = new Set();
  for (const annotation of annotations ?? []) {
    const structured = annotation.structured ?? {};
    for (const key of ["waives_issues", "waived_issues", "waiver_codes", "waives"] ) {
      const value = structured[key];
      if (Array.isArray(value)) for (const code of value) codes.add(String(code));
      else if (value) codes.add(String(value));
    }
    if (structured.waiver?.code) codes.add(String(structured.waiver.code));
    if (Array.isArray(structured.waiver?.codes)) for (const code of structured.waiver.codes) codes.add(String(code));
  }
  return codes;
}
export class VideoAssetService {
constructor({ pluginConfig = {}, logger = console, providerAdapters = null, budgetLedger = null, generationJobAdapter = null, downloadFetchImpl = null } = {}) {
    this.root = resolveRepositoryRoot(pluginConfig);
    this.pluginConfig = pluginConfig && typeof pluginConfig === "object" ? pluginConfig : {};
    this.logger = logger;
    this.db = null;
    this.generationJobAdapter = generationJobAdapter;
    this.generationJobs = null;
    // REN-11 fix round (D4): the provider-media downloader's fetch, injectable for the same reason the
    // job adapter's `fetchImpl` is - a deployment that must survive signed-object stalls can supply its
    // own retrying implementation (the live run lost a paid download to one hung object and had to build
    // that out of band). Defaults to the platform fetch.
    this.downloadFetchImpl = typeof downloadFetchImpl === "function" ? downloadFetchImpl : null;
    // REN-02: every paid provider call goes through this gateway. Adapters are replaceable so the
    // gate can be proven with zero-cost spies, and so a deployment can point at a different
    // executable without touching the policy code.
    this.providerGateway = new ProviderGateway({
      config: this.pluginConfig.security ?? {},
      adapters: {
        [PROVIDER_IDS.DREAMINA_CLI]: ({ argv, timeoutMs }) => runDreaminaCli(argv, { timeoutMs }),
        [PROVIDER_IDS.DOUBAO_AUDIO]: ({ request, outputDir, apiKey }) => runDoubaoAudioGeneration(request, { outputDir, apiKey }),
        [PROVIDER_IDS.KIE_SUNO]: ({ request, outputDir, apiKey }) => runKieSunoGeneration(request, { outputDir, apiKey }),
        ...(providerAdapters ?? {})
      },
      ledger: budgetLedger,
      logger: {
        warn: (...args) => this.logger?.warn?.(...args),
        error: (...args) => this.logger?.error?.(...args),
        info: (...args) => this.logger?.debug?.(...args)
      }
    });
  }

init() {
    ensureRepositoryLayoutSync(this.root);
    this.db = new DatabaseSync(path.join(this.root, "metadata", "video-assets.sqlite"));
    runSqlScript(this.db, CREATE_SCHEMA_SQL);
    this.ensureSchemaMigrations();
    this.narrative = new NarrativeService(this);
    // REN-06: the upload subsystem lives on the service so that every entry point - the streaming route
    // and the legacy staging helper alike - is bounded by the SAME policy object. A second copy of the
    // limits would mean two answers to "how big may this be", which is how a bypass appears.
    this.uploadPolicy = resolveUploadPolicy(this.pluginConfig);
    this.uploadStore = new UploadStore({ db: this.db, root: this.root, policy: this.uploadPolicy, service: this });
    this.uploadGate = new TransferGate({
      concurrency: this.uploadPolicy.maxConcurrentTransfers,
      maxQueue: this.uploadPolicy.maxQueuedTransfers
    });
    this.generationJobs = new GenerationJobQueue({
      db: this.db,
      config: this.pluginConfig.generationJobs ?? {},
      adapter: this.generationJobAdapter,
      entryPolicy: GENERATION_ENTRY_POLICY
    });
    // REN-12 finding F3: with `ledger: "persistent"` the gateway's budget port reads and writes REN-10's
    // durable `generation_budget_ledger` table - the same rows the queue creates per job. The ledger needs
    // the database handle, which only exists here, so it is attached after the schema is in place. Until
    // then the gate stays fail-closed (BUDGET_LEDGER_MISSING), never "budget skipped".
    const gatewayPolicy = this.providerGateway.policy;
    if (gatewayPolicy.ledger === "persistent") {
      this.providerGateway.setLedger(createPersistentBudgetLedger({
        db: this.db,
        budgets: ledgerBudgetsFromPolicy(gatewayPolicy)
      }));
    }
    return this;
  }

close() {
    this.narrative?.jobs.dispose();
    this.db?.close();
    this.db = null;
  }

novelDocument(input) { this.requireDb(); return this.narrative.document(input); }

novelWorkflow(input) { this.requireDb(); return this.narrative.workflow(input); }

novelAdaptation(input) { this.requireDb(); return this.narrative.adaptation(input); }

novelGenerate(input) { this.requireDb(); return this.narrative.jobs.dispatch(input); }

setGenerationJobAdapter(adapter) {
    this.generationJobAdapter = adapter;
    this.generationJobs?.setAdapter(adapter);
    return this;
  }

createGenerationJob(input = {}) {
    this.requireDb();
    const context = trustedContextOf(input);
    return this.generationJobs.create({ ...input, surface: context?.surface ?? "gateway" }, context);
  }

getGenerationJob(input = {}) { this.requireDb(); return this.generationJobs.getForCaller(input, trustedContextOf(input)); }

listGenerationJobs(input = {}) { this.requireDb(); return this.generationJobs.listForCaller(input, trustedContextOf(input)); }

generationJobEvents(input = {}) { this.requireDb(); return this.generationJobs.eventsForCaller(input, trustedContextOf(input)); }

processGenerationJob(input = {}) { this.requireDb(); return this.generationJobs.process(input.job_id, trustedContextOf(input)); }

reconcileGenerationJob(input = {}) { this.requireDb(); return this.generationJobs.reconcile(input.job_id, trustedContextOf(input)); }

resumeGenerationJob(input = {}) { this.requireDb(); return this.generationJobs.resume(input.job_id, trustedContextOf(input)); }

cancelGenerationJob(input = {}) { this.requireDb(); return this.generationJobs.cancel(input.job_id, trustedContextOf(input)); }

async ingestAsset(input) {
    this.requireDb();
    if (!input?.file_path) throw new Error("file_path is required");
    const title = boundedRequiredString(input.title ?? path.basename(String(input.file_path)), "title", ASSET_TITLE_MAX_LENGTH);
    const description = boundedNullableString(input.description, "description", ASSET_DESCRIPTION_MAX_LENGTH);
    const tags = normalizeStringArray(input.tags ?? [], "tags", { maxItems: ASSET_TAG_MAX_ITEMS, maxLength: ASSET_TAG_MAX_LENGTH });
    const kind = input.kind === "working" ? "working" : "raw";
    const actor = this.ensureActor(this.resolveRequestActor(input).actor_id, this.resolveRequestActor(input).actor_type);
    const now = new Date().toISOString();
    const stored = await storeObject(this.root, input.file_path);
    const probe = await probeMediaAsync(input.file_path);
    const asset_id = id("asset");
    const asset_version_id = id("ver");
    const branch_id = id("branch");

    this.db.prepare(`INSERT INTO assets (asset_id, kind, media_type, format_family, title, description, lifecycle, default_version_id, root_asset_id, tags_json, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`)
      .run(asset_id, kind, probe.media_type, probe.format_family, title, description, asset_version_id, asset_id, JSON.stringify(tags), actor.actor_id, now, now);

    this.db.prepare(`INSERT INTO asset_versions (asset_version_id, asset_id, branch_id, version_label, object_id, file_name, extension, mime_type, container, size_bytes, sha256, width, height, duration_ms, frame_rate, sample_rate, channels, codec, change_summary, parent_version_id, created_by, created_at)
      VALUES (?, ?, ?, 'v001', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`)
      .run(asset_version_id, asset_id, branch_id, stored.object_id, stored.file_name, probe.extension, probe.mime_type, probe.container, stored.size_bytes, stored.sha256, probe.width ?? null, probe.height ?? null, probe.duration_ms ?? null, probe.frame_rate ?? null, probe.sample_rate ?? null, probe.channels ?? null, probe.codec ?? null, input.change_summary ?? "初次入库", actor.actor_id, now);

    this.db.prepare(`INSERT INTO asset_branches (branch_id, asset_id, name, description, base_version_id, head_version_id, created_by, created_at, updated_at)
      VALUES (?, ?, 'main', ?, ?, ?, ?, ?, ?)`)
      .run(branch_id, asset_id, "Default branch", asset_version_id, asset_version_id, actor.actor_id, now, now);

    if (input.source?.source_type) {
      this.db.prepare(`INSERT INTO asset_sources (source_id, asset_id, source_type, url, captured_at, notes)
        VALUES (?, ?, ?, ?, ?, ?)`)
        .run(id("source"), asset_id, input.source.source_type, input.source.url ?? null, now, input.source.notes ?? null);
    }

    this.commit({ scope: "asset", target_id: asset_id, action: "asset.create", message: `已入库素材：${title}`, actor_id: actor.actor_id, changes: { asset_version_id, sha256: stored.sha256 } });
    return this.getAsset({ asset_id });
  }

async createVersion(input) {
    this.requireDb();
    if (!input?.asset_id) throw new Error("asset_id is required");
    if (!input?.file_path) throw new Error("file_path is required");
    if (!Array.isArray(input.change_items) || input.change_items.length === 0) {
      throw new Error("change_items is required and must not be empty");
    }
    const asset = this.requireAsset(input.asset_id);
    const actor = this.ensureActor(this.resolveRequestActor(input).actor_id, this.resolveRequestActor(input).actor_type);
    const now = new Date().toISOString();
    const stored = await storeObject(this.root, input.file_path);
    const probe = probeMedia(input.file_path);
    const asset_version_id = id("ver");
    const branch_id = input.branch_id ?? this.getMainBranch(input.asset_id)?.branch_id ?? null;
    const parent_version_id = input.parent_version_id ?? asset.default_version_id;
    const version_label = input.version_label ?? this.nextVersionLabel(input.asset_id);

    if (branch_id) this.requireBranchForAsset(branch_id, input.asset_id);
    if (parent_version_id) this.requireVersionForAsset(parent_version_id, input.asset_id, "parent_version_id");

    this.db.prepare(`INSERT INTO asset_versions (asset_version_id, asset_id, branch_id, version_label, object_id, file_name, extension, mime_type, container, size_bytes, sha256, width, height, duration_ms, frame_rate, sample_rate, channels, codec, change_summary, parent_version_id, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(asset_version_id, input.asset_id, branch_id, version_label, stored.object_id, stored.file_name, probe.extension, probe.mime_type, probe.container, stored.size_bytes, stored.sha256, probe.width ?? null, probe.height ?? null, probe.duration_ms ?? null, probe.frame_rate ?? null, probe.sample_rate ?? null, probe.channels ?? null, probe.codec ?? null, input.change_summary, parent_version_id, actor.actor_id, now);

    for (const item of input.change_items) {
      this.db.prepare(`INSERT INTO asset_version_changes (change_id, asset_version_id, category, summary, before_json, after_json, tool, parameters_json, actor_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id("chg"), asset_version_id, item.category ?? "other", item.summary, jsonOrNull(item.before), jsonOrNull(item.after), item.tool ?? null, jsonOrNull(item.parameters), actor.actor_id, now);
    }

    if (input.set_as_default !== false) {
      this.db.prepare("UPDATE assets SET default_version_id = ?, updated_at = ? WHERE asset_id = ?").run(asset_version_id, now, input.asset_id);
    }
    if (branch_id) {
      this.db.prepare("UPDATE asset_branches SET head_version_id = ?, updated_at = ? WHERE branch_id = ?").run(asset_version_id, now, branch_id);
    }

    this.commit({ scope: "asset", target_id: input.asset_id, action: "asset.version.create", message: input.change_summary, actor_id: actor.actor_id, changes: { asset_version_id, parent_version_id, branch_id } });
    return this.getAsset({ asset_id: input.asset_id });
  }

createBranch(input) {
    this.requireDb();
    if (!input?.asset_id) throw new Error("asset_id is required");
    if (!input?.base_version_id) throw new Error("base_version_id is required");
    if (!input?.name) throw new Error("name is required");
    this.requireAsset(input.asset_id);
    this.requireVersionForAsset(input.base_version_id, input.asset_id, "base_version_id");
    const actor = this.ensureActor(this.resolveRequestActor(input).actor_id, this.resolveRequestActor(input).actor_type);
    const now = new Date().toISOString();
    const branch_id = id("branch");
    this.db.prepare(`INSERT INTO asset_branches (branch_id, asset_id, name, description, base_version_id, head_version_id, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(branch_id, input.asset_id, input.name, input.description ?? null, input.base_version_id, input.base_version_id, actor.actor_id, now, now);
    this.commit({ scope: "asset", target_id: input.asset_id, action: "asset.branch.create", message: `已创建素材分支：${input.name}`, actor_id: actor.actor_id, changes: { branch_id, base_version_id: input.base_version_id } });
    return { branch_id, asset_id: input.asset_id, name: input.name, base_version_id: input.base_version_id, head_version_id: input.base_version_id };
  }

saveCopy(input) {
    this.requireDb();
    if (!input?.source_asset_id) throw new Error("source_asset_id is required");
    if (!input?.source_version_id) throw new Error("source_version_id is required");
    if (!input?.copy_type) throw new Error("copy_type is required");
    const sourceAsset = this.requireAsset(input.source_asset_id, "source_asset_id");
    const sourceVersion = this.requireVersionForAsset(input.source_version_id, input.source_asset_id, "source_version_id");
    const actor = this.ensureActor(this.resolveRequestActor(input).actor_id, this.resolveRequestActor(input).actor_type);
    const now = new Date().toISOString();
    const asset_id = id("asset");
    const asset_version_id = id("ver");
    const branch_id = id("branch");
    const relation_id = id("rel");
    const title = input.title ?? `${sourceAsset.title} copy`;

    this.db.prepare(`INSERT INTO assets (asset_id, kind, media_type, format_family, title, description, lifecycle, default_version_id, root_asset_id, tags_json, risk_level, license_status, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(asset_id, sourceAsset.kind === "raw" ? "working" : sourceAsset.kind, sourceAsset.media_type, sourceAsset.format_family, title, input.reason ?? null, asset_version_id, sourceAsset.root_asset_id ?? sourceAsset.asset_id, sourceAsset.tags_json, sourceAsset.risk_level, sourceAsset.license_status, actor.actor_id, now, now);
    this.db.prepare(`INSERT INTO asset_versions (asset_version_id, asset_id, branch_id, version_label, object_id, file_name, extension, mime_type, container, size_bytes, sha256, width, height, duration_ms, frame_rate, sample_rate, channels, codec, change_summary, parent_version_id, source_version_ids_json, created_by, created_at)
      VALUES (?, ?, ?, 'v001', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(asset_version_id, asset_id, branch_id, sourceVersion.object_id, sourceVersion.file_name, sourceVersion.extension, sourceVersion.mime_type, sourceVersion.container, sourceVersion.size_bytes, sourceVersion.sha256, sourceVersion.width ?? null, sourceVersion.height ?? null, sourceVersion.duration_ms ?? null, sourceVersion.frame_rate ?? null, sourceVersion.sample_rate ?? null, sourceVersion.channels ?? null, sourceVersion.codec ?? null, input.reason ?? `已保存素材副本：${input.copy_type}`, input.source_version_id, JSON.stringify([input.source_version_id]), actor.actor_id, now);
    this.db.prepare(`INSERT INTO asset_branches (branch_id, asset_id, name, description, base_version_id, head_version_id, created_by, created_at, updated_at)
      VALUES (?, ?, 'main', ?, ?, ?, ?, ?, ?)`)
      .run(branch_id, asset_id, input.copy_type, asset_version_id, asset_version_id, actor.actor_id, now, now);
    this.db.prepare(`INSERT INTO asset_relations (relation_id, relation_type, source_asset_id, source_version_id, target_asset_id, target_version_id, copy_type, reason, created_by, created_at)
      VALUES (?, 'copied_from', ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(relation_id, input.source_asset_id, input.source_version_id, asset_id, asset_version_id, input.copy_type, input.reason ?? null, actor.actor_id, now);
    this.commit({ scope: "asset", target_id: asset_id, action: "asset.copy.create", message: input.reason ?? `已保存素材副本：${input.copy_type}`, actor_id: actor.actor_id, changes: { relation_id, source_asset_id: input.source_asset_id, source_version_id: input.source_version_id } });
    return { asset_id, asset_version_id, relation_id };
  }

searchAssets(input = {}) {
    this.requireDb();
    const limit = clampInteger(input.limit ?? 20, 1, 100, "limit");
    const offset = clampInteger(input.offset ?? 0, 0, 100000, "offset");
    const query = String(input.query ?? "").trim().toLowerCase();
    const where = ["lifecycle != 'soft_deleted'"];
    const params = [];
    if (query) {
      where.push("(instr(lower(title), ?) > 0 OR instr(lower(COALESCE(description, '')), ?) > 0 OR instr(lower(asset_id), ?) > 0)");
      params.push(query, query, query);
    }
    const rows = this.db.prepare(`SELECT * FROM assets WHERE ${where.join(" AND ")} ORDER BY updated_at DESC, asset_id DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
    return rows.map(assetFromRow);
  }

getAsset(input) {
    this.requireDb();
    const row = this.getAssetRow(input.asset_id);
    if (!row) throw new Error(`Asset not found: ${input.asset_id}`);
    const versions = this.db.prepare("SELECT * FROM asset_versions WHERE asset_id = ? ORDER BY created_at ASC").all(input.asset_id).map((version) => versionFromRow(this.lazyReprobeVersion(version)));
    const branches = this.db.prepare("SELECT * FROM asset_branches WHERE asset_id = ? ORDER BY created_at ASC").all(input.asset_id);
    return { ...assetFromRow(row), versions, branches, sources: this.listAssetSources(input.asset_id) };
  }

updateAssetMetadata(input = {}) {
    this.requireDb();
    if (!input.asset_id) throw new Error("asset_id is required");
    const asset = this.requireAsset(input.asset_id);
    const actor = this.ensureActor(this.resolveRequestActor(input).actor_id, this.resolveRequestActor(input).actor_type);
    const now = new Date().toISOString();
    const updates = {};

    if (input.title !== undefined) {
      updates.title = boundedRequiredString(input.title, "title", ASSET_TITLE_MAX_LENGTH);
    }
    if (input.description !== undefined) {
      updates.description = boundedNullableString(input.description, "description", ASSET_DESCRIPTION_MAX_LENGTH);
    }
    if (input.tags !== undefined) {
      updates.tags_json = JSON.stringify(normalizeStringArray(input.tags, "tags", { maxItems: ASSET_TAG_MAX_ITEMS, maxLength: ASSET_TAG_MAX_LENGTH }));
    }
    if (Object.keys(updates).length === 0) throw new Error("title, description, or tags is required");

    const before = {
      title: asset.title,
      description: asset.description,
      tags: JSON.parse(asset.tags_json || "[]")
    };
    const fields = Object.keys(updates);
    const setSql = fields.map((field) => `${field} = ?`).join(", ");
    this.db.prepare(`UPDATE assets SET ${setSql}, updated_at = ? WHERE asset_id = ?`).run(...fields.map((field) => updates[field]), now, input.asset_id);

    const updated = this.getAssetRow(input.asset_id);
    const after = {
      title: updated.title,
      description: updated.description,
      tags: JSON.parse(updated.tags_json || "[]")
    };
    this.commit({
      scope: "asset",
      target_id: input.asset_id,
      action: "asset.metadata.update",
      message: input.notes ?? `已更新素材元数据：${asset.title}`,
      actor_id: actor.actor_id,
      changes: { before, after }
    });
    return { asset: assetFromRow(updated), updated_fields: fields.map((field) => field === "tags_json" ? "tags" : field) };
  }

updateAssetRights(input = {}) {
    this.requireDb();
    if (!input.asset_id) throw new Error("asset_id is required");
    const asset = this.requireAsset(input.asset_id);
    const actor = this.ensureActor(this.resolveRequestActor(input).actor_id, this.resolveRequestActor(input).actor_type);
    const now = new Date().toISOString();
    const updates = {};

    if (input.license_status !== undefined) updates.license_status = this.validateLicenseStatus(input.license_status);
    if (input.risk_level !== undefined) updates.risk_level = this.validateRiskLevel(input.risk_level);
    if (Object.keys(updates).length === 0 && !input.source?.source_type) throw new Error("license_status, risk_level, or source is required");

    if (Object.keys(updates).length > 0) {
      const fields = Object.keys(updates);
      const setSql = fields.map((field) => `${field} = ?`).join(", ");
      this.db.prepare(`UPDATE assets SET ${setSql}, updated_at = ? WHERE asset_id = ?`).run(...fields.map((field) => updates[field]), now, input.asset_id);
    }

    let source = null;
    if (input.source?.source_type) {
      source = {
        source_id: id("source"),
        asset_id: input.asset_id,
        source_type: String(input.source.source_type),
        url: input.source.url ?? null,
        captured_at: input.source.captured_at ?? now,
        original_author: input.source.original_author ?? null,
        license_hint: input.source.license_hint ?? null,
        retrieval_method: input.source.retrieval_method ?? null,
        notes: input.source.notes ?? null
      };
      this.db.prepare(`INSERT INTO asset_sources (source_id, asset_id, source_type, url, captured_at, original_author, license_hint, retrieval_method, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(source.source_id, source.asset_id, source.source_type, source.url, source.captured_at, source.original_author, source.license_hint, source.retrieval_method, source.notes);
    }

    this.commit({
      scope: "asset",
      target_id: input.asset_id,
      action: "asset.rights.update",
      message: input.notes ?? `已更新素材授权信息：${asset.title}`,
      actor_id: actor.actor_id,
      changes: { before: { license_status: asset.license_status, risk_level: asset.risk_level }, after: updates, source_id: source?.source_id ?? null }
    });
    return { asset: assetFromRow(this.getAssetRow(input.asset_id)), sources: this.listAssetSources(input.asset_id) };
  }

lineage(input) {
    this.requireDb();
    const asset_id = input.asset_id;
    const asset = this.getAssetRow(asset_id);
    if (!asset) throw new Error(`Asset not found: ${asset_id}`);
    const branches = this.db.prepare("SELECT * FROM asset_branches WHERE asset_id = ?").all(asset_id);
    const versions = this.db.prepare("SELECT * FROM asset_versions WHERE asset_id = ? ORDER BY created_at ASC").all(asset_id).map((version) => versionFromRow(this.lazyReprobeVersion(version)));
    const outgoing = this.db.prepare("SELECT * FROM asset_relations WHERE source_asset_id = ? ORDER BY created_at ASC").all(asset_id);
    const incoming = this.db.prepare("SELECT * FROM asset_relations WHERE target_asset_id = ? ORDER BY created_at ASC").all(asset_id);
    return { asset: assetFromRow(asset), branches, versions, outgoing, incoming };
  }

async registerDerivedFile(input) {
    this.requireDb();
    if (!input?.asset_id) throw new Error("asset_id is required");
    if (!input?.asset_version_id) throw new Error("asset_version_id is required");
    if (!input?.file_path) throw new Error("file_path is required");
    if (!input?.derivative_type) throw new Error("derivative_type is required");
    this.requireAsset(input.asset_id);
    this.requireVersionForAsset(input.asset_version_id, input.asset_id, "asset_version_id");
    const derivative_type = this.validateDerivativeType(input.derivative_type);
    const actor = this.ensureActor(this.resolveRequestActor(input).actor_id, this.resolveRequestActor(input).actor_type);
    const now = new Date().toISOString();
    const stored = await storeObject(this.root, input.file_path);
    const probe = await probeMediaAsync(input.file_path);
    // LAST-MOMENT CHECKPOINT. The caller may have been told this derivation was abandoned while the
    // artifact was being copied into the object store (an await that a cancel can land inside).
    // Refusing here - immediately before the single synchronous INSERT - keeps an abandoned
    // derivation out of the catalog in every case except an abandonment arriving during the INSERT
    // itself, which nothing short of a shared transaction can close.
    // The content-addressed blob just stored is deliberately left in place: it is unreferenced, and
    // deleting a shared content address could remove bytes another row depends on.
    if (input.lifecycle?.isAbandoned?.() || input.lifecycle?.isCancelled?.()) {
      throw new DerivationError(
        "DERIVATION_ABANDONED",
        "the derivation was abandoned before its row could be recorded; no derived file was registered",
        { asset_version_id: input.asset_version_id, derivative_type, reason: input.lifecycle.abandonReason?.() ?? "unknown" }
      );
    }
    const derived_file_id = id("drv");
    this.db.prepare(`INSERT INTO derived_files (derived_file_id, asset_id, asset_version_id, derivative_type, profile, object_id, file_name, extension, mime_type, container, size_bytes, sha256, width, height, duration_ms, frame_rate, sample_rate, channels, codec, status, metadata_json, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`)
      .run(derived_file_id, input.asset_id, input.asset_version_id, derivative_type, input.profile ?? null, stored.object_id, stored.file_name, probe.extension, probe.mime_type, probe.container, stored.size_bytes, stored.sha256, probe.width ?? null, probe.height ?? null, probe.duration_ms ?? null, probe.frame_rate ?? null, probe.sample_rate ?? null, probe.channels ?? null, probe.codec ?? null, JSON.stringify(input.metadata ?? {}), actor.actor_id, now, now);
    this.commit({ scope: "asset", target_id: input.asset_id, action: "asset.derived.register", message: `已登记衍生文件：${derivative_type}`, actor_id: actor.actor_id, changes: { derived_file_id, asset_version_id: input.asset_version_id, derivative_type, profile: input.profile ?? null } });
    return this.getDerivedFile(derived_file_id);
  }

async generateDerivedFile(input) {
    this.requireDb();
    if (!input?.asset_version_id) throw new Error("asset_version_id is required");
    const version = this.getVersionRow(input.asset_version_id);
    if (!version) throw new Error(`Asset version not found: ${input.asset_version_id}`);
    if (input.asset_id && input.asset_id !== version.asset_id) {
      throw new Error(`Asset version ${input.asset_version_id} belongs to ${version.asset_id}, not ${input.asset_id}`);
    }
    this.requireAsset(version.asset_id);

    const derivative_type = this.validateDerivativeType(input.derivative_type ?? "thumbnail");
    return this.performDerivation({
      asset_version_id: input.asset_version_id,
      asset_id: version.asset_id,
      derivative_type,
      parameters: input.parameters ?? input,
      profile_key: input.profile_key ?? null,
      metadata: input.metadata ?? null,
      signal: input.signal ?? null,
      actor_id: this.resolveRequestActor(input).actor_id,
      actor_type: this.resolveRequestActor(input).actor_type
    });
  }

async performDerivation({ asset_version_id, asset_id, derivative_type, parameters = {}, metadata = null, signal = null, lifecycle = null, actor_id, actor_type }) {
    this.requireDb();
    const version = this.getVersionRow(asset_version_id);
    if (!version) throw new Error(`Asset version not found: ${asset_version_id}`);
    if (asset_id && asset_id !== version.asset_id) {
      throw new Error(`Asset version ${asset_version_id} belongs to ${version.asset_id}, not ${asset_id}`);
    }
    this.requireAsset(version.asset_id);
    // A derivation can be submitted without an explicit actor (a queue entry carries whatever the
    // caller supplied). Falling back to the same default the other service methods use keeps the
    // audit row attributable instead of throwing on an undefined SQLite bind parameter.
    const resolvedActor = this.ensureActor(
      actor_id ?? this.resolveRequestActor({}).actor_id,
      actor_type ?? this.resolveRequestActor({}).actor_type
    );
    // A queue-supplied lifecycle lets this method REFUSE TO COMMIT work whose caller has already
    // been told the job was abandoned (timed out or cancelled). The abort signal alone is not
    // sufficient: a child process can ignore an abort, and the run would then still reach the
    // registration step and write a valid-looking derivation for a failed request.
    const abortSignal = signal ?? lifecycle?.signal ?? null;

    const storage = await checkStorageAvailability(this.root);
    if (!storage.ok) {
      throw new QueueError(storage.code, `the object store is not reachable (${storage.code}), so no derivation can be generated`, storage);
    }

    const source = this.resolveVersionFile(asset_version_id);
    const expectedObjectPath = objectPathForVersion(this.root, version.object_id);
    const sourcePresent = source.file_path === expectedObjectPath ? fs.existsSync(expectedObjectPath) : fs.existsSync(source.file_path);
    if (!sourcePresent) {
      throw new DerivationError("DERIVATION_SOURCE_MISSING", "the source object for this version is not present on disk", {
        asset_version_id,
        object_id: version.object_id
      });
    }

    // Resolve the profile up front so an unsupported (kind, derivative type) pair is refused before
    // any encoder is spawned.
    const plan = planDerivation({
      source: { ...source, asset_version_id },
      derivativeType: derivative_type,
      parameters,
      outputDir: path.join(this.root, cacheDirectoryFor(derivative_type))
    });

    const generated = await generateDerivation({
      source: { ...source, asset_version_id },
      derivativeType: derivative_type,
      parameters,
      outputDir: path.dirname(plan.output_path),
      signal: abortSignal
    });

    // Checkpoint before the write: an abandoned derivation must not become a row. The artifact is
    // removed rather than left for a later "the file exists" check to mistake for a real derivative.
    // (Residual window: an abandonment arriving between this check and the registration call can
    // still register a row. The window is bounded by one synchronous call and is documented rather
    // than hidden; closing it fully would need the registration and the abandonment to share one
    // transaction, which the queue does not own.)
    if (lifecycle?.isAbandoned?.() || lifecycle?.isCancelled?.() || abortSignal?.aborted === true) {
      await fs.promises.rm(generated.output_path, { force: true }).catch(() => {});
      throw new DerivationError(
        "DERIVATION_ABANDONED",
        "the derivation was abandoned (timed out or cancelled) before it could be registered; the artifact was discarded and nothing was registered",
        {
          asset_version_id,
          derivative_type,
          reason: lifecycle?.abandonReason?.() ?? (abortSignal?.aborted ? "signal-aborted" : "unknown")
        }
      );
    }

    const derived = await this.registerDerivedFile({
      asset_id: version.asset_id,
      asset_version_id,
      file_path: generated.output_path,
      derivative_type: generated.derivative_type,
      profile: generated.profile,
      metadata: {
        generated_by: "video-assets-plugin",
        generator: "ffmpeg",
        generator_mode: generated.mode,
        profile_key: generated.profile_key,
        ffmpeg_version: generated.ffmpeg_version,
        ffprobe_version: generated.ffprobe_version,
        source_asset_version_id: asset_version_id,
        source_sha256: source.sha256,
        source_mime_type: source.mime_type,
        parameters: generated.parameters,
        verification: generated.verification,
        source_probe: { media_type: generated.source_probe?.media_type, duration_ms: generated.source_probe?.duration_ms ?? null, width: generated.source_probe?.width ?? null, height: generated.source_probe?.height ?? null, codec: generated.source_probe?.codec ?? null },
        output_probe: { media_type: generated.output_probe?.media_type, duration_ms: generated.output_probe?.duration_ms ?? null, width: generated.output_probe?.width ?? null, height: generated.output_probe?.height ?? null, codec: generated.output_probe?.codec ?? null },
        elapsed_ms: generated.elapsed_ms,
        ...(metadata ?? {})
      },
      lifecycle,
      actor_id: resolvedActor.actor_id,
      actor_type: resolvedActor.actor_type
    });
    // The intermediate artifact has been copied into the content-addressed store; removing the
    // working copy keeps cache/ from accumulating a second, unstored copy of every derivation.
    await fs.promises.rm(generated.output_path, { force: true }).catch(() => {});

    this.commit({
      scope: "asset",
      target_id: version.asset_id,
      action: "asset.derived.generate",
      message: `已生成衍生文件：${generated.derivative_type}`,
      actor_id: resolvedActor.actor_id,
      changes: {
        derived_file_id: derived.derived_file_id,
        asset_version_id,
        derivative_type: generated.derivative_type,
        profile: derived.profile,
        generator: "ffmpeg"
      }
    });
    return derived;
  }

listDerivedFiles(input = {}) {
    this.requireDb();
    const where = [];
    const params = [];
    if (input.asset_id) {
      this.requireAsset(input.asset_id);
      where.push("asset_id = ?");
      params.push(input.asset_id);
    }
    if (input.asset_version_id) {
      if (input.asset_id) this.requireVersionForAsset(input.asset_version_id, input.asset_id, "asset_version_id");
      else if (!this.getVersionRow(input.asset_version_id)) throw new Error(`Asset version not found: ${input.asset_version_id}`);
      where.push("asset_version_id = ?");
      params.push(input.asset_version_id);
    }
    if (input.derivative_type) {
      where.push("derivative_type = ?");
      params.push(this.validateDerivativeType(input.derivative_type));
    }
    if (!input.include_inactive) where.push("status = 'active'");
    const sql = `SELECT * FROM derived_files${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at ASC`;
    return this.db.prepare(sql).all(...params).map(derivedFileFromRow);
  }

integrityScan(input = {}) {
    this.requireDb();
    const deep = Boolean(input.deep);
    const issues = [];
    const assets = this.db.prepare("SELECT * FROM assets WHERE lifecycle != 'soft_deleted' ORDER BY updated_at ASC").all();
    const versions = this.db.prepare("SELECT * FROM asset_versions ORDER BY created_at ASC").all();
    const derived = this.db.prepare("SELECT * FROM derived_files WHERE status = 'active' ORDER BY created_at ASC").all();
    const refs = this.db.prepare("SELECT * FROM project_references WHERE status != 'removed' ORDER BY added_at ASC").all();

    for (const asset of assets) {
      if (asset.default_version_id && !this.getVersionRow(asset.default_version_id)) {
        pushIntegrityIssue(issues, "error", "ASSET_DEFAULT_VERSION_MISSING", { asset_id: asset.asset_id, asset_version_id: asset.default_version_id }, `Asset default_version_id is missing: ${asset.default_version_id}`);
      }
    }
    for (const version of versions) {
      const asset = this.getAssetRow(version.asset_id);
      if (!asset) pushIntegrityIssue(issues, "error", "VERSION_ASSET_MISSING", { asset_id: version.asset_id, asset_version_id: version.asset_version_id }, `Version belongs to missing asset ${version.asset_id}.`);
      this.checkObjectIntegrity(issues, "version", version.asset_id, version.asset_version_id, version.object_id, version.sha256, deep);
    }
    for (const item of derived) {
      const asset = this.getAssetRow(item.asset_id);
      const version = this.getVersionRow(item.asset_version_id);
      if (!asset) pushIntegrityIssue(issues, "error", "DERIVED_ASSET_MISSING", { asset_id: item.asset_id, asset_version_id: item.asset_version_id, derived_file_id: item.derived_file_id }, `Derived file belongs to missing asset ${item.asset_id}.`);
      if (!version) pushIntegrityIssue(issues, "error", "DERIVED_VERSION_MISSING", { asset_id: item.asset_id, asset_version_id: item.asset_version_id, derived_file_id: item.derived_file_id }, `Derived file source version is missing: ${item.asset_version_id}.`);
      if (version && version.asset_id !== item.asset_id) pushIntegrityIssue(issues, "error", "DERIVED_ASSET_VERSION_MISMATCH", { asset_id: item.asset_id, asset_version_id: item.asset_version_id, derived_file_id: item.derived_file_id }, `Derived file source version belongs to ${version.asset_id}, not ${item.asset_id}.`);
      this.checkObjectIntegrity(issues, "derived", item.asset_id, item.asset_version_id, item.object_id, item.sha256, deep, item.derived_file_id);
    }
    for (const ref of refs) {
      if (!this.getProjectRow(ref.project_id)) pushIntegrityIssue(issues, "error", "REF_PROJECT_MISSING", ref, `Project reference points to missing project ${ref.project_id}.`);
      if (!this.getAssetRow(ref.asset_id)) pushIntegrityIssue(issues, ref.required ? "error" : "info", "REF_ASSET_MISSING", ref, `Project reference points to missing asset ${ref.asset_id}.`);
      const version = this.getVersionRow(ref.asset_version_id);
      if (!version) pushIntegrityIssue(issues, ref.required ? "error" : "info", "REF_VERSION_MISSING", ref, `Project reference points to missing version ${ref.asset_version_id}.`);
      if (version && version.asset_id !== ref.asset_id) pushIntegrityIssue(issues, ref.required ? "error" : "info", "REF_ASSET_VERSION_MISMATCH", ref, `Project ref version belongs to ${version.asset_id}, not ${ref.asset_id}.`);
    }
    return {
      ok: issues.filter((issue) => issue.level === "error").length === 0,
      deep,
      scanned: { assets: assets.length, versions: versions.length, derived_files: derived.length, project_references: refs.length },
      issues,
      errors: issues.filter((issue) => issue.level === "error"),
      warnings: issues.filter((issue) => issue.level === "warning"),
      info: issues.filter((issue) => issue.level === "info")
    };
  }

getDerivedFile(derived_file_id) {
    const row = this.db.prepare("SELECT * FROM derived_files WHERE derived_file_id = ?").get(derived_file_id);
    if (!row) throw new Error(`Derived file not found: ${derived_file_id}`);
    return derivedFileFromRow(row);
  }

resolveDerivedFile(identifier, allowedTypes) {
    this.requireDb();
    if (!identifier) throw new Error("derived file id or asset version id is required");
    const allowed = new Set((allowedTypes ?? []).map((type) => this.validateDerivativeType(type)));
    let derived;
    if (String(identifier).startsWith("drv_")) {
      derived = this.getDerivedFile(identifier);
      if (allowed.size > 0 && !allowed.has(derived.derivative_type)) {
        const error = new Error(`Derived file ${identifier} is ${derived.derivative_type}, not one of: ${[...allowed].join(", ")}`);
        error.status = 404;
        throw error;
      }
    } else {
      const version = this.getVersionRow(identifier);
      if (!version) throw new Error(`Asset version not found: ${identifier}`);
      const candidates = this.listDerivedFiles({ asset_id: version.asset_id, asset_version_id: identifier, include_inactive: false })
        .filter((item) => allowed.size === 0 || allowed.has(item.derivative_type));
      derived = candidates[0];
      if (!derived) {
        const error = new Error(`No derived file found for asset version ${identifier}`);
        error.status = 404;
        throw error;
      }
    }
    const file_path = getObjectPath(this.root, derived.object_id);
    return {
      derived_file_id: derived.derived_file_id,
      asset_id: derived.asset_id,
      asset_version_id: derived.asset_version_id,
      derivative_type: derived.derivative_type,
      profile: derived.profile,
      file_path,
      file_name: derived.file_name,
      mime_type: derived.mime_type,
      size_bytes: derived.size_bytes,
      sha256: derived.sha256,
      metadata: derived.metadata
    };
  }

checkObjectIntegrity(issues, scope, asset_id, asset_version_id, object_id, expectedSha256, deep, derived_file_id = null) {
    let filePath;
    try {
      filePath = getObjectPath(this.root, object_id);
    } catch {
      pushIntegrityIssue(issues, "error", `${scope.toUpperCase()}_OBJECT_ID_INVALID`, { asset_id, asset_version_id, derived_file_id }, `Invalid object_id: ${object_id}`);
      return;
    }
    if (!fs.existsSync(filePath)) {
      pushIntegrityIssue(issues, "error", `${scope.toUpperCase()}_OBJECT_MISSING`, { asset_id, asset_version_id, derived_file_id }, `Object file is missing: ${object_id}`);
      return;
    }
    if (deep) {
      const actual = hashFileSync(filePath);
      if (actual !== expectedSha256) {
        pushIntegrityIssue(issues, "error", `${scope.toUpperCase()}_SHA256_MISMATCH`, { asset_id, asset_version_id, derived_file_id }, `Object sha256 mismatch for ${object_id}.`);
      }
    }
  }

createProject(input) {
    this.requireDb();
    if (!input?.title) throw new Error("title is required");
    const actor = this.ensureActor(this.resolveRequestActor(input).actor_id, this.resolveRequestActor(input).actor_type);
    const now = new Date().toISOString();
    const project_id = id("project");
    this.db.prepare(`INSERT INTO projects (project_id, title, status, description, target_platforms_json, aspect_ratio, resolution, fps, owner_actor_id, created_by, created_at, updated_at)
      VALUES (?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(project_id, input.title, input.description ?? null, JSON.stringify(input.target_platforms ?? []), input.aspect_ratio ?? null, input.resolution ?? null, input.fps ?? null, input.owner_actor_id ?? null, actor.actor_id, now, now);
    this.commit({ scope: "project", target_id: project_id, action: "project.create", message: `已创建项目：${input.title}`, actor_id: actor.actor_id, changes: {} });
    return this.getProject(project_id);
  }

updateProjectSpec(input = {}) {
    this.requireDb();
    if (!input.project_id) throw new Error("project_id is required");
    const existing = this.requireProject(input.project_id);
    const actor = this.ensureActor(this.resolveRequestActor(input).actor_id, this.resolveRequestActor(input).actor_type);
    const target_platforms = input.target_platforms === undefined ? existing.target_platforms : normalizeTargetPlatforms(input.target_platforms);
    const aspect_ratio = input.aspect_ratio === undefined ? existing.aspect_ratio : normalizeAspectRatio(input.aspect_ratio);
    const resolution = input.resolution === undefined ? existing.resolution : normalizeResolution(input.resolution);
    const fps = input.fps === undefined ? existing.fps : normalizeFps(input.fps);
    const now = new Date().toISOString();
    this.db.prepare("UPDATE projects SET target_platforms_json = ?, aspect_ratio = ?, resolution = ?, fps = ?, updated_at = ? WHERE project_id = ?")
      .run(JSON.stringify(target_platforms), aspect_ratio, resolution, fps, now, input.project_id);
    this.commit({
      scope: "project",
      target_id: input.project_id,
      action: "project.spec.update",
      message: `已更新项目输出规格：${input.project_id}`,
      actor_id: actor.actor_id,
      changes: {
        before: pickProjectSpec(existing),
        after: { target_platforms, aspect_ratio, resolution, fps }
      }
    });
    return this.getProject(input.project_id);
  }

addProjectRef(input) {
    this.requireDb();
    if (!input?.project_id || !input?.asset_id) throw new Error("project_id and asset_id are required");
    const actor = this.ensureActor(this.resolveRequestActor(input).actor_id, this.resolveRequestActor(input).actor_type);
    this.requireProject(input.project_id);
    const asset = this.requireAsset(input.asset_id);
    const asset_version_id = input.asset_version_id ?? asset.default_version_id;
    if (!asset_version_id) throw new Error("asset has no default version");
    this.requireVersionForAsset(asset_version_id, input.asset_id, "asset_version_id");
    const pin_mode = input.pin_mode ?? "pinned";
    this.validatePinMode(pin_mode);
    const now = new Date().toISOString();
    const reference_id = id("ref");
    this.db.prepare(`INSERT INTO project_references (reference_id, project_id, asset_id, asset_version_id, role, usage_scope, pin_mode, required, notes, status, added_by, added_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`)
      .run(reference_id, input.project_id, input.asset_id, asset_version_id, input.role ?? "other", input.usage_scope ?? null, pin_mode, input.required === false ? 0 : 1, input.notes ?? null, actor.actor_id, now, now);
    this.commit({ scope: "project", target_id: input.project_id, action: "project.ref.add", message: `已添加项目素材引用：${reference_id}`, actor_id: actor.actor_id, changes: { reference_id, asset_version_id } });
    return this.requireProjectRef(reference_id);
  }

updateProjectRef(input) {
    this.requireDb();
    if (!input?.reference_id) throw new Error("reference_id is required");
    const existing = this.requireProjectRef(input.reference_id);
    if (existing.status === "removed") throw new Error(`Project reference is removed: ${input.reference_id}`);
    const actor = this.ensureActor(this.resolveRequestActor(input).actor_id, this.resolveRequestActor(input).actor_type);
    const asset_id = input.asset_id ?? existing.asset_id;
    const asset = this.requireAsset(asset_id);
    const asset_version_id = input.asset_version_id ?? (input.asset_id && input.asset_id !== existing.asset_id ? asset.default_version_id : existing.asset_version_id);
    if (!asset_version_id) throw new Error("asset has no default version");
    this.requireVersionForAsset(asset_version_id, asset_id, "asset_version_id");
    const pin_mode = input.pin_mode ?? existing.pin_mode;
    this.validatePinMode(pin_mode);
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE project_references SET asset_id = ?, asset_version_id = ?, role = ?, usage_scope = ?, pin_mode = ?, required = ?, notes = ?, updated_at = ? WHERE reference_id = ?`)
      .run(asset_id, asset_version_id, input.role ?? existing.role, input.usage_scope === undefined ? existing.usage_scope : input.usage_scope, pin_mode, input.required === undefined ? existing.required : (input.required === false ? 0 : 1), input.notes === undefined ? existing.notes : input.notes, now, input.reference_id);
    this.commit({ scope: "project", target_id: existing.project_id, action: "project.ref.update", message: `已更新项目素材引用：${input.reference_id}`, actor_id: actor.actor_id, changes: { reference_id: input.reference_id, asset_id, asset_version_id, pin_mode } });
    return this.requireProjectRef(input.reference_id);
  }

removeProjectRef(input) {
    this.requireDb();
    if (!input?.reference_id) throw new Error("reference_id is required");
    const existing = this.requireProjectRef(input.reference_id);
    if (existing.status === "removed") return { reference_id: input.reference_id, status: "removed" };
    const actor = this.ensureActor(this.resolveRequestActor(input).actor_id, this.resolveRequestActor(input).actor_type);
    const now = new Date().toISOString();
    this.db.prepare("UPDATE project_references SET status = 'removed', removed_at = ?, removed_by = ?, updated_at = ? WHERE reference_id = ?")
      .run(now, actor.actor_id, now, input.reference_id);
    this.commit({ scope: "project", target_id: existing.project_id, action: "project.ref.remove", message: `已移除项目素材引用：${input.reference_id}`, actor_id: actor.actor_id, changes: { reference_id: input.reference_id } });
    return { reference_id: input.reference_id, status: "removed" };
  }

listProjectRefs(input) {
    this.requireDb();
    this.requireProject(input.project_id);
    return this.db.prepare("SELECT * FROM project_references WHERE project_id = ? AND status != 'removed' ORDER BY added_at ASC").all(input.project_id);
  }

projectReport(input) {
    this.requireProject(input.project_id);
    const refs = this.listProjectRefs(input);
    const issues = [];
    for (const ref of refs) {
      if (ref.pin_mode === "follow_latest") pushIssue(issues, "warning", "FOLLOW_LATEST", ref, "项目引用正在跟随素材最新版本；正式交付前应固定具体 asset_version_id。");
      if (ref.pin_mode === "candidate") pushIssue(issues, "warning", "CANDIDATE_REF", ref, "候选引用不适合直接用于最终交付。");
      const asset = this.getAssetRow(ref.asset_id);
      const version = this.getVersionRow(ref.asset_version_id);
      if (!asset) {
        pushIssue(issues, ref.required ? "error" : "info", "MISSING_ASSET", ref, `引用的素材不存在：${ref.asset_id}`);
      }
      if (!version) {
        pushIssue(issues, ref.required ? "error" : "info", "MISSING_VERSION", ref, `引用的素材版本不存在：${ref.asset_version_id}`);
      }
      if (asset && version && version.asset_id !== ref.asset_id) {
        pushIssue(issues, ref.required ? "error" : "info", "ASSET_VERSION_MISMATCH", ref, `素材版本 ${ref.asset_version_id} 属于 ${version.asset_id}，与引用素材 ${ref.asset_id} 不一致。`);
      }
      if (version && !this.objectExists(version.object_id)) {
        pushIssue(issues, ref.required ? "error" : "info", "MISSING_OBJECT_FILE", ref, `素材版本 ${ref.asset_version_id} 的对象文件缺失。`);
      }
      if (asset && asset.license_status !== "cleared") {
        pushIssue(issues, "warning", "LICENSE_UNKNOWN", ref, `素材授权状态为 ${asset.license_status ?? "unknown"}；正式交付前必须完成清权。`);
      }
      if (!ref.required && issues.every((issue) => issue.reference_id !== ref.reference_id || issue.level !== "info")) {
        pushIssue(issues, "info", "OPTIONAL_REF", ref, "该引用为可选项；除非交付策略将其提升为必需项，否则相关问题仅作提示。" );
      }
    }
    return { project_id: input.project_id, refs, issues, warnings: issues.filter((issue) => issue.level === "warning") };
  }

searchProjects(input = {}) {
    this.requireDb();
    const limit = clampInteger(input.limit ?? 50, 1, 200, "limit");
    const offset = clampInteger(input.offset ?? 0, 0, 100000, "offset");
    const query = String(input.query ?? "").trim().toLowerCase();
    const where = [];
    const params = [];
    if (input.status) {
      where.push("status = ?");
      params.push(String(input.status));
    }
    if (query) {
      where.push("(instr(lower(title), ?) > 0 OR instr(lower(COALESCE(description, '')), ?) > 0 OR instr(lower(project_id), ?) > 0)");
      params.push(query, query, query);
    }
    const sql = `SELECT * FROM projects${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY updated_at DESC, project_id DESC LIMIT ? OFFSET ?`;
    return this.db.prepare(sql).all(...params, limit, offset).map((row) => this.projectSummary(row));
  }

getProjectDetail(input) {
    this.requireDb();
    const project = this.getProject(input.project_id);
    const refs = this.listProjectRefs({ project_id: project.project_id });
    const report = this.projectReport({ project_id: project.project_id });
    const continuity = this.projectContinuityReport({ project_id: project.project_id, stage: input.stage ?? "production" });
    return { ...project, refs, report, continuity };
  }

kieAudioApiKey() {
    return pickConfigSecretString(this.pluginConfig, ["audio", "kie", "apiKey"]);
  }

doubaoAudioApiKey() {
    return pickConfigSecretString(this.pluginConfig, ["audio", "doubao", "apiKey"]);
  }

doubaoAudioPlan(input = {}) {
    this.requireDb();
    const project = input.project_id ? this.requireProject(input.project_id) : null;
    const request = normalizeDoubaoAudioRequest(input, { project_id: project?.project_id ?? null });
    const validation = this.validateDoubaoAudioRequestWithAssets(request);
    return this.doubaoAudioPlanResponse({ request, validation, project });
  }

async doubaoAudioGenerate(input = {}) {
    this.requireDb();
    const plan = this.doubaoAudioPlan(input);
    const execute = plan.request.execution.execute === true;
    if (plan.status === "blocked" || !execute) return plan;
    const authorization = this.beginGeneration({ entry: "audio.doubao.generate", input });
    if (!authorization.allowed) return this.blockedGeneration(plan, authorization, "audio.doubao.generate");
    const outputDir = resolveDoubaoAudioOutputDir(plan.request.execution.output_dir, this.root);
    const generated = await this.callProvider({ audit: authorization, payload: { request: plan.request, outputDir, apiKey: this.doubaoAudioApiKey() } });
    const registered_assets = [];

    if (generated.status === "success" && plan.request.execution.ingest_outputs !== false) {
      for (const output of generated.outputs ?? []) {
        const asset = await this.ingestAsset({
          file_path: output.file_path,
          title: plan.request.asset_policy.title,
          description: "由豆包音频生成 1.0 根据项目声音导演稿生成。",
          tags: plan.request.asset_policy.tags,
          kind: plan.request.asset_policy.kind,
          actor_id: this.resolveRequestActor(input).actor_id,
          actor_type: this.resolveRequestActor(input).actor_type,
          source: {
            source_type: "doubao_audio",
            notes: JSON.stringify({
              request: plan.request,
              provider_result: summarizeDoubaoProviderResult(generated),
              platform_review_status: generated.platform_review_status,
              license_policy: "platform_review_passed_is_content_review_only"
            })
          }
        });
        this.updateAssetRights({
          asset_id: asset.asset_id,
          license_status: input.license_status ?? "unknown",
          risk_level: input.risk_level ?? "unknown",
          notes: `豆包音频平台审核通过仅代表内容审核通过；缺可引用授权依据，授权默认记为 unknown：${asset.title}`,
          actor_id: this.resolveRequestActor(input).actor_id,
          actor_type: this.resolveRequestActor(input).actor_type,
          source: {
            source_type: "doubao_audio_platform_review",
            captured_at: generated.completed_at ?? new Date().toISOString(),
            license_hint: "平台审核通过仅代表内容层面审核通过，不构成版权授权依据；授权状态保持 unknown，公开发布前必须完成清权。",
            notes: JSON.stringify({
              task_id: generated.task_id,
              platform_review_status: generated.platform_review_status,
              model: plan.request.model,
              prompt_chars: plan.request.prompt.estimated_chars
            })
          }
        });
        let project_ref = null;
        if (plan.request.project.project_id) {
          project_ref = this.addProjectRef({
            project_id: plan.request.project.project_id,
            asset_id: asset.asset_id,
            asset_version_id: asset.default_version_id,
            role: input.project_ref?.role ?? "generated_audio",
            usage_scope: input.project_ref?.usage_scope ?? "作为 @音频1 或项目声音总轨候选。",
            pin_mode: input.project_ref?.pin_mode ?? "pinned",
            required: input.project_ref?.required ?? false,
            notes: input.project_ref?.notes ?? `doubao_task_id=${generated.task_id}; platform_review_status=${generated.platform_review_status}; license_status=${input.license_status ?? "unknown"}`,
            actor_id: this.resolveRequestActor(input).actor_id,
            actor_type: this.resolveRequestActor(input).actor_type
          });
        }
        registered_assets.push({ asset_id: asset.asset_id, asset_version_id: asset.default_version_id, file_path: output.file_path, project_ref });
      }
    }

    return {
      ...plan,
      status: "success",
      dry_run: false,
      output_dir: outputDir,
      provider_result: generated,
      registered_assets,
      next_actions: doubaoAudioNextActions({ request: plan.request, validation: plan.validation, generated })
    };
  }

doubaoAudioPlanResponse({ request, validation, project = null, canvas = null, slot = null, slotSpec = null, source = "doubao_audio_plan" }) {
    return {
      version: 1,
      source,
      created_at: new Date().toISOString(),
      guide_source: DOUBAO_AUDIO_GUIDE_SOURCE,
      status: validation.status,
      dry_run: request.execution.execute !== true,
      provider: request.provider,
      project,
      canvas: canvas ? { canvas_id: canvas.canvas_id, project_id: canvas.project_id, title: canvas.title } : null,
      slot: slot ? { shape_id: slot.shape_id, title: slot.title, generation_slot: slotSpec } : null,
      request,
      validation,
      cost_policy: [
        "dry-run 只生成请求包，不调用豆包音频端口。",
        "真实执行必须 execute=true 且 accept_cost=true。",
        "平台审核通过、生成成功或输出可下载都只说明内容层审核与生成成功，**不构成版权授权依据**；",
        "因此生成音频的授权默认登记为 license_status=unknown、risk_level=unknown，只有调用方显式传入有据的授权值才会登记为 cleared。"
      ],
      asset_policy: request.asset_policy,
      next_actions: doubaoAudioNextActions({ request, validation })
    };
  }

validateDoubaoAudioRequestWithAssets(request) {
    const validation = validateDoubaoAudioRequest(request, { apiKey: this.doubaoAudioApiKey() });
    for (const voice of request.voices ?? []) {
      if (!voice.reference_asset_id) continue;
      try {
        const asset = this.requireAsset(voice.reference_asset_id);
        if (asset.license_status === "rejected" || asset.risk_level === "high") {
          validation.blockers.push(`reference_asset_id is rejected or high-risk: ${voice.reference_asset_id}`);
        }
      } catch (error) {
        validation.blockers.push(error instanceof Error ? error.message : String(error));
      }
    }
    validation.status = validation.blockers.length ? "blocked" : "ready";
    return validation;
  }

kieSunoPlan(input = {}) {
    this.requireDb();
    const project = input.project_id ? this.requireProject(input.project_id) : null;
    const request = normalizeKieSunoRequest(input, { project_id: project?.project_id ?? null });
    const validation = this.validateKieSunoRequestWithAssets(request);
    return this.kieSunoPlanResponse({ request, validation, project });
  }

async kieSunoGenerate(input = {}) {
    this.requireDb();
    const plan = this.kieSunoPlan(input);
    const execute = plan.request.execution.execute === true;
    if (plan.status === "blocked" || !execute) return plan;
    const authorization = this.beginGeneration({ entry: "audio.kie.generate", input });
    if (!authorization.allowed) return this.blockedGeneration(plan, authorization, "audio.kie.generate");
    const outputDir = resolveKieSunoOutputDir(plan.request.execution.output_dir, this.root);
    const generated = await this.callProvider({ audit: authorization, payload: { request: plan.request, outputDir, apiKey: this.kieAudioApiKey() } });
    const registered_assets = [];

    if (generated.status === "success" && plan.request.execution.ingest_outputs !== false) {
      for (const output of generated.outputs ?? []) {
        const asset = await this.ingestAsset({
          file_path: output.file_path,
          title: plan.request.asset_policy.title,
          description: "由 KIE Suno API 根据项目音乐请求生成，公开交付前需要版权与商用条款复核。",
          tags: plan.request.asset_policy.tags,
          kind: plan.request.asset_policy.kind,
          actor_id: this.resolveRequestActor(input).actor_id,
          actor_type: this.resolveRequestActor(input).actor_type,
          source: {
            source_type: "kie_suno",
            notes: JSON.stringify({
              request: plan.request,
              provider_result: summarizeKieSunoProviderResult(generated),
              rights_policy: "default_unknown_until_human_review"
            })
          }
        });
        this.updateAssetRights({
          asset_id: asset.asset_id,
          license_status: "unknown",
          risk_level: "unknown",
          notes: `KIE Suno 输出已入库但未完成版权/商用条款人工复核：${asset.title}`,
          actor_id: this.resolveRequestActor(input).actor_id,
          actor_type: this.resolveRequestActor(input).actor_type,
          source: {
            source_type: "kie_suno_generation_record",
            captured_at: generated.completed_at ?? new Date().toISOString(),
            license_hint: "unknown",
            notes: JSON.stringify({
              task_id: generated.task_id,
              audio_ids: generated.audio_ids ?? [],
              endpoint: plan.request.endpoint,
              model: plan.request.request.model,
              remote_urls: generated.remote_urls ?? [],
              retention_note: generated.retention_note ?? "KIE 远程文件可能有留存期，项目应使用已下载本地资产。"
            })
          }
        });
        let project_ref = null;
        if (plan.request.project.project_id) {
          project_ref = this.addProjectRef({
            project_id: plan.request.project.project_id,
            asset_id: asset.asset_id,
            asset_version_id: asset.default_version_id,
            role: input.project_ref?.role ?? "generated_music",
            usage_scope: input.project_ref?.usage_scope ?? "作为项目音乐/歌曲/伴奏候选，公开交付前需授权复核。",
            pin_mode: input.project_ref?.pin_mode ?? "pinned",
            required: input.project_ref?.required ?? false,
            notes: input.project_ref?.notes ?? `kie_suno_task_id=${generated.task_id}; license_status=unknown; rights_review_required=true`,
            actor_id: this.resolveRequestActor(input).actor_id,
            actor_type: this.resolveRequestActor(input).actor_type
          });
        }
        registered_assets.push({ asset_id: asset.asset_id, asset_version_id: asset.default_version_id, file_path: output.file_path, project_ref });
      }
    }

    return {
      ...plan,
      status: generated.status === "submitted" ? "submitted" : "success",
      dry_run: false,
      output_dir: outputDir,
      provider_result: generated,
      registered_assets,
      next_actions: kieSunoNextActions({ request: plan.request, validation: plan.validation, generated })
    };
  }

kieSunoPlanResponse({ request, validation, project = null, canvas = null, slot = null, slotSpec = null, source = "kie_suno_plan" }) {
    return {
      version: 1,
      source,
      created_at: new Date().toISOString(),
      guide_source: KIE_SUNO_GUIDE_SOURCE,
      status: validation.status,
      dry_run: request.execution.execute !== true,
      provider: request.provider,
      project,
      canvas: canvas ? { canvas_id: canvas.canvas_id, project_id: canvas.project_id, title: canvas.title } : null,
      slot: slot ? { shape_id: slot.shape_id, title: slot.title, generation_slot: slotSpec } : null,
      request,
      validation,
      cost_policy: [
        "dry-run 只生成 KIE Suno 请求包，不提交任务。",
        "真实执行必须 execute=true 且 accept_cost=true。",
        "KIE Suno 为第三方网关，输出成功后仍默认 license_status=unknown、risk_level=unknown。",
        "远程输出可能有留存期，生产资产必须下载并登记入库后再交接。"
      ],
      asset_policy: request.asset_policy,
      next_actions: kieSunoNextActions({ request, validation })
    };
  }

validateKieSunoRequestWithAssets(request) {
    const validation = validateKieSunoRequest(request, { apiKey: this.kieAudioApiKey() });
    for (const key of ["source_asset_id", "reference_asset_id"]) {
      const assetId = request.request?.[key];
      if (!assetId) continue;
      try {
        const asset = this.requireAsset(assetId, key);
        if (asset.license_status === "rejected" || asset.risk_level === "high") {
          validation.blockers.push(`${key} is rejected or high-risk: ${assetId}`);
        }
      } catch (error) {
        validation.blockers.push(error instanceof Error ? error.message : String(error));
      }
    }
    validation.status = validation.blockers.length ? "blocked" : "ready";
    return validation;
  }

safeResolveVersionFile(asset_version_id) {
    try {
      return this.resolveVersionFile(asset_version_id);
    } catch {
      return null;
    }
  }

fileRoots() {
    return Object.entries(FILE_ROOTS).map(([root_key, root]) => {
      const absolute_path = path.join(this.root, root.relativePath);
      return {
        root_key,
        label: root.label,
        kind: root.kind,
        relative_path: root.relativePath,
        exists: fs.existsSync(absolute_path)
      };
    });
  }

async listFiles(input = {}) {
    this.requireDb();
    const root_key = input.root_key ?? "asset-raw";
    const base = this.resolveAllowedFilePath(root_key, input.relative_path ?? "");
    const stat = await fs.promises.stat(base.absolute_path);
    if (!stat.isDirectory()) throw new Error("relative_path must point to a directory");
    const limit = clampInteger(input.limit ?? 200, 1, 500, "limit");
    const entries = await fs.promises.readdir(base.absolute_path, { withFileTypes: true });
    const result = [];
    for (const entry of entries.slice(0, limit)) {
      const absolute = path.join(base.absolute_path, entry.name);
      result.push(await this.fileEntry(root_key, path.posix.join(base.relative_path_posix, entry.name), absolute, entry));
    }
    result.sort((a, b) => Number(b.is_directory) - Number(a.is_directory) || a.name.localeCompare(b.name));
    return { root_key, relative_path: base.relative_path_posix, entries: result };
  }

async inspectFile(input = {}) {
    this.requireDb();
    if (!input.root_key) throw new Error("root_key is required");
    const resolved = this.resolveAllowedFilePath(input.root_key, input.relative_path ?? "");
    const stat = await fs.promises.stat(resolved.absolute_path);
    const entry = await this.fileEntry(input.root_key, resolved.relative_path_posix, resolved.absolute_path, null, stat);
    let media = null;
    let binding = null;
    if (stat.isFile()) {
      media = probeMedia(resolved.absolute_path);
      binding = this.findFileBinding(resolved.absolute_path);
    }
    const binding_state = binding?.asset_versions?.length || binding?.derived_files?.length ? "bound" : entry.binding_state;
    return { ...entry, binding_state, media, binding };
  }

async searchFiles(input = {}) {
    this.requireDb();
    const root_key = input.root_key ?? "asset-raw";
    const query = String(input.query ?? "").trim().toLowerCase();
    const limit = clampInteger(input.limit ?? 100, 1, 500, "limit");
    const maxDepth = clampInteger(input.max_depth ?? 4, 0, 12, "max_depth");
    const start = this.resolveAllowedFilePath(root_key, input.relative_path ?? "");
    const matches = [];
    await this.walkFiles(root_key, start.absolute_path, start.relative_path_posix, maxDepth, async (absolute, relativePath, dirent) => {
      if (matches.length >= limit) return;
      if (!query || dirent.name.toLowerCase().includes(query)) {
        matches.push(await this.fileEntry(root_key, relativePath, absolute, dirent));
      }
    });
    return { root_key, query, matches };
  }

async uploadStagingFile(input = {}) {
    this.requireDb();
    if (!input.file_name) throw new Error("file_name is required");
    if (!input.content_base64) throw new Error("content_base64 is required");
    const actor = this.ensureActor(this.resolveRequestActor(input).actor_id, this.resolveRequestActor(input).actor_type);
    const fileName = sanitizeFileName(input.file_name);
    const targetDir = this.resolveAllowedFilePath("asset-staging", input.relative_path ?? "");
    await fs.promises.mkdir(targetDir.absolute_path, { recursive: true });
    const buffer = Buffer.from(String(input.content_base64), "base64");
    if (buffer.length === 0) throw new Error("uploaded file is empty");
    const policy = this.uploadPolicy ?? resolveUploadPolicy({});
    if (buffer.length > policy.maxFileBytes) {
      throw new Error(`uploaded file exceeds the ${policy.maxFileBytes}-byte per-file limit`);
    }
    // Same quota and disk floor as the streaming route.
    await this.uploadStore.assertCapacity({ incoming: buffer.length, stage: "legacy-staging-upload" });
    const targetName = uniqueStagingName(fileName);
    const targetPath = path.join(targetDir.absolute_path, targetName);
    if (!isInsidePath(targetDir.root_absolute, targetPath)) throw new Error("upload target escapes staging root");
    await fs.promises.writeFile(targetPath, buffer, { flag: "wx" });
    const relative_path = normalizeRelativePath(path.posix.join(targetDir.relative_path_posix, targetName));
    // Attribute the bytes: this path has no upload session, so the staging row IS the ownership record.
    const sha256 = createHash("sha256").update(buffer).digest("hex");
    this.uploadStore.recordStagedObject({
      relativePath: relative_path,
      ownerActorId: actor.actor_id,
      sizeBytes: buffer.length,
      sha256,
      state: "staged",
      notes: "staged through the legacy base64 entry point (no upload session)"
    });
    this.commit({ scope: "system", target_id: relative_path, action: "staging.upload", message: "已上传暂存文件：" + fileName, actor_id: actor.actor_id, changes: { root_key: "asset-staging", relative_path, size_bytes: buffer.length, sha256, policy_max_file_bytes: policy.maxFileBytes, entry: "legacy-base64" } });
    return this.inspectFile({ root_key: "asset-staging", relative_path });
  }

async ingestStagingFile(input = {}) {
    this.requireDb();
    if (!input.relative_path) throw new Error("relative_path is required");
    const resolved = this.resolveAllowedFilePath("asset-staging", input.relative_path);
    const stat = await fs.promises.stat(resolved.absolute_path);
    if (!stat.isFile()) throw new Error("relative_path must point to a staging file");
    const asset = await this.ingestAsset({
      file_path: resolved.absolute_path,
      title: input.title || path.basename(resolved.absolute_path),
      description: input.description ?? null,
      tags: Array.isArray(input.tags) ? input.tags : ["staging"],
      kind: input.kind ?? "raw",
      actor_id: this.resolveRequestActor(input).actor_id,
      actor_type: this.resolveRequestActor(input).actor_type,
      change_summary: input.change_summary ?? "Confirmed from staging upload",
      source: input.source
    });
    const actor = this.ensureActor(this.resolveRequestActor(input).actor_id, this.resolveRequestActor(input).actor_type);
    this.commit({ scope: "system", target_id: normalizeRelativePath(input.relative_path), action: "staging.ingest", message: "已入库暂存文件：" + path.basename(resolved.absolute_path), actor_id: actor.actor_id, changes: { root_key: "asset-staging", relative_path: normalizeRelativePath(input.relative_path), asset_id: asset.asset_id, default_version_id: asset.default_version_id } });
    return { ok: true, asset, file: await this.inspectFile({ root_key: "asset-staging", relative_path: input.relative_path }) };
  }

async rejectStagingFile(input = {}) {
    this.requireDb();
    if (!input.relative_path) throw new Error("relative_path is required");
    const actor = this.ensureActor(this.resolveRequestActor(input).actor_id, this.resolveRequestActor(input).actor_type);
    const resolved = this.resolveAllowedFilePath("asset-staging", input.relative_path);
    const stat = await fs.promises.stat(resolved.absolute_path);
    if (!stat.isFile()) throw new Error("relative_path must point to a staging file");
    const size_bytes = stat.size;
    await fs.promises.unlink(resolved.absolute_path);
    const relative_path = normalizeRelativePath(input.relative_path);
    this.commit({ scope: "system", target_id: relative_path, action: "staging.reject", message: "已拒绝暂存文件：" + path.basename(resolved.absolute_path), actor_id: actor.actor_id, changes: { root_key: "asset-staging", relative_path, size_bytes, reason: input.reason ?? null } });
    return { ok: true, root_key: "asset-staging", relative_path, rejected: true };
  }

listCommits(input = {}) {
    this.requireDb();
    const limit = clampInteger(input.limit ?? 80, 1, 300, "limit");
    const offset = clampInteger(input.offset ?? 0, 0, 100000, "offset");
    const where = [];
    const params = [];
    if (input.scope) {
      where.push("scope = ?");
      params.push(String(input.scope));
    }
    if (input.target_id) {
      where.push("target_id = ?");
      params.push(String(input.target_id));
    }
    if (input.action) {
      where.push("action = ?");
      params.push(String(input.action));
    }
    const query = String(input.query ?? "").trim().toLowerCase();
    if (query) {
      where.push("(instr(lower(commit_id), ?) > 0 OR instr(lower(scope), ?) > 0 OR instr(lower(target_id), ?) > 0 OR instr(lower(action), ?) > 0 OR instr(lower(message), ?) > 0 OR instr(lower(COALESCE(actor_id, '')), ?) > 0)");
      params.push(query, query, query, query, query, query);
    }
    const sql = `SELECT * FROM commits${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, commit_id DESC LIMIT ? OFFSET ?`;
    return this.db.prepare(sql).all(...params, limit, offset).map(commitFromRow);
  }

classifyAsset(input) {
    this.requireDb();
    if (!input?.asset_id) throw new Error("asset_id is required");
    if (!input?.domain) throw new Error("domain is required");
    if (!input?.type) throw new Error("type is required");
    this.requireAsset(input.asset_id);
    if (input.asset_version_id) this.requireVersionForAsset(input.asset_version_id, input.asset_id, "asset_version_id");
    const domain = this.validateDomain(input.domain);
    const confidence = this.validateConfidence(input.confidence ?? "confirmed");
    const source = this.validateClassificationSource(input.source ?? "manual");
    const actor = this.ensureActor(this.resolveRequestActor(input).actor_id, this.resolveRequestActor(input).actor_type);
    const now = new Date().toISOString();
    const classification_id = id("cls");
    this.db.prepare(`INSERT INTO asset_classifications (classification_id, asset_id, asset_version_id, domain, type, subtype, confidence, source, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(classification_id, input.asset_id, input.asset_version_id ?? null, domain, input.type, input.subtype ?? null, confidence, source, actor.actor_id, now, now);
    this.commit({ scope: "asset", target_id: input.asset_id, action: "asset.classify", message: `已分类素材：${domain}.${input.type}`, actor_id: actor.actor_id, changes: { classification_id, asset_version_id: input.asset_version_id ?? null, domain, type: input.type, subtype: input.subtype ?? null, confidence } });
    return this.getAssetClassification({ asset_id: input.asset_id, asset_version_id: input.asset_version_id });
  }

getAssetClassification(input) {
    this.requireDb();
    if (!input?.asset_id) throw new Error("asset_id is required");
    this.requireAsset(input.asset_id);
    if (input.asset_version_id) this.requireVersionForAsset(input.asset_version_id, input.asset_id, "asset_version_id");
    const classifications = this.db.prepare(`SELECT * FROM asset_classifications WHERE asset_id = ? AND (? IS NULL OR asset_version_id IS NULL OR asset_version_id = ?) ORDER BY created_at ASC`)
      .all(input.asset_id, input.asset_version_id ?? null, input.asset_version_id ?? null);
    const links = this.db.prepare(`SELECT l.*, e.entity_key, e.entity_type, e.canonical_name, e.aliases_json, e.status AS entity_status
      FROM asset_entity_links l JOIN production_entities e ON e.entity_id = l.entity_id
      WHERE l.asset_id = ? AND (? IS NULL OR l.asset_version_id IS NULL OR l.asset_version_id = ?)
      ORDER BY l.created_at ASC`).all(input.asset_id, input.asset_version_id ?? null, input.asset_version_id ?? null).map(linkFromRow);
    return { asset_id: input.asset_id, asset_version_id: input.asset_version_id ?? null, classifications, entity_links: links };
  }

createEntity(input) {
    this.requireDb();
    if (!input?.entity_key) throw new Error("entity_key is required");
    if (!input?.entity_type) throw new Error("entity_type is required");
    if (!input?.canonical_name) throw new Error("canonical_name is required");
    const entity_type = this.validateEntityType(input.entity_type);
    if (input.project_id) this.requireProject(input.project_id);
    const actor = this.ensureActor(this.resolveRequestActor(input).actor_id, this.resolveRequestActor(input).actor_type);
    const now = new Date().toISOString();
    const entity_id = id("ent");
    this.db.prepare(`INSERT INTO production_entities (entity_id, entity_key, entity_type, canonical_name, aliases_json, description, project_id, status, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(entity_id, input.entity_key, entity_type, input.canonical_name, JSON.stringify(input.aliases ?? []), input.description ?? null, input.project_id ?? null, input.status ?? "active", actor.actor_id, now, now);
    this.commit({ scope: "system", target_id: entity_id, action: "entity.create", message: `已创建生产实体：${input.entity_key}`, actor_id: actor.actor_id, changes: { entity_key: input.entity_key, entity_type } });
    return this.getEntityById(entity_id);
  }

searchEntities(input = {}) {
    this.requireDb();
    const limit = clampInteger(input.limit ?? 20, 1, 100, "limit");
    const offset = clampInteger(input.offset ?? 0, 0, 100000, "offset");
    const query = String(input.query ?? "").trim().toLowerCase();
    const where = [];
    const params = [];
    if (input.entity_type) {
      where.push("entity_type = ?");
      params.push(String(input.entity_type));
    }
    if (input.project_id) {
      where.push("project_id = ?");
      params.push(String(input.project_id));
    }
    if (query) {
      where.push("(instr(lower(entity_key), ?) > 0 OR instr(lower(canonical_name), ?) > 0 OR instr(lower(aliases_json), ?) > 0)");
      params.push(query, query, query);
    }
    const sql = `SELECT * FROM production_entities${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY updated_at DESC, entity_id DESC LIMIT ? OFFSET ?`;
    return this.db.prepare(sql).all(...params, limit, offset).map(entityFromRow);
  }

linkEntityAsset(input) {
    this.requireDb();
    if (!input?.asset_id) throw new Error("asset_id is required");
    if (!input?.relation_type) throw new Error("relation_type is required");
    this.requireAsset(input.asset_id);
    if (input.asset_version_id) this.requireVersionForAsset(input.asset_version_id, input.asset_id, "asset_version_id");
    const entity = input.entity_id ? this.getEntityById(input.entity_id) : this.getEntityByKey(input.entity_key);
    if (!entity) throw new Error(`Entity not found: ${input.entity_id ?? input.entity_key}`);
    const relation_type = this.validateRelationType(input.relation_type);
    const confidence = this.validateConfidence(input.confidence ?? "confirmed");
    const actor = this.ensureActor(this.resolveRequestActor(input).actor_id, this.resolveRequestActor(input).actor_type);
    const now = new Date().toISOString();
    const link_id = id("link");
    this.db.prepare(`INSERT INTO asset_entity_links (link_id, asset_id, asset_version_id, entity_id, relation_type, confidence, notes, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(link_id, input.asset_id, input.asset_version_id ?? null, entity.entity_id, relation_type, confidence, input.notes ?? null, actor.actor_id, now);
    this.commit({ scope: "asset", target_id: input.asset_id, action: "asset.entity.link", message: `已关联素材与实体：${entity.entity_key}`, actor_id: actor.actor_id, changes: { link_id, entity_id: entity.entity_id, relation_type, confidence } });
    return { ...this.getAssetClassification({ asset_id: input.asset_id, asset_version_id: input.asset_version_id }), link_id };
  }

annotateAsset(input) {
    this.requireDb();
    if (!input?.target_type) throw new Error("target_type is required");
    if (!input?.target_id) throw new Error("target_id is required");
    if (!input?.annotation_type) throw new Error("annotation_type is required");
    if (!input?.title) throw new Error("title is required");
    if (!input?.body) throw new Error("body is required");
    const target_type = this.validateAnnotationTargetType(input.target_type);
    const annotation_type = this.validateAnnotationType(input.annotation_type);
    this.requireAnnotationTarget(target_type, input.target_id);
    const visibility = this.validateAnnotationVisibility(input.visibility ?? "internal");
    const actor = this.ensureActor(this.resolveRequestActor(input).actor_id, this.resolveRequestActor(input).actor_type);
    const now = new Date().toISOString();
    const annotation_id = id("ann");
    this.db.prepare(`INSERT INTO asset_annotations (annotation_id, target_type, target_id, annotation_type, title, body, structured_json, status, visibility, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`)
      .run(annotation_id, target_type, input.target_id, annotation_type, input.title, input.body, jsonOrNull(input.structured), visibility, actor.actor_id, now, now);
    this.commit({ scope: target_type === "project_ref" ? "project" : "asset", target_id: input.target_id, action: "asset.annotation.create", message: `已创建批注：${target_type} ${input.target_id}`, actor_id: actor.actor_id, changes: { annotation_id, annotation_type } });
    return this.getAnnotation(annotation_id);
  }

listAnnotations(input) {
    this.requireDb();
    if (!input?.target_type) throw new Error("target_type is required");
    if (!input?.target_id) throw new Error("target_id is required");
    const target_type = this.validateAnnotationTargetType(input.target_type);
    this.requireAnnotationTarget(target_type, input.target_id);
    const rows = input.include_archived
      ? this.db.prepare("SELECT * FROM asset_annotations WHERE target_type = ? AND target_id = ? ORDER BY created_at ASC").all(target_type, input.target_id)
      : this.db.prepare("SELECT * FROM asset_annotations WHERE target_type = ? AND target_id = ? AND status != 'archived' ORDER BY created_at ASC").all(target_type, input.target_id);
    return rows.map(annotationFromRow);
  }

updateAnnotation(input) {
    this.requireDb();
    if (!input?.annotation_id) throw new Error("annotation_id is required");
    const existing = this.getAnnotation(input.annotation_id);
    const status = input.status === undefined ? existing.status : this.validateAnnotationStatus(input.status);
    const visibility = input.visibility === undefined ? existing.visibility : this.validateAnnotationVisibility(input.visibility);
    const actor = this.ensureActor(this.resolveRequestActor(input).actor_id, this.resolveRequestActor(input).actor_type);
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE asset_annotations SET title = ?, body = ?, structured_json = ?, status = ?, visibility = ?, updated_at = ? WHERE annotation_id = ?`)
      .run(input.title ?? existing.title, input.body ?? existing.body, input.structured === undefined ? existing.structured_json : jsonOrNull(input.structured), status, visibility, now, input.annotation_id);
    this.commit({ scope: existing.target_type === "project_ref" ? "project" : "asset", target_id: existing.target_id, action: "asset.annotation.update", message: `已更新批注：${input.annotation_id}`, actor_id: actor.actor_id, changes: { annotation_id: input.annotation_id, status, visibility } });
    return this.getAnnotation(input.annotation_id);
  }

projectContinuityReport(input) {
    this.requireDb();
    const project = this.requireProject(input.project_id);
    const stage = input.stage ?? "production";
    const refs = this.listProjectRefs({ project_id: project.project_id });
    const issues = [];
    const ref_reports = [];
    const entityOccurrences = new Map();
    const versionEntityOccurrences = new Map();
    const characterEntityKeys = new Set();
    for (const ref of refs) {
      const refIssues = [];
      const classifications = this.getClassificationsForRef(ref);
      const primary = classifications[0] ?? null;
      const keyDomain = primary && KEY_DOMAINS.has(primary.domain);
      if (stage === "delivery" && ref.pin_mode !== "pinned" && ref.required) {
        pushContinuityIssue(refIssues, "error", "DELIVERY_REF_NOT_PINNED", ref, `交付阶段引用当前为 ${ref.pin_mode}；交付前必须固定到明确的 asset_version_id。`);
      }
      if (!primary) {
        pushContinuityIssue(refIssues, ref.required ? "error" : "info", "MISSING_TAXONOMY", ref, "项目素材引用缺少 taxonomy 分类。");
      }
      if (primary && ["candidate", "inferred"].includes(primary.confidence)) {
        pushContinuityIssue(refIssues, stage === "delivery" && ref.required ? "error" : "warning", "UNCONFIRMED_TAXONOMY", ref, `taxonomy 置信度为 ${primary.confidence}；交付前必须确认。`);
      }
      const links = this.getEntityLinksForRef(ref);
      if (keyDomain && links.length === 0) {
        pushContinuityIssue(refIssues, ref.required ? "error" : "info", "MISSING_ENTITY_LINK", ref, `必需的 ${primary.domain} 素材缺少实体关联。`);
      }
      if (links.some((link) => ["candidate", "inferred"].includes(link.confidence))) {
        pushContinuityIssue(refIssues, stage === "delivery" && ref.required ? "error" : "warning", "UNCONFIRMED_ENTITY_LINK", ref, "实体关联仍为 candidate/inferred；交付前必须确认。" );
      }
      const annotations = this.getAnnotationsForContinuity(ref, links, primary?.domain);
      if (keyDomain && annotations.required_count === 0) {
        pushContinuityIssue(refIssues, ref.required ? "warning" : "info", "MISSING_KEY_ANNOTATION", ref, `必需的 ${primary.domain} 素材缺少有效的 ${requiredAnnotationForDomain(primary.domain)} 批注。`);
      }
      for (const link of links) {
        const occurrence = { ref, asset_version_id: ref.asset_version_id, entity_key: link.entity_key, entity_type: link.entity_type };
        if (!entityOccurrences.has(link.entity_id)) entityOccurrences.set(link.entity_id, []);
        entityOccurrences.get(link.entity_id).push(occurrence);
        const versionEntityKey = `${ref.asset_version_id}:${link.entity_type}`;
        if (!versionEntityOccurrences.has(versionEntityKey)) versionEntityOccurrences.set(versionEntityKey, []);
        versionEntityOccurrences.get(versionEntityKey).push({ ...occurrence, entity_id: link.entity_id });
        if (link.entity_type === "character") characterEntityKeys.add(link.entity_key);
      }
      const costume_owner_keys = primary?.domain === "costume" ? extractStructuredValues(annotations.details, "owner_character_key") : [];
      const { active, waived } = filterWaivedIssues(refIssues, annotations.details);
      issues.push(...active);
      ref_reports.push({ reference_id: ref.reference_id, asset_id: ref.asset_id, asset_version_id: ref.asset_version_id, taxonomy: primary, entity_links: links, annotation_summary: annotations, costume_owner_keys, issues: active, waived_issues: waived });
    }
    const pushProjectIssue = (level, code, ref, message) => {
      const issue = makeContinuityIssue(level, code, ref, message);
      const refReport = ref_reports.find((item) => item.reference_id === ref.reference_id);
      if (isIssueWaived(issue, refReport?.annotation_summary?.details ?? [])) {
        refReport?.waived_issues.push({ ...issue, waived: true });
      } else {
        issues.push(issue);
        refReport?.issues.push(issue);
      }
    };
    for (const entry of ref_reports) {
      if (entry.taxonomy?.domain === "costume" && entry.costume_owner_keys.length > 0) {
        for (const ownerKey of entry.costume_owner_keys) {
          if (!characterEntityKeys.has(ownerKey)) {
            const ref = refs.find((item) => item.reference_id === entry.reference_id);
            pushProjectIssue("warning", "COSTUME_OWNER_NOT_IN_PROJECT", ref, `服装 owner_character_key=${ownerKey} 未在本项目关联为角色实体。`);
          }
        }
      }
    }
    for (const occurrences of entityOccurrences.values()) {
      const versions = new Set(occurrences.map((item) => item.asset_version_id));
      if (versions.size > 1) {
        const first = occurrences[0];
        pushProjectIssue("warning", "ENTITY_VERSION_CONFLICT", first.ref, `实体 ${first.entity_key} 在本项目关联了多个素材版本：${[...versions].join(", ")}。请补充连续性说明或固定预期版本集合。`);
      }
    }
    for (const occurrences of versionEntityOccurrences.values()) {
      const entities = new Set(occurrences.map((item) => item.entity_id));
      if (entities.size > 1) {
        const first = occurrences[0];
        pushProjectIssue("warning", "MULTI_ENTITY_LINK_CONFLICT", first.ref, `素材版本 ${first.asset_version_id} 在本项目关联了多个 ${first.entity_type} 实体。`);
      }
    }
    const waived = ref_reports.flatMap((ref) => ref.waived_issues);
    return { project_id: project.project_id, stage, refs: ref_reports, issues, waived, errors: issues.filter((issue) => issue.level === "error"), warnings: issues.filter((issue) => issue.level === "warning") };
  }

assetTaxonomyReport(input = {}) {
    this.requireDb();
    const limit = Math.min(Number(input.limit ?? 200), 500);
    const rows = input.include_archived
      ? this.db.prepare("SELECT * FROM assets ORDER BY updated_at DESC LIMIT ?").all(limit)
      : this.db.prepare("SELECT * FROM assets WHERE lifecycle != 'archived' AND lifecycle != 'soft_deleted' ORDER BY updated_at DESC LIMIT ?").all(limit);
    const assets = [];
    const issues = [];
    for (const asset of rows) {
      const version_id = asset.default_version_id;
      const classifications = this.db.prepare("SELECT * FROM asset_classifications WHERE asset_id = ? AND (asset_version_id IS NULL OR asset_version_id = ?) ORDER BY asset_version_id IS NULL ASC, created_at ASC").all(asset.asset_id, version_id);
      const primary = classifications[0] ?? null;
      const links = this.db.prepare(`SELECT l.*, e.entity_key, e.entity_type, e.canonical_name, e.aliases_json, e.status AS entity_status
        FROM asset_entity_links l JOIN production_entities e ON e.entity_id = l.entity_id
        WHERE l.asset_id = ? AND (l.asset_version_id IS NULL OR l.asset_version_id = ?)
        ORDER BY l.asset_version_id IS NULL ASC, l.created_at ASC`).all(asset.asset_id, version_id).map(linkFromRow);
      const keyDomain = primary && KEY_DOMAINS.has(primary.domain);
      const annotations = this.getAnnotationsForContinuity({ asset_id: asset.asset_id, asset_version_id: version_id, reference_id: null }, links, primary?.domain);
      const assetIssues = [];
      const pseudoRef = { reference_id: null, asset_id: asset.asset_id, asset_version_id: version_id, required: 1 };
      if (!primary) pushContinuityIssue(assetIssues, "warning", "MISSING_TAXONOMY", pseudoRef, "素材缺少 taxonomy 分类。");
      if (primary && ["candidate", "inferred"].includes(primary.confidence)) pushContinuityIssue(assetIssues, "warning", "UNCONFIRMED_TAXONOMY", pseudoRef, `taxonomy 置信度为 ${primary.confidence}。`);
      if (keyDomain && links.length === 0) pushContinuityIssue(assetIssues, "warning", "MISSING_ENTITY_LINK", pseudoRef, `关键 ${primary.domain} 素材缺少实体关联。`);
      if (keyDomain && annotations.required_count === 0) pushContinuityIssue(assetIssues, "info", "MISSING_KEY_ANNOTATION", pseudoRef, `关键 ${primary.domain} 素材缺少有效的 ${requiredAnnotationForDomain(primary.domain)} 批注。`);
      const { active, waived } = filterWaivedIssues(assetIssues, annotations.details);
      issues.push(...active);
      assets.push({ asset_id: asset.asset_id, default_version_id: version_id, title: asset.title, media_type: asset.media_type, taxonomy: primary, entity_links: links, annotation_summary: annotations, issues: active, waived_issues: waived });
    }
    const waived = assets.flatMap((asset) => asset.waived_issues);
    return { assets_scanned: assets.length, assets, issues, waived, warnings: issues.filter((issue) => issue.level === "warning"), info: issues.filter((issue) => issue.level === "info") };
  }

getProject(input) {
    this.requireDb();
    const project_id = typeof input === "string" ? input : input?.project_id;
    if (!project_id) throw new Error("project_id is required");
    const row = this.db.prepare("SELECT * FROM projects WHERE project_id = ?").get(project_id);
    if (!row) throw new Error(`Project not found: ${project_id}`);
    return projectFromRow(row);
  }

resolveRequestActor(input = {}) {
    const context = trustedContextOf(input);
    if (context && context.trusted === true && typeof context.actor_id === "string" && context.actor_id.trim()) {
      return { actor_id: context.actor_id.trim(), actor_type: context.actor_type ?? "agent", actor_source: context.source ?? "trusted-context", trusted: true };
    }
    const supplied = typeof input?.actor_id === "string" && input.actor_id.trim() ? input.actor_id.trim() : null;
    return {
      actor_id: supplied ?? DEFAULT_ACTOR,
      actor_type: input?.actor_type ?? "agent",
      actor_source: supplied ? "request-param" : "default-unattributed",
      trusted: false
    };
  }

beginGeneration({ entry, input = {}, params = null, budget_scope = null }) {
    if (!GENERATION_ENTRY_POLICY[entry]) throw new Error(`unknown generation entry: ${String(entry)}`);
    const context = trustedContextOf(input);
    const decision = this.providerGateway.authorize({
      entry,
      surface: context?.surface ?? "tool",
      context,
      params: params ?? input,
      // Trusted, plugin-supplied reservation scope (a job's durable ledger id). It is a separate
      // argument on purpose: a request body cannot reach it, so no caller can declare its own spend.
      budget_scope
    });
    // The trusted context rides on the returned object (as a Symbol, so a JSON round trip cannot
    // forge it). `callProvider` reads it back to bind every adapter call of this operation to the
    // actor the authorization was issued to.
    return withTrustedContext({ ...decision, public: this.publicAuthorization(decision) }, context);
  }

async callProvider({ audit, provider = null, payload = {} }) {
    const outcome = await this.providerGateway.invokeAdapter({
      audit_id: audit?.audit_id,
      provider: provider ?? GENERATION_ENTRY_POLICY[audit?.audit?.entry]?.provider ?? null,
      context: trustedContextOf(audit),
      payload
    });
    if (outcome && outcome.refused) {
      const error = new Error(`provider call refused (${outcome.code}): ${outcome.error}`);
      error.code = outcome.code;
      error.details = outcome.details;
      throw error;
    }
    return outcome;
  }

finishGeneration(audit, outcome = "completed") {
    if (!audit?.audit_id) return { closed: false, reason: "no audit id" };
    try {
      return this.providerGateway.finalize(audit.audit_id, { outcome });
    } catch (error) {
      this.logger?.warn?.(`[video-assets] closing generation authorization failed: ${error instanceof Error ? error.message : String(error)}`);
      return { closed: false, reason: "error" };
    }
  }

publicAuthorization(decision) {
    return {
      allowed: decision.allowed === true,
      code: decision.code ?? "OK",
      error: decision.error ?? null,
      details: decision.details ?? null,
      audit_id: decision.audit_id ?? null,
      entry: decision.audit?.entry ?? null,
      provider: decision.audit?.provider ?? null,
      surface: decision.audit?.surface ?? null,
      actor: decision.audit?.attribution ?? null,
      estimated_credits: decision.audit?.estimate?.credits ?? null,
      // The published provider-call allowance and the reservation scope: both are part of the contract a
      // caller (the queue adapter) reads back, so they are reported instead of being internal.
      calls_max: decision.audit?.calls_max ?? null,
      budget_scope: decision.audit?.budget_scope ?? null,
      budget: decision.audit?.budget ?? null,
      // The accepted submission a read-only recovery grant is bound to (null for a paid grant). Part of
      // the contract a caller reads back, so a report can show WHAT the grant was bound to.
      read_only_binding: decision.read_only_binding ?? decision.audit?.read_only_binding ?? null,
      decided_at: decision.audit?.at ?? null
    };
  }

blockedGeneration(base, decision, entry) {
    return {
      ...base,
      status: "blocked",
      provider_invoked: false,
      entry,
      blockers: [...(base?.blockers ?? []), decision.error],
      authorization: decision.public,
      next_actions: [
        "生成未执行：当前调用未获得生成授权或没有可用预算，provider 未被调用。",
        "如需授权，请检查 security.generation（allowSurfaces / allowActors / ledger）与预算配置。"
      ]
    };
  }

providerGatewayStats() {
    return this.providerGateway.stats();
  }

providerGatewayDenials() {
    return this.providerGateway.denials();
  }

ensureActor(actor_id, actor_type) {
    const existing = this.db.prepare("SELECT * FROM actors WHERE actor_id = ?").get(actor_id);
    if (existing) return existing;
    const now = new Date().toISOString();
    this.db.prepare("INSERT INTO actors (actor_id, actor_type, display_name, created_at) VALUES (?, ?, ?, ?)").run(actor_id, actor_type, actor_id, now);
    return { actor_id, actor_type, display_name: actor_id, created_at: now };
  }

ensureSchemaMigrations() {
    const columns = new Set(this.db.prepare("PRAGMA table_info(project_references)").all().map((column) => column.name));
    const addColumn = (name, definition) => {
      if (!columns.has(name)) this.db.prepare(`ALTER TABLE project_references ADD COLUMN ${name} ${definition}`).run();
    };
    addColumn("status", "TEXT NOT NULL DEFAULT 'active'");
    addColumn("updated_at", "TEXT");
    addColumn("removed_at", "TEXT");
    addColumn("removed_by", "TEXT");

    // REN-08: the canvas document revision. `CREATE TABLE IF NOT EXISTS` in the schema script gives the column to a
    // NEW database but does nothing to one that already exists, so the column is added here too - a canvas created
    // before this package must be editable and must start reporting a revision, not fail on a missing column.
    // DEFAULT 0 is the honest starting value: an existing canvas has no recorded history, and claiming a nonzero
    // revision would assert a change that was never applied.
    const canvasColumns = new Set(this.db.prepare("PRAGMA table_info(canvases)").all().map((column) => column.name));
    if (!canvasColumns.has("revision")) {
      this.db.prepare("ALTER TABLE canvases ADD COLUMN revision INTEGER NOT NULL DEFAULT 0").run();
    }
    // The command log itself: old databases predate it, so create it here as well as in the schema script.
    this.db.exec(`CREATE TABLE IF NOT EXISTS canvas_commands (
      command_id TEXT PRIMARY KEY,
      canvas_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      base_revision INTEGER NOT NULL,
      command_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      inverse_json TEXT,
      result_json TEXT,
      actor_id TEXT NOT NULL,
      client_id TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(canvas_id) REFERENCES canvases(canvas_id),
      UNIQUE(canvas_id, revision)
    )`);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_canvas_commands_canvas_revision ON canvas_commands(canvas_id, revision DESC)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_canvas_commands_actor ON canvas_commands(actor_id, canvas_id, revision DESC)");
  }

commit({ scope, target_id, action, message, actor_id, changes }) {
    this.db.prepare(`INSERT INTO commits (commit_id, scope, target_id, action, message, actor_id, created_at, changes_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id("commit"), scope, target_id, action, message, actor_id, new Date().toISOString(), JSON.stringify(changes ?? {}));
  }

getAssetRow(asset_id) {
    return this.db.prepare("SELECT * FROM assets WHERE asset_id = ?").get(asset_id);
  }

getVersionRow(asset_version_id) {
    return this.db.prepare("SELECT * FROM asset_versions WHERE asset_version_id = ?").get(asset_version_id);
  }

listAssetSources(asset_id) {
    return this.db.prepare("SELECT * FROM asset_sources WHERE asset_id = ? ORDER BY captured_at ASC").all(asset_id);
  }

lazyReprobeVersion(version) {
    if (!this.shouldLazyReprobeVersion(version)) return version;
    const filePath = getObjectPath(this.root, version.object_id);
    if (!fs.existsSync(filePath)) return version;

    const probe = probeMedia(filePath, { file_name: version.file_name, mime_type: version.mime_type });
    const updates = Object.fromEntries(MEDIA_METADATA_FIELDS
      .filter((field) => version[field] == null && probe[field] != null)
      .map((field) => [field, probe[field]]));
    if (Object.keys(updates).length === 0) return version;

    const fields = Object.keys(updates);
    const setSql = fields.map((field) => `${field} = ?`).join(", ");
    this.db.prepare(`UPDATE asset_versions SET ${setSql} WHERE asset_version_id = ?`).run(...fields.map((field) => updates[field]), version.asset_version_id);
    this.commit({
      scope: "asset",
      target_id: version.asset_id,
      action: "asset.version.lazy_reprobe",
      message: `已延迟刷新媒体元数据：${version.file_name}`,
      actor_id: DEFAULT_ACTOR,
      changes: { asset_version_id: version.asset_version_id, fields }
    });
    return { ...version, ...updates };
  }

shouldLazyReprobeVersion(version) {
    if (!version) return false;
    const extension = String(version.extension ?? "").toLowerCase();
    const mimeType = String(version.mime_type ?? "").toLowerCase();
    const isIsoBmffVideo = LAZY_REPROBE_VIDEO_EXTENSIONS.has(extension) || ["video/mp4", "video/quicktime", "video/x-m4v"].includes(mimeType);
    return isIsoBmffVideo && VIDEO_METADATA_FIELDS.every((field) => version[field] == null);
  }

getProjectRow(project_id) {
    return this.db.prepare("SELECT * FROM projects WHERE project_id = ?").get(project_id);
  }

getBranchRow(branch_id) {
    return this.db.prepare("SELECT * FROM asset_branches WHERE branch_id = ?").get(branch_id);
  }

getProjectRefRow(reference_id) {
    return this.db.prepare("SELECT * FROM project_references WHERE reference_id = ?").get(reference_id);
  }

getEntityById(entity_id) {
    const row = this.db.prepare("SELECT * FROM production_entities WHERE entity_id = ?").get(entity_id);
    if (!row) throw new Error(`Entity not found: ${entity_id}`);
    return entityFromRow(row);
  }

getEntityByKey(entity_key) {
    if (!entity_key) return null;
    const row = this.db.prepare("SELECT * FROM production_entities WHERE entity_key = ?").get(entity_key);
    return row ? entityFromRow(row) : null;
  }

getAnnotation(annotation_id) {
    const row = this.db.prepare("SELECT * FROM asset_annotations WHERE annotation_id = ?").get(annotation_id);
    if (!row) throw new Error(`Annotation not found: ${annotation_id}`);
    return annotationFromRow(row);
  }

getClassificationsForRef(ref) {
    return this.db.prepare(`SELECT * FROM asset_classifications WHERE asset_id = ? AND (asset_version_id IS NULL OR asset_version_id = ?) ORDER BY asset_version_id IS NULL ASC, created_at ASC`)
      .all(ref.asset_id, ref.asset_version_id);
  }

getEntityLinksForRef(ref) {
    return this.db.prepare(`SELECT l.*, e.entity_key, e.entity_type, e.canonical_name, e.aliases_json, e.status AS entity_status
      FROM asset_entity_links l JOIN production_entities e ON e.entity_id = l.entity_id
      WHERE l.asset_id = ? AND (l.asset_version_id IS NULL OR l.asset_version_id = ?)
      ORDER BY l.asset_version_id IS NULL ASC, l.created_at ASC`).all(ref.asset_id, ref.asset_version_id).map(linkFromRow);
  }

getAnnotationsForContinuity(ref, links, domain) {
    const requiredType = requiredAnnotationForDomain(domain);
    const targets = [
      ["asset", ref.asset_id],
      ["asset_version", ref.asset_version_id],
      ref.reference_id ? ["project_ref", ref.reference_id] : null,
      ...links.map((link) => ["entity", link.entity_id])
    ].filter(Boolean);
    let active_count = 0;
    let required_count = 0;
    const details = [];
    for (const [target_type, target_id] of targets) {
      const row = this.db.prepare("SELECT annotation_type, COUNT(*) AS count FROM asset_annotations WHERE target_type = ? AND target_id = ? AND status = 'active' GROUP BY annotation_type").all(target_type, target_id);
      for (const item of row) {
        active_count += Number(item.count ?? 0);
        if (requiredType && item.annotation_type === requiredType) required_count += Number(item.count ?? 0);
      }
      details.push(...this.db.prepare("SELECT * FROM asset_annotations WHERE target_type = ? AND target_id = ? AND status = 'active' ORDER BY created_at ASC").all(target_type, target_id).map(annotationFromRow));
    }
    return { active_count, required_annotation_type: requiredType, required_count, details };
  }

requireAsset(asset_id, label = "asset_id") {
    const asset = this.getAssetRow(asset_id);
    if (!asset) throw new Error(`Asset not found for ${label}: ${asset_id}`);
    return asset;
  }

requireProject(project_id) {
    return this.getProject(project_id);
  }

requireProjectRef(reference_id) {
    const ref = this.getProjectRefRow(reference_id);
    if (!ref) throw new Error(`Project reference not found: ${reference_id}`);
    return ref;
  }

requireVersionForAsset(asset_version_id, asset_id, label = "asset_version_id") {
    const version = this.getVersionRow(asset_version_id);
    if (!version) throw new Error(`Asset version not found for ${label}: ${asset_version_id}`);
    if (version.asset_id !== asset_id) throw new Error(`${label} ${asset_version_id} belongs to asset ${version.asset_id}, not ${asset_id}`);
    return version;
  }

validateLicenseStatus(value) {
    const status = String(value ?? "").trim();
    if (!LICENSE_STATUSES.has(status)) throw new Error(`Invalid license_status: ${value}`);
    return status;
  }

validateRiskLevel(value) {
    const level = String(value ?? "").trim();
    if (!RISK_LEVELS.has(level)) throw new Error(`Invalid risk_level: ${value}`);
    return level;
  }

requireBranchForAsset(branch_id, asset_id, label = "branch_id") {
    const branch = this.getBranchRow(branch_id);
    if (!branch) throw new Error(`Asset branch not found for ${label}: ${branch_id}`);
    if (branch.asset_id !== asset_id) throw new Error(`${label} ${branch_id} belongs to asset ${branch.asset_id}, not ${asset_id}`);
    return branch;
  }

validatePinMode(pin_mode) {
    if (!["pinned", "follow_latest", "candidate"].includes(pin_mode)) throw new Error(`Invalid pin_mode: ${pin_mode}`);
  }

validateDomain(domain) {
    if (!DOMAINS.has(domain)) throw new Error(`Invalid taxonomy domain: ${domain}`);
    return domain;
  }

validateConfidence(confidence) {
    if (!["confirmed", "candidate", "inferred"].includes(confidence)) throw new Error(`Invalid confidence: ${confidence}`);
    return confidence;
  }

validateClassificationSource(source) {
    if (!["manual", "agent", "import", "migration"].includes(source)) throw new Error(`Invalid classification source: ${source}`);
    return source;
  }

validateEntityType(entity_type) {
    if (!["character", "scene", "costume", "prop", "organization", "style", "other"].includes(entity_type)) throw new Error(`Invalid entity_type: ${entity_type}`);
    return entity_type;
  }

validateRelationType(relation_type) {
    if (!["depicts", "costume_for", "prop_for", "scene_for", "style_for", "voice_for", "reference_for"].includes(relation_type)) throw new Error(`Invalid relation_type: ${relation_type}`);
    return relation_type;
  }

validateDerivativeType(derivative_type) {
    if (!DERIVATIVE_TYPES.has(derivative_type)) throw new Error(`Invalid derivative_type: ${derivative_type}`);
    return derivative_type;
  }

validateAnnotationTargetType(target_type) {
    if (!["asset", "asset_version", "entity", "project_ref"].includes(target_type)) throw new Error(`Invalid annotation target_type: ${target_type}`);
    return target_type;
  }

validateAnnotationType(annotation_type) {
    if (!["character_profile", "scene_concept", "costume_spec", "prop_function", "visual_continuity", "source_rights", "production_note", "review_note", "prompt_note", "other"].includes(annotation_type)) throw new Error(`Invalid annotation_type: ${annotation_type}`);
    return annotation_type;
  }

validateAnnotationVisibility(visibility) {
    if (!["internal", "project", "public_summary"].includes(visibility)) throw new Error(`Invalid visibility: ${visibility}`);
    return visibility;
  }

validateAnnotationStatus(status) {
    if (!["draft", "active", "superseded", "resolved", "archived"].includes(status)) throw new Error(`Invalid annotation status: ${status}`);
    return status;
  }

requireAnnotationTarget(target_type, target_id) {
    if (target_type === "asset") return this.requireAsset(target_id);
    if (target_type === "asset_version") {
      const version = this.getVersionRow(target_id);
      if (!version) throw new Error(`Asset version not found: ${target_id}`);
      return version;
    }
    if (target_type === "entity") return this.getEntityById(target_id);
    if (target_type === "project_ref") return this.requireProjectRef(target_id);
    throw new Error(`Invalid annotation target_type: ${target_type}`);
  }

objectExists(object_id) {
    try {
      return fs.existsSync(getObjectPath(this.root, object_id));
    } catch {
      return false;
    }
  }

resolveVersionFile(asset_version_id) {
    this.requireDb();
    const version = this.lazyReprobeVersion(this.getVersionRow(asset_version_id));
    if (!version) throw new Error(`Asset version not found: ${asset_version_id}`);
    return {
      asset_version_id,
      file_path: getObjectPath(this.root, version.object_id),
      file_name: version.file_name,
      extension: version.extension,
      mime_type: version.mime_type,
      size_bytes: version.size_bytes,
      sha256: version.sha256,
      width: version.width,
      height: version.height,
      duration_ms: version.duration_ms,
      frame_rate: version.frame_rate,
      sample_rate: version.sample_rate,
      channels: version.channels,
      codec: version.codec
    };
  }

getMainBranch(asset_id) {
    return this.db.prepare("SELECT * FROM asset_branches WHERE asset_id = ? AND name = 'main'").get(asset_id);
  }

nextVersionLabel(asset_id) {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM asset_versions WHERE asset_id = ?").get(asset_id);
    return `v${String(Number(row?.count ?? 0) + 1).padStart(3, "0")}`;
  }

requireDb() {
    if (!this.db) throw new Error("VideoAssetService is not initialized");
  }

projectSummary(row) {
    const refStats = this.db.prepare(`SELECT COUNT(*) AS ref_count, SUM(CASE WHEN required = 1 THEN 1 ELSE 0 END) AS required_ref_count
      FROM project_references WHERE project_id = ? AND status != 'removed'`).get(row.project_id);
    let warning_count = 0;
    let error_count = 0;
    try {
      const report = this.projectReport({ project_id: row.project_id });
      const continuity = this.projectContinuityReport({ project_id: row.project_id, stage: "production" });
      warning_count = report.issues.filter((issue) => issue.level === "warning").length + continuity.warnings.length;
      error_count = report.issues.filter((issue) => issue.level === "error").length + continuity.errors.length;
    } catch {
      warning_count = 0;
      error_count = 1;
    }
    return {
      ...projectFromRow(row),
      ref_count: Number(refStats?.ref_count ?? 0),
      required_ref_count: Number(refStats?.required_ref_count ?? 0),
      warning_count,
      error_count
    };
  }

resolveAllowedFilePath(root_key, relativePath = "") {
    const root = FILE_ROOTS[root_key];
    if (!root) throw new Error(`Unknown file root: ${root_key}`);
    const cleaned = String(relativePath ?? "").replaceAll("\\", "/").replace(/^\/+/, "");
    if (path.isAbsolute(String(relativePath ?? "")) || cleaned.split("/").includes("..")) {
      throw new Error("relative_path must stay inside the selected root");
    }
    const rootAbsolute = path.resolve(this.root, root.relativePath);
    const absolute_path = path.resolve(rootAbsolute, cleaned);
    if (!isInsidePath(rootAbsolute, absolute_path)) {
      throw new Error("resolved file path escapes the selected root");
    }
    return { root_key, root_absolute: rootAbsolute, absolute_path, relative_path_posix: cleaned };
  }

async fileEntry(root_key, relativePath, absolutePath, dirent = null, knownStat = null) {
    const stat = knownStat ?? await fs.promises.stat(absolutePath);
    const isDirectory = dirent ? dirent.isDirectory() : stat.isDirectory();
    return {
      root_key,
      relative_path: normalizeRelativePath(relativePath),
      name: path.basename(absolutePath),
      extension: isDirectory ? null : path.extname(absolutePath).toLowerCase(),
      is_directory: isDirectory,
      size_bytes: stat.size,
      modified_at: stat.mtime.toISOString(),
      created_at: stat.birthtime.toISOString(),
      binding_state: isDirectory ? "directory" : this.fileBindingState(absolutePath)
    };
  }

fileBindingState(absolutePath) {
    const binding = this.findFileBinding(absolutePath, { skipHashFallback: true });
    if (binding?.asset_versions?.length || binding?.derived_files?.length) return "bound";
    return "unbound";
  }

findFileBinding(absolutePath, { skipHashFallback = false } = {}) {
    const normalized = path.resolve(absolutePath);
    const objectId = objectIdFromObjectPath(this.root, normalized);
    let sha256 = objectId ? objectId.slice("sha256:".length) : null;
    if (!sha256 && !skipHashFallback) {
      try {
        sha256 = hashFileSync(normalized);
      } catch {
        sha256 = null;
      }
    }
    if (!sha256) return { asset_versions: [], derived_files: [] };
    const versions = this.db.prepare(`SELECT v.*, a.title, a.kind, a.media_type, a.lifecycle, a.license_status
      FROM asset_versions v JOIN assets a ON a.asset_id = v.asset_id WHERE v.sha256 = ? ORDER BY v.created_at ASC`).all(sha256);
    const derived = this.db.prepare("SELECT * FROM derived_files WHERE sha256 = ? ORDER BY created_at ASC").all(sha256).map(derivedFileFromRow);
    return { sha256, asset_versions: versions.map(versionFromRow), derived_files: derived };
  }

async walkFiles(root_key, absoluteDir, relativeDir, depth, visitor) {
    if (depth < 0) return;
    let entries = [];
    try {
      entries = await fs.promises.readdir(absoluteDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const absolute = path.join(absoluteDir, entry.name);
      const relativePath = path.posix.join(relativeDir, entry.name);
      await visitor(absolute, relativePath, entry);
      if (entry.isDirectory()) {
        await this.walkFiles(root_key, absolute, relativePath, depth - 1, visitor);
      }
    }
  }
}
