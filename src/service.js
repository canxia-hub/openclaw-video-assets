import { DatabaseSync } from "node:sqlite";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { CREATE_SCHEMA_SQL } from "./schema.js";
import { probeMedia } from "./media-probe.js";
import { ensureRepositoryLayoutSync, getObjectPath, resolveRepositoryRoot, storeObject } from "./storage.js";
import {
  DOUBAO_AUDIO_GUIDE_SOURCE,
  doubaoAudioNextActions,
  normalizeDoubaoAudioRequest,
  runDoubaoAudioGeneration,
  validateDoubaoAudioRequest
} from "./doubao-audio-adapter.js";
import {
  KIE_SUNO_GUIDE_SOURCE,
  kieSunoNextActions,
  normalizeKieSunoRequest,
  runKieSunoGeneration,
  validateKieSunoRequest
} from "./kie-suno-adapter.js";

const DEFAULT_ACTOR = "agent:unknown";
const VIDEO_ASSETS_WIDGET_URI = "ui://widget/video-assets/canvas.html";
const VIDEO_ASSETS_WORKBENCH_URL = "/__openclaw__/video-assets/workbench/";
const MAX_STAGING_UPLOAD_BYTES = 100 * 1024 * 1024;
const ASSET_TITLE_MAX_LENGTH = 512;
const ASSET_DESCRIPTION_MAX_LENGTH = 65536;
const ASSET_TAG_MAX_ITEMS = 64;
const ASSET_TAG_MAX_LENGTH = 128;
const DOMAINS = new Set(["character", "scene", "costume", "prop", "audio", "reference", "prompt", "document", "delivery", "other"]);
const KEY_DOMAINS = new Set(["character", "scene", "costume", "prop"]);
const DERIVATIVE_TYPES = new Set(["thumbnail", "proxy", "transcode", "audio_proxy", "subtitle", "waveform", "contact_sheet", "metadata", "other"]);
const LAZY_REPROBE_VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".m4v"]);
const MEDIA_METADATA_FIELDS = ["width", "height", "duration_ms", "frame_rate", "sample_rate", "channels", "codec"];
const VIDEO_METADATA_FIELDS = ["width", "height", "duration_ms", "frame_rate", "codec"];
const LICENSE_STATUSES = new Set(["unknown", "cleared", "restricted", "rejected"]);
const RISK_LEVELS = new Set(["unknown", "low", "medium", "high"]);
const CANVAS_SHAPE_TYPES = new Set(["project_card", "asset_card", "entity_card", "reference_card", "note", "section"]);
const CANVAS_SUBJECT_TYPES = new Set(["project", "asset", "asset_version", "project_ref", "entity", "note", "section"]);
const CANVAS_RELATION_TYPES = new Set(["uses", "depends_on", "references", "derived_from", "revises", "replaces", "continues", "belongs_to", "appears_in", "blocks", "contains", "related_to"]);
const GENERATION_TYPES = new Set(["image", "image_to_video", "text_to_video", "multimodal_to_video", "edit", "voice", "subtitle", "cover", "export"]);
const WIDGET_DISPLAY_MODES = new Set(["inline", "fullscreen", "pip"]);
const GENERATION_SLOT_KEYS = Object.freeze(["main_reference", "character_reference", "scene_reference", "motion_reference", "style_reference", "video_clip", "audio", "subtitle", "project_config", "draft_output"]);
const GENERATION_INPUT_SLOT_KEYS = new Set(GENERATION_SLOT_KEYS.filter((slot) => slot !== "draft_output"));
const GENERATION_SLOT_REPLACE_POLICIES = new Set(["insert_beside", "replace_slot", "new_revision", "append_timeline"]);
const GENERATION_SLOT_STATUSES = new Set(["empty", "ready", "generating", "filled", "blocked"]);
const REVISION_CARD_STATUSES = new Set(["open", "in_progress", "resolved", "rejected"]);
const DEFAULT_DREAMINA_CLI_PATH = path.join(process.env.USERPROFILE ?? process.env.HOME ?? "", "bin", "dreamina.exe");
const DREAMINA_TEXT2VIDEO_MODELS = new Set(["seedance2.0", "seedance2.0fast", "seedance2.0_vip", "seedance2.0fast_vip", "seedance2.0mini"]);
const DREAMINA_IMAGE2VIDEO_MODELS = new Set(["3.0", "3.0fast", "3.0pro", "3.0_fast", "3.0_pro", "3.5pro", "3.5_pro", "seedance2.0", "seedance2.0fast", "seedance2.0_vip", "seedance2.0fast_vip", "seedance2.0mini"]);
const DREAMINA_VIDEO_RATIOS = new Set(["1:1", "3:4", "16:9", "4:3", "9:16", "21:9"]);
const DREAMINA_VIDEO_RESOLUTIONS = new Set(["720p", "1080p"]);
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
const PRODUCTION_CANVAS_STAGES = Object.freeze([
  { key: "overview", title: "项目总览", x: 0, y: 0, width: 300, height: 190, required: true },
  { key: "characters", title: "角色 / 表演", x: 340, y: 0, width: 360, height: 260, required: true },
  { key: "scenes", title: "场景 / 美术", x: 740, y: 0, width: 360, height: 260, required: true },
  { key: "props", title: "服装 / 道具", x: 1140, y: 0, width: 360, height: 260, required: false },
  { key: "references", title: "参考 / 风格", x: 340, y: 330, width: 360, height: 260, required: false },
  { key: "audio", title: "声音 / 字幕", x: 740, y: 330, width: 360, height: 260, required: false },
  { key: "shots", title: "镜头 / 生成槽位", x: 1140, y: 330, width: 360, height: 300, required: true },
  { key: "delivery", title: "审核 / 交付", x: 0, y: 330, width: 300, height: 260, required: true }
]);
const PRODUCTION_CANVAS_STAGE_BY_KEY = new Map(PRODUCTION_CANVAS_STAGES.map((stage) => [stage.key, stage]));
const PRODUCTION_CANVAS_SLOT_NOTES = Object.freeze([
  { key: "main_reference", title: "主参考图槽位", stage: "shots", text: "等待绑定主参考图或关键项目引用。" },
  { key: "motion_reference", title: "动作/镜头参考槽位", stage: "shots", text: "等待绑定动作参考、分镜参考或镜头说明。" },
  { key: "draft_output", title: "测试样片槽位", stage: "shots", text: "等待放入测试图、短样片或代理预览。" },
  { key: "review_delivery", title: "审核交付槽位", stage: "delivery", text: "等待补审核意见、交付规格与最终导出引用。" }
]);
const DEFAULT_WIDGET_RUNTIME_SUPPORT = Object.freeze({
  nativeResource: false,
  resourceRegistration: "not_available_in_current_openclaw_plugin_api",
  fallback: "protected_workbench_route",
  resourceUri: VIDEO_ASSETS_WIDGET_URI,
  fallbackUrl: VIDEO_ASSETS_WORKBENCH_URL,
  attemptedApis: [],
  diagnostics: ["No OpenClaw native widget resource registration API has been detected in this runtime."]
});

export class VideoAssetService {
  constructor({ pluginConfig = {}, logger = console } = {}) {
    this.root = resolveRepositoryRoot(pluginConfig);
    this.logger = logger;
    this.db = null;
    this.canvasWidgetRuntimeSupport = { ...DEFAULT_WIDGET_RUNTIME_SUPPORT };
  }

  init() {
    ensureRepositoryLayoutSync(this.root);
    this.db = new DatabaseSync(path.join(this.root, "metadata", "video-assets.sqlite"));
    runSqlScript(this.db, CREATE_SCHEMA_SQL);
    this.ensureSchemaMigrations();
    return this;
  }

  close() {
    this.db?.close();
    this.db = null;
  }

  setCanvasWidgetRuntimeSupport(support = {}) {
    this.canvasWidgetRuntimeSupport = {
      ...DEFAULT_WIDGET_RUNTIME_SUPPORT,
      ...support,
      attemptedApis: Array.isArray(support.attemptedApis) ? support.attemptedApis : DEFAULT_WIDGET_RUNTIME_SUPPORT.attemptedApis,
      diagnostics: Array.isArray(support.diagnostics) ? support.diagnostics : DEFAULT_WIDGET_RUNTIME_SUPPORT.diagnostics
    };
  }

