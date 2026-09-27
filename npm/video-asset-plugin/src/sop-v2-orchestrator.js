/**
 * REN-11 SOP-v2 orchestrator.
 *
 * One run walks a fixed stage chain and persists, per stage, the artifacts it produced (path +
 * sha256 + bytes) and the hash of the inputs it consumed. Resumption is by *evidence*, not by
 * trust: a stage is skipped only when its recorded artifacts still hash the same on disk AND the
 * inputs it would consume today hash the same as when it ran. Anything else re-runs.
 *
 * Three modes are kept strictly apart and are never inferred from each other:
 *   dry_run       - plans only; produces no media and is never allowed to claim a rendered result
 *   real_local    - everything renders locally with FFmpeg; no provider is contacted
 *   paid_provider - requires an explicit budget authorisation in the brief; contacts the queue
 *
 * The orchestrator does not own long-term task state (that is the work-management layer's job); it
 * owns only its own run directory.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  REN11_FIXTURE_SPEC,
  burnSubtitles,
  decodeCheck,
  dominantToneAt,
  ensureScratchFont,
  extractSubtitleStream,
  ffprobeJson,
  fileFact,
  outputSpecFromBrief,
  parseSrt,
  probeSummary,
  renderSrt,
  ren11CuePlan,
  runFfmpeg,
  sha256File
} from "./sop-v2-media.js";
import { buildLocalFixturePackage, FIXTURE_STATUS } from "./sop-v2-fixture.js";
// REN-11 fix round: a paid run must reach the real post chain with provider media, not with fixture
// media wearing a provider label.
import { buildProviderProgramme } from "./sop-v2-provider-pipeline.js";
// The trusted caller context is a Symbol-carrying seam, not a plain field: a paid run has to be
// attributed by construction, so the orchestrator applies it with the same helper the plugin uses.
import { withTrustedContext } from "./provider-gateway.js";
import { qcLocalRender, qcVerdictLine } from "./sop-v2-qc.js";

export const SOP_V2_STAGES = Object.freeze([
  "brief_spec",
  "storyboard_refs",
  "canvas_gate",
  "generation",
  "artifact_import",
  "audio",
  "subtitle",
  "edit",
  "qc",
  "export",
  "delivery"
]);

export const SOP_V2_MODES = Object.freeze({
  DRY_RUN: "dry_run",
  REAL_LOCAL: "real_local",
  PAID_PROVIDER: "paid_provider"
});

export const SOP_V2_LABELS = Object.freeze({
  /** Rendered locally, verified, but explicitly not a generated-model sample and not a final cut. */
  ENGINEERING_TEST_PREVIEW: "engineering_test_preview",
  /** Built from real provider output, verified locally; still not a publication release. */
  PROVIDER_GENERATED_PREVIEW: "provider_generated_preview",
  /** Blocked before a deliverable label could be granted (or revoked after one was). */
  WITHHELD: "withheld"
});

const PROVIDER_SOURCES = Object.freeze({
  LOCAL_FIXTURE: "local_fixture",
  PROVIDER_JOB: "provider_job"
});

const GATE_CODES = Object.freeze({
  QC_FAILED: "SOP_V2_QC_FAILED",
  MODE_MISMATCH: "SOP_V2_MODE_MISMATCH",
  BUDGET_NOT_AUTHORIZED: "SOP_V2_PROVIDER_BUDGET_NOT_AUTHORIZED",
  BUDGET_LIMIT_MISSING: "SOP_V2_PROVIDER_BUDGET_LIMIT_MISSING",
  BUDGET_EXCEEDED: "SOP_V2_PROVIDER_BUDGET_EXCEEDED",
  PROVIDER_ADAPTER_MISSING: "SOP_V2_PROVIDER_ADAPTER_MISSING",
  JOB_NOT_COMPLETED: "SOP_V2_PROVIDER_JOB_NOT_COMPLETED",
  TRUSTED_CONTEXT_REQUIRED: "SOP_V2_TRUSTED_CONTEXT_REQUIRED",
  ARTIFACT_MISMATCH: "SOP_V2_ARTIFACT_MISMATCH",
  NEGATIVE_CONTROL_MISSING: "SOP_V2_NEGATIVE_CONTROL_MISSING",
  AUDIO_MISSING: "SOP_V2_AUDIO_STREAM_MISSING"
});

/**
 * The strongest available cost evidence for one job.
 *
 * A `user_credit` delta measured around the generate call beats a credit number that merely appeared in
 * a response, and both beat nothing at all. The estimate never participates: if neither source measured
 * anything, the answer is `unmeasured`, so a later report cannot read the estimate as a measurement.
 */
export function bestCreditEvidence(result = null) {
  const candidates = [result?.poll?.credits, result?.submit?.credits].filter((item) => item && typeof item === "object");
  return candidates.find((item) => item.measured === true && item.evidence === "credit_delta")
    ?? candidates.find((item) => item.measured === true)
    ?? { value: null, measured: false, evidence: "unmeasured", basis: "no provider credit evidence for this job" };
}

export function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

export function hashOf(value) {
  return createHash("sha256").update(typeof value === "string" ? value : stableJson(value)).digest("hex");
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
}

export function defaultBrief() {
  return {
    title: "REN-11 本地三镜头验收包",
    project_slug: "video-platform-renewal-20260920",
    objective: "用本地原创程序化夹具跑通 brief→分镜→画布→生成/导入→音频/字幕/剪辑→QC→导出→入库交付 的零成本生产链。",
    platform_targets: ["internal_engineering_review"],
    aspect_ratio: "16:9",
    resolution: "1280x720",
    fps: 30,
    duration_seconds: 15,
    shots: [
      { key: "shot-1", seconds: 5, intent: "冷色开场：横向移动的强调块，建立节奏基准。", cue_text: "镜头一：冷色开场，横向建立节奏。" },
      { key: "shot-2", seconds: 5, intent: "中段转绿：纵向移动，提示中段加速。", cue_text: "镜头二：中段转绿，纵向加速。" },
      { key: "shot-3", seconds: 5, intent: "暖色收束：斜向移动，作为收尾与识别点。", cue_text: "镜头三：暖色收束，斜向收尾。" }
    ],
    subtitle: { language: "zh-CN", per_shot_cue: true, burn_in_variant: true },
    audio: { kind: "synthetic_tones", tones_hz: [440, 660, 880] },
    generation_source: PROVIDER_SOURCES.LOCAL_FIXTURE,
    rights: {
      basis: "original_synthetic_fixture",
      note: "全部画面/声音由本机 FFmpeg lavfi 合成源生成，不含第三方素材；用于内部工程验收。"
    }
  };
}

export class SopV2Run {
  /**
   * @param {object} options
   * @param {string} options.runRoot        directory holding state.json + stage outputs
   * @param {object} options.service        an already-initialised VideoAssetService (isolated repo)
   * @param {object} options.brief          brief/spec input
   * @param {string} [options.mode]         one of SOP_V2_MODES
   * @param {object} [options.hooks]        { onStageStart, onArtifactsWritten, onStageCompleted, onCheckpoint }
   */
  constructor({ runRoot, service, brief = defaultBrief(), mode = SOP_V2_MODES.REAL_LOCAL, workRoot = null, outputRoot = null, logger = console, ffmpegPath = null, ffprobePath = null, hooks = {}, providerAdapter = null, trustedContext = null, qcOverrideFile = null } = {}) {
    if (!runRoot) throw new Error("runRoot is required");
    if (!service) throw new Error("service is required");
    if (!Object.values(SOP_V2_MODES).includes(mode)) throw new Error(`unknown mode: ${mode}`);
    this.runRoot = runRoot;
    this.service = service;
    this.brief = brief;
    this.mode = mode;
    this.logger = logger;
    this.ffmpegPath = ffmpegPath;
    this.ffprobePath = ffprobePath;
    this.hooks = hooks;
    // The orchestrator reaches the paid chain through the *service's* adapter by default: in a real
    // deployment `index.js` wires the Dreamina adapter onto the service, so requiring a second copy of
    // the same object here would be one more place for the two to disagree.
    // The orchestrator reaches the paid chain through the *service's* adapter by default: in a real
    // deployment `index.js` wires the Dreamina adapter onto the service, so requiring a second copy of
    // the same object here would be one more place for the two to disagree.
    this.providerAdapter = providerAdapter ?? service?.generationJobAdapter ?? service?.generationJobs?.adapter ?? null;
    // Who this run acts as. Required for a paid run: the queue refuses an unattributed job and the
    // gateway binds every provider call to this identity.
    this.trustedContext = trustedContext ?? brief?.provider_budget?.trusted_context ?? null;
    // The QC negative control points the QC stage at a deliberately defective render, so the whole
    // downstream chain has to refuse the deliverable label. It is an input, never a pass-through flag.
    this.qcOverrideFile = qcOverrideFile;
    this.workRoot = workRoot ?? path.join(runRoot, "work");
    this.outputRoot = outputRoot ?? path.join(runRoot, "output");
    this.mediaRoot = path.join(this.outputRoot, "media");
    // REN-11 fix round: the spec this run is judged against is the run's OWN spec, derived from its
    // brief. `REN11_FIXTURE_SPEC` (3 shots x 5s = 15s) is the local fixture's shape and stays the codec
    // profile base; using its duration as the yardstick for a paid 4s brief failed the real delivery.
    this.runSpec = outputSpecFromBrief(brief);
    this.statePath = path.join(runRoot, "state.json");
    this.journalPath = path.join(runRoot, "journal.ndjson");
    fs.mkdirSync(this.workRoot, { recursive: true });
    fs.mkdirSync(this.mediaRoot, { recursive: true });
    this.state = readJson(this.statePath) ?? {
      schema: "ren11.sop-v2.state.v1",
      run_id: path.basename(runRoot),
      mode,
      created_at: new Date().toISOString(),
      stages: {},
      label: SOP_V2_LABELS.WITHHELD,
      deliverable: null,
      // Revoked deliveries are *moved* here, never deleted: the files stay on disk and the record of
      // what was once qualified (and why it stopped being qualified) stays readable.
      deliverable_history: []
    };
    this.state.deliverable_history = Array.isArray(this.state.deliverable_history) ? this.state.deliverable_history : [];
    // The mode is part of the run's identity: opening the same run root with a different mode is a
    // configuration error, not a silent switch (a dry-run must never be resumed "as" a real run).
    if (this.state.mode !== mode) {
      throw new Error(`${GATE_CODES.MODE_MISMATCH}: run ${this.state.run_id} was created as mode=${this.state.mode}, opened as mode=${mode}`);
    }
  }

  journal(entry) {
    fs.appendFileSync(this.journalPath, `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...entry })}\n`, "utf8");
  }

  saveState() {
    this.state.updated_at = new Date().toISOString();
    writeJsonAtomic(this.statePath, this.state);
  }

  stageInputsHash(stage) {
    const inputs = { stage, mode: this.mode, brief: this.brief, media_spec: REN11_FIXTURE_SPEC, output_spec: this.runSpec };
    for (const dependency of SOP_V2_STAGES.slice(0, SOP_V2_STAGES.indexOf(stage))) {
      const record = this.state.stages[dependency];
      // Only the upstream *content* artifacts enter the hash (`stable`): a stage's own JSON report
      // carries timestamps and self-referential hashes, so hashing it would make every re-run look
      // like an input change and cascade through the whole chain. What a downstream stage actually
      // consumes is the media plus the upstream summary.
      inputs[dependency] = record?.status === "completed"
        ? {
          status: "completed",
          summary: record.summary ?? null,
          artifacts: (record.artifacts ?? []).filter((a) => a.stable === true).map((a) => ({ name: a.name, sha256: a.sha256 }))
        }
        : { status: record?.status ?? "pending" };
    }
    return hashOf(inputs);
  }

  async artifactRecord(name, file, extra = {}) {
    if (!fs.existsSync(file)) throw new Error(`artifact ${name} was not produced: ${file}`);
    return { name, path: file, sha256: await sha256File(file), ...fileFact(file), ...extra };
  }

  verifyArtifacts(record) {
    const artifacts = record?.artifacts ?? [];
    if (artifacts.length === 0) return { ok: false, reason: "no artifacts recorded" };
    for (const artifact of artifacts) {
      if (!fs.existsSync(artifact.path)) return { ok: false, reason: `missing ${artifact.path}` };
      const actualBytes = fs.statSync(artifact.path).size;
      if (actualBytes !== artifact.bytes) return { ok: false, reason: `size drift on ${artifact.path}` };
    }
    return { ok: true };
  }

  async verifyArtifactHashes(record) {
    for (const artifact of record?.artifacts ?? []) {
      if (!fs.existsSync(artifact.path)) return { ok: false, reason: `missing ${artifact.path}` };
      const actual = await sha256File(artifact.path);
      if (actual !== artifact.sha256) return { ok: false, reason: `hash drift on ${artifact.path}` };
    }
    return { ok: true };
  }

  factsFile(stage) {
    return path.join(this.runRoot, "facts", `${stage}.json`);
  }

  /**
   * Drop the current delivery qualification.
   *
   * A delivery label is a statement about the run *as it stands now*. Once a stage is re-opened (its
   * artifact drifted) or fails, the previously delivered file no longer describes what this run
   * produces - so the label and the deliverable pointer have to be withdrawn, not left standing as a
   * stale claim. The file itself is untouched and its record moves to `deliverable_history`.
   */
  revokeDeliverable({ stage, reason, code = null }) {
    const had = this.state.deliverable;
    const hadLabel = this.state.label;
    const stale = (this.state.stages ?? {});
    if (had || hadLabel !== SOP_V2_LABELS.WITHHELD) {
      this.state.deliverable_history.push({
        ...(had ?? {}),
        prior_label: hadLabel,
        revoked_at: new Date().toISOString(),
        revoked_by_stage: stage,
        reason,
        code
      });
    }
    this.state.deliverable = null;
    this.state.label = SOP_V2_LABELS.WITHHELD;
    this.saveState();
    this.journal({ event: "deliverable_revoked", stage, reason, code, prior_label: hadLabel, prior_deliverable: had ?? null });
    this.logger.log?.(`[sop-v2] deliverable revoked by ${stage}: ${reason}`);
    return { revoked: Boolean(had) || hadLabel !== SOP_V2_LABELS.WITHHELD, stale };
  }

  setStage(stage, patch) {
    this.state.stages[stage] = { ...(this.state.stages[stage] ?? {}), ...patch };
    this.saveState();
  }

  /** Execute the chain. `stages` restricts (and still verifies) which stages run. */
  async run({ stages = null, force = false } = {}) {
    const plan = stages ?? [...SOP_V2_STAGES];
    const executed = [];
    const skipped = [];
    for (const stage of plan) {
      if (!SOP_V2_STAGES.includes(stage)) throw new Error(`unknown stage: ${stage}`);
      const inputsHash = this.stageInputsHash(stage);
      const existing = this.state.stages[stage];
      // The delivery stage is special: its output is a *claim*, and a claim that was withdrawn cannot be
      // re-established by pointing at the old artifacts. Skipping it here is what left a run with its label
      // revoked and nothing re-granted - the files were intact, but the run no longer stood behind them.
      const withdrewClaim = stage === "delivery"
        && (this.state.deliverable === null || this.state.label === SOP_V2_LABELS.WITHHELD);
      if (!force && !withdrewClaim && existing?.status === "completed" && existing.inputs_hash === inputsHash) {
        const check = await this.verifyArtifactHashes(existing);
        if (check.ok) {
          skipped.push({ stage, reason: "artifacts verified" });
          this.logger.log?.(`[sop-v2] skip ${stage} (artifacts verified)`);
          continue;
        }
        this.journal({ event: "stage_reopened", stage, reason: check.reason });
        this.logger.log?.(`[sop-v2] re-open ${stage}: ${check.reason}`);
        // Re-opening invalidates the delivery statement this run had already made.
        this.revokeDeliverable({ stage, reason: `artifact verification failed on re-open: ${check.reason}` });
      }
      this.hooks.onStageStart?.({ stage, run: this });
      this.journal({ event: "stage_start", stage, inputs_hash: inputsHash, ...(withdrewClaim ? { reason: "previous delivery claim was withdrawn; re-granting requires this stage to run" } : {}) });
      this.setStage(stage, { status: "running", inputs_hash: inputsHash, started_at: new Date().toISOString(), attempts: (existing?.attempts ?? 0) + 1 });
      try {
        const result = await this.stageImplementations()[stage].call(this);
        const artifacts = [];
        for (const artifact of result.artifacts ?? []) {
          artifacts.push(await this.artifactRecord(artifact.name, artifact.path, artifact.extra ?? {}));
        }
        if (result.facts) writeJsonAtomic(this.factsFile(stage), result.facts);
        // The window between "side effects + artifacts exist" and "state records completion" is
        // exactly where the crash-resume fixture kills the process; resume must re-run from here.
        this.hooks.onArtifactsWritten?.({ stage, run: this, artifacts });
        this.setStage(stage, {
          status: "completed",
          finished_at: new Date().toISOString(),
          artifacts,
          facts_file: result.facts ? this.factsFile(stage) : null,
          summary: result.summary ?? null,
          error: null
        });
        this.journal({ event: "stage_completed", stage, artifacts: artifacts.map((a) => ({ name: a.name, sha256: a.sha256 })) });
        this.hooks.onStageCompleted?.({ stage, run: this });
        executed.push(stage);
      } catch (error) {
        this.setStage(stage, { status: "failed", error: { message: error.message, code: error.code ?? null }, failed_at: new Date().toISOString() });
        this.journal({ event: "stage_failed", stage, message: error.message, code: error.code ?? null });
        // A failed stage means this run currently produces no deliverable, even if an earlier pass
        // did deliver one (the QC-failure control depends on exactly this).
        this.revokeDeliverable({ stage, reason: `stage failed: ${error.message}`, code: error.code ?? null });
        error.stage = stage;
        throw error;
      }
    }
    return { executed, skipped, state: this.state, state_path: this.statePath };
  }

  async resume(options = {}) {
    return this.run(options);
  }