  async ingestAsset(input) {
    this.requireDb();
    if (!input?.file_path) throw new Error("file_path is required");
    const title = boundedRequiredString(input.title ?? path.basename(String(input.file_path)), "title", ASSET_TITLE_MAX_LENGTH);
    const description = boundedNullableString(input.description, "description", ASSET_DESCRIPTION_MAX_LENGTH);
    const tags = normalizeStringArray(input.tags ?? [], "tags", { maxItems: ASSET_TAG_MAX_ITEMS, maxLength: ASSET_TAG_MAX_LENGTH });
    const kind = input.kind === "working" ? "working" : "raw";
    const actor = this.ensureActor(input.actor_id ?? DEFAULT_ACTOR, input.actor_type ?? "agent");
    const now = new Date().toISOString();
    const stored = await storeObject(this.root, input.file_path);
    const probe = probeMedia(input.file_path);
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
    const actor = this.ensureActor(input.actor_id ?? DEFAULT_ACTOR, input.actor_type ?? "agent");
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
    const actor = this.ensureActor(input.actor_id ?? DEFAULT_ACTOR, input.actor_type ?? "agent");
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
    const actor = this.ensureActor(input.actor_id ?? DEFAULT_ACTOR, input.actor_type ?? "agent");
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

  createAssetRelation(input = {}) {
    this.requireDb();
    if (!input.relation_type) throw new Error("relation_type is required");
    if (!input.source_asset_id) throw new Error("source_asset_id is required");
    if (!input.source_version_id) throw new Error("source_version_id is required");
    if (!input.target_asset_id) throw new Error("target_asset_id is required");
    this.requireAsset(input.source_asset_id, "source_asset_id");
    this.requireAsset(input.target_asset_id, "target_asset_id");
    this.requireVersionForAsset(input.source_version_id, input.source_asset_id, "source_version_id");
    if (input.target_version_id) this.requireVersionForAsset(input.target_version_id, input.target_asset_id, "target_version_id");
    const actor = this.ensureActor(input.actor_id ?? DEFAULT_ACTOR, input.actor_type ?? "agent");
    const relation_id = input.relation_id ?? id("rel");
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO asset_relations (relation_id, relation_type, source_asset_id, source_version_id, target_asset_id, target_version_id, copy_type, reason, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(relation_id, input.relation_type, input.source_asset_id, input.source_version_id, input.target_asset_id, input.target_version_id ?? null, input.copy_type ?? null, input.reason ?? null, actor.actor_id, now);
    this.commit({ scope: "asset", target_id: input.target_asset_id, action: "asset.relation.create", message: input.reason ?? `已建立素材关系：${input.source_asset_id} → ${input.target_asset_id}`, actor_id: actor.actor_id, changes: { relation_id, relation_type: input.relation_type, source_asset_id: input.source_asset_id, source_version_id: input.source_version_id, target_version_id: input.target_version_id ?? null } });
    return { relation_id, relation_type: input.relation_type, source_asset_id: input.source_asset_id, source_version_id: input.source_version_id, target_asset_id: input.target_asset_id, target_version_id: input.target_version_id ?? null, copy_type: input.copy_type ?? null, reason: input.reason ?? null, created_by: actor.actor_id, created_at: now };
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
    const actor = this.ensureActor(input.actor_id ?? DEFAULT_ACTOR, input.actor_type ?? "agent");
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
    const actor = this.ensureActor(input.actor_id ?? DEFAULT_ACTOR, input.actor_type ?? "agent");
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
    const actor = this.ensureActor(input.actor_id ?? DEFAULT_ACTOR, input.actor_type ?? "agent");
    const now = new Date().toISOString();
    const stored = await storeObject(this.root, input.file_path);
    const probe = probeMedia(input.file_path);
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
    const source = this.resolveVersionFile(input.asset_version_id);
    const generation = buildSafeDerivedCopyPlan(this.root, source, version, derivative_type, input);

    await fs.promises.mkdir(path.dirname(generation.outputPath), { recursive: true });
    await fs.promises.copyFile(source.file_path, generation.outputPath);

    const derived = await this.registerDerivedFile({
      asset_id: version.asset_id,
      asset_version_id: input.asset_version_id,
      file_path: generation.outputPath,
      derivative_type: generation.derivative_type,
      profile: input.profile ?? generation.profile,
      metadata: {
        generated_by: "video-assets-plugin",
        generator: "safe-copy",
        source_asset_version_id: input.asset_version_id,
        source_sha256: source.sha256,
        source_mime_type: source.mime_type,
        parameters: generation.parameters,
        ...(input.metadata ?? {})
      },
      actor_id: input.actor_id,
      actor_type: input.actor_type
    });
    this.commit({
      scope: "asset",
      target_id: version.asset_id,
      action: "asset.derived.generate",
      message: `已生成衍生文件：${generation.derivative_type}`,
      actor_id: input.actor_id ?? DEFAULT_ACTOR,
      changes: {
        derived_file_id: derived.derived_file_id,
        asset_version_id: input.asset_version_id,
        derivative_type: generation.derivative_type,
        profile: derived.profile
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
    const actor = this.ensureActor(input.actor_id ?? DEFAULT_ACTOR, input.actor_type ?? "agent");
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
    const actor = this.ensureActor(input.actor_id ?? DEFAULT_ACTOR, input.actor_type ?? "agent");
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
    const actor = this.ensureActor(input.actor_id ?? DEFAULT_ACTOR, input.actor_type ?? "agent");
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
    const actor = this.ensureActor(input.actor_id ?? DEFAULT_ACTOR, input.actor_type ?? "agent");
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
    const actor = this.ensureActor(input.actor_id ?? DEFAULT_ACTOR, input.actor_type ?? "agent");
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

  createCanvas(input = {}) {
    this.requireDb();
    if (!input.project_id) throw new Error("project_id is required");
    const project = this.requireProject(input.project_id);
    const actor = this.ensureActor(input.actor_id ?? DEFAULT_ACTOR, input.actor_type ?? "agent");
    const now = new Date().toISOString();
    const canvas_id = id("canvas");
    const title = input.title || `${project.title} 画布`;
    const viewport = normalizeViewport(input.viewport);
    const document = input.document && typeof input.document === "object" ? input.document : {};
    this.db.prepare(`INSERT INTO canvases (canvas_id, project_id, title, status, viewport_json, document_json, created_by, created_at, updated_at)
      VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?)`).run(canvas_id, input.project_id, title, JSON.stringify(viewport), JSON.stringify(document), actor.actor_id, now, now);
    this.commit({ scope: "project", target_id: input.project_id, action: "canvas.create", message: `已创建画布：${title}`, actor_id: actor.actor_id, changes: { canvas_id } });
    return this.getCanvas({ canvas_id });
  }

  applyProductionCanvasTemplate(input = {}) {
    this.requireDb();
    const canvas = input.canvas_id ? this.requireCanvas(input.canvas_id) : null;
    const project_id = input.project_id ?? canvas?.project_id;
    if (!project_id) throw new Error("project_id or canvas_id is required");
    const project = this.requireProject(project_id);
    const actor = this.ensureActor(input.actor_id ?? DEFAULT_ACTOR, input.actor_type ?? "agent");
    const detail = canvas
      ? this.getCanvas({ canvas_id: canvas.canvas_id })
      : this.createCanvas({
        project_id,
        title: input.title || `${project.title} 生产画布`,
        viewport: input.viewport ?? { x: -80, y: -80, zoom: 0.85, width: 1440, height: 900 },
        document: { template_kind: "production_pilot", template_version: 1 },
        actor_id: actor.actor_id,
        actor_type: actor.actor_type
      });
    const canvas_id = detail.canvas_id;
    const stageShapes = new Map();
    let z = 1;
    for (const stage of PRODUCTION_CANVAS_STAGES) {
      const shape = this.upsertCanvasShape({
        canvas_id,
        shape_id: productionCanvasId("shape", canvas_id, `stage-${stage.key}`),
        shape_type: "section",
        subject_type: "section",
        subject_id: `stage:${stage.key}`,
        title: stage.title,
        x: stage.x,
        y: stage.y,
        width: stage.width,
        height: stage.height,
        z_index: z++,
        props: { role: "production_stage", stage: stage.key, required: stage.required },
        actor_id: actor.actor_id,
        actor_type: actor.actor_type
      });
      stageShapes.set(stage.key, shape);
    }

    const projectShape = this.upsertCanvasShape({
      canvas_id,
      shape_id: productionCanvasId("shape", canvas_id, "project-overview"),
      shape_type: "project_card",
      subject_type: "project",
      subject_id: project.project_id,
      title: project.title,
      x: 24,
      y: 54,
      width: 252,
      height: 112,
      z_index: z++,
      props: { role: "project_anchor", stage: "overview" },
      actor_id: actor.actor_id,
      actor_type: actor.actor_type
    });
    this.linkCanvasShapes({
      canvas_id,
      edge_id: productionCanvasId("edge", canvas_id, "stage-overview-project"),
      source_shape_id: stageShapes.get("overview").shape_id,
      target_shape_id: projectShape.shape_id,
      relation_type: "belongs_to",
      label: "项目",
      actor_id: actor.actor_id,
      actor_type: actor.actor_type
    });

    const stageCounts = Object.fromEntries(PRODUCTION_CANVAS_STAGES.map((stage) => [stage.key, 0]));
    const refs = this.listProjectRefs({ project_id });
    refs.forEach((ref) => {
      const asset = this.getAssetRow(ref.asset_id);
      const stageKey = this.productionStageForProjectRef(ref);
      const stage = PRODUCTION_CANVAS_STAGE_BY_KEY.get(stageKey) ?? PRODUCTION_CANVAS_STAGE_BY_KEY.get("references");
      const slotIndex = stageCounts[stage.key]++;
      const shape = this.upsertCanvasShape({
        canvas_id,
        shape_id: productionCanvasId("shape", canvas_id, `ref-${ref.reference_id}`),
        shape_type: "reference_card",
        subject_type: "project_ref",
        subject_id: ref.reference_id,
        title: asset?.title || ref.role || ref.reference_id,
        x: stage.x + 24,
        y: stage.y + 54 + slotIndex * 88,
        width: Math.min(292, stage.width - 48),
        height: 74,
        z_index: z++,
        props: { role: "project_ref", stage: stage.key, usage_scope: ref.usage_scope ?? null, required: Boolean(ref.required) },
        actor_id: actor.actor_id,
        actor_type: actor.actor_type
      });
      this.linkCanvasShapes({
        canvas_id,
        edge_id: productionCanvasId("edge", canvas_id, `stage-${stage.key}-ref-${ref.reference_id}`),
        source_shape_id: stageShapes.get(stage.key).shape_id,
        target_shape_id: shape.shape_id,
        relation_type: "contains",
        label: "引用",
        actor_id: actor.actor_id,
        actor_type: actor.actor_type
      });
    });

    const entities = this.searchEntities({ project_id, limit: 100 });
    entities.forEach((entity) => {
      const stageKey = productionStageForEntity(entity);
      const stage = PRODUCTION_CANVAS_STAGE_BY_KEY.get(stageKey) ?? PRODUCTION_CANVAS_STAGE_BY_KEY.get("references");
      const slotIndex = stageCounts[stage.key]++;
      const shape = this.upsertCanvasShape({
        canvas_id,
        shape_id: productionCanvasId("shape", canvas_id, `entity-${entity.entity_id}`),
        shape_type: "entity_card",
        subject_type: "entity",
        subject_id: entity.entity_id,
        title: entity.canonical_name,
        x: stage.x + 24,
        y: stage.y + 54 + slotIndex * 88,
        width: Math.min(292, stage.width - 48),
        height: 74,
        z_index: z++,
        props: { role: "production_entity", stage: stage.key, entity_type: entity.entity_type },
        actor_id: actor.actor_id,
        actor_type: actor.actor_type
      });
      this.linkCanvasShapes({
        canvas_id,
        edge_id: productionCanvasId("edge", canvas_id, `stage-${stage.key}-entity-${entity.entity_id}`),
        source_shape_id: stageShapes.get(stage.key).shape_id,
        target_shape_id: shape.shape_id,
        relation_type: "contains",
        label: "实体",
        actor_id: actor.actor_id,
        actor_type: actor.actor_type
      });
    });

    for (const slot of PRODUCTION_CANVAS_SLOT_NOTES) {
      const stage = PRODUCTION_CANVAS_STAGE_BY_KEY.get(slot.stage);
      const slotIndex = stageCounts[slot.stage]++;
      const shape = this.upsertCanvasShape({
        canvas_id,
        shape_id: productionCanvasId("shape", canvas_id, `slot-${slot.key}`),
        shape_type: "note",
        subject_type: "note",
        subject_id: `slot:${slot.key}`,
        title: slot.title,
        x: stage.x + 24,
        y: stage.y + 54 + slotIndex * 82,
        width: Math.min(292, stage.width - 48),
        height: 68,
        z_index: z++,
        props: { role: "production_slot", stage: slot.stage, slot: slot.key, text: slot.text },
        actor_id: actor.actor_id,
        actor_type: actor.actor_type
      });
      this.linkCanvasShapes({
        canvas_id,
        edge_id: productionCanvasId("edge", canvas_id, `stage-${slot.stage}-slot-${slot.key}`),
        source_shape_id: stageShapes.get(slot.stage).shape_id,
        target_shape_id: shape.shape_id,
        relation_type: "contains",
        label: "槽位",
        actor_id: actor.actor_id,
        actor_type: actor.actor_type
      });
    }

    const document = {
      ...(detail.document ?? {}),
      template_kind: "production_pilot",
      template_version: 1,
      production_stages: PRODUCTION_CANVAS_STAGES.map(({ key, title, required }) => ({ key, title, required })),
      applied_at: new Date().toISOString()
    };
    const updated = this.saveCanvasSnapshot({
      canvas_id,
      viewport: input.viewport ?? { x: -80, y: -80, zoom: 0.85, width: 1440, height: 900 },
      document,
      state: { reason: "production_template_applied", stage_count: PRODUCTION_CANVAS_STAGES.length },
      actor_id: actor.actor_id,
      actor_type: actor.actor_type
    });
    return {
      canvas: updated,
      template: {
        kind: "production_pilot",
        version: 1,
        stage_count: PRODUCTION_CANVAS_STAGES.length,
        slot_count: PRODUCTION_CANVAS_SLOT_NOTES.length,
        project_ref_count: refs.length,
        entity_count: entities.length
      },
      production_stages: this.canvasProductionStageSummary(updated, this.lintCanvas({ canvas_id }))
    };
  }

  searchCanvases(input = {}) {
    this.requireDb();
    const limit = clampInteger(input.limit ?? 50, 1, 200, "limit");
    const offset = clampInteger(input.offset ?? 0, 0, 100000, "offset");
    const query = String(input.query ?? "").trim().toLowerCase();
    const where = ["status != 'archived'"];
    const params = [];
    if (input.project_id) {
      where.push("project_id = ?");
      params.push(String(input.project_id));
    }
    if (query) {
      where.push("(instr(lower(title), ?) > 0 OR instr(lower(canvas_id), ?) > 0 OR instr(lower(project_id), ?) > 0)");
      params.push(query, query, query);
    }
    const sql = `SELECT * FROM canvases WHERE ${where.join(" AND ")} ORDER BY updated_at DESC, canvas_id DESC LIMIT ? OFFSET ?`;
    return this.db.prepare(sql).all(...params, limit, offset).map((row) => this.canvasSummary(row));
  }

  getCanvas(input = {}) {
    this.requireDb();
    if (!input.canvas_id) throw new Error("canvas_id is required");
    const row = this.getCanvasRow(input.canvas_id);
    if (!row) throw new Error(`Canvas not found: ${input.canvas_id}`);
    const shapes = this.db.prepare("SELECT * FROM canvas_shapes WHERE canvas_id = ? ORDER BY z_index ASC, created_at ASC").all(input.canvas_id).map(canvasShapeFromRow);
    const edges = this.db.prepare("SELECT * FROM canvas_edges WHERE canvas_id = ? ORDER BY created_at ASC").all(input.canvas_id).map(canvasEdgeFromRow);
    const snapshots = this.db.prepare("SELECT snapshot_id, canvas_id, created_by, created_at FROM canvas_snapshots WHERE canvas_id = ? ORDER BY created_at DESC LIMIT 5").all(input.canvas_id);
    return { ...this.canvasSummary(row), viewport: JSON.parse(row.viewport_json || "{}"), document: JSON.parse(row.document_json || "{}"), shapes, edges, snapshots };
  }

  createGenerationSlot(input = {}) {
    this.requireDb();
    if (!input.canvas_id) throw new Error("canvas_id is required");
    const canvas = this.getCanvas({ canvas_id: input.canvas_id });
    const slotProps = normalizeGenerationSlotProps(input);
    const stage = normalizeProductionStage(input.stage ?? slotProps.stage ?? "shots");
    const index = canvas.shapes.length;
    const width = input.width ?? 320;
    const height = input.height ?? 150;
    const requestedPosition = { x: input.x ?? 1140, y: input.y ?? 680 };
    const position = input.x === undefined && input.y === undefined
      ? findOpenCanvasPosition(requestedPosition, width, height, canvas.shapes, { stepY: height + 32 })
      : requestedPosition;
    const shape = this.upsertCanvasShape({
      canvas_id: canvas.canvas_id,
      shape_id: input.shape_id,
      shape_type: "note",
      subject_type: "note",
      subject_id: input.subject_id ?? `slot:${slotProps.slot}`,
      title: input.title ?? generationSlotTitle(slotProps),
      x: position.x,
      y: position.y,
      width,
      height,
      rotation: input.rotation,
      z_index: input.z_index ?? (index + 1),
      props: {
        ...slotProps,
        stage,
        role: "generation_slot",
        source: input.source ?? "video_canvas_create_generation_slot"
      },
      actor_id: input.actor_id,
      actor_type: input.actor_type
    });
    return this.generationSlotDetail(shape);
  }

  updateGenerationSlot(input = {}) {
    this.requireDb();
    if (!input.shape_id) throw new Error("shape_id is required");
    const existing = this.requireCanvasShape(input.shape_id);
    const existingShape = canvasShapeFromRow(existing);
    const existingProps = existingShape.props ?? {};
    const slotProps = normalizeGenerationSlotProps(input, existingProps);
    const stage = normalizeProductionStage(input.stage ?? slotProps.stage ?? existingProps.stage ?? "shots");
    const shape = this.upsertCanvasShape({
      canvas_id: existing.canvas_id,
      shape_id: existing.shape_id,
      shape_type: input.shape_type ?? existing.shape_type,
      subject_type: input.subject_type ?? existing.subject_type,
      subject_id: input.subject_id ?? existing.subject_id ?? `slot:${slotProps.slot}`,
      title: input.title ?? existing.title ?? generationSlotTitle(slotProps),
      x: input.x ?? existing.x,
      y: input.y ?? existing.y,
      width: input.width ?? existing.width,
      height: input.height ?? existing.height,
      rotation: input.rotation ?? existing.rotation,
      z_index: input.z_index ?? existing.z_index,
      props: {
        ...existingProps,
        ...slotProps,
        stage,
        role: "generation_slot",
        source: input.source ?? existingProps.source ?? "video_canvas_update_generation_slot"
      },
      actor_id: input.actor_id,
      actor_type: input.actor_type
    });
    return this.generationSlotDetail(shape);
  }

  generationSlotDetail(shape) {
    const slot = generationSlotFromShape(shape);
    return { ...shape, generation_slot: slot };
  }

  saveCanvasSnapshot(input = {}) {
    this.requireDb();
    if (!input.canvas_id) throw new Error("canvas_id is required");
    const canvas = this.requireCanvas(input.canvas_id);
    if (input.expected_updated_at !== undefined && input.expected_updated_at !== canvas.updated_at) {
      throw new Error(`canvas snapshot version conflict: expected_updated_at ${input.expected_updated_at} does not match ${canvas.updated_at}`);
    }
    const actor = this.ensureActor(input.actor_id ?? DEFAULT_ACTOR, input.actor_type ?? "agent");
    const now = new Date().toISOString();
    const snapshot_id = id("snap");
    const state = input.state && typeof input.state === "object" ? input.state : {};
    const viewport = input.viewport ? normalizeViewport(input.viewport) : JSON.parse(canvas.viewport_json || "{}");
    const previousDocument = JSON.parse(canvas.document_json || "{}");
    const documentMode = normalizeCanvasDocumentMode(input.document_mode);
    if (input.document && documentMode === "replace" && input.confirm_document_replace !== true) {
      throw new Error("confirm_document_replace=true is required when document_mode=replace");
    }
    const document = input.document && typeof input.document === "object"
      ? (documentMode === "replace" ? input.document : mergeJsonObjects(previousDocument, input.document))
      : previousDocument;
    this.db.prepare("INSERT INTO canvas_snapshots (snapshot_id, canvas_id, state_json, created_by, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(snapshot_id, input.canvas_id, JSON.stringify(state), actor.actor_id, now);
    this.db.prepare("UPDATE canvases SET viewport_json = ?, document_json = ?, updated_at = ? WHERE canvas_id = ?")
      .run(JSON.stringify(viewport), JSON.stringify(document), now, input.canvas_id);
    this.commit({
      scope: "project",
      target_id: canvas.project_id,
      action: "canvas.snapshot.save",
      message: `已保存画布快照 ${snapshot_id}`,
      actor_id: actor.actor_id,
      changes: { canvas_id: input.canvas_id, snapshot_id, document_mode: documentMode, expected_updated_at: input.expected_updated_at ?? null }
    });
    return this.getCanvas({ canvas_id: input.canvas_id });
  }

  canvasWidgetContext(input = {}) {
    const canvas = this.getCanvas(input);
    const selection = this.getCanvasSelection({ canvas_id: canvas.canvas_id });
    const storedViewState = this.getCanvasViewState({ canvas_id: canvas.canvas_id });
    const viewport = input.viewport
      ? normalizeViewport(input.viewport)
      : (storedViewState.view_state?.viewport ?? canvas.viewport);
    const agent_context = this.canvasAgentContext({ canvas_id: canvas.canvas_id, viewport });
    return {
      version: 1,
      source: "video_assets_canvas_widget_context",
      widget: {
        status: "contract_ready",
        rendering: "native_widget_or_workbench",
        resource_hint: "/__openclaw__/video-assets/workbench/"
      },
      canvas: agent_context.canvas,
      viewport,
      selection,
      action_policy: this.canvasActionPolicy(canvas),
      capabilities: [
        "canvas_read",
        "visible_agent_context",
        "selection_state",
        "view_state",
        "canvas_only_shape_edit",
        "generation_package_handoff",
        "asset_writeback_requires_versioned_tools"
      ],
      agent_context
    };
  }

  renderCanvasWidget(input = {}) {
    this.requireDb();
    const title = String(input.title ?? "视频资产画布").trim() || "视频资产画布";
    const preferredDisplayMode = normalizeWidgetDisplayMode(input.display_mode ?? input.displayMode);
    const requestedProjectId = input.project_id ? String(input.project_id) : null;
    let canvas_id = input.canvas_id ? String(input.canvas_id) : null;
    let context = null;
    let status = "ready";
    let project_id = requestedProjectId;

    if (!canvas_id && requestedProjectId) {
      this.requireProject(requestedProjectId);
      canvas_id = this.searchCanvases({ project_id: requestedProjectId, limit: 1 })[0]?.canvas_id ?? null;
    }
    if (canvas_id) {
      context = this.canvasWidgetContext({ canvas_id, viewport: input.viewport });
      project_id = context.canvas.project_id;
    } else {
      status = requestedProjectId ? "needs_canvas" : "needs_target";
    }

    const widgetData = {
      version: 1,
      widget: "video-assets-canvas-widget",
      title,
      rendering: "native-widget-compatible-descriptor",
      status,
      resourceUri: VIDEO_ASSETS_WIDGET_URI,
      preferredDisplayMode,
      fallbackUrl: VIDEO_ASSETS_WORKBENCH_URL,
      runtimeSupport: this.canvasWidgetRuntimeSupport,
      project_id,
      canvas: context?.canvas ?? null,
      viewport: context?.viewport ?? null,
      selection: context?.selection ?? null,
      action_policy: context?.action_policy ?? this.canvasActionPolicy(),
      capabilities: context?.capabilities ?? [
        "workbench_fallback",
        "create_canvas_required",
        "canvas_widget_contract"
      ],
      agent_context: context?.agent_context ?? null,
      workbench: {
        url: VIDEO_ASSETS_WORKBENCH_URL,
        auth: "plugin_http_session",
        rpc: "/__openclaw__/video-assets/rpc/call"
      }
    };
    return {
      content: [
        {
          type: "text",
          text: status === "ready"
            ? `已将「${title}」渲染为视频资产画布描述。`
            : `视频资产画布描述已准备，但当前状态为：${canvasWidgetStatusText(status)}。`
        }
      ],
      structuredContent: widgetData,
      _meta: {
        "openai/outputTemplate": VIDEO_ASSETS_WIDGET_URI,
        "openai/widgetAccessible": true,
        "openai/toolInvocation/invoking": "正在打开视频资产画布",
        "openai/toolInvocation/invoked": "视频资产画布已就绪",
        "ui/resourceUri": VIDEO_ASSETS_WIDGET_URI,
        ui: {
          resourceUri: VIDEO_ASSETS_WIDGET_URI,
          visibility: ["model", "app"]
        },
        widgetData
      }
    };
  }

  saveCanvasSelection(input = {}) {
    this.requireDb();
    if (!input.canvas_id) throw new Error("canvas_id is required");
    const canvas = this.getCanvas(input);
    const ids = normalizeStringArray(input.selected_shape_ids, "selected_shape_ids");
    const known = new Set(canvas.shapes.map((shape) => shape.shape_id));
    const missing = ids.filter((shape_id) => !known.has(shape_id));
    if (missing.length) throw new Error(`Selected shapes do not belong to canvas ${input.canvas_id}: ${missing.join(", ")}`);
    const primary_shape_id = input.primary_shape_id
      ? String(input.primary_shape_id)
      : (ids[0] ?? null);
    if (primary_shape_id && !known.has(primary_shape_id)) throw new Error(`primary_shape_id does not belong to canvas ${input.canvas_id}: ${primary_shape_id}`);
    const selection = {
      version: 1,
      selected_shape_ids: ids,
      primary_shape_id,
      source: normalizeWidgetStateSource(input.source),
      updated_at: new Date().toISOString()
    };
    this.updateCanvasWidgetState(input.canvas_id, { selection });
    return this.getCanvasSelection({ canvas_id: input.canvas_id });
  }

  getCanvasSelection(input = {}) {
    const canvas = this.getCanvas(input);
    const selection = canvas.document?.widget_state?.selection && typeof canvas.document.widget_state.selection === "object"
      ? canvas.document.widget_state.selection
      : {};
    const ids = normalizeStringArray(selection.selected_shape_ids, "selected_shape_ids", { allowUndefined: true });
    const known = new Set(canvas.shapes.map((shape) => shape.shape_id));
    const selected_shape_ids = ids.filter((shape_id) => known.has(shape_id));
    const primary_shape_id = selection.primary_shape_id && known.has(String(selection.primary_shape_id))
      ? String(selection.primary_shape_id)
      : (selected_shape_ids[0] ?? null);
    return {
      version: 1,
      canvas_id: canvas.canvas_id,
      selected_shape_ids,
      primary_shape_id,
      selected_shapes: selected_shape_ids
        .map((shape_id) => canvas.shapes.find((shape) => shape.shape_id === shape_id))
        .filter(Boolean)
        .map((shape) => this.enrichCanvasShape(shape, canvas)),
      source: selection.source ?? null,
      updated_at: selection.updated_at ?? null
    };
  }

  saveCanvasViewState(input = {}) {
    this.requireDb();
    if (!input.canvas_id) throw new Error("canvas_id is required");
    this.requireCanvas(input.canvas_id);
    const viewportInput = input.viewport ?? input.view_state?.viewport;
    if (!viewportInput) throw new Error("viewport is required");
    const view_state = {
      version: 1,
      viewport: normalizeViewport(viewportInput),
      source: normalizeWidgetStateSource(input.source),
      updated_at: new Date().toISOString()
    };
    this.updateCanvasWidgetState(input.canvas_id, { view_state });
    return this.getCanvasViewState({ canvas_id: input.canvas_id });
  }

  getCanvasViewState(input = {}) {
    const canvas = this.getCanvas(input);
    const view_state = canvas.document?.widget_state?.view_state && typeof canvas.document.widget_state.view_state === "object"
      ? canvas.document.widget_state.view_state
      : null;
    return {
      version: 1,
      canvas_id: canvas.canvas_id,
      view_state: view_state
        ? {
            version: 1,
            viewport: normalizeViewport(view_state.viewport ?? canvas.viewport),
            source: view_state.source ?? null,
            updated_at: view_state.updated_at ?? null
          }
        : null,
      fallback_viewport: canvas.viewport
    };
  }

  updateCanvasWidgetState(canvas_id, patch) {
    const row = this.requireCanvas(canvas_id);
    const now = new Date().toISOString();
    const document = JSON.parse(row.document_json || "{}");
    const current = document.widget_state && typeof document.widget_state === "object" ? document.widget_state : {};
    document.widget_state = { ...current, ...patch, updated_at: now };
    this.db.prepare("UPDATE canvases SET document_json = ?, updated_at = ? WHERE canvas_id = ?")
      .run(JSON.stringify(document), now, canvas_id);
  }

  upsertCanvasShape(input = {}) {
    this.requireDb();
    if (!input.canvas_id) throw new Error("canvas_id is required");
    const canvas = this.requireCanvas(input.canvas_id);
    const actor = this.ensureActor(input.actor_id ?? DEFAULT_ACTOR, input.actor_type ?? "agent");
    const shape_type = this.validateCanvasShapeType(input.shape_type ?? "note");
    const subject_type = this.validateCanvasSubjectType(input.subject_type ?? subjectTypeForShape(shape_type));
    if (input.subject_id) this.requireCanvasSubject(subject_type, input.subject_id);
    const now = new Date().toISOString();
    const shape_id = input.shape_id || id("shape");
    const existing = this.getCanvasShapeRow(shape_id);
    if (existing && existing.canvas_id !== input.canvas_id) throw new Error(`Shape ${shape_id} does not belong to canvas ${input.canvas_id}`);
    const x = finiteNumber(input.x ?? existing?.x ?? 0, "x");
    const y = finiteNumber(input.y ?? existing?.y ?? 0, "y");
    const width = positiveNumber(input.width ?? existing?.width ?? 220, "width");
    const height = positiveNumber(input.height ?? existing?.height ?? 120, "height");
    const rotation = finiteNumber(input.rotation ?? existing?.rotation ?? 0, "rotation");
    const z_index = Math.trunc(finiteNumber(input.z_index ?? existing?.z_index ?? 0, "z_index"));
    const title = input.title === undefined ? existing?.title ?? null : input.title;
    const props = input.props && typeof input.props === "object" ? input.props : (existing ? JSON.parse(existing.props_json || "{}") : {});
    if (existing) {
      this.db.prepare(`UPDATE canvas_shapes SET shape_type = ?, subject_type = ?, subject_id = ?, title = ?, x = ?, y = ?, width = ?, height = ?, rotation = ?, z_index = ?, props_json = ?, updated_at = ? WHERE shape_id = ?`)
        .run(shape_type, subject_type, input.subject_id ?? existing.subject_id ?? null, title ?? null, x, y, width, height, rotation, z_index, JSON.stringify(props), now, shape_id);
    } else {
      this.db.prepare(`INSERT INTO canvas_shapes (shape_id, canvas_id, shape_type, subject_type, subject_id, title, x, y, width, height, rotation, z_index, props_json, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(shape_id, input.canvas_id, shape_type, subject_type, input.subject_id ?? null, title ?? null, x, y, width, height, rotation, z_index, JSON.stringify(props), actor.actor_id, now, now);
    }
    this.touchCanvas(input.canvas_id, now);
    this.commit({ scope: "project", target_id: canvas.project_id, action: existing ? "canvas.shape.update" : "canvas.shape.create", message: `${existing ? "已更新" : "已创建"}画布卡片：${shape_id}`, actor_id: actor.actor_id, changes: { canvas_id: input.canvas_id, shape_id, subject_type, subject_id: input.subject_id ?? existing?.subject_id ?? null } });
    return canvasShapeFromRow(this.getCanvasShapeRow(shape_id));
  }

  deleteCanvasShape(input = {}) {
    this.requireDb();
    if (!input.shape_id) throw new Error("shape_id is required");
    const shape = this.requireCanvasShape(input.shape_id);
    const canvas = this.requireCanvas(shape.canvas_id);
    const actor = this.ensureActor(input.actor_id ?? DEFAULT_ACTOR, input.actor_type ?? "agent");
    const now = new Date().toISOString();
    const removedEdges = this.db.prepare("SELECT COUNT(*) AS count FROM canvas_edges WHERE source_shape_id = ? OR target_shape_id = ?").get(input.shape_id, input.shape_id);
    this.db.prepare("DELETE FROM canvas_edges WHERE source_shape_id = ? OR target_shape_id = ?").run(input.shape_id, input.shape_id);
    this.db.prepare("DELETE FROM canvas_shapes WHERE shape_id = ?").run(input.shape_id);
    this.touchCanvas(shape.canvas_id, now);
    this.commit({ scope: "project", target_id: canvas.project_id, action: "canvas.shape.delete", message: `已删除画布卡片：${input.shape_id}`, actor_id: actor.actor_id, changes: { canvas_id: shape.canvas_id, shape_id: input.shape_id, removed_edges: Number(removedEdges?.count ?? 0) } });
    return { shape_id: input.shape_id, deleted: true, removed_edges: Number(removedEdges?.count ?? 0) };
  }

  linkCanvasShapes(input = {}) {
    this.requireDb();
    if (!input.canvas_id || !input.source_shape_id || !input.target_shape_id) throw new Error("canvas_id, source_shape_id, and target_shape_id are required");
    const canvas = this.requireCanvas(input.canvas_id);
    const source = this.requireCanvasShape(input.source_shape_id);
    const target = this.requireCanvasShape(input.target_shape_id);
    if (source.canvas_id !== input.canvas_id || target.canvas_id !== input.canvas_id) throw new Error("source and target shapes must belong to the canvas");
    const relation_type = this.validateCanvasRelationType(input.relation_type ?? "related_to");
    const actor = this.ensureActor(input.actor_id ?? DEFAULT_ACTOR, input.actor_type ?? "agent");
    const now = new Date().toISOString();
    const edge_id = input.edge_id || id("edge");
    const props = input.props && typeof input.props === "object" ? input.props : {};
    this.db.prepare(`INSERT INTO canvas_edges (edge_id, canvas_id, source_shape_id, target_shape_id, relation_type, label, props_json, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(edge_id) DO UPDATE SET source_shape_id = excluded.source_shape_id, target_shape_id = excluded.target_shape_id, relation_type = excluded.relation_type, label = excluded.label, props_json = excluded.props_json, updated_at = excluded.updated_at`)
      .run(edge_id, input.canvas_id, input.source_shape_id, input.target_shape_id, relation_type, input.label ?? null, JSON.stringify(props), actor.actor_id, now, now);
    this.touchCanvas(input.canvas_id, now);
    this.commit({ scope: "project", target_id: canvas.project_id, action: "canvas.edge.link", message: `已连接画布卡片：${input.source_shape_id} → ${input.target_shape_id}`, actor_id: actor.actor_id, changes: { canvas_id: input.canvas_id, edge_id, relation_type } });
    return canvasEdgeFromRow(this.db.prepare("SELECT * FROM canvas_edges WHERE edge_id = ?").get(edge_id));
  }

  unlinkCanvasShapes(input = {}) {
    this.requireDb();
    if (!input.edge_id) throw new Error("edge_id is required");
    const edge = this.db.prepare("SELECT * FROM canvas_edges WHERE edge_id = ?").get(input.edge_id);
    if (!edge) return { edge_id: input.edge_id, deleted: false };
    const canvas = this.requireCanvas(edge.canvas_id);
    const actor = this.ensureActor(input.actor_id ?? DEFAULT_ACTOR, input.actor_type ?? "agent");
    const now = new Date().toISOString();
    this.db.prepare("DELETE FROM canvas_edges WHERE edge_id = ?").run(input.edge_id);
    this.touchCanvas(edge.canvas_id, now);
    this.commit({ scope: "project", target_id: canvas.project_id, action: "canvas.edge.unlink", message: `已解除画布连线：${input.edge_id}`, actor_id: actor.actor_id, changes: { canvas_id: edge.canvas_id, edge_id: input.edge_id } });
    return { edge_id: input.edge_id, deleted: true };
  }

  canvasAgentContext(input = {}) {
    const canvas = this.getCanvas(input);
    const viewport = input.viewport ? normalizeViewport(input.viewport) : canvas.viewport;
    const visible = canvas.shapes.filter((shape) => shapeIntersectsViewport(shape, viewport));
    const offscreen = canvas.shapes.filter((shape) => !visible.some((item) => item.shape_id === shape.shape_id));
    const clusters = summarizeShapesBySubject(offscreen);
    const lint = this.lintCanvas({ canvas_id: canvas.canvas_id });
    const production_stages = this.canvasProductionStageSummary(canvas, lint);
    const production_stage_gaps = production_stages
      .filter((stage) => stage.missing.length > 0 || !stage.ready)
      .map((stage) => ({ key: stage.key, title: stage.title, missing: stage.missing, issue_count: stage.issue_count, ready: stage.ready }));
    return {
      canvas: { canvas_id: canvas.canvas_id, project_id: canvas.project_id, title: canvas.title, status: canvas.status, updated_at: canvas.updated_at },
      viewport,
      visible_shapes: visible.map((shape) => this.enrichCanvasShape(shape, canvas)),
      offscreen_clusters: clusters,
      edges: canvas.edges,
      lint,
      action_policy: this.canvasActionPolicy(canvas),
      production_readiness: {
        ok: lint.errors.length === 0,
        error_count: lint.errors.length,
        warning_count: lint.warnings.length,
        info_count: lint.infos.length,
        stage_ready: production_stage_gaps.length === 0,
        stage_gap_count: production_stage_gaps.length
      },
      production_stages,
      production_stage_gaps
    };
  }

  canvasGenerationPackage(input = {}) {
    const canvas = this.getCanvas(input);
    const project = this.getProjectDetail({ project_id: canvas.project_id, stage: "production" });
    const lint = this.lintCanvas({ canvas_id: canvas.canvas_id });
    const production_stages = this.canvasProductionStageSummary(canvas, lint);
    const production_stage_gaps = production_stages
      .filter((stage) => stage.missing.length > 0 || !stage.ready)
      .map((stage) => ({ key: stage.key, title: stage.title, missing: stage.missing, issue_count: stage.issue_count, ready: stage.ready }));
    const generation_type = this.validateGenerationType(input.generation_type ?? "image_to_video");
    const inputs = [];
    const seenRefs = new Set();
    const generation_slots = canvas.shapes
      .filter((shape) => shape.props?.role === "generation_slot")
      .map((shape) => generationSlotFromShape(shape))
      .filter((slot) => !input.generation_type || !slot.generation_type || slot.generation_type === generation_type);
    const active_generation_slot = selectActiveGenerationSlot(generation_slots, input.slot_shape_id);

    for (const shape of canvas.shapes) {
      if (!["project_ref", "asset", "asset_version"].includes(shape.subject_type)) continue;
      const context = this.safeCanvasSubjectContext(shape, canvas);
      const ref = context?.ref ?? context?.project_refs?.[0] ?? null;
      const asset = context?.asset ?? null;
      const version = context?.version ?? (asset?.default_version_id ? versionFromRow(this.getVersionRow(asset.default_version_id)) : null);
      const reference_id = ref?.reference_id ?? null;
      if (reference_id && seenRefs.has(reference_id)) continue;
      if (reference_id) seenRefs.add(reference_id);
      if (!asset && !version) continue;
      const asset_id = asset?.asset_id ?? version?.asset_id ?? null;
      const asset_version_id = ref?.asset_version_id ?? version?.asset_version_id ?? asset?.default_version_id ?? null;
      const derived_files = asset_id ? this.listDerivedFiles({ asset_id, asset_version_id: asset_version_id ?? undefined }).slice(0, 12) : [];
      inputs.push({
        slot: canvasGenerationSlot(shape, context),
        shape_id: shape.shape_id,
        title: shape.title ?? asset?.title ?? ref?.role ?? shape.subject_id,
        reference_id,
        asset_id,
        asset_version_id,
        role: ref?.role ?? context?.taxonomy?.domain ?? shape.props?.stage ?? shape.subject_type,
        pin_mode: ref?.pin_mode ?? null,
        required: ref ? Boolean(ref.required) : false,
        media_type: asset?.media_type ?? null,
        license_status: asset?.license_status ?? null,
        risk_level: asset?.risk_level ?? null,
        taxonomy: context?.taxonomy ?? null,
        entity_links: context?.entity_links ?? [],
        annotation_summary: context?.annotation_summary ?? null,
        version_file: version?.file_name ?? null,
        derived_files: derived_files.map((derived) => ({
          derived_file_id: derived.derived_file_id,
          derivative_type: derived.derivative_type,
          profile: derived.profile,
          file_name: derived.file_name,
          mime_type: derived.mime_type,
          width: derived.width,
          height: derived.height,
          duration_ms: derived.duration_ms
        }))
      });
    }

    const slots = Object.fromEntries(GENERATION_SLOT_KEYS.map((slot) => [slot, inputs.filter((item) => item.slot === slot)]));
    const target_spec = generationOutputSpec(project, active_generation_slot);
    const gates = this.canvasGenerationGates({ project, inputs, generation_type, lint, production_stage_gaps, slots, active_generation_slot });
    return {
      version: 1,
      source: "canvas",
      generation_type,
      canvas: { canvas_id: canvas.canvas_id, project_id: canvas.project_id, title: canvas.title, updated_at: canvas.updated_at },
      project: {
        project_id: project.project_id,
        title: project.title,
        target_platforms: project.target_platforms,
        aspect_ratio: project.aspect_ratio,
        resolution: project.resolution,
        fps: project.fps
      },
      generation_slots,
      active_generation_slot,
      target_spec,
      slots,
      inputs,
      production_stages,
      production_stage_gaps,
      gates
    };
  }

  canvasGenerationHandoff(input = {}) {
    const generationPackage = this.canvasGenerationPackage(input);
    const outputSpec = generationPackage.target_spec ?? projectOutputSpec(generationPackage.project);
    const inputs = generationPackage.inputs.map((item) => {
      const resolved = item.asset_version_id ? this.safeResolveVersionFile(item.asset_version_id) : null;
      return {
        slot: item.slot,
        title: item.title,
        reference_id: item.reference_id,
        asset_id: item.asset_id,
        asset_version_id: item.asset_version_id,
        media_type: item.media_type,
        role: item.role,
        file_name: item.version_file,
        file_path: resolved?.file_path ?? null,
        mime_type: resolved?.mime_type ?? null,
        sha256: resolved?.sha256 ?? null,
        derived_files: item.derived_files
      };
    });
    const parameters = generationTaskParameters(generationPackage, outputSpec);
    const dreaminaCli = dreaminaCliHandoff({
      generation_type: generationPackage.generation_type,
      outputSpec,
      inputs,
      parameters
    });
    const generationGateReady = generationPackage.gates.ok;
    const task = {
      task_kind: "video_generation",
      generation_type: generationPackage.generation_type,
      project_id: generationPackage.project.project_id,
      canvas_id: generationPackage.canvas.canvas_id,
      generation_slot_shape_id: generationPackage.active_generation_slot?.shape_id ?? null,
      target: outputSpec,
      inputs,
      parameters,
      providers: {
        dreamina_cli: dreaminaCli.provider
      },
      execution: {
        recommended_provider: dreaminaCli.provider.provider_id,
        mode: "manual_or_agent_executed_cli",
        preflight: dreaminaCli.preflight,
        command: generationGateReady ? dreaminaCli.command : null,
        postprocess: dreaminaCli.postprocess
      }
    };
    return {
      version: 1,
      source: "canvas_generation_handoff",
      created_at: new Date().toISOString(),
      status: generationGateReady && dreaminaCli.ready ? "ready" : "blocked",
      package: generationPackage,
      task,
      validation: {
        gates: generationPackage.gates,
        generation_gate_blockers: generationPackage.gates.errors,
        input_count: generationPackage.inputs.length,
        stage_ready: generationPackage.production_stage_gaps.length === 0,
        output_spec_ready: Boolean(outputSpec.aspect_ratio && outputSpec.resolution && outputSpec.fps),
        dreamina_cli_ready: dreaminaCli.ready,
        dreamina_cli_blockers: dreaminaCli.blockers
      }
    };
  }

  canvasDreaminaCliPlan(input = {}) {
    const handoff = this.canvasGenerationHandoff(input);
    const guide = dreaminaCliUsageGuide();
    const command = handoff.task.execution.command;
    const preflight = handoff.task.execution.preflight;
    return {
      version: 1,
      source: "canvas_dreamina_cli_plan",
      created_at: new Date().toISOString(),
      guide_source: guide.source,
      status: handoff.status,
      canvas: handoff.package.canvas,
      project: handoff.package.project,
      generation_type: handoff.package.generation_type,
      recommended_provider: "dreamina_cli",
      zero_cost_checks: guide.zero_cost_checks,
      cost_policy: guide.cost_policy,
      preflight,
      command,
      download_and_register: guide.download_and_register,
      canvas_writeback: guide.canvas_writeback,
      troubleshooting: guide.troubleshooting,
      blockers: [
        ...(handoff.validation.generation_gate_blockers ?? []),
        ...(handoff.validation.dreamina_cli_blockers ?? [])
      ],
      next_actions: dreaminaCliNextActions({ handoff, preflight, command })
    };
  }

  async canvasDreaminaCliGenerateVideo(input = {}) {
    this.requireDb();
    const generation_type = input.generation_type ?? "image_to_video";
    if (!["image_to_video", "text_to_video", "multimodal_to_video"].includes(generation_type)) {
      throw new Error("即梦视频生成工具只支持图生视频、文生视频或多模态视频。");
    }
    const handoff = this.canvasGenerationHandoff({ canvas_id: input.canvas_id, generation_type });
    const guide = dreaminaCliUsageGuide();
    const videoConfig = dreaminaVideoConfig({
      generation_type,
      model_version: input.model_version,
      duration: input.duration ?? handoff.task.target.duration_seconds,
      video_resolution: input.video_resolution,
      ratio: input.ratio ?? handoff.task.target.aspect_ratio,
      poll: input.poll,
      session: input.session
    });
    const command = dreaminaVideoCommandFromHandoff({
      handoff,
      generation_type,
      prompt: input.prompt,
      videoConfig
    });
    const execute = input.execute === true || input.accept_credit_spend === true;
    const outputDir = resolveDreaminaOutputDir(input.output_dir, this.root);
    const runPreflight = input.run_preflight !== false;
    const ingestOutputs = input.ingest_outputs !== false;
    const writebackCanvas = input.writeback_canvas !== false;
    const timeoutMs = clampInteger(input.timeout_ms ?? Math.max(120000, (videoConfig.poll + 90) * 1000), 30000, 900000, "timeout_ms");
    const blockers = [
      ...(handoff.status === "ready" ? [] : ["canvas generation handoff is not ready"]),
      ...(handoff.validation.generation_gate_blockers ?? []),
      ...(handoff.validation.dreamina_cli_blockers ?? []),
      ...(command.blockers ?? [])
    ];

    const base = {
      version: 1,
      source: "canvas_dreamina_cli_video_generation",
      created_at: new Date().toISOString(),
      guide_source: guide.source,
      status: blockers.length ? "blocked" : (execute ? "pending_execution" : "ready"),
      canvas: handoff.package.canvas,
      project: handoff.package.project,
      generation_type,
      provider: "dreamina_cli",
      safety: {
        video_only: true,
        accepts_credit_spend: input.accept_credit_spend === true,
        execute,
        dry_run: !execute
      },
      parameters: videoConfig,
      preflight: [{ name: "user_credit", argv: [DEFAULT_DREAMINA_CLI_PATH || "dreamina", "user_credit"], required: true }],
      command: blockers.length ? null : command.command,
      reference_inputs: command.reference_inputs ?? null,
      output_dir: outputDir,
      blockers,
      cost_policy: [
        "此工具只执行视频生成，不执行图像生成命令。",
        "真实执行前必须明确接受积分消耗。",
        "除非显式关闭预检，否则真实生成前会先检查即梦账户余额。",
        "如果任务返回查询中，请保存提交编号，后续查询结果，不要重复提交。"
      ]
    };

    if (blockers.length || !execute) return base;
    if (input.accept_credit_spend !== true) throw new Error("真实执行即梦视频生成前必须明确接受积分消耗。");

    await fs.promises.mkdir(outputDir, { recursive: true });
    const creditBefore = runPreflight ? await runDreaminaCli(["user_credit"], { timeoutMs: 90000 }) : null;
    const generation = await runDreaminaCli(command.command.argv.slice(1), { timeoutMs });
    const parsed = parseDreaminaJson(generation.stdout);
    const creditAfter = runPreflight ? await runDreaminaCli(["user_credit"], { timeoutMs: 90000 }) : null;
    const videos = extractDreaminaVideos(parsed);
    const downloads = [];
    const registered_assets = [];
    let canvas_writeback = null;

    if (parsed?.gen_status === "success" && videos.length && (input.download_outputs !== false)) {
      for (let index = 0; index < videos.length; index += 1) {
        const item = videos[index];
        const target = path.join(outputDir, dreaminaVideoDownloadName({ submit_id: parsed.submit_id, index, url: item.url }));
        await downloadUrl(item.url, target);
        downloads.push({ ...item, file_path: target });
      }
    }

    if (downloads.length && ingestOutputs) {
      for (const download of downloads) {
        const asset = await this.ingestAsset({
          file_path: download.file_path,
          title: input.output_title ?? `即梦视频输出 ${parsed.submit_id ?? "未命名"}`,
          description: "由即梦命令行根据视频资产画布生成。",
          tags: ["dreamina_cli", generation_type, videoConfig.model_version],
          kind: "working",
          actor_id: input.actor_id ?? DEFAULT_ACTOR,
          actor_type: input.actor_type ?? "agent",
          source: {
            source_type: "dreamina_cli",
            notes: JSON.stringify({
              submit_id: parsed.submit_id ?? null,
              generation_type,
              model_version: videoConfig.model_version,
              duration: videoConfig.duration,
              video_resolution: videoConfig.video_resolution,
              prompt: command.prompt
            })
          }
        });
        this.updateAssetRights({
          asset_id: asset.asset_id,
          license_status: input.license_status ?? "cleared",
          risk_level: input.risk_level ?? "low",
          actor_id: input.actor_id ?? DEFAULT_ACTOR,
          actor_type: input.actor_type ?? "agent",
          source: {
            source_type: "dreamina_cli",
            captured_at: new Date().toISOString(),
            license_hint: "由已登录的即梦命令行账号生成；公开发布前仍需复核项目用途与授权边界。",
            notes: JSON.stringify({
              submit_id: parsed.submit_id ?? null,
              command: command.command.shell,
              credit_count: parsed?.credit_count ?? null
            })
          }
        });
        registered_assets.push({ asset_id: asset.asset_id, asset_version_id: asset.default_version_id, file_path: download.file_path });
      }
    }

    if (registered_assets.length && writebackCanvas) {
      canvas_writeback = this.writeDreaminaVideoOutputsToCanvas({
        canvas_id: handoff.package.canvas.canvas_id,
        project_id: handoff.package.project.project_id,
        generation_type,
        assets: registered_assets,
        submit_id: parsed.submit_id,
        actor_id: input.actor_id ?? DEFAULT_ACTOR,
        actor_type: input.actor_type ?? "agent"
      });
    }

    return {
      ...base,
      status: parsed?.gen_status === "success" ? "success" : (parsed?.gen_status ?? "submitted"),
      dry_run: false,
      credit_before: creditBefore ? parseDreaminaJson(creditBefore.stdout) : null,
      cli_result: parsed,
      raw_stdout: generation.stdout,
      raw_stderr: generation.stderr,
      credit_after: creditAfter ? parseDreaminaJson(creditAfter.stdout) : null,
      downloads,
      registered_assets,
      canvas_writeback,
      next_actions: dreaminaCliGenerationNextActions({ parsed, downloads, registered_assets, outputDir })
    };
  }

  writeDreaminaVideoOutputsToCanvas(input = {}) {
    const refs = [];
    const shapes = [];
    const edges = [];
    const canvas = this.getCanvas({ canvas_id: input.canvas_id });
    const sourceShapes = canvas.shapes.filter((shape) => ["main_reference", "character_reference", "scene_reference", "motion_reference", "style_reference", "video_clip", "audio"].includes(String(shape.props?.generation_slot ?? "")));
    for (let index = 0; index < input.assets.length; index += 1) {
      const item = input.assets[index];
      const ref = this.addProjectRef({
        project_id: input.project_id,
        asset_id: item.asset_id,
        asset_version_id: item.asset_version_id,
        role: "generated_video",
        usage_scope: `即梦${generationTypeText(input.generation_type)}输出。`,
        pin_mode: "pinned",
        required: false,
        notes: input.submit_id ? `submit_id=${input.submit_id}` : null,
        actor_id: input.actor_id,
        actor_type: input.actor_type
      });
      refs.push(ref);
      const shape = this.upsertCanvasShape({
        canvas_id: input.canvas_id,
        shape_id: productionCanvasId("shape", input.canvas_id, `dreamina-video-output-${input.submit_id ?? Date.now()}-${index}`),
        shape_type: "reference_card",
        subject_type: "project_ref",
        subject_id: ref.reference_id,
        title: `即梦视频输出 ${index + 1}`,
        x: 1140,
        y: 720 + index * 170,
        width: 320,
        height: 150,
        props: {
          generation_slot: "draft_output",
          stage: "shots",
          role: "generated_output",
          source: "dreamina_cli",
          submit_id: input.submit_id ?? null
        },
        actor_id: input.actor_id,
        actor_type: input.actor_type
      });
      shapes.push(shape);
      for (const sourceShape of sourceShapes) {
        const edge = this.linkCanvasShapes({
          canvas_id: input.canvas_id,
          edge_id: productionCanvasId("edge", input.canvas_id, `${sourceShape.shape_id}-dreamina-output-${shape.shape_id}`),
          source_shape_id: sourceShape.shape_id,
          target_shape_id: shape.shape_id,
          relation_type: "derived_from",
          label: "即梦生成输出",
          props: { source: "dreamina_cli", submit_id: input.submit_id ?? null },
          actor_id: input.actor_id,
          actor_type: input.actor_type
        });
        edges.push(edge);
      }
    }
    const lint = this.lintCanvas({ canvas_id: input.canvas_id });
    return { refs, shapes, edges, lint };
  }

  canvasReviewBrief(input = {}) {
    this.requireDb();
    if (!input.canvas_id) throw new Error("canvas_id is required");
    if (!input.shape_id) throw new Error("shape_id is required");
    const canvas = this.getCanvas({ canvas_id: input.canvas_id });
    const shape = canvas.shapes.find((item) => item.shape_id === input.shape_id);
    if (!shape) throw new Error(`Canvas shape not found on canvas ${input.canvas_id}: ${input.shape_id}`);
    const enriched = this.enrichCanvasShape(shape, canvas);
    const annotationTarget = annotationTargetForCanvasShape(enriched);
    const lint = this.lintCanvas({ canvas_id: canvas.canvas_id });
    const shapeIssues = lint.issues.filter((issue) => issue.shape_id === shape.shape_id);
    return {
      version: 1,
      source: "canvas_review_brief",
      created_at: new Date().toISOString(),
      canvas: { canvas_id: canvas.canvas_id, project_id: canvas.project_id, title: canvas.title },
      shape: enriched,
      annotation_target: annotationTarget,
      review: {
        title: input.title ?? `审阅：${shape.title ?? shape.shape_id}`,
        body: input.body ?? "",
        severity: input.severity ?? "note",
        requested_change: input.requested_change ?? null,
        screenshot_asset_version_id: input.screenshot_asset_version_id ?? null
      },
      lint_issues: shapeIssues,
      suggested_annotation: annotationTarget ? {
        target_type: annotationTarget.target_type,
        target_id: annotationTarget.target_id,
        annotation_type: input.annotation_type ?? "review_note",
        title: input.title ?? `审阅：${shape.title ?? shape.shape_id}`,
        visibility: input.visibility ?? "project"
      } : null
    };
  }

  registerCanvasReviewAnnotation(input = {}) {
    const brief = this.canvasReviewBrief(input);
    if (!brief.annotation_target) throw new Error(`Canvas shape cannot be annotated directly: ${input.shape_id}`);
    if (!input.body) throw new Error("body is required");
    const annotation = this.annotateAsset({
      target_type: brief.annotation_target.target_type,
      target_id: brief.annotation_target.target_id,
      annotation_type: input.annotation_type ?? "review_note",
      title: input.title ?? brief.review.title,
      body: input.body,
      structured: {
        ...(input.structured && typeof input.structured === "object" ? input.structured : {}),
        source: "canvas_review_annotation",
        canvas: brief.canvas,
        shape_id: input.shape_id,
        severity: input.severity ?? "note",
        requested_change: input.requested_change ?? null,
        screenshot_asset_version_id: input.screenshot_asset_version_id ?? null,
        lint_issues: brief.lint_issues.map((issue) => ({ level: issue.level, code: issue.code, message: issue.message }))
      },
      visibility: input.visibility ?? "project",
      actor_id: input.actor_id,
      actor_type: input.actor_type
    });
    return { brief, annotation };
  }

  createCanvasRevisionCard(input = {}) {
    this.requireDb();
    if (!input.canvas_id) throw new Error("canvas_id is required");
    const canvas = this.getCanvas({ canvas_id: input.canvas_id });
    const actor_id = input.actor_id ?? DEFAULT_ACTOR;
    const actor_type = input.actor_type ?? "agent";
    const annotation = input.annotation_id ? this.getAnnotation(input.annotation_id) : null;
    const source_shape_id = input.source_shape_id ?? input.shape_id ?? null;
    let sourceShape = source_shape_id ? canvas.shapes.find((shape) => shape.shape_id === source_shape_id) ?? null : null;
    if (!sourceShape && annotation) {
      sourceShape = canvas.shapes.find((shape) => {
        const target = annotationTargetForCanvasShape(shape);
        return target?.target_type === annotation.target_type && target.target_id === annotation.target_id;
      }) ?? null;
    }
    if (!sourceShape) throw new Error("source_shape_id or annotation_id must resolve to a canvas shape");
    const target = annotation ? { target_type: annotation.target_type, target_id: annotation.target_id } : annotationTargetForCanvasShape(sourceShape);
    const sourceProps = sourceShape.props ?? {};
    const previousShapeId = input.previous_shape_id ?? sourceProps.previous_shape_id ?? null;
    const previousShape = previousShapeId ? canvas.shapes.find((shape) => shape.shape_id === previousShapeId) ?? null : null;
    const slotShapeId = input.slot_shape_id ?? sourceProps.slot_shape_id ?? null;
    const slotShape = slotShapeId ? canvas.shapes.find((shape) => shape.shape_id === slotShapeId) ?? null : null;
    const lineageEdge = previousShape ? canvas.edges.find((edge) => edge.source_shape_id === previousShape.shape_id && edge.target_shape_id === sourceShape.shape_id) ?? null : null;
    const body = input.body ?? input.requested_change ?? annotation?.body ?? "请求审阅。";
    const severity = input.severity ?? annotation?.structured?.severity ?? "revision";
    const requested_change = input.requested_change ?? annotation?.structured?.requested_change ?? body;
    const title = input.title ?? `返修卡：${sourceShape.title ?? sourceShape.shape_id}`;
    const offset = revisionCardOffset(sourceShape, canvas);
    const shape = this.upsertCanvasShape({
      canvas_id: canvas.canvas_id,
      shape_id: input.revision_card_shape_id,
      shape_type: "note",
      subject_type: "note",
      title,
      x: input.x ?? offset.x,
      y: input.y ?? offset.y,
      width: input.width ?? 340,
      height: input.height ?? 190,
      props: {
        role: "revision_card",
        stage: input.stage ?? sourceProps.stage ?? "delivery",
        source: "video_canvas_create_revision_card",
        status: input.status ?? "open",
        severity,
        requested_change,
        body,
        annotation_id: annotation?.annotation_id ?? null,
        annotation_type: annotation?.annotation_type ?? null,
        screenshot_asset_version_id: input.screenshot_asset_version_id ?? annotation?.structured?.screenshot_asset_version_id ?? null,
        source_shape_id: sourceShape.shape_id,
        source_shape_role: sourceProps.role ?? null,
        source_subject_type: sourceShape.subject_type,
        source_subject_id: sourceShape.subject_id ?? null,
        target_type: target?.target_type ?? null,
        target_id: target?.target_id ?? null,
        previous_shape_id: previousShape?.shape_id ?? null,
        previous_asset_id: sourceProps.previous_asset_id ?? previousShape?.props?.asset_id ?? null,
        previous_asset_version_id: sourceProps.previous_asset_version_id ?? previousShape?.props?.asset_version_id ?? null,
        current_shape_id: sourceShape.shape_id,
        current_asset_id: sourceProps.asset_id ?? null,
        current_asset_version_id: sourceProps.asset_version_id ?? null,
        current_reference_id: sourceProps.reference_id ?? null,
        slot_shape_id: slotShape?.shape_id ?? null,
        generation_slot: sourceProps.generation_slot ?? slotShape?.props?.generation_slot ?? null,
        writeback_semantic: sourceProps.writeback_semantic ?? null,
        lineage_edge_id: lineageEdge?.edge_id ?? null,
        lineage_relation_type: lineageEdge?.relation_type ?? null
      },
      actor_id,
      actor_type
    });
    const edge = this.linkCanvasShapes({
      canvas_id: canvas.canvas_id,
      edge_id: input.edge_id ?? productionCanvasId("edge", canvas.canvas_id, `${sourceShape.shape_id}-revision-card-${shape.shape_id}`),
      source_shape_id: sourceShape.shape_id,
      target_shape_id: shape.shape_id,
      relation_type: "references",
      label: "返修卡",
      props: {
        source: "video_canvas_create_revision_card",
        semantic: "reviewed_by",
        annotation_id: annotation?.annotation_id ?? null,
        severity,
        requested_change
      },
      actor_id,
      actor_type
    });
    const lint = this.lintCanvas({ canvas_id: canvas.canvas_id });
    return {
      revision_card: shape,
      edge,
      source_shape: sourceShape,
      annotation,
      lineage: {
        previous_shape: previousShape,
        current_shape: sourceShape,
        slot_shape: slotShape,
        lineage_edge: lineageEdge
      },
      lint
    };
  }

  updateCanvasRevisionCardStatus(input = {}) {
    this.requireDb();
    if (!input.shape_id) throw new Error("shape_id is required");
    const existing = this.requireCanvasShape(input.shape_id);
    const existingShape = canvasShapeFromRow(existing);
    const existingProps = existingShape.props ?? {};
    if (existingProps.role !== "revision_card") throw new Error(`Canvas shape is not a revision_card: ${input.shape_id}`);
    const status = normalizeRevisionCardStatus(input.status ?? existingProps.status);
    const actor_id = input.actor_id ?? DEFAULT_ACTOR;
    const actor_type = input.actor_type ?? "agent";
    const now = new Date().toISOString();
    const statusNote = input.status_note === undefined ? existingProps.status_note ?? null : nullableTrimmedString(input.status_note);
    const props = {
      ...existingProps,
      status,
      status_note: statusNote,
      status_updated_at: now,
      status_updated_by: actor_id,
      source: existingProps.source ?? "video_canvas_create_revision_card"
    };
    const shape = this.upsertCanvasShape({
      canvas_id: existing.canvas_id,
      shape_id: existing.shape_id,
      shape_type: existing.shape_type,
      subject_type: existing.subject_type,
      subject_id: existing.subject_id,
      title: input.title ?? existing.title,
      x: input.x ?? existing.x,
      y: input.y ?? existing.y,
      width: input.width ?? existing.width,
      height: input.height ?? existing.height,
      rotation: input.rotation ?? existing.rotation,
      z_index: input.z_index ?? existing.z_index,
      props,
      actor_id,
      actor_type
    });
    const canvas = this.getCanvas({ canvas_id: shape.canvas_id });
    const sourceShapeId = stringOrNull(shape.props.source_shape_id);
    const sourceShape = sourceShapeId ? canvas.shapes.find((item) => item.shape_id === sourceShapeId) ?? null : null;
    const edge = sourceShapeId ? canvas.edges.find((item) => item.source_shape_id === sourceShapeId && item.target_shape_id === shape.shape_id && item.props?.semantic === "reviewed_by") ?? null : null;
    const lint = this.lintCanvas({ canvas_id: shape.canvas_id });
    return {
      revision_card: shape,
      source_shape: sourceShape,
      edge,
      status_flow: {
        status,
        previous_status: String(existingProps.status ?? "open"),
        status_note: statusNote,
        status_updated_at: now,
        status_updated_by: actor_id
      },
      lint
    };
  }

  async insertGeneratedAsset(input = {}) {
    this.requireDb();
    if (!input.canvas_id) throw new Error("缺少画布编号。");
    if (!input.slot_shape_id) throw new Error("缺少生成槽卡片编号。");
    if (!input.file_path) throw new Error("缺少文件路径。");
    const canvas = this.getCanvas({ canvas_id: input.canvas_id });
    const slot = canvas.shapes.find((shape) => shape.shape_id === input.slot_shape_id);
    if (!slot) throw new Error(`生成槽卡片不属于当前画布：${input.slot_shape_id}`);
    if (slot.props?.role !== "generation_slot") throw new Error(`指定卡片不是生成槽：${input.slot_shape_id}`);
    const slotSpec = generationSlotFromShape(slot);
    const priorOutput = latestGeneratedOutputForSlot(canvas, slot.shape_id);
    const writebackSemantics = generationWritebackSemantics(slotSpec.replace_policy, priorOutput);
    const actor_id = input.actor_id ?? DEFAULT_ACTOR;
    const actor_type = input.actor_type ?? "agent";
    const idempotencyKey = normalizeGeneratedAssetIdempotencyKey(input.idempotency_key, {
      file_path: input.file_path,
      slot_shape_id: slot.shape_id,
      replace_policy: slotSpec.replace_policy,
      semantic: writebackSemantics.semantic,
      explicit_shape_id: input.shape_id ?? null
    });
    const existingWriteback = this.findGeneratedAssetWritebackByIdempotencyKey(canvas, idempotencyKey);
    if (existingWriteback) {
      const updatedSlot = this.updateGenerationSlot({
        shape_id: slot.shape_id,
        status: input.slot_status ?? "filled",
        actor_id,
        actor_type
      });
      const lint = this.lintCanvas({ canvas_id: canvas.canvas_id });
      return {
        ...existingWriteback,
        updated_slot: updatedSlot,
        lint,
        idempotent: {
          reused: true,
          key: idempotencyKey.key,
          source_sha256: idempotencyKey.source_sha256,
          reason: "matched_existing_generated_asset_writeback"
        }
      };
    }
    const asset = await this.ingestAsset({
      file_path: input.file_path,
      kind: input.kind ?? "working",
      title: input.title ?? `来自${slot.title ?? slot.shape_id}的生成资产`,
      description: input.description ?? `画布生成槽 ${slot.shape_id} 的生成输出`,
      tags: input.tags ?? ["generated", "canvas-output"],
      source: input.source,
      actor_id,
      actor_type
    });
    if (input.license_status || input.risk_level || input.rights_notes) {
      this.updateAssetRights({
        asset_id: asset.asset_id,
        license_status: input.license_status ?? asset.license_status ?? "unknown",
        risk_level: input.risk_level ?? asset.risk_level ?? "unknown",
        notes: input.rights_notes ?? `由画布生成槽 ${slot.shape_id} 产生`,
        actor_id,
        actor_type
      });
    }
    if (input.classification?.domain) {
      this.classifyAsset({
        asset_id: asset.asset_id,
        asset_version_id: asset.default_version_id,
        domain: input.classification.domain,
        type: input.classification.type ?? "generated_output",
        subtype: input.classification.subtype,
        confidence: input.classification.confidence ?? "confirmed",
        source: input.classification.source ?? "agent",
        actor_id,
        actor_type
      });
    }
    const currentAsset = this.getAsset({ asset_id: asset.asset_id });
    const ref = this.addProjectRef({
      project_id: canvas.project_id,
      asset_id: currentAsset.asset_id,
      asset_version_id: currentAsset.default_version_id,
      role: input.project_ref?.role ?? input.role ?? "generated_output",
      usage_scope: input.project_ref?.usage_scope ?? `${generationTypeText(slotSpec.generation_type)}生成槽输出。`,
      pin_mode: input.project_ref?.pin_mode ?? "pinned",
      required: input.project_ref?.required ?? false,
      notes: input.project_ref?.notes ?? `slot_shape_id=${slot.shape_id}; replace_policy=${slotSpec.replace_policy}${priorOutput ? `; previous_shape_id=${priorOutput.shape_id}` : ""}`,
      actor_id,
      actor_type
    });
    const placement = input.writeback?.placement ?? "right";
    const outputWidth = input.width ?? 320;
    const outputHeight = input.height ?? 150;
    const offset = writebackOffset(placement, slot, canvas, outputWidth, outputHeight);
    const shape = this.upsertCanvasShape({
      canvas_id: canvas.canvas_id,
      shape_id: input.shape_id,
      shape_type: "reference_card",
      subject_type: "project_ref",
      subject_id: ref.reference_id,
      title: input.title ?? `生成结果 ${shortId(currentAsset.asset_id)}`,
      x: input.x ?? offset.x,
      y: input.y ?? offset.y,
      width: outputWidth,
      height: outputHeight,
      props: {
        role: writebackSemantics.output_role,
        stage: slot.props?.stage ?? "shots",
        generation_slot: slotSpec.slot,
        source: input.source?.source_type ?? "generated_asset",
        slot_shape_id: slot.shape_id,
        generation_type: slotSpec.generation_type,
        replace_policy: slotSpec.replace_policy,
        writeback_policy: slotSpec.replace_policy,
        writeback_semantic: writebackSemantics.semantic,
        idempotency_key: idempotencyKey.key,
        source_sha256: idempotencyKey.source_sha256,
        revision_index: writebackSemantics.revision_index,
        previous_shape_id: priorOutput?.shape_id ?? null,
        previous_asset_id: priorOutput?.props?.asset_id ?? null,
        previous_asset_version_id: priorOutput?.props?.asset_version_id ?? null,
        previous_reference_id: priorOutput?.props?.reference_id ?? null,
        asset_id: currentAsset.asset_id,
        asset_version_id: currentAsset.default_version_id,
        reference_id: ref.reference_id,
        lineage_key: idempotencyKey.key
      },
      actor_id,
      actor_type
    });
    const edge = this.linkCanvasShapes({
      canvas_id: canvas.canvas_id,
      edge_id: input.edge_id ?? productionCanvasId("edge", canvas.canvas_id, `${slot.shape_id}-generated-${shape.shape_id}`),
      source_shape_id: slot.shape_id,
      target_shape_id: shape.shape_id,
      relation_type: input.writeback?.relation_type ?? "derived_from",
      label: input.writeback?.label ?? "生成输出",
      props: {
        source: "video_canvas_insert_generated_asset",
        asset_id: currentAsset.asset_id,
        asset_version_id: currentAsset.default_version_id,
        writeback_policy: slotSpec.replace_policy,
        writeback_semantic: writebackSemantics.semantic,
        idempotency_key: idempotencyKey.key,
        source_sha256: idempotencyKey.source_sha256
      },
      actor_id,
      actor_type
    });
    let lineage_edge = null;
    let asset_relation = null;
    if (priorOutput && writebackSemantics.lineage_relation_type) {
      lineage_edge = this.linkCanvasShapes({
        canvas_id: canvas.canvas_id,
        edge_id: productionCanvasId("edge", canvas.canvas_id, `${priorOutput.shape_id}-${writebackSemantics.lineage_relation_type}-${shape.shape_id}`),
        source_shape_id: priorOutput.shape_id,
        target_shape_id: shape.shape_id,
        relation_type: writebackSemantics.lineage_relation_type,
        label: writebackSemantics.lineage_label,
        props: {
          source: "video_canvas_insert_generated_asset",
          slot_shape_id: slot.shape_id,
          writeback_policy: slotSpec.replace_policy,
          previous_asset_id: priorOutput.props?.asset_id ?? null,
          previous_asset_version_id: priorOutput.props?.asset_version_id ?? null,
          asset_id: currentAsset.asset_id,
          asset_version_id: currentAsset.default_version_id
        },
        actor_id,
        actor_type
      });
    }
    if (priorOutput?.props?.asset_id && priorOutput?.props?.asset_version_id && writebackSemantics.asset_relation_type) {
      asset_relation = this.createAssetRelation({
        relation_type: writebackSemantics.asset_relation_type,
        source_asset_id: priorOutput.props.asset_id,
        source_version_id: priorOutput.props.asset_version_id,
        target_asset_id: currentAsset.asset_id,
        target_version_id: currentAsset.default_version_id,
        copy_type: slotSpec.replace_policy,
        reason: `${writebackSemantics.lineage_label}，来源生成槽 ${slot.shape_id}`,
        actor_id,
        actor_type
      });
    }
    const updatedSlot = this.updateGenerationSlot({
      shape_id: slot.shape_id,
      status: input.slot_status ?? "filled",
      actor_id,
      actor_type
    });
    const lint = this.lintCanvas({ canvas_id: canvas.canvas_id });
    return {
      asset: currentAsset,
      project_ref: ref,
      shape,
      edge,
      lineage_edge,
      asset_relation,
      updated_slot: updatedSlot,
      lint,
      idempotent: {
        reused: false,
        key: idempotencyKey.key,
        source_sha256: idempotencyKey.source_sha256,
        reason: "created_new_generated_asset_writeback"
      }
    };
  }

  findGeneratedAssetWritebackByIdempotencyKey(canvas, idempotencyKey) {
    const key = typeof idempotencyKey === "string" ? idempotencyKey : idempotencyKey?.key;
    if (!key) return null;
    const currentCanvas = this.getCanvas({ canvas_id: canvas.canvas_id });
    const shape = currentCanvas.shapes.find((item) => {
      const props = item.props ?? {};
      const shapeKey = typeof props.idempotency_key === "object" ? props.idempotency_key?.key : props.idempotency_key;
      return isGeneratedOutputShape(item) && shapeKey === key;
    });
    if (!shape?.props?.asset_id || !shape.props.asset_version_id || !shape.props.reference_id) return null;
    const edge = currentCanvas.edges.find((item) => item.target_shape_id === shape.shape_id && item.source_shape_id === shape.props.slot_shape_id) ?? null;
    const lineage_edge = currentCanvas.edges.find((item) => item.target_shape_id === shape.shape_id && ["revises", "replaces", "continues"].includes(item.relation_type)) ?? null;
    const asset_relation = this.db.prepare(`SELECT * FROM asset_relations WHERE target_asset_id = ? AND target_version_id = ? ORDER BY created_at DESC`).get(shape.props.asset_id, shape.props.asset_version_id) ?? null;
    return {
      asset: this.getAsset({ asset_id: shape.props.asset_id }),
      project_ref: this.requireProjectRef(shape.props.reference_id),
      shape,
      edge,
      lineage_edge,
      asset_relation
    };
  }

  async fillGenerationSlot(input = {}) {
    this.requireDb();
    if (!input.canvas_id) throw new Error("缺少画布编号。");
    if (!input.slot_shape_id) throw new Error("缺少生成槽卡片编号。");
    if (!input.file_path) throw new Error("缺少文件路径。");
    const canvas = this.getCanvas({ canvas_id: input.canvas_id });
    const slot = canvas.shapes.find((shape) => shape.shape_id === input.slot_shape_id);
    if (!slot) throw new Error(`生成槽卡片不属于当前画布：${input.slot_shape_id}`);
    if (slot.props?.role !== "generation_slot") throw new Error(`指定卡片不是生成槽：${input.slot_shape_id}`);
    const slotSpec = generationSlotFromShape(slot);
    const source = input.source ?? {
      source_type: "generated_asset",
      notes: `已填入生成槽 ${slot.shape_id}`
    };
    const writeback = {
      placement: placementForGenerationSlotPolicy(slotSpec.replace_policy),
      relation_type: "derived_from",
      label: "已填入生成槽",
      ...(input.writeback && typeof input.writeback === "object" ? input.writeback : {})
    };
    const project_ref = {
      role: "generated_output",
      usage_scope: `已填入${generationTypeText(slotSpec.generation_type)}生成槽 ${generationSlotLabel(slotSpec.slot)}。`,
      pin_mode: "pinned",
      required: false,
      notes: `slot_shape_id=${slot.shape_id}; replace_policy=${slotSpec.replace_policy}`,
      ...(input.project_ref && typeof input.project_ref === "object" ? input.project_ref : {})
    };
    const classification = input.classification ?? {
      domain: "delivery",
      type: "generated_output",
      subtype: slotSpec.generation_type,
      confidence: "confirmed",
      source: "agent"
    };
    const result = await this.insertGeneratedAsset({
      ...input,
      title: input.title ?? `已填入${generationSlotLabel(slotSpec.slot)} ${shortId(slot.shape_id)}`,
      description: input.description ?? `已填入画布生成槽 ${slot.shape_id} 的生成输出。`,
      kind: input.kind ?? "working",
      tags: input.tags ?? ["generated", "canvas-output", "generation-slot", slotSpec.slot, slotSpec.generation_type],
      source,
      license_status: input.license_status ?? "unknown",
      risk_level: input.risk_level ?? "unknown",
      rights_notes: input.rights_notes ?? `生成输出已填入画布生成槽 ${slot.shape_id}；公开交付前需要人工复核授权。`,
      classification,
      project_ref,
      writeback,
      slot_status: input.slot_status ?? "filled"
    });
    return {
      ...result,
      fill: {
        source: "video_canvas_fill_generation_slot",
        canvas_id: canvas.canvas_id,
        slot_shape_id: slot.shape_id,
        generation_slot: slotSpec,
        target_spec: {
          generation_type: slotSpec.generation_type,
          target_width: slotSpec.target_width,
          target_height: slotSpec.target_height,
          target_aspect_ratio: slotSpec.target_aspect_ratio,
          duration_seconds: slotSpec.duration_seconds,
          replace_policy: slotSpec.replace_policy
        },
        writeback
      }
    };
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
    const outputDir = resolveDoubaoAudioOutputDir(plan.request.execution.output_dir, this.root);
    const generated = await runDoubaoAudioGeneration(plan.request, { outputDir });
    const registered_assets = [];

    if (generated.status === "success" && plan.request.execution.ingest_outputs !== false) {
      for (const output of generated.outputs ?? []) {
        const asset = await this.ingestAsset({
          file_path: output.file_path,
          title: plan.request.asset_policy.title,
          description: "由豆包音频生成 1.0 根据项目声音导演稿生成。",
          tags: plan.request.asset_policy.tags,
          kind: plan.request.asset_policy.kind,
          actor_id: input.actor_id ?? DEFAULT_ACTOR,
          actor_type: input.actor_type ?? "agent",
          source: {
            source_type: "doubao_audio",
            notes: JSON.stringify({
              request: plan.request,
              provider_result: summarizeDoubaoProviderResult(generated),
              platform_review_status: generated.platform_review_status,
              license_policy: "platform_review_passed_means_cleared"
            })
          }
        });
        this.updateAssetRights({
          asset_id: asset.asset_id,
          license_status: "cleared",
          risk_level: "low",
          notes: `豆包音频平台审核通过，资产按项目策略登记为 cleared：${asset.title}`,
          actor_id: input.actor_id ?? DEFAULT_ACTOR,
          actor_type: input.actor_type ?? "agent",
          source: {
            source_type: "doubao_audio_platform_review",
            captured_at: generated.completed_at ?? new Date().toISOString(),
            license_hint: "平台审核通过即代表本次上传素材、模型输出与相关版权问题已通过。",
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
            notes: input.project_ref?.notes ?? `doubao_task_id=${generated.task_id}; platform_review_status=${generated.platform_review_status}; license_status=cleared`,
            actor_id: input.actor_id ?? DEFAULT_ACTOR,
            actor_type: input.actor_type ?? "agent"
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

  canvasDoubaoAudioPlan(input = {}) {
    this.requireDb();
    if (!input.canvas_id) throw new Error("canvas_id is required");
    const canvas = this.getCanvas({ canvas_id: input.canvas_id });
    const slot = this.resolveDoubaoAudioSlot(canvas, input.slot_shape_id);
    const slotSpec = slot ? generationSlotFromShape(slot) : null;
    const request = normalizeDoubaoAudioRequest(input, {
      project_id: canvas.project_id,
      canvas_id: canvas.canvas_id,
      slot_shape_id: slot?.shape_id ?? null,
      duration_seconds: slotSpec?.duration_seconds ?? input.duration_seconds,
      purpose: "canvas_audio_track"
    });
    const validation = this.validateDoubaoAudioRequestWithAssets(request);
    if (!slot) validation.blockers.push("canvas audio generation slot is required");
    validation.status = validation.blockers.length ? "blocked" : "ready";
    return this.doubaoAudioPlanResponse({ request, validation, project: this.requireProject(canvas.project_id), canvas, slot, slotSpec, source: "canvas_doubao_audio_plan" });
  }

  async canvasDoubaoAudioGenerate(input = {}) {
    this.requireDb();
    const plan = this.canvasDoubaoAudioPlan(input);
    const execute = plan.request.execution.execute === true;
    if (plan.status === "blocked" || !execute) return plan;
    const outputDir = resolveDoubaoAudioOutputDir(plan.request.execution.output_dir, this.root);
    const generated = await runDoubaoAudioGeneration(plan.request, { outputDir });
    let canvas_writeback = null;

    if (generated.status === "success" && generated.outputs?.length && plan.request.execution.ingest_outputs !== false && plan.request.execution.writeback_canvas !== false) {
      const output = generated.outputs[0];
      canvas_writeback = await this.fillGenerationSlot({
        canvas_id: plan.canvas.canvas_id,
        slot_shape_id: plan.slot.shape_id,
        file_path: output.file_path,
        title: plan.request.asset_policy.title,
        description: "由豆包音频生成 1.0 根据画布音频生成槽生成。",
        kind: plan.request.asset_policy.kind,
        tags: [...plan.request.asset_policy.tags, "canvas-output", "generation-slot", "audio"],
        source: {
          source_type: "doubao_audio",
          notes: JSON.stringify({
            request: plan.request,
            provider_result: summarizeDoubaoProviderResult(generated),
            platform_review_status: generated.platform_review_status,
            license_policy: "platform_review_passed_means_cleared"
          })
        },
        license_status: "cleared",
        risk_level: "low",
        rights_notes: "豆包音频平台审核通过；按项目权利策略，平台审核通过即代表本次上传素材、模型输出与相关版权问题已通过，可作为资产库 cleared 依据。",
        classification: {
          domain: "audio",
          type: "generated_output",
          subtype: "doubao_audio",
          confidence: "confirmed",
          source: "agent"
        },
        project_ref: {
          role: "generated_audio",
          usage_scope: "作为 @音频1 或画布声音总轨候选。",
          pin_mode: "pinned",
          required: false,
          notes: `doubao_task_id=${generated.task_id}; platform_review_status=${generated.platform_review_status}; license_status=cleared`
        },
        writeback: { placement: "right", relation_type: "derived_from", label: "豆包音频输出" },
        slot_status: "filled",
        actor_id: input.actor_id ?? DEFAULT_ACTOR,
        actor_type: input.actor_type ?? "agent"
      });
    }

    return {
      ...plan,
      status: "success",
      dry_run: false,
      output_dir: outputDir,
      provider_result: generated,
      registered_assets: canvas_writeback?.asset ? [{ asset_id: canvas_writeback.asset.asset_id, asset_version_id: canvas_writeback.asset.default_version_id, file_path: generated.outputs[0]?.file_path, project_ref: canvas_writeback.project_ref }] : [],
      canvas_writeback,
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
        "按家主最高指示，平台审核通过、生成成功或输出可下载后，生成音频自动登记为 license_status=cleared、risk_level=low。"
      ],
      asset_policy: request.asset_policy,
      next_actions: doubaoAudioNextActions({ request, validation })
    };
  }

  validateDoubaoAudioRequestWithAssets(request) {
    const validation = validateDoubaoAudioRequest(request);
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
    const outputDir = resolveKieSunoOutputDir(plan.request.execution.output_dir, this.root);
    const generated = await runKieSunoGeneration(plan.request, { outputDir });
    const registered_assets = [];

    if (generated.status === "success" && plan.request.execution.ingest_outputs !== false) {
      for (const output of generated.outputs ?? []) {
        const asset = await this.ingestAsset({
          file_path: output.file_path,
          title: plan.request.asset_policy.title,
          description: "由 KIE Suno API 根据项目音乐请求生成，公开交付前需要版权与商用条款复核。",
          tags: plan.request.asset_policy.tags,
          kind: plan.request.asset_policy.kind,
          actor_id: input.actor_id ?? DEFAULT_ACTOR,
          actor_type: input.actor_type ?? "agent",
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
          actor_id: input.actor_id ?? DEFAULT_ACTOR,
          actor_type: input.actor_type ?? "agent",
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
            actor_id: input.actor_id ?? DEFAULT_ACTOR,
            actor_type: input.actor_type ?? "agent"
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

  canvasKieSunoPlan(input = {}) {
    this.requireDb();
    if (!input.canvas_id) throw new Error("canvas_id is required");
    const canvas = this.getCanvas({ canvas_id: input.canvas_id });
    const slot = this.resolveDoubaoAudioSlot(canvas, input.slot_shape_id);
    const slotSpec = slot ? generationSlotFromShape(slot) : null;
    const request = normalizeKieSunoRequest(input, {
      project_id: canvas.project_id,
      canvas_id: canvas.canvas_id,
      slot_shape_id: slot?.shape_id ?? null,
      duration_seconds: slotSpec?.duration_seconds ?? input.duration_seconds,
      intent: "canvas music generation"
    });
    const validation = this.validateKieSunoRequestWithAssets(request);
    if (!slot) validation.blockers.push("canvas audio/music generation slot is required");
    validation.status = validation.blockers.length ? "blocked" : "ready";
    return this.kieSunoPlanResponse({ request, validation, project: this.requireProject(canvas.project_id), canvas, slot, slotSpec, source: "canvas_kie_suno_plan" });
  }

  async canvasKieSunoGenerate(input = {}) {
    this.requireDb();
    const plan = this.canvasKieSunoPlan(input);
    const execute = plan.request.execution.execute === true;
    if (plan.status === "blocked" || !execute) return plan;
    const outputDir = resolveKieSunoOutputDir(plan.request.execution.output_dir, this.root);
    const generated = await runKieSunoGeneration(plan.request, { outputDir });
    let canvas_writeback = null;

    if (generated.status === "success" && generated.outputs?.length && plan.request.execution.ingest_outputs !== false && plan.request.execution.writeback_canvas !== false) {
      const output = generated.outputs[0];
      canvas_writeback = await this.fillGenerationSlot({
        canvas_id: plan.canvas.canvas_id,
        slot_shape_id: plan.slot.shape_id,
        file_path: output.file_path,
        title: plan.request.asset_policy.title,
        description: "由 KIE Suno API 根据画布音乐生成槽生成，公开交付前需要版权与商用条款复核。",
        kind: plan.request.asset_policy.kind,
        tags: [...plan.request.asset_policy.tags, "canvas-output", "generation-slot", "audio", "music"],
        source: {
          source_type: "kie_suno",
          notes: JSON.stringify({
            request: plan.request,
            provider_result: summarizeKieSunoProviderResult(generated),
            rights_policy: "default_unknown_until_human_review"
          })
        },
        license_status: "unknown",
        risk_level: "unknown",
        rights_notes: "KIE Suno 输出默认授权未知；公开视频、商用或可交付版本前必须人工复核条款和输入素材权利。",
        classification: {
          domain: "audio",
          type: "generated_output",
          subtype: plan.request.handoff.track_role || "music",
          confidence: "candidate",
          source: "agent"
        },
        project_ref: {
          role: "generated_music",
          usage_scope: "作为画布音乐/歌曲/伴奏候选，公开交付前需授权复核。",
          pin_mode: "pinned",
          required: false,
          notes: `kie_suno_task_id=${generated.task_id}; license_status=unknown; rights_review_required=true`
        },
        writeback: { placement: "right", relation_type: "derived_from", label: "KIE Suno 输出" },
        slot_status: "filled",
        actor_id: input.actor_id ?? DEFAULT_ACTOR,
        actor_type: input.actor_type ?? "agent"
      });
    }

    return {
      ...plan,
      status: generated.status === "submitted" ? "submitted" : "success",
      dry_run: false,
      output_dir: outputDir,
      provider_result: generated,
      registered_assets: canvas_writeback?.asset ? [{ asset_id: canvas_writeback.asset.asset_id, asset_version_id: canvas_writeback.asset.default_version_id, file_path: generated.outputs[0]?.file_path, project_ref: canvas_writeback.project_ref }] : [],
      canvas_writeback,
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
    const validation = validateKieSunoRequest(request);
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

  resolveDoubaoAudioSlot(canvas, slot_shape_id = null) {
    if (slot_shape_id) {
      const slot = canvas.shapes.find((shape) => shape.shape_id === slot_shape_id);
      if (!slot) throw new Error(`slot_shape_id does not belong to canvas: ${slot_shape_id}`);
      if (slot.props?.role !== "generation_slot") throw new Error(`slot_shape_id is not a generation slot: ${slot_shape_id}`);
      return slot;
    }
    return canvas.shapes.find((shape) => {
      if (shape.props?.role !== "generation_slot") return false;
      const spec = generationSlotFromShape(shape);
      return spec.generation_type === "voice" || spec.slot === "audio" || spec.generation_slot === "audio";
    }) ?? null;
  }

  safeResolveVersionFile(asset_version_id) {
    try {
      return this.resolveVersionFile(asset_version_id);
    } catch {
      return null;
    }
  }

  lintCanvas(input = {}) {
    const canvas = this.getCanvas(input);
    const issues = [];
    const shapeIds = new Set(canvas.shapes.map((shape) => shape.shape_id));
    const connectedShapeIds = new Set();
    const push = (level, code, shape, message, extra = {}) => issues.push({ level, code, shape_id: shape?.shape_id ?? null, subject_type: shape?.subject_type ?? null, subject_id: shape?.subject_id ?? null, message, ...extra });
    if (canvas.shapes.length === 0) issues.push({ level: "info", code: "EMPTY_CANVAS", shape_id: null, subject_type: null, subject_id: null, message: "画布为空，可添加项目、素材或实体卡片。" });
    for (const edge of canvas.edges) {
      if (!shapeIds.has(edge.source_shape_id) || !shapeIds.has(edge.target_shape_id)) {
        issues.push({ level: "error", code: "DANGLING_EDGE", edge_id: edge.edge_id, message: "画布连线指向不存在的卡片。" });
      } else {
        connectedShapeIds.add(edge.source_shape_id);
        connectedShapeIds.add(edge.target_shape_id);
      }
      if (edge.source_shape_id === edge.target_shape_id) issues.push({ level: "warning", code: "SELF_EDGE", edge_id: edge.edge_id, message: "画布连线的起点和终点相同，通常需要修正。" });
    }
    for (const shape of canvas.shapes) {
      if (shape.subject_type !== "note" && shape.subject_type !== "section" && !shape.subject_id) {
        push("warning", "UNBOUND_SHAPE", shape, "画布卡片缺少 subject_id，Agent 无法稳定追溯。");
      }
      if (!connectedShapeIds.has(shape.shape_id) && !["note", "section"].includes(shape.subject_type)) {
        push("info", "ISOLATED_SHAPE", shape, "卡片未与其他卡片建立关系，Agent 可能无法判断它在项目中的用途。");
      }
      let context = null;
      try {
        context = this.canvasSubjectContext(shape, canvas);
      } catch (error) {
        push("error", "MISSING_SUBJECT", shape, error instanceof Error ? error.message : String(error));
        continue;
      }
      if (["asset", "asset_version", "project_ref"].includes(shape.subject_type)) {
        const asset = context.asset;
        const taxonomy = context.taxonomy;
        const entityLinks = context.entity_links ?? [];
        const annotationSummary = context.annotation_summary ?? { required_count: 0 };
        if (asset) {
          if (asset.license_status === "rejected") push("error", "ASSET_LICENSE_REJECTED", shape, "资产授权状态为 rejected，不能进入生产画布。", { asset_id: asset.asset_id });
          else if (asset.license_status !== "cleared") push("warning", "ASSET_LICENSE_NOT_CLEARED", shape, "资产授权状态为 " + (asset.license_status ?? "unknown") + "，正式生产前需清理。", { asset_id: asset.asset_id });
          if (asset.risk_level === "high") push("error", "ASSET_RISK_HIGH", shape, "资产风险等级为 high，必须先处理。", { asset_id: asset.asset_id });
          else if (asset.risk_level === "medium" || asset.risk_level === "unknown") push("warning", "ASSET_RISK_REVIEW", shape, "资产风险等级为 " + asset.risk_level + "，生产前需复核。", { asset_id: asset.asset_id });
        }
        if (!taxonomy) {
          push("warning", "MISSING_TAXONOMY", shape, "资产卡缺少 taxonomy 分类，Agent 无法可靠判断角色/场景/服装/道具等生产职责。");
        } else {
          if (["candidate", "inferred"].includes(taxonomy.confidence)) push("warning", "UNCONFIRMED_TAXONOMY", shape, "taxonomy 置信度为 " + taxonomy.confidence + "，进入交付前需确认。");
          if (KEY_DOMAINS.has(taxonomy.domain)) {
            if (entityLinks.length === 0) push("warning", "MISSING_ENTITY_LINK", shape, "关键 " + taxonomy.domain + " 资产缺少 entity link。");
            if (annotationSummary.required_count === 0) push("warning", "MISSING_KEY_ANNOTATION", shape, "关键 " + taxonomy.domain + " 资产缺少 active " + requiredAnnotationForDomain(taxonomy.domain) + " 信息卡。");
          }
        }
        if (shape.subject_type !== "project_ref" && context.project_refs && context.project_refs.length === 0) {
          push("info", "ASSET_NOT_REFERENCED_IN_PROJECT", shape, "素材/版本卡尚未加入当前项目引用，可能只是参考或候选素材。");
        }
      }
      if (shape.subject_type === "project_ref" && shape.subject_id) {
        const ref = context.ref;
        if (!ref || ref.status === "removed") push("error", "MISSING_PROJECT_REF", shape, "画布卡片绑定的项目引用不存在或已移除。");
        else if (ref.pin_mode !== "pinned" && ref.required) push("warning", "PROJECT_REF_NOT_PINNED", shape, "项目引用为 " + ref.pin_mode + "，交付前应锁定 asset_version_id。", { reference_id: ref.reference_id });
      }
      if (shape.subject_type === "entity" && shape.subject_id) {
        const entity = context.entity;
        if (!entity) push("error", "MISSING_ENTITY", shape, "画布卡片绑定的实体不存在。");
        else if (entity.status !== "active") push("warning", "ENTITY_NOT_ACTIVE", shape, "实体状态为 " + entity.status + "，生产前需复核。");
        if ((context.annotation_summary?.active_count ?? 0) === 0) push("info", "ENTITY_NO_ANNOTATION", shape, "实体没有 active 注释，后续可补信息卡。");
      }
    }
    this.canvasStageGapIssues(canvas).forEach((issue) => issues.push(issue));
    return { canvas_id: canvas.canvas_id, issue_count: issues.length, issues, errors: issues.filter((issue) => issue.level === "error"), warnings: issues.filter((issue) => issue.level === "warning"), infos: issues.filter((issue) => issue.level === "info") };
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
    const actor = this.ensureActor(input.actor_id ?? DEFAULT_ACTOR, input.actor_type ?? "agent");
    const fileName = sanitizeFileName(input.file_name);
    const targetDir = this.resolveAllowedFilePath("asset-staging", input.relative_path ?? "");
    await fs.promises.mkdir(targetDir.absolute_path, { recursive: true });
    const buffer = Buffer.from(String(input.content_base64), "base64");
    if (buffer.length === 0) throw new Error("uploaded file is empty");
    if (buffer.length > MAX_STAGING_UPLOAD_BYTES) throw new Error("uploaded file exceeds staging limit");
    const targetName = uniqueStagingName(fileName);
    const targetPath = path.join(targetDir.absolute_path, targetName);
    if (!isInsidePath(targetDir.root_absolute, targetPath)) throw new Error("upload target escapes staging root");
    await fs.promises.writeFile(targetPath, buffer, { flag: "wx" });
    const relative_path = normalizeRelativePath(path.posix.join(targetDir.relative_path_posix, targetName));
    this.commit({ scope: "system", target_id: relative_path, action: "staging.upload", message: "已上传暂存文件：" + fileName, actor_id: actor.actor_id, changes: { root_key: "asset-staging", relative_path, size_bytes: buffer.length } });
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
      actor_id: input.actor_id ?? DEFAULT_ACTOR,
      actor_type: input.actor_type ?? "agent",
      change_summary: input.change_summary ?? "Confirmed from staging upload",
      source: input.source
    });
    const actor = this.ensureActor(input.actor_id ?? DEFAULT_ACTOR, input.actor_type ?? "agent");
    this.commit({ scope: "system", target_id: normalizeRelativePath(input.relative_path), action: "staging.ingest", message: "已入库暂存文件：" + path.basename(resolved.absolute_path), actor_id: actor.actor_id, changes: { root_key: "asset-staging", relative_path: normalizeRelativePath(input.relative_path), asset_id: asset.asset_id, default_version_id: asset.default_version_id } });
    return { ok: true, asset, file: await this.inspectFile({ root_key: "asset-staging", relative_path: input.relative_path }) };
  }

  async rejectStagingFile(input = {}) {
    this.requireDb();
    if (!input.relative_path) throw new Error("relative_path is required");
    const actor = this.ensureActor(input.actor_id ?? DEFAULT_ACTOR, input.actor_type ?? "agent");
    const resolved = this.resolveAllowedFilePath("asset-staging", input.relative_path);
    const stat = await fs.promises.stat(resolved.absolute_path);
    if (!stat.isFile()) throw new Error("relative_path must point to a staging file");
    const size_bytes = stat.size;
    await fs.promises.unlink(resolved.absolute_path);
    const relative_path = normalizeRelativePath(input.relative_path);
    this.commit({ scope: "system", target_id: relative_path, action: "staging.reject", message: "已拒绝暂存文件：" + path.basename(resolved.absolute_path), actor_id: actor.actor_id, changes: { root_key: "asset-staging", relative_path, size_bytes, reason: input.reason ?? null } });
    return { ok: true, root_key: "asset-staging", relative_path, rejected: true };
  }

  uiDashboardSummary() {
    this.requireDb();
    const projects = this.db.prepare("SELECT COUNT(*) AS count FROM projects").get();
    const assets = this.db.prepare("SELECT COUNT(*) AS count FROM assets WHERE lifecycle != 'soft_deleted'").get();
    const refs = this.db.prepare("SELECT COUNT(*) AS count FROM project_references WHERE status != 'removed'").get();
    const derived = this.db.prepare("SELECT COUNT(*) AS count FROM derived_files WHERE status = 'active'").get();
    return {
      repository_root: this.root,
      project_count: Number(projects?.count ?? 0),
      asset_count: Number(assets?.count ?? 0),
      project_ref_count: Number(refs?.count ?? 0),
      derived_file_count: Number(derived?.count ?? 0),
      file_roots: this.fileRoots()
    };
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
    const actor = this.ensureActor(input.actor_id ?? DEFAULT_ACTOR, input.actor_type ?? "agent");
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
    const actor = this.ensureActor(input.actor_id ?? DEFAULT_ACTOR, input.actor_type ?? "agent");
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
    const actor = this.ensureActor(input.actor_id ?? DEFAULT_ACTOR, input.actor_type ?? "agent");
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
    const actor = this.ensureActor(input.actor_id ?? DEFAULT_ACTOR, input.actor_type ?? "agent");
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
    const actor = this.ensureActor(input.actor_id ?? DEFAULT_ACTOR, input.actor_type ?? "agent");
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

  getCanvasRow(canvas_id) {
    return this.db.prepare("SELECT * FROM canvases WHERE canvas_id = ?").get(canvas_id);
  }

  getCanvasShapeRow(shape_id) {
    return this.db.prepare("SELECT * FROM canvas_shapes WHERE shape_id = ?").get(shape_id);
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

  validateCanvasShapeType(shape_type) {
    if (!CANVAS_SHAPE_TYPES.has(shape_type)) throw new Error(`Invalid canvas shape_type: ${shape_type}`);
    return shape_type;
  }

  validateCanvasSubjectType(subject_type) {
    if (!CANVAS_SUBJECT_TYPES.has(subject_type)) throw new Error(`Invalid canvas subject_type: ${subject_type}`);
    return subject_type;
  }

  validateCanvasRelationType(relation_type) {
    if (!CANVAS_RELATION_TYPES.has(relation_type)) throw new Error(`Invalid canvas relation_type: ${relation_type}`);
    return relation_type;
  }

  requireCanvas(canvas_id) {
    const canvas = this.getCanvasRow(canvas_id);
    if (!canvas) throw new Error(`Canvas not found: ${canvas_id}`);
    return canvas;
  }

  requireCanvasShape(shape_id) {
    const shape = this.getCanvasShapeRow(shape_id);
    if (!shape) throw new Error(`Canvas shape not found: ${shape_id}`);
    return shape;
  }

  requireCanvasSubject(subject_type, subject_id) {
    if (subject_type === "project") return this.requireProject(subject_id);
    if (subject_type === "asset") return this.requireAsset(subject_id);
    if (subject_type === "asset_version") {
      const version = this.getVersionRow(subject_id);
      if (!version) throw new Error(`Asset version not found: ${subject_id}`);
      return version;
    }
    if (subject_type === "project_ref") return this.requireProjectRef(subject_id);
    if (subject_type === "entity") return this.getEntityById(subject_id);
    return { subject_type, subject_id };
  }

  touchCanvas(canvas_id, now = new Date().toISOString()) {
    this.db.prepare("UPDATE canvases SET updated_at = ? WHERE canvas_id = ?").run(now, canvas_id);
  }

  canvasSummary(row) {
    const shapeStats = this.db.prepare("SELECT COUNT(*) AS shape_count FROM canvas_shapes WHERE canvas_id = ?").get(row.canvas_id);
    const edgeStats = this.db.prepare("SELECT COUNT(*) AS edge_count FROM canvas_edges WHERE canvas_id = ?").get(row.canvas_id);
    return { ...canvasFromRow(row), shape_count: Number(shapeStats?.shape_count ?? 0), edge_count: Number(edgeStats?.edge_count ?? 0) };
  }

  enrichCanvasShape(shape, canvas = null) {
    let subject = null;
    let subject_context = null;
    try {
      if (shape.subject_type === "project" && shape.subject_id) subject = this.getProject(shape.subject_id);
      else if (shape.subject_type === "asset" && shape.subject_id) subject = assetFromRow(this.requireAsset(shape.subject_id));
      else if (shape.subject_type === "asset_version" && shape.subject_id) subject = versionFromRow(this.getVersionRow(shape.subject_id));
      else if (shape.subject_type === "project_ref" && shape.subject_id) subject = this.requireProjectRef(shape.subject_id);
      else if (shape.subject_type === "entity" && shape.subject_id) subject = this.getEntityById(shape.subject_id);
      subject_context = this.canvasSubjectContext(shape, canvas);
    } catch (error) {
      subject = { error: error instanceof Error ? error.message : String(error) };
      subject_context = { error: subject.error };
    }
    return { ...shape, subject, subject_context };
  }

  canvasSubjectContext(shape, canvas = null) {
    if (!shape.subject_id || shape.subject_type === "note" || shape.subject_type === "section") {
      return { subject_type: shape.subject_type, subject_id: shape.subject_id ?? null };
    }
    if (shape.subject_type === "project") {
      const project = this.getProject(shape.subject_id);
      return { subject_type: "project", subject_id: shape.subject_id, project, project_ref_count: this.listProjectRefs({ project_id: shape.subject_id }).length };
    }
    if (shape.subject_type === "asset") {
      const asset = assetFromRow(this.requireAsset(shape.subject_id));
      const version_id = asset.default_version_id ?? null;
      const classifications = this.getClassificationsForAsset(asset.asset_id, version_id);
      const entity_links = this.getEntityLinksForAsset(asset.asset_id, version_id);
      const annotation_summary = this.getAnnotationsForCanvasSubject({ asset_id: asset.asset_id, asset_version_id: version_id, entity_links, domain: classifications[0]?.domain });
      const project_refs = canvas ? this.projectRefsForAsset(canvas.project_id, asset.asset_id, null) : [];
      return { subject_type: "asset", subject_id: shape.subject_id, asset, default_version_id: version_id, taxonomy: classifications[0] ?? null, classifications, entity_links, annotation_summary, project_refs };
    }
    if (shape.subject_type === "asset_version") {
      const version = versionFromRow(this.getVersionRow(shape.subject_id));
      const asset = assetFromRow(this.requireAsset(version.asset_id));
      const classifications = this.getClassificationsForAsset(asset.asset_id, version.asset_version_id);
      const entity_links = this.getEntityLinksForAsset(asset.asset_id, version.asset_version_id);
      const annotation_summary = this.getAnnotationsForCanvasSubject({ asset_id: asset.asset_id, asset_version_id: version.asset_version_id, entity_links, domain: classifications[0]?.domain });
      const project_refs = canvas ? this.projectRefsForAsset(canvas.project_id, asset.asset_id, version.asset_version_id) : [];
      return { subject_type: "asset_version", subject_id: shape.subject_id, asset, version, taxonomy: classifications[0] ?? null, classifications, entity_links, annotation_summary, project_refs };
    }
    if (shape.subject_type === "project_ref") {
      const ref = this.requireProjectRef(shape.subject_id);
      const asset = assetFromRow(this.requireAsset(ref.asset_id));
      const version = versionFromRow(this.getVersionRow(ref.asset_version_id));
      const classifications = this.getClassificationsForRef(ref);
      const entity_links = this.getEntityLinksForRef(ref);
      const annotation_summary = this.getAnnotationsForContinuity(ref, entity_links, classifications[0]?.domain);
      return { subject_type: "project_ref", subject_id: shape.subject_id, ref, asset, version, taxonomy: classifications[0] ?? null, classifications, entity_links, annotation_summary };
    }
    if (shape.subject_type === "entity") {
      const entity = this.getEntityById(shape.subject_id);
      const annotations = this.getActiveAnnotations("entity", shape.subject_id);
      return { subject_type: "entity", subject_id: shape.subject_id, entity, annotation_summary: summarizeAnnotations(annotations) };
    }
    return { subject_type: shape.subject_type, subject_id: shape.subject_id };
  }

  getClassificationsForAsset(asset_id, asset_version_id = null) {
    return this.db.prepare(`SELECT * FROM asset_classifications WHERE asset_id = ? AND (? IS NULL OR asset_version_id IS NULL OR asset_version_id = ?) ORDER BY asset_version_id IS NULL ASC, created_at ASC`)
      .all(asset_id, asset_version_id, asset_version_id);
  }

  getEntityLinksForAsset(asset_id, asset_version_id = null) {
    return this.db.prepare(`SELECT l.*, e.entity_key, e.entity_type, e.canonical_name, e.aliases_json, e.status AS entity_status
      FROM asset_entity_links l JOIN production_entities e ON e.entity_id = l.entity_id
      WHERE l.asset_id = ? AND (? IS NULL OR l.asset_version_id IS NULL OR l.asset_version_id = ?)
      ORDER BY l.asset_version_id IS NULL ASC, l.created_at ASC`).all(asset_id, asset_version_id, asset_version_id).map(linkFromRow);
  }

  getActiveAnnotations(target_type, target_id) {
    return this.db.prepare("SELECT * FROM asset_annotations WHERE target_type = ? AND target_id = ? AND status = 'active' ORDER BY created_at ASC")
      .all(target_type, target_id).map(annotationFromRow);
  }

  getAnnotationsForCanvasSubject({ asset_id, asset_version_id, entity_links = [], domain = null }) {
    const requiredType = requiredAnnotationForDomain(domain);
    const targets = [
      ["asset", asset_id],
      asset_version_id ? ["asset_version", asset_version_id] : null,
      ...entity_links.map((link) => ["entity", link.entity_id])
    ].filter(Boolean);
    const details = [];
    for (const [target_type, target_id] of targets) details.push(...this.getActiveAnnotations(target_type, target_id));
    return summarizeAnnotations(details, requiredType);
  }

  projectRefsForAsset(project_id, asset_id, asset_version_id = null) {
    return this.db.prepare(`SELECT * FROM project_references
      WHERE project_id = ? AND asset_id = ? AND (? IS NULL OR asset_version_id = ?) AND status != 'removed'
      ORDER BY added_at ASC`).all(project_id, asset_id, asset_version_id, asset_version_id);
  }

  productionStageForProjectRef(ref) {
    const classifications = this.getClassificationsForRef(ref);
    if (classifications[0]) return productionStageForDomain(classifications[0].domain);
    const asset = this.getAssetRow(ref.asset_id);
    if (asset?.media_type === "audio") return "audio";
    const role = String(ref.role ?? ref.usage_scope ?? "").toLowerCase();
    if (role.includes("character") || role.includes("角色")) return "characters";
    if (role.includes("scene") || role.includes("场景")) return "scenes";
    if (role.includes("costume") || role.includes("服装") || role.includes("prop") || role.includes("道具")) return "props";
    if (role.includes("audio") || role.includes("voice") || role.includes("subtitle") || role.includes("声音") || role.includes("字幕")) return "audio";
    if (role.includes("delivery") || role.includes("export") || role.includes("交付") || role.includes("导出")) return "delivery";
    return "references";
  }

  canvasProductionStageSummary(canvasDetail, lint = null) {
    const canvas = canvasDetail.shapes ? canvasDetail : this.getCanvas({ canvas_id: canvasDetail.canvas_id });
    const issues = lint?.issues ?? [];
    return PRODUCTION_CANVAS_STAGES.map((stage) => {
      const shapes = canvas.shapes.filter((shape) => canvasShapeStage(shape, this.safeCanvasSubjectContext(shape, canvas)) === stage.key);
      const stageIssues = issues.filter((issue) => shapes.some((shape) => shape.shape_id === issue.shape_id));
      const section = shapes.find((shape) => shape.subject_type === "section" && shape.props?.role === "production_stage");
      const contentShapes = shapes.filter((shape) => shape.shape_id !== section?.shape_id && shape.props?.role !== "production_slot");
      const slotShapes = shapes.filter((shape) => shape.props?.role === "production_slot");
      const missing = [];
      if (!section) missing.push("stage_section");
      if (stage.required && contentShapes.length === 0 && stage.key !== "shots" && stage.key !== "delivery") missing.push("content_card");
      if (stage.key === "shots" && slotShapes.length === 0) missing.push("generation_slots");
      return {
        key: stage.key,
        title: stage.title,
        required: stage.required,
        shape_count: shapes.length,
        content_count: contentShapes.length,
        slot_count: slotShapes.length,
        issue_count: stageIssues.length,
        missing,
        ready: missing.length === 0 && !stageIssues.some((issue) => issue.level === "error")
      };
    });
  }

  canvasStageGapIssues(canvasDetail) {
    const canvas = canvasDetail.shapes ? canvasDetail : this.getCanvas({ canvas_id: canvasDetail.canvas_id });
    const hasProductionTemplate = canvas.document?.template_kind === "production_pilot"
      || canvas.shapes.some((shape) => shape.subject_type === "section" && shape.props?.role === "production_stage");
    if (!hasProductionTemplate) return [];
    return this.canvasProductionStageSummary(canvas, { issues: [] }).flatMap((stage) => {
      const stageShape = canvas.shapes.find((shape) => shape.subject_type === "section" && shape.props?.role === "production_stage" && canvasShapeStage(shape, null) === stage.key);
      return stage.missing.map((missing) => ({
        level: "warning",
        code: "PRODUCTION_STAGE_GAP",
        shape_id: stageShape?.shape_id ?? null,
        subject_type: stageShape?.subject_type ?? "section",
        subject_id: stageShape?.subject_id ?? "stage:" + stage.key,
        stage: stage.key,
        missing,
        message: "生产阶段“" + stage.title + "”缺少 " + productionStageMissingText(missing) + "。"
      }));
    });
  }

  validateGenerationType(value) {
    const normalized = String(value ?? "").trim() || "image_to_video";
    if (!GENERATION_TYPES.has(normalized)) throw new Error("Invalid generation_type: " + value);
    return normalized;
  }

  canvasGenerationGates({ project, inputs, generation_type, lint, production_stage_gaps, slots = {}, active_generation_slot = null }) {
    const errors = [];
    const warnings = [];
    const waivers = [];
    if (!project) errors.push("未选择项目。");
    if (inputs.length === 0) errors.push("画布没有可用于生成准备的项目引用或素材卡。");
    if (!active_generation_slot) warnings.push("画布尚未选择生成槽，交接包将使用项目默认输出规格。");
    for (const required of active_generation_slot?.required_refs ?? []) {
      if (!GENERATION_INPUT_SLOT_KEYS.has(required)) continue;
      if ((slots[required] ?? []).length === 0) errors.push("生成槽缺少必需引用：" + generationSlotLabel(required));
    }
    if (project && (!project.aspect_ratio || !project.resolution)) warnings.push("项目输出比例或分辨率未完整设置。");
    if (generation_type === "image_to_video" && !inputs.some((item) => ["main_reference", "character_reference", "scene_reference", "style_reference"].includes(item.slot) && item.media_type === "image")) {
      errors.push("图生视频至少需要一个图像类画布输入。");
    }
    if (generation_type === "voice" && !inputs.some((item) => item.slot === "audio")) warnings.push("配音生成缺少音频参考，后续需要补文本或音色输入。");
    if (generation_type === "subtitle" && !inputs.some((item) => item.slot === "audio" || item.slot === "video_clip")) errors.push("字幕生成需要音频或视频片段输入。");
    for (const input of inputs) {
      if (!input.asset_version_id) errors.push("画布输入缺少具体资产版本：" + (input.title ?? input.shape_id));
      if (input.pin_mode === "candidate") warnings.push("候选引用需在正式生成前确认：" + input.reference_id);
      if (input.pin_mode === "follow_latest") warnings.push("跟随最新会降低复现性，建议固定版本：" + input.reference_id);
      if (input.license_status !== "cleared") {
        const waiver = generationGateWaiver(input, "ASSET_LICENSE_NOT_CLEARED");
        if (waiver) {
          waivers.push(waiver);
          warnings.push("已按审计批注豁免授权门：" + input.title + " (" + (input.license_status ?? "unknown") + ")");
        } else {
          errors.push("授权状态未清理：" + input.title + " (" + (input.license_status ?? "unknown") + ")");
        }
      }
      if (!input.taxonomy) {
        const waiver = generationGateWaiver(input, "MISSING_TAXONOMY");
        if (waiver) {
          waivers.push(waiver);
          warnings.push("已按审计批注豁免 taxonomy 门：" + input.title);
        } else {
          errors.push("生成输入缺少 taxonomy 分类：" + input.title);
        }
      }
      if (input.risk_level === "high") errors.push("高风险素材不能进入生成准备：" + input.title);
    }
    for (const gap of production_stage_gaps) warnings.push("生产画布缺口：" + gap.title + " / " + gap.missing.join(", "));
    for (const issue of lint.errors) errors.push(issue.message);
    return { ok: errors.length === 0, errors, warnings, waivers };
  }

  safeCanvasSubjectContext(shape, canvas) {
    try {
      return this.canvasSubjectContext(shape, canvas);
    } catch {
      return null;
    }
  }

  canvasActionPolicy() {
    return {
      allowed_actions: [
        { action: "create_shape", tool: "video_canvas_upsert_shape", scope: "canvas_only" },
        { action: "apply_production_template", tool: "video_canvas_apply_production_template", scope: "canvas_only" },
        { action: "update_shape_layout", tool: "video_canvas_upsert_shape", scope: "canvas_only" },
        { action: "save_selection", tool: "video_canvas_save_selection", scope: "canvas_widget_state" },
        { action: "save_view_state", tool: "video_canvas_save_view_state", scope: "canvas_widget_state" },
        { action: "link_shapes", tool: "video_canvas_link_shapes", scope: "canvas_only" },
        { action: "unlink_shapes", tool: "video_canvas_unlink_shapes", scope: "canvas_only" },
        { action: "save_snapshot", tool: "video_canvas_save_snapshot", scope: "canvas_only" },
        { action: "mark_gap", tool: "video_canvas_upsert_shape", scope: "canvas_note_or_props" }
      ],
      blocked_actions: [
        { action: "delete_asset_file", reason: "画布动作不得删除资产库真实文件。" },
        { action: "overwrite_asset_version", reason: "画布动作不得覆盖资产版本；必须走版本化工具。" },
        { action: "publish_or_approve_delivery", reason: "画布 lint 只是生产检查，不代表最终发布授权。" }
      ]
    };
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

function id(prefix) {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

function productionCanvasId(prefix, canvas_id, key) {
  const hash = createHash("sha256").update(`${canvas_id}:${key}`).digest("hex").slice(0, 32);
  return `${prefix}_${hash}`;
}

function productionStageForDomain(domain) {
  return {
    character: "characters",
    scene: "scenes",
    costume: "props",
    prop: "props",
    audio: "audio",
    reference: "references",
    prompt: "references",
    document: "references",
    delivery: "delivery"
  }[domain] ?? "references";
}

function productionStageForEntity(entity) {
  return {
    character: "characters",
    scene: "scenes",
    costume: "props",
    prop: "props",
    voice: "audio",
    audio: "audio"
  }[entity?.entity_type] ?? "references";
}

function productionStageMissingText(missing) {
  return {
    stage_section: "生产阶段分区",
    content_card: "内容卡片",
    generation_slots: "镜头/生成槽位"
  }[missing] ?? missing;
}

// 运行时返回值仍保留内部枚举；展示和报告统一走中文术语。
function generationTypeText(value) {
  return {
    image: "图像生成",
    cover: "封面生成",
    edit: "图像编辑",
    image_to_video: "图生视频",
    text_to_video: "文生视频",
    multimodal_to_video: "多模态视频",
    export: "导出",
    voice: "配音",
    subtitle: "字幕"
  }[value] ?? "生成";
}

function canvasWidgetStatusText(value) {
  return {
    ready: "就绪",
    needs_canvas: "需要先创建画布",
    needs_target: "需要指定项目或画布"
  }[value] ?? "未就绪";
}

function canvasShapeStage(shape, context = null) {
  if (shape?.props?.stage && PRODUCTION_CANVAS_STAGE_BY_KEY.has(shape.props.stage)) return shape.props.stage;
  if (shape?.subject_type === "project") return "overview";
  if (shape?.subject_type === "entity") return productionStageForEntity(context?.entity);
  if (["asset", "asset_version", "project_ref"].includes(shape?.subject_type)) {
    if (context?.taxonomy?.domain) return productionStageForDomain(context.taxonomy.domain);
    if (context?.asset?.media_type === "audio") return "audio";
  }
  if (shape?.subject_type === "section") {
    const key = String(shape.subject_id ?? "").replace(/^stage:/, "");
    if (PRODUCTION_CANVAS_STAGE_BY_KEY.has(key)) return key;
  }
  return "references";
}

function canvasGenerationSlot(shape, context = null) {
  const explicit = String(shape?.props?.generation_slot ?? "").trim();
  if (GENERATION_SLOT_KEYS.includes(explicit)) return explicit;
  const role = String(context?.ref?.role ?? shape?.props?.role ?? "").toLowerCase();
  const stage = canvasShapeStage(shape, context);
  const domain = context?.taxonomy?.domain ?? null;
  const media = String(context?.asset?.media_type ?? "").toLowerCase();
  if (role.includes("character") || role.includes("角色") || domain === "character" || stage === "characters") return "character_reference";
  if (role.includes("scene") || role.includes("场景") || domain === "scene" || stage === "scenes") return "scene_reference";
  if (role.includes("motion") || role.includes("action") || role.includes("动作")) return "motion_reference";
  if (role.includes("style") || role.includes("风格") || domain === "reference" || domain === "prompt") return "style_reference";
  if (role.includes("audio") || role.includes("voice") || role.includes("声音") || media === "audio" || stage === "audio") return "audio";
  if (role.includes("subtitle") || role.includes("字幕")) return "subtitle";
  if (media === "video") return role.includes("reference") || role.includes("参考") ? "motion_reference" : "video_clip";
  if (media === "image") return "main_reference";
  return "main_reference";
}

function generationSlotFromShape(shape) {
  const props = shape.props ?? {};
  return {
    shape_id: shape.shape_id,
    title: shape.title ?? generationSlotTitle(props),
    stage: normalizeProductionStage(props.stage ?? "shots"),
    slot: normalizeGenerationSlotKey(props.slot ?? props.generation_slot ?? "draft_output"),
    generation_slot: normalizeGenerationSlotKey(props.generation_slot ?? props.slot ?? "draft_output"),
    generation_type: GENERATION_TYPES.has(String(props.generation_type ?? "")) ? String(props.generation_type) : "image_to_video",
    target_width: nullableInteger(props.target_width, 16, 16384, "target_width"),
    target_height: nullableInteger(props.target_height, 16, 16384, "target_height"),
    target_aspect_ratio: props.target_aspect_ratio ? normalizeAspectRatio(props.target_aspect_ratio) : null,
    duration_seconds: nullableNumber(props.duration_seconds, 1, 120, "duration_seconds"),
    replace_policy: normalizeGenerationSlotReplacePolicy(props.replace_policy),
    required_refs: normalizeGenerationSlotRequiredRefs(props.required_refs, { allowUndefined: true }),
    status: normalizeGenerationSlotStatus(props.status),
    source: props.source ?? null
  };
}

function annotationTargetForCanvasShape(shape) {
  if (!shape?.subject_type || !shape.subject_id) return null;
  if (["asset", "asset_version", "entity", "project_ref"].includes(shape.subject_type)) {
    return { target_type: shape.subject_type, target_id: shape.subject_id };
  }
  return null;
}

function writebackOffset(placement, slot, canvas, width = 320, height = 150) {
  const sameSlotOutputs = canvas.shapes.filter((shape) => isGeneratedOutputShape(shape) && shape.props?.slot_shape_id === slot.shape_id).length;
  const stride = height + 32;
  let candidate;
  if (placement === "below") candidate = { x: slot.x, y: slot.y + slot.height + 40 + sameSlotOutputs * stride };
  else if (placement === "left") candidate = { x: slot.x - width - 40, y: slot.y + sameSlotOutputs * stride };
  else if (placement === "above") candidate = { x: slot.x, y: slot.y - height - 40 - sameSlotOutputs * stride };
  else candidate = { x: slot.x + slot.width + 40, y: slot.y + sameSlotOutputs * stride };
  return findOpenCanvasPosition(candidate, width, height, canvas.shapes, {
    stepY: placement === "above" ? -stride : stride,
    ignoreShapeIds: new Set([slot.shape_id])
  });
}

function revisionCardOffset(sourceShape, canvas) {
  const sourceRevisionCards = canvas.shapes.filter((shape) => shape.props?.role === "revision_card" && shape.props?.source_shape_id === sourceShape.shape_id).length;
  return findOpenCanvasPosition(
    { x: sourceShape.x + sourceShape.width + 48, y: sourceShape.y + sourceRevisionCards * 220 },
    340,
    190,
    canvas.shapes,
    { stepY: 220, ignoreShapeIds: new Set([sourceShape.shape_id]) }
  );
}

function findOpenCanvasPosition(candidate, width, height, shapes, options = {}) {
  const stepY = Number(options.stepY ?? height + 32);
  const ignoreShapeIds = options.ignoreShapeIds instanceof Set ? options.ignoreShapeIds : new Set();
  const blockers = shapes.filter((shape) => shape.shape_type !== "section" && !ignoreShapeIds.has(shape.shape_id));
  let position = { x: Number(candidate.x), y: Number(candidate.y) };
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const collides = blockers.some((shape) => canvasRectsOverlap(
      { x: position.x, y: position.y, width, height },
      { x: shape.x, y: shape.y, width: shape.width, height: shape.height },
      16
    ));
    if (!collides) return position;
    position = { ...position, y: position.y + stepY };
  }
  return position;
}

function canvasRectsOverlap(a, b, padding = 0) {
  return a.x < b.x + b.width + padding
    && a.x + a.width + padding > b.x
    && a.y < b.y + b.height + padding
    && a.y + a.height + padding > b.y;
}

function placementForGenerationSlotPolicy(policy) {
  if (policy === "append_timeline" || policy === "new_revision") return "below";
  if (policy === "replace_slot") return "right";
  return "right";
}

function latestGeneratedOutputForSlot(canvas, slot_shape_id) {
  const outputs = canvas.shapes
    .filter((shape) => isGeneratedOutputShape(shape) && shape.props?.slot_shape_id === slot_shape_id)
    .sort((a, b) => String(a.updated_at ?? a.created_at ?? "").localeCompare(String(b.updated_at ?? b.created_at ?? "")));
  return outputs.at(-1) ?? null;
}

function isGeneratedOutputShape(shape) {
  return ["generated_output", "revision_output", "replacement_output", "timeline_output"].includes(String(shape?.props?.role ?? ""));
}

function generationWritebackSemantics(policy, priorOutput = null) {
  const previousRevision = Number(priorOutput?.props?.revision_index ?? 0);
  if (policy === "new_revision") {
    return {
      semantic: "revision",
      output_role: "revision_output",
      revision_index: previousRevision + 1,
      lineage_relation_type: priorOutput ? "revises" : null,
      lineage_label: "新修订",
      asset_relation_type: priorOutput ? "revision_of" : null
    };
  }
  if (policy === "replace_slot") {
    return {
      semantic: "replacement",
      output_role: "replacement_output",
      revision_index: previousRevision,
      lineage_relation_type: priorOutput ? "replaces" : null,
      lineage_label: "替换输出",
      asset_relation_type: priorOutput ? "replaces" : null
    };
  }
  if (policy === "append_timeline") {
    return {
      semantic: "timeline_append",
      output_role: "timeline_output",
      revision_index: previousRevision,
      lineage_relation_type: priorOutput ? "continues" : null,
      lineage_label: "追加时间线",
      asset_relation_type: priorOutput ? "continues_from" : null
    };
  }
  return {
    semantic: "insert",
    output_role: "generated_output",
    revision_index: previousRevision,
    lineage_relation_type: null,
    lineage_label: "生成输出",
    asset_relation_type: null
  };
}

function generatedAssetIdempotencyKey(input = {}) {
  const source_sha256 = hashFileSync(input.file_path);
  const parts = [
    "generated-writeback",
    input.slot_shape_id,
    input.replace_policy,
    input.semantic,
    input.explicit_shape_id ?? "",
    source_sha256
  ];
  return {
    key: createHash("sha256").update(parts.map((item) => String(item ?? "")).join("|")).digest("hex"),
    source_sha256,
    scope: "generated_asset_writeback"
  };
}

function normalizeGeneratedAssetIdempotencyKey(value, input = {}) {
  if (value === undefined || value === null) return generatedAssetIdempotencyKey(input);
  const source_sha256 = hashFileSync(input.file_path);
  if (typeof value === "string") {
    const key = value.trim();
    if (!key) throw new Error("idempotency_key must not be empty");
    return { key, source_sha256, scope: "generated_asset_writeback" };
  }
  if (typeof value === "object") {
    const key = String(value.key ?? "").trim();
    if (!key) throw new Error("idempotency_key.key is required");
    return {
      key,
      source_sha256: value.source_sha256 ?? source_sha256,
      scope: value.scope ?? "generated_asset_writeback"
    };
  }
  throw new Error("idempotency_key must be a string or object");
}

function shortId(value) {
  const text = String(value ?? "");
  return text.length > 12 ? `${text.slice(0, 8)}...${text.slice(-4)}` : text;
}

function normalizeGenerationSlotProps(input = {}, existing = {}) {
  const generation_type = GENERATION_TYPES.has(String(input.generation_type ?? existing.generation_type ?? "")) ? String(input.generation_type ?? existing.generation_type) : "image_to_video";
  const target_width = input.target_width !== undefined ? nullableInteger(input.target_width, 16, 16384, "target_width") : nullableInteger(existing.target_width, 16, 16384, "target_width");
  const target_height = input.target_height !== undefined ? nullableInteger(input.target_height, 16, 16384, "target_height") : nullableInteger(existing.target_height, 16, 16384, "target_height");
  if ((target_width && !target_height) || (!target_width && target_height)) throw new Error("target_width and target_height must be provided together");
  const target_aspect_ratio = input.target_aspect_ratio !== undefined
    ? normalizeAspectRatio(input.target_aspect_ratio)
    : (existing.target_aspect_ratio ? normalizeAspectRatio(existing.target_aspect_ratio) : aspectRatioFromDimensions(target_width, target_height));
  return {
    role: "generation_slot",
    slot: normalizeGenerationSlotKey(input.slot ?? existing.slot ?? input.generation_slot ?? existing.generation_slot ?? "draft_output"),
    generation_slot: normalizeGenerationSlotKey(input.generation_slot ?? existing.generation_slot ?? input.slot ?? existing.slot ?? "draft_output"),
    generation_type,
    target_width,
    target_height,
    target_aspect_ratio,
    duration_seconds: input.duration_seconds !== undefined ? nullableNumber(input.duration_seconds, 1, 120, "duration_seconds") : nullableNumber(existing.duration_seconds, 1, 120, "duration_seconds"),
    replace_policy: normalizeGenerationSlotReplacePolicy(input.replace_policy ?? existing.replace_policy),
    required_refs: input.required_refs !== undefined ? normalizeGenerationSlotRequiredRefs(input.required_refs) : normalizeGenerationSlotRequiredRefs(existing.required_refs, { allowUndefined: true }),
    status: normalizeGenerationSlotStatus(input.status ?? existing.status),
    text: input.text ?? existing.text ?? null
  };
}

function selectActiveGenerationSlot(slots, slot_shape_id = null) {
  if (!slots.length) return null;
  if (slot_shape_id) {
    const selected = slots.find((slot) => slot.shape_id === slot_shape_id);
    if (!selected) throw new Error(`画布中没有找到生成槽：${slot_shape_id}`);
    return selected;
  }
  return slots.find((slot) => slot.status !== "filled") ?? slots[0] ?? null;
}

function normalizeGenerationSlotKey(value) {
  const normalized = String(value ?? "draft_output").trim();
  if (!GENERATION_SLOT_KEYS.includes(normalized)) throw new Error(`生成槽类型无效：${value}`);
  return normalized;
}

function normalizeGenerationSlotRequiredRefs(value, options = {}) {
  if (value === undefined && options.allowUndefined) return [];
  if (value === null) return [];
  if (!Array.isArray(value)) throw new Error("required_refs must be an array");
  const normalized = value.map((item) => normalizeGenerationSlotKey(item));
  const invalid = normalized.filter((item) => !GENERATION_INPUT_SLOT_KEYS.has(item));
  if (invalid.length) throw new Error(`required_refs 只能包含输入槽 key：${[...new Set(invalid)].join(", ")}`);
  return [...new Set(normalized)];
}

function normalizeGenerationSlotReplacePolicy(value) {
  const normalized = String(value ?? "insert_beside").trim();
  if (!GENERATION_SLOT_REPLACE_POLICIES.has(normalized)) throw new Error(`生成槽写回策略无效：${value}`);
  return normalized;
}

function normalizeGenerationSlotStatus(value) {
  const normalized = String(value ?? "empty").trim();
  if (!GENERATION_SLOT_STATUSES.has(normalized)) throw new Error(`生成槽状态无效：${value}`);
  return normalized;
}

function normalizeRevisionCardStatus(value) {
  const normalized = String(value ?? "open").trim();
  if (!REVISION_CARD_STATUSES.has(normalized)) throw new Error(`Invalid revision card status: ${value}`);
  return normalized;
}

function normalizeProductionStage(value) {
  const normalized = String(value ?? "shots").trim();
  if (!PRODUCTION_CANVAS_STAGE_BY_KEY.has(normalized)) throw new Error(`Invalid production stage: ${value}`);
  return normalized;
}

function generationSlotTitle(slot) {
  return `${generationSlotLabel(slot.generation_slot ?? slot.slot ?? "draft_output")} · ${slot.target_width && slot.target_height ? `${slot.target_width}x${slot.target_height}` : "目标待定"}`;
}

function generationSlotLabel(slot) {
  return {
    main_reference: "主参考",
    character_reference: "角色参考",
    scene_reference: "场景参考",
    motion_reference: "动作参考",
    style_reference: "风格参考",
    video_clip: "视频片段",
    audio: "音频",
    subtitle: "字幕",
    project_config: "项目配置",
    draft_output: "生成输出"
  }[slot] ?? slot;
}

function aspectRatioFromDimensions(width, height) {
  if (!width || !height) return null;
  const divisor = gcd(width, height);
  return `${width / divisor}:${height / divisor}`;
}

function gcd(a, b) {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y) {
    const next = x % y;
    x = y;
    y = next;
  }
  return x || 1;
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

function projectOutputSpec(project) {
  const resolution = parseResolution(project.resolution);
  return {
    ...pickProjectSpec(project),
    width: resolution?.width ?? null,
    height: resolution?.height ?? null
  };
}

function generationOutputSpec(project, generationSlot = null) {
  const projectSpec = projectOutputSpec(project);
  if (!generationSlot) return projectSpec;
  const width = generationSlot.target_width ?? projectSpec.width;
  const height = generationSlot.target_height ?? projectSpec.height;
  const resolution = width && height ? `${width}x${height}` : projectSpec.resolution;
  return {
    ...projectSpec,
    aspect_ratio: generationSlot.target_aspect_ratio ?? projectSpec.aspect_ratio,
    resolution,
    width,
    height,
    duration_seconds: generationSlot.duration_seconds ?? null,
    replace_policy: generationSlot.replace_policy ?? "insert_beside",
    generation_slot_shape_id: generationSlot.shape_id ?? null,
    generation_slot_status: generationSlot.status ?? null,
    required_refs: generationSlot.required_refs ?? []
  };
}

function parseResolution(value) {
  const match = String(value ?? "").trim().toLowerCase().match(/^(\d+)x(\d+)$/);
  if (!match) return null;
  return { width: Number(match[1]), height: Number(match[2]) };
}

function generationTaskParameters(generationPackage, outputSpec) {
  const slots = generationPackage.slots;
  const primaryImage = slots.main_reference[0] ?? slots.character_reference[0] ?? slots.scene_reference[0] ?? slots.style_reference[0] ?? null;
  const character = slots.character_reference[0] ?? null;
  const scene = slots.scene_reference[0] ?? null;
  const motion = slots.motion_reference[0] ?? null;
  return {
    mode: generationPackage.generation_type,
    aspect_ratio: outputSpec.aspect_ratio,
    resolution: outputSpec.resolution,
    width: outputSpec.width,
    height: outputSpec.height,
    fps: outputSpec.fps,
    duration_seconds: outputSpec.duration_seconds ?? null,
    replace_policy: outputSpec.replace_policy ?? "insert_beside",
    generation_slot_shape_id: outputSpec.generation_slot_shape_id ?? null,
    required_refs: outputSpec.required_refs ?? [],
    target_platforms: outputSpec.target_platforms,
    primary_reference_asset_version_id: primaryImage?.asset_version_id ?? null,
    character_reference_asset_version_id: character?.asset_version_id ?? null,
    scene_reference_asset_version_id: scene?.asset_version_id ?? null,
    motion_reference_asset_version_id: motion?.asset_version_id ?? null,
    prompt_context: {
      project_title: generationPackage.project.title,
      character: character?.title ?? null,
      scene: scene?.title ?? null,
      style: slots.style_reference.map((item) => item.title),
      notes: "由视频资产画布交接包生成；下游生成器执行前需要把资产版本编号解析成本机文件路径。"
    }
  };
}

function dreaminaCliHandoff({ generation_type, outputSpec, inputs, parameters }) {
  const provider = {
    provider_id: "dreamina_cli",
    label: "即梦命令行",
    executable: DEFAULT_DREAMINA_CLI_PATH || "dreamina",
    version_source: path.join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".dreamina_cli", "version.json"),
    requires_login: true,
    login_command: [DEFAULT_DREAMINA_CLI_PATH || "dreamina", "login", "--headless"],
    credit_check_command: [DEFAULT_DREAMINA_CLI_PATH || "dreamina", "user_credit"],
    output_policy: "外部生成器会返回远程结果；需先下载并登记为工作素材，再写回制作画布"
  };
  const prompt = dreaminaPromptText(parameters);
  const ratio = normalizeDreaminaRatio(outputSpec.aspect_ratio);
  const resolutionType = dreaminaImageResolutionType(outputSpec);
  const primaryImage = firstResolvedInput(inputs, ["main_reference", "character_reference", "scene_reference", "style_reference"], "image");
  const motionVideo = firstResolvedInput(inputs, ["motion_reference", "video_clip"], "video");
  const audio = firstResolvedInput(inputs, ["audio"], "audio");
  const blockers = [];
  let command = null;

  if (["image", "cover"].includes(generation_type)) {
    command = {
      kind: "text2image",
      argv: compactArgs([provider.executable, "text2image", "--prompt", prompt, "--ratio", ratio, "--resolution_type", resolutionType, "--poll", "120"])
    };
  } else if (generation_type === "text_to_video") {
    const videoConfig = dreaminaVideoConfig({ generation_type, ratio, duration: 5, model_version: "seedance2.0fast", video_resolution: "720p", poll: 180 });
    command = {
      kind: "text2video",
      argv: dreaminaVideoArgv({ executable: provider.executable, generation_type, prompt, videoConfig })
    };
  } else if (generation_type === "multimodal_to_video") {
    const multimodal = dreaminaMultimodalInputs(inputs);
    blockers.push(...multimodal.blockers);
    if (!multimodal.blockers.length) {
      const videoConfig = dreaminaVideoConfig({ generation_type, ratio, duration: 5, model_version: "seedance2.0fast", video_resolution: "720p", poll: 180 });
      command = {
        kind: "multimodal2video",
        argv: dreaminaVideoArgv({ executable: provider.executable, generation_type, multimodal, prompt, videoConfig })
      };
    }
  } else if (generation_type === "image_to_video") {
    if (!primaryImage?.file_path) blockers.push("图生视频需要一个可解析到本机文件路径的图像输入。");
    if (primaryImage?.file_path) {
      const videoConfig = dreaminaVideoConfig({ generation_type, duration: 5, model_version: "seedance2.0fast", video_resolution: "720p", poll: 180 });
      command = {
        kind: "image2video",
        argv: dreaminaVideoArgv({ executable: provider.executable, generation_type, image: primaryImage.file_path, prompt, videoConfig })
      };
    }
  } else if (generation_type === "edit") {
    if (!primaryImage?.file_path) blockers.push("编辑生成需要一个可解析到本机文件路径的图像输入。");
    if (primaryImage?.file_path) {
      command = {
        kind: "image2image",
        argv: compactArgs([provider.executable, "image2image", "--images", primaryImage.file_path, "--prompt", prompt, "--ratio", ratio, "--model_version", "5.0", "--poll", "120"])
      };
    }
  } else if (generation_type === "export") {
    blockers.push("导出应由平台导出或本地转码链路处理，不由即梦命令行处理。");
  } else if (generation_type === "voice" || generation_type === "subtitle") {
    blockers.push(`${generationTypeText(generation_type)}应由音频或字幕链路处理，不由即梦命令行处理。`);
  }

  if (command) {
    command.shell = dreaminaShellCommand(command.argv);
    command.dry_run = true;
    command.submit_policy = "仅在余额检查通过后执行；正式生产前先做低成本小样。";
  }

  return {
    provider,
    preflight: [
      { name: "check_login_and_credits", label: "检查登录与余额", argv: provider.credit_check_command, required: true },
      { name: "login_if_needed", label: "必要时登录", argv: provider.login_command, required: true }
    ],
    command,
    postprocess: {
      register_outputs_with: "素材入库工具",
      link_outputs_to_canvas_with: "画布卡片写回工具",
      recommended_output_kind: "工作素材",
      source_metadata: {
        source_type: "dreamina_cli",
        generator: command?.kind ?? null,
        prompt,
        ratio,
        resolution_type: resolutionType,
        motion_reference_file: motionVideo?.file_path ?? null,
        audio_reference_file: audio?.file_path ?? null
      }
    },
    ready: Boolean(command && blockers.length === 0),
    blockers
  };
}

function dreaminaVideoConfig(input = {}) {
  const generation_type = input.generation_type;
  const model_version = normalizeDreaminaVideoModel(generation_type, input.model_version);
  const duration = normalizeDreaminaVideoDuration(generation_type, model_version, input.duration);
  const video_resolution = normalizeDreaminaVideoResolution(model_version, input.video_resolution);
  const ratio = ["text_to_video", "multimodal_to_video"].includes(generation_type) ? normalizeDreaminaVideoRatio(input.ratio) : null;
  const poll = clampInteger(input.poll ?? 180, 0, 600, "poll");
  const session = input.session === undefined || input.session === null || input.session === "" ? null : clampInteger(input.session, 0, 2147483647, "session");
  return { model_version, duration, video_resolution, ratio, poll, session };
}

function normalizeDreaminaVideoModel(generation_type, value) {
  const fallback = "seedance2.0fast";
  const model = String(value ?? fallback).trim();
  const allowed = ["text_to_video", "multimodal_to_video"].includes(generation_type) ? DREAMINA_TEXT2VIDEO_MODELS : DREAMINA_IMAGE2VIDEO_MODELS;
  if (!allowed.has(model)) {
    throw new Error(`${generation_type} model_version must be one of: ${[...allowed].join(", ")}`);
  }
  return model;
}

function normalizeDreaminaVideoDuration(generation_type, model_version, value) {
  const duration = clampInteger(value ?? 5, 1, 30, "duration");
  let min = 4;
  let max = 15;
  if (generation_type === "image_to_video") {
    if (["3.0", "3.0fast", "3.0pro", "3.0_fast", "3.0_pro"].includes(model_version)) {
      min = 3;
      max = 10;
    } else if (["3.5pro", "3.5_pro"].includes(model_version)) {
      min = 4;
      max = 12;
    }
  }
  if (duration < min || duration > max) throw new Error(`${generation_type} duration for ${model_version} must be ${min}-${max} seconds`);
  return duration;
}

function normalizeDreaminaVideoResolution(model_version, value) {
  const resolution = String(value ?? "720p").trim();
  if (!DREAMINA_VIDEO_RESOLUTIONS.has(resolution)) throw new Error("video_resolution must be 720p or 1080p");
  if (resolution === "1080p" && model_version !== "seedance2.0_vip") {
    throw new Error("video_resolution 1080p is only supported by model_version seedance2.0_vip");
  }
  return resolution;
}

function normalizeDreaminaVideoRatio(value) {
  const ratio = normalizeDreaminaRatio(value);
  if (!DREAMINA_VIDEO_RATIOS.has(ratio)) throw new Error(`text_to_video ratio must be one of: ${[...DREAMINA_VIDEO_RATIOS].join(", ")}`);
  return ratio;
}

function dreaminaVideoArgv({ executable, generation_type, image = null, multimodal = null, prompt, videoConfig }) {
  if (generation_type === "text_to_video") {
    return compactArgs([
      executable,
      "text2video",
      "--prompt", prompt,
      "--duration", String(videoConfig.duration),
      "--ratio", videoConfig.ratio,
      "--video_resolution", videoConfig.video_resolution,
      "--model_version", videoConfig.model_version,
      videoConfig.session === null ? null : "--session", videoConfig.session === null ? null : String(videoConfig.session),
      "--poll", String(videoConfig.poll)
    ]);
  }
  if (generation_type === "multimodal_to_video") {
    return compactArgs([
      executable,
      "multimodal2video",
      ...multimodal.images.flatMap((item) => ["--image", item.file_path]),
      ...multimodal.videos.flatMap((item) => ["--video", item.file_path]),
      ...multimodal.audios.flatMap((item) => ["--audio", item.file_path]),
      "--prompt", prompt,
      "--duration", String(videoConfig.duration),
      "--ratio", videoConfig.ratio,
      "--video_resolution", videoConfig.video_resolution,
      "--model_version", videoConfig.model_version,
      videoConfig.session === null ? null : "--session", videoConfig.session === null ? null : String(videoConfig.session),
      "--poll", String(videoConfig.poll)
    ]);
  }
  return compactArgs([
    executable,
    "image2video",
    "--image", image,
    "--prompt", prompt,
    "--duration", String(videoConfig.duration),
    "--video_resolution", videoConfig.video_resolution,
    "--model_version", videoConfig.model_version,
    videoConfig.session === null ? null : "--session", videoConfig.session === null ? null : String(videoConfig.session),
    "--poll", String(videoConfig.poll)
  ]);
}

function dreaminaVideoCommandFromHandoff({ handoff, generation_type, prompt, videoConfig }) {
  const provider = handoff.task.providers.dreamina_cli;
  const inputs = handoff.task.inputs ?? [];
  const finalPrompt = String(prompt ?? dreaminaPromptText(handoff.task.parameters)).trim();
  const blockers = [];
  if (!finalPrompt) blockers.push("即梦视频生成需要提示词。");
  const primaryImage = firstResolvedInput(inputs, ["main_reference", "character_reference", "scene_reference", "style_reference"], "image");
  let argv = null;
  if (generation_type === "image_to_video") {
    if (!primaryImage?.file_path) blockers.push("图生视频需要一个可解析到本机文件路径的图像输入。");
    if (primaryImage?.file_path) {
      argv = dreaminaVideoArgv({ executable: provider.executable, generation_type, image: primaryImage.file_path, prompt: finalPrompt, videoConfig });
    }
  } else if (generation_type === "multimodal_to_video") {
    const multimodal = dreaminaMultimodalInputs(inputs);
    blockers.push(...multimodal.blockers);
    if (!multimodal.blockers.length) {
      argv = dreaminaVideoArgv({ executable: provider.executable, generation_type, multimodal, prompt: finalPrompt, videoConfig });
    }
  } else {
    argv = dreaminaVideoArgv({ executable: provider.executable, generation_type, prompt: finalPrompt, videoConfig });
  }
  const command = argv ? {
    kind: generation_type === "text_to_video" ? "text2video" : (generation_type === "multimodal_to_video" ? "multimodal2video" : "image2video"),
    argv,
    shell: dreaminaShellCommand(argv),
    dry_run: true,
    submit_policy: "真实执行前必须明确接受积分消耗。"
  } : null;
  return { prompt: finalPrompt, command, blockers, reference_inputs: generation_type === "multimodal_to_video" ? dreaminaMultimodalInputs(inputs).summary : null };
}

function runDreaminaCli(args, { timeoutMs = 180000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(DEFAULT_DREAMINA_CLI_PATH || "dreamina", args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        error.message = `${error.message}\nstdout:\n${stdout}\nstderr:\n${stderr}`;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function parseDreaminaJson(stdout) {
  const text = String(stdout ?? "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
    throw new Error("即梦命令行输出中没有可解析的结果数据。");
  }
}

function extractDreaminaVideos(result) {
  const videos = [];
  const push = (item) => {
    if (!item) return;
    if (typeof item === "string") {
      videos.push({ url: item, width: null, height: null, duration_ms: null });
      return;
    }
    const url = item.video_url ?? item.url ?? item.download_url ?? item.play_url ?? item.result_url ?? null;
    if (url) {
      videos.push({
        url,
        width: item.width ?? null,
        height: item.height ?? null,
        duration_ms: item.duration_ms ?? item.duration ?? null,
        cover_url: item.cover_url ?? item.cover ?? null
      });
    }
  };
  const resultJson = result?.result_json ?? result?.data ?? result ?? {};
  if (Array.isArray(resultJson.videos)) resultJson.videos.forEach(push);
  if (Array.isArray(resultJson.video_list)) resultJson.video_list.forEach(push);
  if (resultJson.video) push(resultJson.video);
  return videos;
}

function resolveDoubaoAudioOutputDir(value, root = process.cwd()) {
  if (value) return path.resolve(String(value));
  const stamp = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  return path.join(root, "output", `doubao-audio-${stamp}`);
}

function resolveKieSunoOutputDir(value, root = process.cwd()) {
  if (value) return path.resolve(String(value));
  const stamp = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  return path.join(root, "output", `kie-suno-${stamp}`);
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

function resolveDreaminaOutputDir(value, root = process.cwd()) {
  if (value) return path.resolve(String(value));
  const stamp = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  return path.join(root, "output", `dreamina-cli-video-${stamp}`);
}

function dreaminaVideoDownloadName({ submit_id, index, url }) {
  const urlPath = (() => {
    try {
      return new URL(url).pathname;
    } catch {
      return "";
    }
  })();
  const ext = path.extname(urlPath).toLowerCase() || ".mp4";
  const safeSubmit = String(submit_id ?? "dreamina-video").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80) || "dreamina-video";
  return `${safeSubmit}-${index + 1}${ext}`;
}

async function downloadUrl(url, targetPath) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`download failed ${response.status} ${response.statusText}: ${url}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length) throw new Error(`downloaded file is empty: ${url}`);
  await fs.promises.writeFile(targetPath, buffer, { flag: "wx" });
}

function dreaminaCliGenerationNextActions({ parsed, downloads, registered_assets, outputDir }) {
  if (!parsed) return ["检查原始输出、错误输出和即梦命令行日志。"];
  if (parsed.gen_status === "querying") return [`保存提交编号 ${parsed.submit_id}，后续查询结果；不要重复提交。`, `下载完成结果时使用输出目录：${outputDir}。`];
  if (parsed.gen_status === "success") return [
    downloads.length ? `已下载 ${downloads.length} 个视频文件。` : "没有下载到视频地址，请检查命令结果。",
    registered_assets.length ? `已登记 ${registered_assets.length} 个工作素材。` : "下游使用前请先登记下载后的视频文件。",
    "将画布视为可交接前，请先执行画布生产就绪检查。"
  ];
  return ["生成未报告成功，请检查命令结果、错误输出和即梦日志目录。"];
}

function dreaminaCliUsageGuide() {
  const executable = DEFAULT_DREAMINA_CLI_PATH || "dreamina";
  return {
    source: {
      title: "即梦 CLI 体验指南",
      url: "https://bytedance.larkoffice.com/wiki/FVTwwm0bGiishxkKOoScdHR2nsg",
      captured_at: "2026-06-25"
    },
    install_or_update: {
      official_command: ["curl", "-fsSL", "https://jimeng.jianying.com/cli", "|", "bash"],
      windows_executable: DEFAULT_DREAMINA_CLI_PATH,
      success_check: [executable, "-h"],
      path_hint: "如果安装后找不到即梦命令，请重启终端，或按安装器提示写入环境变量。"
    },
    login: {
      interactive: [executable, "login"],
      headless: [executable, "login", "--headless"],
      headless_check: [executable, "login", "checklogin", "--device_code", "<device_code>", "--poll", "30"],
      relogin: [executable, "relogin"],
      logout: [executable, "logout"]
    },
    zero_cost_checks: [
      { name: "help", label: "帮助信息", argv: [executable, "-h"], expected: "可以看到命令帮助和子命令列表" },
      { name: "credit", label: "余额检查", argv: [executable, "user_credit"], expected: "返回用户编号、会员信息和积分余额" },
      { name: "recent_success_tasks", label: "近期成功任务", argv: [executable, "list_task", "--gen_status=success"], expected: "可以检查近期本地任务记录" }
    ],
    cost_policy: [
      "每次真实生成前先运行 user_credit 余额检查。",
      "视频或多模态生成前，先用最低成本的匹配小样验证方向。",
      "轮询时间保持有限；如果任务仍在查询中，保存提交编号后续查询。",
      "调用方未明确接受积分消耗前，不执行计划返回的真实生成命令。"
    ],
    command_examples: {
      text2image: [executable, "text2image", "--prompt", "<prompt>", "--ratio", "1:1", "--resolution_type", "2k", "--poll", "30"],
      image2image: [executable, "image2image", "--images", "<input.png>", "--prompt", "<prompt>", "--resolution_type", "2k", "--poll", "30"],
      text2video: [executable, "text2video", "--prompt", "<prompt>", "--duration", "5", "--ratio", "16:9", "--video_resolution", "720p", "--poll", "30"],
      image2video: [executable, "image2video", "--image", "<first_frame.png>", "--prompt", "<prompt>", "--duration", "5", "--poll", "30"],
      multiframe2video: [executable, "multiframe2video", "--images", "<a.png>,<b.png>", "--prompt", "<prompt>", "--duration", "3", "--poll", "30"],
      multimodal2video: [executable, "multimodal2video", "--image", "<input.png>", "--audio", "<music.mp3>", "--prompt", "<prompt>", "--model_version", "seedance2.0fast", "--duration", "5", "--poll", "30"],
      image_upscale: [executable, "image_upscale", "--image", "<input.png>", "--resolution_type", "2k"]
    },
    async_results: {
      query: [executable, "query_result", "--submit_id", "<submit_id>"],
      download: [executable, "query_result", "--submit_id", "<submit_id>", "--download_dir", "<downloads_dir>"],
      success_status: "生成状态为成功",
      waiting_status: "生成状态为查询中"
    },
    sessions: {
      default_session: "0",
      create: [executable, "session", "create", "<project-name>"],
      list: [executable, "session", "list"],
      search: [executable, "session", "search", "<keyword>"],
      rename: [executable, "session", "rename", "<session_id>", "<new-name>"],
      delete: [executable, "session", "delete", "<session_id>"],
      generate_in_session: [executable, "text2image", "--session=<session_id>", "--prompt", "<prompt>", "--ratio", "16:9", "--poll", "30"]
    },
    local_files: {
      logs: path.join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".dreamina_cli", "logs"),
      tasks_db: path.join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".dreamina_cli", "tasks.db"),
      version_json: path.join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".dreamina_cli", "version.json")
    },
    download_and_register: [
      "当命令返回查询中时，保留提交编号并稍后查询结果。",
      "将远程结果文件下载到输出目录或暂存目录。",
      "把下载文件按工作素材通过 video_asset_ingest 登记入库。",
      "用提交编号、提示词和模型信息更新来源证据。",
      "生成资产写回制作画布前，先完成分类标注。"
    ],
    canvas_writeback: [
      "为生成的工作素材添加项目引用。",
      "通过 video_canvas_upsert_shape 把结果放入草稿输出或审片交付分区。",
      "将生成输出与来源参考卡片建立画布连线。",
      "写回后重新执行画布生产就绪检查，并重建生成准备包与交接包。"
    ],
    troubleshooting: [
      { symptom: "找不到即梦命令", action: "重启终端，或按安装器提示写入环境变量。" },
      { symptom: "登录未完成", action: "使用无头登录，把验证地址和用户码交给人工确认，再用设备码检查登录状态。" },
      { symptom: "未登录或无权限", action: "先检查余额，必要时重新登录，并确认账号等级和积分后再重试。" },
      { symptom: "任务长期查询中", action: "使用保存的提交编号查询结果，避免重复提交。" },
      { symptom: "故障原因不清", action: "收集完整命令、错误文本和即梦日志目录下的相关文件。" }
    ]
  };
}

function dreaminaCliNextActions({ handoff, preflight, command }) {
  if (handoff.status !== "ready" || !command) {
    return [
      "执行命令前先修复画布生成门或即梦阻断项。",
      "修复输入后，重新生成准备包并重建即梦命令计划。"
    ];
  }
  return [
    `先执行 user_credit 零成本预检：${dreaminaShellCommand(preflight[0].argv)}。`,
    `复核积分消耗和提示词，确认接受后再执行：${command.shell}。`,
    "如果任务返回查询中，保存提交编号，稍后查询并下载。",
    "下载结果后按工作素材入库，补来源信息、完成分类，并写回制作画布。"
  ];
}

function dreaminaPromptText(parameters) {
  const context = parameters.prompt_context ?? {};
  const parts = [
    context.project_title ? `Project: ${context.project_title}` : null,
    context.character ? `Character: ${context.character}` : null,
    context.scene ? `Scene: ${context.scene}` : null,
    Array.isArray(context.style) && context.style.length ? `Style references: ${context.style.join(", ")}` : null,
    "Generate a clean production test output from the bound canvas references."
  ].filter(Boolean);
  return parts.join("\n");
}

function dreaminaMultimodalInputs(inputs) {
  const usable = inputs.filter((item) => item.file_path);
  const images = usable.filter((item) => mediaKindFromVersionLike(item) === "image").slice(0, 9);
  const videos = usable.filter((item) => mediaKindFromVersionLike(item) === "video").slice(0, 3);
  const audios = usable.filter((item) => mediaKindFromVersionLike(item) === "audio").slice(0, 3);
  const blockers = [];
  if (!images.length && !videos.length) blockers.push("multimodal_to_video requires at least one image or video input with a resolvable local file_path");
  if (usable.filter((item) => mediaKindFromVersionLike(item) === "image").length > 9) blockers.push("multimodal_to_video supports at most 9 image inputs");
  if (usable.filter((item) => mediaKindFromVersionLike(item) === "video").length > 3) blockers.push("multimodal_to_video supports at most 3 video inputs");
  if (usable.filter((item) => mediaKindFromVersionLike(item) === "audio").length > 3) blockers.push("multimodal_to_video supports at most 3 audio inputs");
  for (const audio of audios) {
    if (Number.isFinite(audio.duration_ms) && (audio.duration_ms < 2000 || audio.duration_ms > 15000)) {
      blockers.push(`multimodal_to_video audio input must be 2-15 seconds: ${audio.title ?? audio.asset_version_id}`);
    }
  }
  const summarize = (item) => ({
    slot: item.slot,
    title: item.title,
    reference_id: item.reference_id,
    asset_id: item.asset_id,
    asset_version_id: item.asset_version_id,
    file_path: item.file_path
  });
  return {
    images,
    videos,
    audios,
    blockers,
    summary: {
      images: images.map(summarize),
      videos: videos.map(summarize),
      audios: audios.map(summarize)
    }
  };
}

function firstResolvedInput(inputs, slots, mediaKind = null) {
  return inputs.find((item) => slots.includes(item.slot) && item.file_path && (!mediaKind || mediaKindFromVersionLike(item) === mediaKind)) ?? null;
}

function mediaKindFromVersionLike(item) {
  const mime = String(item.mime_type ?? "").toLowerCase();
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  const name = String(item.file_name ?? item.file_path ?? "").toLowerCase();
  if (/\.(png|jpe?g|webp|gif|tiff?|bmp)$/.test(name)) return "image";
  if (/\.(mp4|mov|webm|mkv|avi|m4v)$/.test(name)) return "video";
  if (/\.(wav|mp3|aac|m4a|flac|ogg|opus)$/.test(name)) return "audio";
  return "other";
}

function normalizeDreaminaRatio(aspectRatio) {
  const ratio = String(aspectRatio ?? "16:9").trim();
  return ["21:9", "16:9", "3:2", "4:3", "1:1", "3:4", "2:3", "9:16"].includes(ratio) ? ratio : "16:9";
}

function dreaminaImageResolutionType(outputSpec) {
  const maxSide = Math.max(Number(outputSpec.width ?? 0), Number(outputSpec.height ?? 0));
  if (maxSide >= 3000) return "4k";
  if (maxSide >= 1600) return "2k";
  return "1k";
}

function compactArgs(args) {
  return args.filter((value) => value !== null && value !== undefined && value !== "");
}

function dreaminaShellCommand(argv) {
  return argv.map((arg) => {
    const text = String(arg);
    if (/^[A-Za-z0-9_./:=@-]+$/.test(text)) return text;
    return `"${text.replaceAll('"', '\\"')}"`;
  }).join(" ");
}

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

function runSqlScript(db, sql) {
  for (const statement of sql.split(";")) {
    const trimmed = statement.trim();
    if (trimmed) db.prepare(trimmed).run();
  }
}

function jsonOrNull(value) {
  return value === undefined ? null : JSON.stringify(value);
}

function assetFromRow(row) {
  return { ...row, tags: JSON.parse(row.tags_json || "[]") };
}

function projectFromRow(row) {
  return { ...row, target_platforms: JSON.parse(row.target_platforms_json || "[]") };
}

function versionFromRow(row) {
  return { ...row, source_version_ids: JSON.parse(row.source_version_ids_json || "[]") };
}

function entityFromRow(row) {
  return { ...row, aliases: JSON.parse(row.aliases_json || "[]") };
}

function linkFromRow(row) {
  return { ...row, aliases: JSON.parse(row.aliases_json || "[]") };
}

function annotationFromRow(row) {
  return { ...row, structured: row.structured_json ? JSON.parse(row.structured_json) : null };
}

function summarizeAnnotations(details = [], requiredType = null) {
  let required_count = 0;
  const by_type = {};
  for (const annotation of details) {
    by_type[annotation.annotation_type] = (by_type[annotation.annotation_type] ?? 0) + 1;
    if (requiredType && annotation.annotation_type === requiredType) required_count += 1;
  }
  return {
    active_count: details.length,
    required_annotation_type: requiredType,
    required_count,
    by_type,
    details
  };
}

function derivedFileFromRow(row) {
  return { ...row, metadata: JSON.parse(row.metadata_json || "{}") };
}

function canvasFromRow(row) {
  return {
    canvas_id: row.canvas_id,
    project_id: row.project_id,
    title: row.title,
    status: row.status,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function canvasShapeFromRow(row) {
  return {
    ...row,
    x: Number(row.x),
    y: Number(row.y),
    width: Number(row.width),
    height: Number(row.height),
    rotation: Number(row.rotation ?? 0),
    z_index: Number(row.z_index ?? 0),
    props: JSON.parse(row.props_json || "{}")
  };
}

function canvasEdgeFromRow(row) {
  return { ...row, props: JSON.parse(row.props_json || "{}") };
}

function commitFromRow(row) {
  return { ...row, changes: JSON.parse(row.changes_json || "{}") };
}

function mediaKindFromVersion(version) {
  const mime = String(version.mime_type ?? "").toLowerCase();
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  const ext = String(version.extension ?? "").toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".webp", ".gif", ".tif", ".tiff", ".bmp"].includes(ext)) return "image";
  if ([".mp4", ".mov", ".webm", ".mkv", ".avi", ".m4v"].includes(ext)) return "video";
  if ([".wav", ".mp3", ".aac", ".m4a", ".flac", ".ogg", ".opus"].includes(ext)) return "audio";
  return "other";
}

function buildSafeDerivedCopyPlan(root, source, version, derivative_type, input = {}) {
  const sourceKind = mediaKindFromVersion(version);
  if (derivative_type === "thumbnail") {
    if (sourceKind !== "image") throw new Error(`safe thumbnail generation requires an image source, got ${sourceKind}`);
    const width = clampInteger(input.width ?? 512, 64, 4096, "width");
    const extension = source.extension || path.extname(source.file_name) || ".png";
    const outputPath = path.join(root, "cache", "thumbnails", `${safeToken(source.asset_version_id)}-${id("thumb")}${extension}`);
    return {
      derivative_type,
      profile: `safe-copy-w${width}`,
      outputPath,
      parameters: { width, mode: "safe-copy", source_kind: sourceKind }
    };
  }

  if (derivative_type === "proxy" || derivative_type === "transcode" || derivative_type === "audio_proxy") {
    if (derivative_type === "audio_proxy" && sourceKind !== "audio") throw new Error(`audio_proxy generation requires an audio source, got ${sourceKind}`);
    if (derivative_type !== "audio_proxy" && sourceKind !== "video") throw new Error(`${derivative_type} generation requires a video source, got ${sourceKind}`);
    const width = makeEven(clampInteger(input.width ?? 1280, 64, 4096, "width"));
    const extension = source.extension || path.extname(source.file_name) || ".mp4";
    const outputPath = path.join(root, "cache", "proxies", `${safeToken(source.asset_version_id)}-${id("proxy")}${extension}`);
    return {
      derivative_type,
      profile: `safe-copy-w${width}`,
      outputPath,
      parameters: { width, mode: "safe-copy", source_kind: sourceKind }
    };
  }

  throw new Error(`safe automatic generation is not supported for derivative_type: ${derivative_type}`);
}

function clampInteger(value, min, max, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return number;
}

function nullableInteger(value, min, max, name) {
  if (value === undefined || value === null || value === "") return null;
  return clampInteger(value, min, max, name);
}

function nullableNumber(value, min, max, name) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) throw new Error(`${name} must be a number between ${min} and ${max}`);
  return number;
}

function makeEven(value) {
  return value % 2 === 0 ? value : value - 1;
}

function safeToken(value) {
  return String(value).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 96) || "asset-version";
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

function pushContinuityIssue(issues, level, code, ref, message) {
  issues.push(makeContinuityIssue(level, code, ref, message));
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

function filterWaivedIssues(issues, annotations) {
  const active = [];
  const waived = [];
  for (const issue of issues) {
    if (isIssueWaived(issue, annotations)) waived.push({ ...issue, waived: true });
    else active.push(issue);
  }
  return { active, waived };
}

function isIssueWaived(issue, annotations) {
  return waiverCodesFromAnnotations(annotations).has(issue.code);
}

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

function generationGateWaiver(input, code) {
  const annotations = input.annotation_summary?.details ?? [];
  const matching = annotations.filter((annotation) => waiverCodesFromAnnotations([annotation]).has(code));
  if (!matching.length) return null;
  return {
    code,
    title: input.title ?? null,
    reference_id: input.reference_id ?? null,
    asset_id: input.asset_id ?? null,
    asset_version_id: input.asset_version_id ?? null,
    annotation_ids: matching.map((annotation) => annotation.annotation_id)
  };
}

function requiredAnnotationForDomain(domain) {
  return {
    character: "character_profile",
    scene: "scene_concept",
    costume: "costume_spec",
    prop: "prop_function"
  }[domain] ?? null;
}

function normalizeViewport(value = {}) {
  return {
    x: finiteNumber(value.x ?? 0, "viewport.x"),
    y: finiteNumber(value.y ?? 0, "viewport.y"),
    zoom: positiveNumber(value.zoom ?? 1, "viewport.zoom"),
    width: positiveNumber(value.width ?? 1200, "viewport.width"),
    height: positiveNumber(value.height ?? 800, "viewport.height")
  };
}

function normalizeCanvasDocumentMode(value) {
  const mode = String(value ?? "merge").trim();
  if (!new Set(["merge", "replace"]).has(mode)) throw new Error(`Invalid document_mode: ${value}`);
  return mode;
}

function mergeJsonObjects(base, patch) {
  const safeBase = isMergeableJsonObject(base) ? base : {};
  const safePatch = isMergeableJsonObject(patch) ? patch : {};
  const result = { ...safeBase };
  for (const [key, value] of Object.entries(safePatch)) {
    if (["__proto__", "prototype", "constructor"].includes(key)) continue;
    result[key] = isMergeableJsonObject(value) && isMergeableJsonObject(result[key])
      ? mergeJsonObjects(result[key], value)
      : value;
  }
  return result;
}

function isMergeableJsonObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

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

function boundedRequiredString(value, name, maxLength) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new Error(`${name} must not be empty`);
  if (normalized.length > maxLength) throw new Error(`${name} must not exceed ${maxLength} characters`);
  return normalized;
}

function boundedNullableString(value, name, maxLength) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  if (normalized.length > maxLength) throw new Error(`${name} must not exceed ${maxLength} characters`);
  return normalized || null;
}

function nullableTrimmedString(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function stringOrNull(value) {
  return typeof value === "string" && value.trim() ? value : null;
}

function normalizeWidgetStateSource(value) {
  const normalized = String(value ?? "widget").trim();
  return normalized || "widget";
}

function normalizeWidgetDisplayMode(value) {
  const normalized = String(value ?? "fullscreen").trim();
  return WIDGET_DISPLAY_MODES.has(normalized) ? normalized : "fullscreen";
}

function finiteNumber(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${name} must be a finite number`);
  return number;
}

function positiveNumber(value, name) {
  const number = finiteNumber(value, name);
  if (number <= 0) throw new Error(`${name} must be greater than 0`);
  return number;
}

function subjectTypeForShape(shape_type) {
  return {
    project_card: "project",
    asset_card: "asset",
    entity_card: "entity",
    reference_card: "project_ref",
    section: "section",
    note: "note"
  }[shape_type] ?? "note";
}

function shapeIntersectsViewport(shape, viewport) {
  const minX = viewport.x;
  const minY = viewport.y;
  const maxX = viewport.x + viewport.width / viewport.zoom;
  const maxY = viewport.y + viewport.height / viewport.zoom;
  return shape.x + shape.width >= minX && shape.x <= maxX && shape.y + shape.height >= minY && shape.y <= maxY;
}

function summarizeShapesBySubject(shapes) {
  const counts = new Map();
  for (const shape of shapes) counts.set(shape.subject_type, (counts.get(shape.subject_type) ?? 0) + 1);
  return [...counts.entries()].map(([subject_type, count]) => ({ subject_type, count }));
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

function hashFileSync(filePath) {
  const hash = createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function normalizeRelativePath(value) {
  return String(value ?? "").replaceAll("\\", "/").replace(/^\/+/, "");
}

function isInsidePath(parent, child) {
  const parentPath = path.resolve(parent);
  const childPath = path.resolve(child);
  const relative = path.relative(parentPath, childPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function objectIdFromObjectPath(root, absolutePath) {
  const objectRoot = path.resolve(root, "asset-repo", "objects", "sha256");
  const resolved = path.resolve(absolutePath);
  if (!isInsidePath(objectRoot, resolved)) return null;
  const basename = path.basename(resolved);
  if (!/^[a-f0-9]{64}\.blob$/.test(basename)) return null;
  return `sha256:${basename.slice(0, 64)}`;
}