  stageImplementations() {
    return {
      brief_spec: async () => {
        const spec = {
          schema: "ren11.sop-v2.spec.v1",
          run_id: this.state.run_id,
          mode: this.mode,
          title: this.brief.title,
          project_slug: this.brief.project_slug,
          objective: this.brief.objective,
          target_platforms: this.brief.platform_targets,
          aspect_ratio: this.brief.aspect_ratio,
          resolution: this.brief.resolution,
          fps: this.brief.fps,
          duration_seconds: this.brief.duration_seconds,
          shot_count: this.brief.shots.length,
          shots: this.brief.shots,
          subtitle: this.brief.subtitle,
          audio: this.brief.audio,
          generation_source: this.brief.generation_source,
          rights_basis: this.brief.rights,
          media_spec: REN11_FIXTURE_SPEC,
          output_spec: this.runSpec,
          brief_hash: hashOf(this.brief)
        };
        const file = path.join(this.runRoot, "stages", "brief_spec", "spec.json");
        writeJsonAtomic(file, spec);
        return { artifacts: [{ name: "spec.json", path: file }], facts: spec, summary: { title: spec.title, mode: this.mode } };
      },

      storyboard_refs: async () => {
        const storyboard = {
          schema: "ren11.sop-v2.storyboard.v1",
          run_id: this.state.run_id,
          shots: this.brief.shots.map((shot, index) => ({
            index: index + 1,
            key: shot.key,
            seconds: shot.seconds,
            intent: shot.intent,
            in_point: index * shot.seconds,
            out_point: (index + 1) * shot.seconds,
            subtitle_cue: ren11CuePlan(REN11_FIXTURE_SPEC)[index]
          })),
          references: [],
          reference_note: "本包为本地程序化夹具：画面与声音都由 FFmpeg lavfi 合成源生成，因此不需要外部参考素材；此处留空是设计选择，不是缺失。",
          timeline: {
            total_seconds: this.brief.duration_seconds,
            rhythm: this.brief.shots.map((shot) => `${shot.seconds}s`)
          }
        };
        const file = path.join(this.runRoot, "stages", "storyboard_refs", "storyboard.json");
        writeJsonAtomic(file, storyboard);
        return { artifacts: [{ name: "storyboard.json", path: file }], facts: storyboard, summary: { shots: storyboard.shots.length } };
      },

      canvas_gate: async () => this.runCanvasGate(),

      generation: async () => {
        if (this.mode === SOP_V2_MODES.DRY_RUN) return this.planOnlyGeneration();
        if (this.mode === SOP_V2_MODES.PAID_PROVIDER) return this.providerGeneration();
        return this.localFixtureGeneration();
      },

      artifact_import: async () => this.importArtifacts(),
      audio: async () => this.audioStage(),
      subtitle: async () => this.subtitleStage(),
      edit: async () => this.editStage(),
      qc: async () => this.qcStage(),
      export: async () => this.exportStage(),
      delivery: async () => this.deliveryStage()
    };
  }

  // ------------------------------------------------------------------------------------------
  // canvas gate: real project + canvas + slots in the isolated service repository
  // ------------------------------------------------------------------------------------------
  async runCanvasGate() {
    const runMarker = `sop-v2:${this.state.run_id}`;
    const existing = this.service.searchProjects({ query: runMarker }).find((project) => String(project.description ?? "").includes(runMarker));
    // The project description names what this run actually is (shot count / duration / generation
    // source) instead of the fixture's hardcoded "local three-shot package" copy, which was attached to
    // paid single-shot runs as well.
    const sourceLabel = this.mode === SOP_V2_MODES.PAID_PROVIDER ? "付费供应商生成" : (this.mode === SOP_V2_MODES.DRY_RUN ? "计划（未渲染）" : "本地夹具渲染");
    const runDescription = `${runMarker} · ${this.brief.title} · ${this.brief.shots.length} 镜头 / ${this.runSpec.total_seconds}s · ${sourceLabel}`;
    const project = existing ?? this.service.createProject({
      title: this.brief.title,
      description: `${runDescription}（${this.mode === SOP_V2_MODES.PAID_PROVIDER ? "工程预览，非公开发布" : "工程测试预览"}）`
    });
    const spec = this.service.updateProjectSpec({
      project_id: project.project_id,
      target_platforms: this.brief.platform_targets,
      aspect_ratio: this.brief.aspect_ratio,
      resolution: this.brief.resolution,
      fps: this.brief.fps
    });
    const canvases = this.service.searchCanvases({ project_id: project.project_id });
    const canvas = canvases[0] ?? this.service.createCanvas({
      project_id: project.project_id,
      title: `${this.brief.title} 制作画布`,
      viewport: { x: 0, y: 0, zoom: 0.8, width: 1600, height: 900 }
    });
    const template = this.service.applyProductionCanvasTemplate({ canvas_id: canvas.canvas_id });
    // One generation slot per shot, so the rendered output has a declared home before it exists.
    const slots = [];
    const storyboard = readJson(this.factsFile("storyboard_refs"), { shots: [] });
    for (const shot of storyboard.shots) {
      const shapeId = `shape_ren11_slot_${this.state.run_id}_${shot.key}`;
      const already = this.service.getCanvas({ canvas_id: canvas.canvas_id }).shapes.find((shape) => shape.shape_id === shapeId);
      const slot = already ?? this.service.createGenerationSlot({
        canvas_id: canvas.canvas_id,
        slot: "draft_output",
        generation_type: "image_to_video",
        shape_id: shapeId,
        title: `${shot.key} 生成槽（${this.mode === SOP_V2_MODES.PAID_PROVIDER ? "供应商生成" : "本地夹具"}）`,
        status: "ready",
        target_width: this.runSpec.width,
        target_height: this.runSpec.height,
        target_aspect_ratio: this.brief.aspect_ratio,
        duration_seconds: shot.seconds,
        x: 1140,
        y: 330 + storyboard.shots.indexOf(shot) * 180,
        width: 320,
        height: 150
      });
      slots.push({ shot_key: shot.key, slot_shape_id: slot.shape_id ?? shapeId });
    }
    const canvasState = this.service.getCanvas({ canvas_id: canvas.canvas_id });
    const lint = this.service.lintCanvas({ canvas_id: canvas.canvas_id });
    const handoff = this.service.canvasGenerationHandoff({ canvas_id: canvas.canvas_id, generation_type: "image_to_video" });
    const facts = {
      run_marker: runMarker,
      project_id: project.project_id,
      project_spec: { aspect_ratio: spec.aspect_ratio, resolution: spec.resolution, fps: spec.fps, target_platforms: spec.target_platforms },
      canvas_id: canvas.canvas_id,
      template: { kind: template.template.kind, stage_count: template.template.stage_count },
      shape_count: canvasState.shapes.length,
      edge_count: canvasState.edges.length,
      slots,
      lint: { errors: lint.errors.length, warnings: lint.warnings.map((w) => w.code) },
      handoff: { status: handoff.status, output_spec_ready: handoff.validation.output_spec_ready, blockers: handoff.validation.generation_gate_blockers ?? [] },
      handoff_note: this.mode === SOP_V2_MODES.REAL_LOCAL
        ? "本模式不调用生成供应商，handoff 只作为画布输出规格与槽位可用性的检查；其 blocked 状态来自缺少外部生成参考，不影响本地夹具链。"
        : null
    };
    const file = path.join(this.runRoot, "stages", "canvas_gate", "canvas-gate.json");
    writeJsonAtomic(file, facts);
    return {
      artifacts: [{ name: "canvas-gate.json", path: file }],
      facts,
      summary: { project_id: project.project_id, canvas_id: canvas.canvas_id, slots: slots.length, lint_errors: facts.lint.errors }
    };
  }

  // ------------------------------------------------------------------------------------------
  // generation
  // ------------------------------------------------------------------------------------------
  async planOnlyGeneration() {
    const plan = {
      schema: "ren11.sop-v2.generation-plan.v1",
      mode: this.mode,
      status: "planned_only",
      statement: "dry_run 只产出计划，不渲染任何媒体，也不得被下游当作已产出素材。",
      shots: this.brief.shots.map((shot) => ({
        key: shot.key,
        seconds: shot.seconds,
        provider_plan: {
          provider: "dreamina_cli",
          command_kind: "image2video",
          model_version: "seedance2.0fast",
          video_resolution: "720p",
          duration: shot.seconds
        }
      })),
      cost: { charged: false, credits_spent: 0, evidence: "no provider call was made in dry_run" }
    };
    const file = path.join(this.runRoot, "stages", "generation", "generation-plan.json");
    writeJsonAtomic(file, plan);
    return { artifacts: [{ name: "generation-plan.json", path: file }], facts: plan, summary: { status: plan.status } };
  }

  /**
   * Paid generation: real queue, real trusted context, per-layer hard budget, then the provider's own
   * media is normalized into the post chain.
   *
   * The four source-level gaps the parent review named are handled here, not in prose:
   *   * a per-layer `max_credits` is required and the estimated total is checked against it *before*
   *     any job is created;
   *   * a job that did not reach `completed` stops the stage instead of being accepted;
   *   * the project/canvas and per-shot slot produced by `canvas_gate` are the defaults for every job,
   *     so a paid output has a declared home before it exists;
   *   * an already-`completed` job is reused rather than re-submitted, which is what makes a repeated
   *     resume free of duplicate provider submissions.
   */
  async providerGeneration() {
    const budget = this.brief.provider_budget ?? null;
    if (!budget?.authorized) {
      const error = new Error(`${GATE_CODES.BUDGET_NOT_AUTHORIZED}: 未授权的付费生成：需要 brief.provider_budget.authorized=true 与明确预算上限。`);
      error.code = GATE_CODES.BUDGET_NOT_AUTHORIZED;
      throw error;
    }
    if (!this.providerAdapter) {
      const error = new Error(`${GATE_CODES.PROVIDER_ADAPTER_MISSING}: generation job queue has no provider adapter wired`);
      error.code = GATE_CODES.PROVIDER_ADAPTER_MISSING;
      throw error;
    }
    if (!this.trustedContext?.trusted || !this.trustedContext?.actor_id) {
      const error = new Error(`${GATE_CODES.TRUSTED_CONTEXT_REQUIRED}: 付费生成需要可信调用方上下文（trusted + actor_id）；未归属的付费任务不得创建。`);
      error.code = GATE_CODES.TRUSTED_CONTEXT_REQUIRED;
      throw error;
    }
    const trusted = this.trustedContext;
    const canvasFacts = readJson(this.factsFile("canvas_gate"), null);
    if (!canvasFacts?.project_id || !canvasFacts?.canvas_id) {
      const error = new Error(`${GATE_CODES.MODE_MISMATCH}: 付费生成需要 canvas_gate 产出的 project/canvas，先跑 canvas_gate。`);
      error.code = GATE_CODES.MODE_MISMATCH;
      throw error;
    }
    const maxCredits = Number(budget.max_credits);
    if (!Number.isFinite(maxCredits) || maxCredits <= 0) {
      const error = new Error(`${GATE_CODES.BUDGET_LIMIT_MISSING}: 付费生成需要本层硬上限 brief.provider_budget.max_credits。`);
      error.code = GATE_CODES.BUDGET_LIMIT_MISSING;
      throw error;
    }
    const perShotEstimate = Number(budget.estimate_credits);
    if (!Number.isFinite(perShotEstimate) || perShotEstimate < 0) {
      const error = new Error(`${GATE_CODES.BUDGET_LIMIT_MISSING}: 付费生成需要逐镜头成本估算 brief.provider_budget.estimate_credits。`);
      error.code = GATE_CODES.BUDGET_LIMIT_MISSING;
      throw error;
    }
    const estimatedTotal = perShotEstimate * this.brief.shots.length;
    if (estimatedTotal > maxCredits) {
      const error = new Error(`${GATE_CODES.BUDGET_EXCEEDED}: 本层上限 ${maxCredits} 不足以覆盖估算总花费 ${estimatedTotal}（${perShotEstimate} × ${this.brief.shots.length} 镜头）；未提交任何任务。`);
      error.code = GATE_CODES.BUDGET_EXCEEDED;
      error.details = { max_credits: maxCredits, estimate_per_shot: perShotEstimate, estimated_total: estimatedTotal };
      throw error;
    }
    const entry = budget.entry ?? "dreamina.video.generate";
    const provider = budget.provider ?? "dreamina_cli";
    const created = [];
    for (const shot of this.brief.shots) {
      const slot = (canvasFacts.slots ?? []).find((item) => item.shot_key === shot.key) ?? null;
      const job = this.service.createGenerationJob(withTrustedContext({
        project_id: canvasFacts.project_id,
        canvas_id: canvasFacts.canvas_id,
        entry,
        provider,
        idempotency_key: `ren11:${this.state.run_id}:${shot.key}`,
        estimate_credits: perShotEstimate,
        confirm_cost: true,
        request: {
          shot_key: shot.key,
          seconds: shot.seconds,
          slot_shape_id: slot?.slot_shape_id ?? null,
          title: `${this.brief.title} · ${shot.key}`,
          ...(budget.request ?? {})
        }
      }, trusted));
      created.push({ shot, job });
    }
    const jobs = [];
    for (const { shot, job } of created) {
      // A job that is already complete is reused as-is: `processGenerationJob` would be a no-op, but
      // skipping it outright is what makes "resume does not resubmit" visible in the facts.
      const processed = job.state === "completed"
        ? job
        : await this.service.processGenerationJob(withTrustedContext({ job_id: job.job_id }, trusted));
      if (processed.state !== "completed") {
        const error = new Error(`${GATE_CODES.JOB_NOT_COMPLETED}: 镜头 ${shot.key} 的任务 ${job.job_id} 状态为 ${processed.state}（${processed.error_code ?? "no code"}）；未完成的任务不得当作已产出。`);
        error.code = GATE_CODES.JOB_NOT_COMPLETED;
        error.details = { job_id: job.job_id, state: processed.state, error_code: processed.error_code ?? null, error_message: processed.error_message ?? null };
        throw error;
      }
      jobs.push({
        shot_key: shot.key,
        job_id: job.job_id,
        reused: job.state === "completed",
        state: processed.state,
        provider_request_id: processed.provider_request_id ?? null,
        submit_attempts: processed.submit_attempts ?? null,
        download_files: (processed.result?.download?.files ?? []).map((file) => ({ path: file.path, sha256: file.sha256, bytes: file.bytes ?? null, source_url: file.source_url ?? null })),
        ingested: processed.result?.ingest?.ingested ?? [],
        credits: bestCreditEvidence(processed.result),
        actual_credits: processed.actual_credits ?? null
      });
    }
    const programme = await buildProviderProgramme({
      jobs,
      brief: this.brief,
      workDir: path.join(this.workRoot, "provider"),
      outputDir: path.join(this.mediaRoot, "provider"),
      ffmpegPath: this.ffmpegPath,
      ffprobePath: this.ffprobePath
    });
    // `null` must survive as "unknown": `Number(null)` is 0, so a naive reduce would turn three unknown
    // costs into a measured total of zero - the exact confusion this package exists to prevent.
    const measured = jobs.map((job) => (job.credits?.measured === true && typeof job.credits.value === "number" && Number.isFinite(job.credits.value)
      ? job.credits.value
      : null));
    const measuredAll = measured.length > 0 && measured.every((value) => value !== null);
    const facts = {
      schema: "ren11.sop-v2.provider-generation.v1",
      mode: this.mode,
      source: PROVIDER_SOURCES.PROVIDER_JOB,
      status: {
        kind: "provider_generated_preview",
        statement: "供应商产物经本地规范化后进入后期链；这是工程预览，不是公开发布版本。"
      },
      project_id: canvasFacts.project_id,
      canvas_id: canvasFacts.canvas_id,
      budget: {
        authorized: budget.authorized === true,
        max_credits: maxCredits,
        estimate_credits_per_shot: perShotEstimate,
        estimated_total: estimatedTotal,
        layer_limit_enforced: true
      },
      credits: {
        estimated_total: estimatedTotal,
        measured_total: measuredAll ? measured.reduce((sum, value) => sum + Number(value), 0) : null,
        measured_per_shot: measured,
        evidence: measuredAll ? jobs[0]?.credits?.evidence ?? "provider_reported" : "unmeasured",
        estimate_value: perShotEstimate,
        measured_differs_from_estimate: measuredAll ? measured.some((value) => Number(value) !== Number(perShotEstimate)) : null,
        statement: "measured_total 仅在供应商/账号给出证据时才有值（优先 user_credit 前后差额）；否则只有估算，不得当实测。"
      },
      provider_jobs: jobs,
      base_video: programme.base_video,
      master: programme.base_video,
      shots: programme.shots,
      cues: programme.cues,
      defective_control: programme.defective_control,
      audio_expectation: { kind: "provider_audio", tones_hz: null },
      normalization: {
        conform: "scale+pad (no crop) + fps, trimmed/extended to each shot's declared seconds",
        pad_only: true,
        audio_per_shot: programme.shots.map((shot) => ({ shot_key: shot.key, audio_source: shot.file.audio_source }))
      }
    };
    const file = path.join(this.runRoot, "stages", "generation", "provider-jobs.json");
    writeJsonAtomic(file, facts);
    return {
      artifacts: [
        { name: "provider-jobs.json", path: file },
        { name: "provider-programme.mp4", path: programme.base_video.path, extra: { stable: true } },
        { name: "local-qc-negative-control.mp4", path: programme.defective_control.path, extra: { stable: true } }
      ],
      facts,
      summary: { source: facts.source, jobs: jobs.length, estimated_total: estimatedTotal, reused_jobs: jobs.filter((job) => job.reused).length }
    };
  }

  async localFixtureGeneration() {
    const workDir = path.join(this.workRoot, "fixture");
    const outDir = path.join(this.mediaRoot, "fixture");
    const built = await buildLocalFixturePackage({
      workDir,
      outputDir: outDir,
      ffmpegPath: this.ffmpegPath,
      ffprobePath: this.ffprobePath
    });
    const facts = {
      schema: "ren11.sop-v2.local-generation.v1",
      mode: this.mode,
      source: PROVIDER_SOURCES.LOCAL_FIXTURE,
      status: FIXTURE_STATUS,
      provider_calls: 0,
      credits_spent: 0,
      fixture_manifest: built.manifest_path,
      master: built.master,
      // Uniform downstream contract: every generation source exposes the continuous programme as
      // `base_video`, its per-shot renders and a cue plan. `master` stays for the fixture's own
      // reports and earlier evidence.
      base_video: built.master,
      soft_subtitle: built.deliverables.soft_subtitle,
      burned_subtitle: built.deliverables.burned_subtitle,
      preview_renders: {
        soft_subtitle: built.deliverables.soft_subtitle,
        burned_subtitle: built.deliverables.burned_subtitle
      },
      defective_control: built.defective_control,
      shots: built.shots,
      cues: built.cues,
      audio_expectation: { kind: "synthetic_tones", tones_hz: built.shots.map((shot) => shot.tone_hz) }
    };
    const file = path.join(this.runRoot, "stages", "generation", "generation.json");
    writeJsonAtomic(file, facts);
    return {
      artifacts: [
        { name: "generation.json", path: file },
        { name: "fixture-manifest.json", path: built.manifest_path },
        { name: "soft-subtitle-render.mp4", path: built.deliverables.soft_subtitle.path, extra: { stable: true } },
        { name: "burned-subtitle-render.mp4", path: built.deliverables.burned_subtitle.path, extra: { stable: true } },
        { name: "defective-control.mp4", path: built.defective_control.path, extra: { stable: true } }
      ],
      facts,
      summary: { source: facts.source, provider_calls: 0 }
    };
  }

  // ------------------------------------------------------------------------------------------
  // artifact import: real ingest into the isolated service repository
  // ------------------------------------------------------------------------------------------
  /**
   * Register the run's persistent outputs as real assets.
   *
   * Source-aware on purpose. A provider run imports the *provider's* media (its normalized programme
   * and per-shot renders) with provenance `provider_generated` and rights left `unknown`, and reuses
   * the asset versions the queue's ingest phase already created for the raw provider files instead of
   * ingesting them twice. A local fixture run imports its synthetic renders with the fixture
   * provenance. Neither path may substitute the other's media.
   *
   * Facts that carry no media at all are refused here: `provider_job` is accepted as a source, but a
   * provider run whose programme was never normalized has nothing whose post-production could be
   * verified, and importing "nothing successfully" would be the old claim in new clothes.
   */
  async importArtifacts() {
    const generation = readJson(this.factsFile("generation"), null);
    const canvas = readJson(this.factsFile("canvas_gate"), null);
    const source = generation?.source ?? "none";
    if (![PROVIDER_SOURCES.LOCAL_FIXTURE, PROVIDER_SOURCES.PROVIDER_JOB].includes(source)) {
      const error = new Error(`${GATE_CODES.MODE_MISMATCH}: artifact_import 只接受 local_fixture 或 provider_job 产出；当前 generation.source=${source}`);
      error.code = GATE_CODES.MODE_MISMATCH;
      throw error;
    }
    if (!generation.base_video?.path || !Array.isArray(generation.shots) || generation.shots.length === 0) {
      const error = new Error(`${GATE_CODES.ARTIFACT_MISMATCH}: ${source} 产出缺少规范化媒体（base_video/shots）；无媒体不得当作已产出，也不会入库。`);
      error.code = GATE_CODES.ARTIFACT_MISMATCH;
      error.details = { source, has_base_video: Boolean(generation.base_video?.path), shots: Array.isArray(generation.shots) ? generation.shots.length : null };
      throw error;
    }
    const runMarker = `sop-v2:${this.state.run_id}`;
    const isProvider = source === PROVIDER_SOURCES.PROVIDER_JOB;
    const provenance = isProvider
      ? {
        source_type: "provider_generated",
        license_status: "unknown",
        risk_level: "unknown",
        license_hint: null,
        rights_note: "供应商产物及其本地规范化派生物未清权；不得声明 cleared 或可公开发布。",
        subtype: "provider_generated_preview"
      }
      : {
        source_type: "internal_synthetic_fixture",
        license_status: "cleared",
        risk_level: "low",
        license_hint: "original synthetic lavfi render",
        rights_note: `依据：${this.brief.rights.basis}；${this.brief.rights.note} 仅限内部工程使用，未声明可公开发布。`,
        subtype: "engineering_test_preview"
      };

    const wanted = [
      { role: "master_render", file: generation.base_video },
      ...generation.shots.map((shot) => ({ role: `shot_render_${shot.key}`, file: shot.file, shot_key: shot.key }))
    ];
    if (!isProvider) {
      for (const [role, file] of Object.entries(generation.preview_renders ?? {})) {
        if (file?.path) wanted.push({ role: `preview_${role}`, file });
      }
    }

    const imports = [];
    for (const item of wanted) {
      const existing = this.findVersionBySha(item.file.sha256);
      if (existing) {
        imports.push({ ...item, asset_id: existing.asset_id, asset_version_id: existing.asset_version_id, replayed: true });
        continue;
      }
      const asset = await this.service.ingestAsset({
        file_path: item.file.path,
        kind: "raw",
        title: `${this.brief.title} · ${item.role}`,
        description: `${runMarker} · ${item.role} · sha256=${item.file.sha256.slice(0, 16)} · ${isProvider ? "供应商产物本地规范化" : "本地程序化夹具"}`,
        tags: ["ren11", "sop-v2", provenance.subtype, item.role],
        source: {
          source_type: provenance.source_type,
          notes: isProvider
            ? `provider job 产物经本地规范化；源文件 ${item.file.path}`
            : `由 sop-v2 ${this.state.run_id} 本地 FFmpeg 渲染；源文件 ${item.file.path}`
        },
        change_summary: `sop-v2 ${this.state.run_id} ${isProvider ? "provider normalization" : "本地渲染"}`
      });
      this.service.updateAssetRights({
        asset_id: asset.asset_id,
        license_status: provenance.license_status,
        risk_level: provenance.risk_level,
        notes: provenance.rights_note,
        source: {
          source_type: provenance.source_type,
          ...(provenance.license_hint ? { license_hint: provenance.license_hint } : {}),
          notes: provenance.rights_note
        }
      });
      this.service.classifyAsset({
        asset_id: asset.asset_id,
        asset_version_id: asset.default_version_id,
        domain: "delivery",
        type: item.role,
        subtype: provenance.subtype,
        confidence: "confirmed",
        source: "agent"
      });
      imports.push({
        ...item,
        asset_id: asset.asset_id,
        asset_version_id: asset.default_version_id,
        replayed: false,
        stored_sha256: asset.versions?.[0]?.sha256 ?? null
      });
    }

    // The raw provider files are already assets (the queue's ingest phase created them). Record the
    // reference rather than re-ingesting: a second copy of the same bytes would be a second answer to
    // "which file is the provider's output".
    const providerOriginals = isProvider
      ? (generation.provider_jobs ?? []).flatMap((job) => (job.ingested ?? []).map((item) => ({
        shot_key: job.shot_key,
        job_id: job.job_id,
        asset_id: item.asset_id,
        asset_version_id: item.asset_version_id,
        sha256: item.sha256,
        license_status: item.license_status ?? "unknown",
        reused_from_queue_ingest: true
      })))
      : [];

    const facts = {
      schema: "ren11.sop-v2.artifact-import.v1",
      run_id: this.state.run_id,
      source,
      project_id: canvas?.project_id ?? null,
      provenance: {
        source_type: provenance.source_type,
        license_status: provenance.license_status,
        risk_level: provenance.risk_level,
        note: provenance.rights_note
      },
      imports,
      provider_originals: providerOriginals,
      statement: isProvider
        ? `${imports.length} 个规范化产物已真实入库（授权 unknown）；${providerOriginals.length} 个供应商原始文件复用队列入库记录，未重复入库。`
        : `${imports.length} 个持久产出（母版 + 逐镜头 + 预览）已真实入库到隔离库；重复运行按 sha256 复用既有版本，不产生第二份资产。`
    };
    const file = path.join(this.runRoot, "stages", "artifact_import", "asset-import.json");
    writeJsonAtomic(file, facts);
    return { artifacts: [{ name: "asset-import.json", path: file }], facts, summary: { imported: imports.length, source } };
  }

  /** Read-only lookup: an asset version with this content hash already exists in the isolated repo. */
  findVersionBySha(sha256) {
    if (!this.service?.db || !sha256) return null;
    const row = this.service.db.prepare(
      "SELECT asset_id, asset_version_id FROM asset_versions WHERE sha256 = ? ORDER BY created_at ASC LIMIT 1"
    ).get(sha256);
    return row ?? null;
  }

  // ------------------------------------------------------------------------------------------
  // audio / subtitle / edit
  // ------------------------------------------------------------------------------------------
  /**
   * Audio stage. Source-aware, because a synthetic tone grid is a *fixture* property: a provider
   * programme must not be failed (or passed) against frequencies only the fixture ever emitted.
   */
  async audioStage() {
    const generation = readJson(this.factsFile("generation"), null);
    const master = generation.base_video?.path ?? generation.master?.path ?? null;
    if (!master) {
      const error = new Error(`${GATE_CODES.ARTIFACT_MISMATCH}: audio 阶段找不到基础节目（base_video/master）。`);
      error.code = GATE_CODES.ARTIFACT_MISMATCH;
      throw error;
    }
    const expectation = generation.audio_expectation ?? { kind: "unknown", tones_hz: null };
    const probe = probeSummary(await ffprobeJson(master, { ffprobePath: this.ffprobePath }));
    if (!probe.audio) {
      const error = new Error(`${GATE_CODES.AUDIO_MISSING}: 基础节目没有音轨（${master}）；声明需要音轨的交付不得无音轨通过。`);
      error.code = GATE_CODES.AUDIO_MISSING;
      throw error;
    }
    const tones = [];
    const tonesAsserted = expectation.kind === "synthetic_tones"
      && Array.isArray(expectation.tones_hz)
      && expectation.tones_hz.length === generation.shots.length;
    if (tonesAsserted) {
      for (const shot of generation.shots) {
        const at = (shot.index - 1) * this.runSpec.shot_seconds + 1;
        const tone = await dominantToneAt({
          file: master,
          time: at,
          candidates: expectation.tones_hz,
          sampleRate: this.runSpec.audio_sample_rate,
          ffmpegPath: this.ffmpegPath
        });
        tones.push({ shot_key: shot.key, at_seconds: at, expected_hz: shot.tone_hz, dominant_hz: tone.dominant_hz, ok: tone.dominant_hz === shot.tone_hz });
      }
    }
    // Loudness is measured, not assumed: ebur128 prints a rolling summary while it decodes, so the
    // LAST `I:`/`Peak:` pair is the final integrated figure for the whole programme. Reading the
    // first pair reports the opening gating value (-70 LUFS on a quiet start), not the programme.
    const loudness = await runFfmpeg(
      ["-v", "info", "-i", path.resolve(master), "-af", "ebur128=peak=true", "-f", "null", "-"],
      { ffmpegPath: this.ffmpegPath, timeoutMs: 180000 }
    );
    const lastMatch = (pattern) => {
      const matches = [...loudness.stderr.matchAll(pattern)];
      return matches.length ? Number(matches.at(-1)[1]) : null;
    };
    const integrated = lastMatch(/I:\s*(-?\d+(?:\.\d+)?)\s*LUFS/g);
    const peak = lastMatch(/Peak:\s*(-?\d+(?:\.\d+)?)\s*dBFS/g);
    const extractedWav = path.join(this.mediaRoot, "audio", "ren11-master-audio.wav");
    fs.mkdirSync(path.dirname(extractedWav), { recursive: true });
    const extract = await runFfmpeg(
      ["-y", "-i", path.resolve(master), "-vn", "-c:a", "pcm_s16le", "-ar", String(REN11_FIXTURE_SPEC.audio_sample_rate), "-ac", "2", path.basename(extractedWav)],
      { cwd: path.dirname(extractedWav), ffmpegPath: this.ffmpegPath }
    );
    if (extract.code !== 0) throw new Error(`audio extraction failed: ${extract.stderr.slice(-800)}`);
    const facts = {
      schema: "ren11.sop-v2.audio.v1",
      source: generation.source,
      stream: probe.audio,
      expectation,
      tones,
      tone_check: tonesAsserted ? "asserted" : "not_applicable",
      all_tones_ok: tonesAsserted ? tones.every((t) => t.ok) : null,
      loudness: { integrated_lufs: integrated, true_peak_dbfs: peak, measured: integrated !== null, source: "ffmpeg ebur128 (last summary), 实测值" },
      extracted_wav: { path: extractedWav, sha256: await sha256File(extractedWav), ...fileFact(extractedWav) },
      note: tonesAsserted
        ? "本地合成音轨：三镜头各自单音，用于节奏与识别校验；不是配音，也不是供应商音频产物。"
        : "供应商音轨：只校验音轨存在、可解码与响度实测；不对供应商音频做单音断言。"
    };
    const file = path.join(this.runRoot, "stages", "audio", "audio-report.json");
    writeJsonAtomic(file, facts);
    return {
      artifacts: [{ name: "audio-report.json", path: file }, { name: "master-audio.wav", path: extractedWav, extra: { stable: true } }],
      facts,
      summary: { all_tones_ok: facts.all_tones_ok, tone_check: facts.tone_check, loudness_measured: facts.loudness.measured }
    };
  }

  async subtitleStage() {
    const generation = readJson(this.factsFile("generation"), null);
    const cues = generation.cues;
    if (!Array.isArray(cues) || cues.length === 0) {
      const error = new Error(`${GATE_CODES.ARTIFACT_MISMATCH}: 字幕阶段需要生成阶段给出 cue 计划。`);
      error.code = GATE_CODES.ARTIFACT_MISMATCH;
      throw error;
    }
    const srtPath = path.join(this.mediaRoot, "subtitle", "ren11-zh-CN.srt");
    fs.mkdirSync(path.dirname(srtPath), { recursive: true });
    fs.writeFileSync(srtPath, renderSrt(cues), "utf8");
    const shotBoundaries = this.brief.shots.reduce((acc, shot) => {
      const inPoint = acc.length ? acc[acc.length - 1].out_point : 0;
      acc.push({ shot_key: shot.key, in_point: inPoint, out_point: inPoint + Number(shot.seconds) });
      return acc;
    }, []);
    const cueCountMatchesShots = cues.length === shotBoundaries.length;
    const cuesInsideShots = cueCountMatchesShots && cues.every((cue, i) => cue.start > shotBoundaries[i].in_point && cue.end < shotBoundaries[i].out_point);
    // Round-trip the SRT through the parser, so a malformed timestamp cannot leave the stage as a
    // "written" file that no subtitle consumer could actually read.
    const roundTripped = parseSrt(fs.readFileSync(srtPath, "utf8"));
    const srtRoundTrip = roundTripped.length === cues.length
      && cues.every((cue, i) => Math.abs(roundTripped[i].start - cue.start) < 0.01
        && Math.abs(roundTripped[i].end - cue.end) < 0.01
        && roundTripped[i].text === cue.text);
    const facts = {
      schema: "ren11.sop-v2.subtitle.v1",
      source: generation.source,
      language: this.brief.subtitle.language,
      cues,
      shot_boundaries: shotBoundaries,
      cue_count_matches_shots: cueCountMatchesShots,
      cues_inside_their_shot: cuesInsideShots,
      srt_round_trip: srtRoundTrip,
      srt: { path: srtPath, sha256: await sha256File(srtPath), ...fileFact(srtPath) },
      container_readback_stage: "edit",
      note: "本阶段只负责 cue 计划与 SRT；字幕真正进入容器后的回读断言在 edit 阶段（那里做封装）。"
    };
    const file = path.join(this.runRoot, "stages", "subtitle", "subtitle-report.json");
    writeJsonAtomic(file, facts);
    return {
      artifacts: [{ name: "subtitle-report.json", path: file }, { name: "ren11-zh-CN.srt", path: srtPath, extra: { stable: true } }],
      facts,
      summary: { cues: cues.length, cues_inside_their_shot: cuesInsideShots, cue_count_matches_shots: cueCountMatchesShots, srt_round_trip: srtRoundTrip }
    };
  }

  /**
   * Edit stage: it owns the timeline. The base video comes from whichever source produced it (local
   * fixture master or the normalized provider programme) and the cue plan is muxed in *here*, so the
   * container readback happens in the stage that creates the container.
   */
  async editStage() {
    const generation = readJson(this.factsFile("generation"), null);
    const subtitle = readJson(this.factsFile("subtitle"), null);
    const base = generation.base_video?.path ?? generation.master?.path ?? null;
    const srtPath = subtitle?.srt?.path ?? null;
    if (!base || !srtPath) {
      const error = new Error(`${GATE_CODES.ARTIFACT_MISMATCH}: 剪辑阶段需要基础节目与 SRT（base=${Boolean(base)} srt=${Boolean(srtPath)}）。`);
      error.code = GATE_CODES.ARTIFACT_MISMATCH;
      throw error;
    }
    const tag = generation.source === PROVIDER_SOURCES.PROVIDER_JOB ? "provider-programme" : "local-fixture";
    const timelinePath = path.join(this.mediaRoot, "edit", `ren11-${tag}-timeline.mp4`);
    fs.rmSync(timelinePath, { force: true });
    fs.mkdirSync(path.dirname(timelinePath), { recursive: true });
    const result = await runFfmpeg(
      // Explicit stream maps: with `-c copy` the automatic selection silently dropped the mov_text
      // subtitle track from the timeline, so the QC stage rightly saw a master without subtitles.
      [
        "-y", "-i", path.resolve(base), "-i", path.resolve(srtPath),
        "-map", "0:v:0", "-map", "0:a:0", "-map", "1:0",
        "-c:v", "copy", "-c:a", "copy", "-c:s", "mov_text",
        "-metadata:s:s:0", "language=zho", "-movflags", "+faststart",
        path.basename(timelinePath)
      ],
      { cwd: path.dirname(timelinePath), ffmpegPath: this.ffmpegPath }
    );
    if (result.code !== 0) throw new Error(`timeline build failed: ${result.stderr.slice(-800)}`);
    const probe = probeSummary(await ffprobeJson(timelinePath, { ffprobePath: this.ffprobePath }));
    const readBack = parseSrt(await extractSubtitleStream({ file: timelinePath, ffmpegPath: this.ffmpegPath }));
    const cues = generation.cues ?? [];
    const containerReadbackMatches = readBack.length === cues.length
      && cues.every((cue, i) => Math.abs(readBack[i].start - cue.start) < 0.05
        && Math.abs(readBack[i].end - cue.end) < 0.05
        && readBack[i].text.replace(/\s+/g, "") === cue.text.replace(/\s+/g, ""));
    const cutList = this.brief.shots.reduce((acc, shot) => {
      const inPoint = acc.length ? acc[acc.length - 1].out_point : 0;
      acc.push({ shot_key: shot.key, in_point: inPoint, out_point: inPoint + Number(shot.seconds) });
      return acc;
    }, []);
    const facts = {
      schema: "ren11.sop-v2.edit.v1",
      source: generation.source,
      timeline: { path: timelinePath, sha256: await sha256File(timelinePath), ...fileFact(timelinePath), probe },
      cut_list: cutList,
      edit_operations: [`mux(${generation.source} base video + SRT, stream copy)`, "subtitles as mov_text", "faststart remux"],
      container_readback: readBack,
      container_readback_matches: containerReadbackMatches,
      subtitle_stream_present: Boolean(probe.subtitle),
      note: "剪辑只做封装与字幕接入，不做调色或变速；画面来源由 generation.source 标识。"
    };
    const file = path.join(this.runRoot, "stages", "edit", "edit.json");
    writeJsonAtomic(file, facts);
    return {
      artifacts: [{ name: "edit.json", path: file }, { name: "timeline.mp4", path: timelinePath, extra: { stable: true } }],
      facts,
      summary: { duration: probe.duration_seconds, container_readback_matches: containerReadbackMatches, subtitle_stream_present: facts.subtitle_stream_present }
    };
  }

  /**
   * What the QC stage is allowed to expect from this run's media.
   *
   * Cue text always comes from the run's own plan (so a supplier run is not failed for not repeating the
   * fixture's captions), while the fixture-only expectations - a configured flat background per shot and
   * a synthetic tone per shot - are declared not applicable unless the run really produced them.
   */
  qcExpectation(generation) {
    const cues = generation?.cues ?? null;
    const fixture = generation?.source === PROVIDER_SOURCES.LOCAL_FIXTURE;
    if (fixture) return null;
    const providerTonePlan = generation?.audio_expectation?.kind === "synthetic_tones" ? generation.shots.map((shot) => ({ index: shot.index, tone_hz: shot.tone_hz })) : null;
    const providerPalette = generation?.palette_expectation === "fixture_palette" ? generation.shots.map((shot) => ({ ...shot })) : null;
    return { cues, tones: providerTonePlan, shots: providerPalette };
  }

  /**
   * QC stage: measures the timeline, and carries its own instrumentation.
   *
   * The burn-in probe and the deliberately defective negative control are built *here* by this stage
   * rather than inherited from a fixture, so every run has them: a run that cannot produce a negative
   * control has no way to show its checks can fail, and is therefore refused instead of trusted.
   */
  async qcStage() {
    const edit = readJson(this.factsFile("edit"), null);
    const generation = readJson(this.factsFile("generation"), null);
    const subtitle = readJson(this.factsFile("subtitle"), null);
    const target = this.qcOverrideFile ?? edit.timeline.path;
    const workDir = path.join(this.workRoot, "qc");
    fs.mkdirSync(workDir, { recursive: true });
    await ensureScratchFont(workDir);
    // Burn-in instrumentation: rendered from the timeline the run actually produced (not from the
    // override target), so the "ink present in the cue window" probe always measures real cues.
    // The burner works entirely inside its scratch dir (inputs included), so the timeline and the SRT
    // are copied in, burned, and the result is placed next to the other QC artifacts.
    const burnDir = path.join(this.mediaRoot, "qc");
    fs.mkdirSync(burnDir, { recursive: true });
    const burnScratch = path.join(workDir, "burn");
    fs.rmSync(burnScratch, { recursive: true, force: true });
    fs.mkdirSync(burnScratch, { recursive: true });
    const stagedTimeline = path.join(burnScratch, "timeline.mp4");
    const stagedSrt = path.join(burnScratch, "cues.srt");
    fs.copyFileSync(edit.timeline.path, stagedTimeline);
    fs.copyFileSync(subtitle.srt.path, stagedSrt);
    const stagedBurn = path.join(burnScratch, "qc-burnin-instrumentation.mp4");
    const burnPath = path.join(burnDir, "qc-burnin-instrumentation.mp4");
    const burned = await burnSubtitles({
      videoPath: stagedTimeline,
      srtPath: stagedSrt,
      outputPath: stagedBurn,
      workDir: burnScratch,
      spec: this.runSpec,
      ffmpegPath: this.ffmpegPath
    });
    fs.rmSync(burnPath, { force: true });
    fs.renameSync(burned.path, burnPath);
    const burnedPlaced = { ...burned, path: burnPath, sha256: await sha256File(burnPath), ...fileFact(burnPath) };
    const qc = await qcLocalRender({
      file: target,
      burnedFile: this.qcOverrideFile ? null : burnedPlaced.path,
      // The run's own output spec - not the fixture's 15s/3-shot shape - is what its media is measured
      // against. A brief that says 4s/one shot is judged on 4s/one shot.
      spec: this.runSpec,
      // The run states what its media should contain. Local fixture media keeps every fixture check;
      // supplier-derived media keeps the cue and distinctness checks but declares that the fixture's
      // flat palette and synthetic tone grid are not expectations it can be judged against.
      expectation: this.qcExpectation(generation),
      ffmpegPath: this.ffmpegPath,
      ffprobePath: this.ffprobePath
    });
    const negativeFile = generation?.defective_control?.path ?? null;
    if (!negativeFile || !fs.existsSync(negativeFile)) {
      const error = new Error(`${GATE_CODES.NEGATIVE_CONTROL_MISSING}: 没有可用的 QC 负控文件，无法证明本次检查具备检出能力；拒绝授予交付资格。`);
      error.code = GATE_CODES.NEGATIVE_CONTROL_MISSING;
      throw error;
    }
    const negative = await qcLocalRender({ file: negativeFile, spec: this.runSpec, expectation: this.qcExpectation(generation), ffmpegPath: this.ffmpegPath, ffprobePath: this.ffprobePath });
    const decode = await decodeCheck({ file: target, ffmpegPath: this.ffmpegPath });
    const negativeDetected = negative.verdict === "fail";
    const facts = {
      schema: "ren11.sop-v2.qc.v1",
      source: generation?.source ?? "unknown",
      target,
      override_used: Boolean(this.qcOverrideFile),
      output_spec: this.runSpec,
      verdict: qc.verdict,
      verdict_line: qcVerdictLine(qc),
      failed_checks: qc.failed_checks,
      passed: qc.passed,
      checks: qc.checks,
      applied_checks: qc.applied_checks,
      not_applied_checks: qc.not_applied_checks,
      negative_control: { file: negativeFile, instrument: generation?.defective_control?.instrument ?? "local_qc_negative_control", verdict: negative.verdict, failed_checks: negative.failed_checks },
      negative_control_detected: negativeDetected,
      burn_in_instrumentation: { file: burnedPlaced.path, sha256: burnedPlaced.sha256, built_by_stage: "qc" },
      burn_in_probe: qc.burn_in?.probe ?? null,
      decode,
      gate: {
        deliverable_allowed: qc.passed && negativeDetected,
        code: qc.passed && negativeDetected ? "OK" : GATE_CODES.QC_FAILED,
        rule: "QC 失败或不具备负控检出能力的运行，一律不得授予可交付标签（已授予的会被撤销）。"
      }
    };
    const file = path.join(this.runRoot, "stages", "qc", "qc.json");
    writeJsonAtomic(file, facts);
    return {
      artifacts: [{ name: "qc.json", path: file }, { name: "qc-burnin-instrumentation.mp4", path: burnedPlaced.path, extra: { stable: true } }],
      facts,
      summary: facts.verdict_line
    };
  }

  async exportStage() {
    const qc = readJson(this.factsFile("qc"), null);
    if (!qc.gate.deliverable_allowed) {
      const error = new Error(`${GATE_CODES.QC_FAILED}: QC 未通过（verdict=${qc.verdict}，负控检出=${qc.negative_control_detected}），导出与交付被阻断。`);
      error.code = GATE_CODES.QC_FAILED;
      throw error;
    }
    const edit = readJson(this.factsFile("edit"), null);
    const generation = readJson(this.factsFile("generation"), null);
    const isProvider = generation.source === PROVIDER_SOURCES.PROVIDER_JOB;
    const outDir = path.join(this.outputRoot, "delivery");
    fs.mkdirSync(outDir, { recursive: true });
    const tag = isProvider ? "provider-programme" : "local-fixture";
    const target = path.join(outDir, `ren11-${tag}-${this.runSpec.total_seconds}s-${this.runSpec.width}x${this.runSpec.height}-${this.runSpec.fps}fps-delivery.mp4`);
    const result = await runFfmpeg(
      [
        "-y", "-i", path.resolve(edit.timeline.path),
        "-map", "0:v:0", "-map", "0:a:0", "-map", "0:s:0",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-profile:v", "high", "-level", "4.0",
        "-pix_fmt", "yuv420p", "-r", String(this.runSpec.fps), "-g", String(this.runSpec.fps * 2),
        "-c:a", "aac", "-b:a", "192k", "-ar", String(this.runSpec.audio_sample_rate), "-ac", String(this.runSpec.audio_channels),
        "-c:s", "mov_text", "-movflags", "+faststart",
        path.basename(target)
      ],
      { cwd: outDir, ffmpegPath: this.ffmpegPath }
    );
    if (result.code !== 0) throw new Error(`export transcode failed: ${result.stderr.slice(-1200)}`);
    const probe = probeSummary(await ffprobeJson(target, { ffprobePath: this.ffprobePath }));
    const facts = {
      schema: "ren11.sop-v2.export.v1",
      source: generation.source,
      export: { path: target, sha256: await sha256File(target), ...fileFact(target), probe },
      profile: { container: "mp4", video: "h264 high@4.0 crf20", audio: "aac 192k", subtitle: "mov_text", faststart: true },
      platform_targets: this.brief.platform_targets,
      label: isProvider ? SOP_V2_LABELS.PROVIDER_GENERATED_PREVIEW : SOP_V2_LABELS.ENGINEERING_TEST_PREVIEW,
      statement: isProvider
        ? "供应商产物经本地规范化与后期转码得到的工程预览；授权未清，不是公开发布版本。"
        : FIXTURE_STATUS.statement
    };
    const file = path.join(this.runRoot, "stages", "export", "export.json");
    writeJsonAtomic(file, facts);
    return { artifacts: [{ name: "export.json", path: file }, { name: "delivery-export.mp4", path: target, extra: { stable: true } }], facts, summary: { sha256: facts.export.sha256 } };
  }

  async deliveryStage() {
    const exportFacts = readJson(this.factsFile("export"), null);
    const qc = readJson(this.factsFile("qc"), null);
    const canvas = readJson(this.factsFile("canvas_gate"), null);
    if (!qc?.gate?.deliverable_allowed) {
      const error = new Error(`${GATE_CODES.QC_FAILED}: QC 未通过，交付阶段拒绝授予可交付标签。`);
      error.code = GATE_CODES.QC_FAILED;
      throw error;
    }
    const runMarker = `sop-v2:${this.state.run_id}`;
    const exportFile = exportFacts.export;
    const generation = readJson(this.factsFile("generation"), null);
    const isProvider = generation?.source === PROVIDER_SOURCES.PROVIDER_JOB;
    const provenance = isProvider
      ? {
        source_type: "provider_generated",
        license_status: "unknown",
        risk_level: "unknown",
        subtype: "provider_generated_preview",
        title_suffix: "供应商产物规范化节目（工程预览）",
        rights_note: "供应商产物及其本地规范化派生物未清权；不得声明 cleared 或可公开发布。"
      }
      : {
        source_type: "internal_synthetic_fixture",
        license_status: "cleared",
        risk_level: "low",
        subtype: "engineering_test_preview",
        title_suffix: "交付导出（工程测试预览）",
        rights_note: `依据：${this.brief.rights.basis}；仅限内部工程验收，未声明可公开发布。`
      };
    const deliveredLabel = isProvider ? SOP_V2_LABELS.PROVIDER_GENERATED_PREVIEW : SOP_V2_LABELS.ENGINEERING_TEST_PREVIEW;
    let assetRef = this.findVersionBySha(exportFile.sha256);
    if (!assetRef) {
      const asset = await this.service.ingestAsset({
        file_path: exportFile.path,
        kind: "working",
        title: `${this.brief.title} · ${provenance.title_suffix}`,
        description: `${runMarker} · delivery export · sha256=${exportFile.sha256.slice(0, 16)}`,
        tags: ["ren11", "sop-v2", "delivery", provenance.subtype],
        source: { source_type: provenance.source_type, notes: `render ${exportFile.path}` },
        change_summary: "sop-v2 交付导出转码"
      });
      this.service.updateAssetRights({
        asset_id: asset.asset_id,
        license_status: provenance.license_status,
        risk_level: provenance.risk_level,
        notes: provenance.rights_note,
        source: { source_type: provenance.source_type, notes: provenance.rights_note }
      });
      this.service.classifyAsset({
        asset_id: asset.asset_id,
        asset_version_id: asset.default_version_id,
        domain: "delivery",
        type: "final_export_candidate",
        subtype: provenance.subtype,
        confidence: "confirmed",
        source: "agent"
      });
      assetRef = { asset_id: asset.asset_id, asset_version_id: asset.default_version_id };
    }
    const refs = this.service.listProjectRefs({ project_id: canvas.project_id });
    const deliveryRole = "delivery_export";
    let projectRef = refs.find((ref) => ref.asset_version_id === assetRef.asset_version_id && ref.role === deliveryRole);
    if (!projectRef) {
      projectRef = this.service.addProjectRef({
        project_id: canvas.project_id,
        asset_id: assetRef.asset_id,
        asset_version_id: assetRef.asset_version_id,
        role: deliveryRole,
        usage_scope: isProvider ? "内部工程预览（供应商产物未清权，非公开发布）" : "内部工程验收样片（非公开发布）",
        pin_mode: "pinned",
        required: true,
        notes: `${runMarker} · ${provenance.subtype}`
      });
    }
    // Writeback: every shot slot gets *its own* shot render, written back into the canvas. Copying
    // the finished programme into all three slots would have created three identical assets and
    // claimed a per-shot provenance the file does not have.
    //
    // The binding check is media-aware on purpose. On the paid path the queue has already written each
    // job's *raw* provider download into its slot (that is the job's declared home and it stays), but
    // raw provider media is pre-normalization: one supplier clip is 640x360/3s and another carries no
    // audio at all. "The slot already has some output" is therefore a different question from "this
    // slot already holds the media the programme is made of", and answering the first one made this
    // stage skip its writeback silently - and then report the skip as a writeback. The output shape
    // records the sha of the file that was written back (`props.source_sha256`), so the question is
    // answered exactly instead of positionally.
    const isGeneratedOutput = (shape) => ["generated_output", "revision_output", "replacement_output", "timeline_output"]
      .includes(String(shape?.props?.role ?? ""));
    const shotFilesByKey = new Map((generation?.shots ?? []).map((shot) => [shot.key, shot.file]));
    const writebacks = [];
    for (const slot of canvas.slots) {
      const shotFile = shotFilesByKey.get(slot.shot_key);
      if (!shotFile) {
        const error = new Error(`${GATE_CODES.ARTIFACT_MISMATCH}: 镜头槽 ${slot.shot_key} 找不到对应的镜头渲染文件，拒绝用整片冒充单镜头产物。`);
        error.code = GATE_CODES.ARTIFACT_MISMATCH;
        throw error;
      }
      const slotOutputs = this.service.getCanvas({ canvas_id: canvas.canvas_id }).shapes
        .filter((shape) => isGeneratedOutput(shape) && shape.props?.slot_shape_id === slot.slot_shape_id);
      const siblingOutputs = (excludeShapeId) => slotOutputs
        .filter((shape) => shape.shape_id !== excludeShapeId)
        .map((shape) => ({ output_shape_id: shape.shape_id, media_sha256: shape.props?.source_sha256 ?? null, writeback_policy: shape.props?.replace_policy ?? null }));
      const alreadyBound = slotOutputs.find((shape) => String(shape.props?.source_sha256 ?? "") === shotFile.sha256) ?? null;
      if (alreadyBound) {
        writebacks.push({
          shot_key: slot.shot_key,
          slot_shape_id: slot.slot_shape_id,
          replayed: true,
          output_shape_id: alreadyBound.shape_id,
          output_asset_id: alreadyBound.props?.asset_id ?? null,
          output_asset_version_id: alreadyBound.props?.asset_version_id ?? null,
          media_sha256: shotFile.sha256,
          media_role: "normalized_shot_render",
          sibling_outputs: siblingOutputs(alreadyBound.shape_id)
        });
        continue;
      }
      const written = await this.service.insertGeneratedAsset({
        canvas_id: canvas.canvas_id,
        slot_shape_id: slot.slot_shape_id,
        file_path: shotFile.path,
        // The media hash is part of the key: a re-run that produced different media must create a new
        // writeback instead of silently reusing the older shape under the same explicit key.
        idempotency_key: `ren11:${this.state.run_id}:${slot.shot_key}:writeback:${String(shotFile.sha256).slice(0, 12)}`,
        title: isProvider ? `${slot.shot_key} 供应商产物规范化（工程预览）` : `${slot.shot_key} 本地夹具渲染（工程测试预览）`,
        kind: "raw",
        license_status: provenance.license_status,
        risk_level: provenance.risk_level,
        source: { source_type: provenance.source_type, notes: `sop-v2 ${this.state.run_id} shot render` }
      });
      writebacks.push({
        shot_key: slot.shot_key,
        slot_shape_id: slot.slot_shape_id,
        replayed: written?.idempotent?.reused === true || written?.idempotent_replay === true,
        output_shape_id: written?.shape?.shape_id ?? null,
        output_asset_id: written?.asset?.asset_id ?? null,
        output_asset_version_id: written?.asset?.default_version_id ?? null,
        media_sha256: shotFile.sha256,
        media_role: "normalized_shot_render",
        sibling_outputs: siblingOutputs(written?.shape?.shape_id ?? null)
      });
    }
    const projectReport = this.service.projectReport({ project_id: canvas.project_id });
    const continuity = this.service.projectContinuityReport({ project_id: canvas.project_id, stage: "delivery" });
    const facts = {
      schema: "ren11.sop-v2.delivery.v1",
      run_id: this.state.run_id,
      mode: this.mode,
      source: generation?.source ?? null,
      label: deliveredLabel,
      project_id: canvas.project_id,
      canvas_id: canvas.canvas_id,
      asset: { ...assetRef, sha256: exportFile.sha256, probe: exportFile.probe },
      project_ref: { reference_id: projectRef.reference_id, role: projectRef.role, pin_mode: projectRef.pin_mode },
      writebacks,
      project_report: { issues: projectReport.issues?.length ?? 0, issue_codes: (projectReport.issues ?? []).map((i) => i.code) },
      continuity_report: { ok: continuity.ok ?? null, issue_count: (continuity.issues ?? []).length },
      publishable: false,
      publish_blocker: isProvider
        ? "供应商产物未清权（license_status=unknown），且本包只做内部工程验收；公开发布需家主授权并按 REN-13 走发布门与清权流程。"
        : "零成本本地夹具是工程测试预览；公开发布需要家主授权并按 REN-13 走发布门。"
    };
    const file = path.join(this.runRoot, "stages", "delivery", "delivery-index.json");
    writeJsonAtomic(file, facts);
    this.state.label = deliveredLabel;
    this.state.deliverable = { asset_id: assetRef.asset_id, asset_version_id: assetRef.asset_version_id, sha256: exportFile.sha256, path: exportFile.path, label: deliveredLabel, source: generation?.source ?? null };
    return { artifacts: [{ name: "delivery-index.json", path: file }], facts, summary: { label: facts.label, writebacks: writebacks.length } };
  }
}

export { PROVIDER_SOURCES, GATE_CODES };
