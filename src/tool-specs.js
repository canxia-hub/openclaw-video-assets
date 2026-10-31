// Agent tool schemas are the source of truth. No browser or internal-board registrations.
import { NARRATIVE_TOOLS } from "./narrative-contract.js";
import { schemaEnums } from "./capability-registry.js";
import { buildCliToolSpecs } from "./cli-tools.js";
function doubaoAudioToolSchema({ includeCanvas }) {
  return {
    project_id: { type: "string" },
    ...(includeCanvas ? {
      canvas_id: { type: "string" },
      slot_shape_id: { type: "string" }
    } : {}),
    prompt_text: { type: "string" },
    video_linkage_block: { type: "string" },
    purpose: { type: "string" },
    model_id: { type: "string" },
    api_model_id: { type: "string" },
    adapter_version: { type: "string" },
    language: { type: "string" },
    char_limit: { type: "number" },
    duration_seconds: { type: "number" },
    output_format: { type: "string", enum: ["wav", "mp3", "pcm", "ogg_opus"] },
    sample_rate: { type: "number" },
    speech_rate: { type: "number" },
    loudness_rate: { type: "number" },
    pitch_rate: { type: "number" },
    enable_subtitle: { type: "boolean" },
    channels: { type: "number" },
    seed: { type: "number" },
    backend: { type: "string", enum: ["mock", "api"] },
    execute: { type: "boolean" },
    accept_cost: { type: "boolean" },
    accept_credit_spend: { type: "boolean" },
    timeout_ms: { type: "number" },
    output_dir: { type: "string" },
    download_outputs: { type: "boolean" },
    ingest_outputs: { type: "boolean" },
    writeback_canvas: { type: "boolean" },
    output_title: { type: "string" },
    title: { type: "string" },
    kind: { type: "string", enum: KIND_VALUES },
    tags: { type: "array", items: { type: "string" } },
    voices: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: true
      }
    },
    timeline: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: true
      }
    },
    sound_layers: { type: "object", additionalProperties: true },
    references: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          speaker: { type: "string" },
          audio_data: { type: "string" },
          audio_url: { type: "string" },
          image_data: { type: "string" },
          image_url: { type: "string" }
        }
      }
    },
    audio_config: {
      type: "object",
      additionalProperties: false,
      properties: {
        format: { type: "string", enum: ["wav", "mp3", "pcm", "ogg_opus"] },
        sample_rate: { type: "number" },
        speech_rate: { type: "number" },
        loudness_rate: { type: "number" },
        pitch_rate: { type: "number" },
        enable_subtitle: { type: "boolean" }
      }
    },
    watermark: {
      type: "object",
      additionalProperties: false,
      properties: {
        aigc_watermark: { type: "boolean" },
        aigc_metadata: {
          type: "object",
          additionalProperties: false,
          properties: {
            enable: { type: "boolean" },
            content_producer: { type: "string" },
            produce_id: { type: "string" },
            content_propagator: { type: "string" },
            propagate_id: { type: "string" }
          }
        }
      }
    },
    provider_parameters: { type: "object", additionalProperties: true },
    classification: { type: "object", additionalProperties: true },
    project_ref: { type: "object", additionalProperties: true },
    actor_id: { type: "string" },
    actor_type: { type: "string" }
  };
}
function kieSunoToolSchema({ includeCanvas }) {
  return {
    project_id: { type: "string" },
    ...(includeCanvas ? {
      canvas_id: { type: "string" },
      slot_shape_id: { type: "string" }
    } : {}),
    endpoint: { type: "string" },
    intent: { type: "string" },
    slug: { type: "string" },
    stage: { type: "string" },
    scene: { type: "string" },
    shot_id: { type: "string" },
    timecode: { type: "string" },
    target_duration: { type: "string" },
    duration_seconds: { type: "number" },
    platform: { type: "string" },
    model: { type: "string", enum: ["V4", "V4_5", "V4_5PLUS", "V4_5ALL", "V5", "V5_5"] },
    customMode: { type: "boolean" },
    instrumental: { type: "boolean" },
    prompt: { type: "string" },
    lyrics: { type: "string" },
    style: { type: "string" },
    title: { type: "string" },
    output_title: { type: "string" },
    negativeTags: { type: "string" },
    negative_tags: { type: "string" },
    callBackUrl: { type: "string" },
    callback_url: { type: "string" },
    vocalGender: { type: "string", enum: ["m", "f"] },
    track_role: { type: "string", enum: ["music", "song", "instrumental", "vocal", "stem", "wav", "lyrics", "mv", "reference", "test"] },
    dialogue_priority: { type: "string" },
    mix_priority: { type: "string" },
    downstream_target: { type: "string" },
    review_notes: { type: "string" },
    input_rights: { type: "string", enum: LICENSE_STATUS_VALUES },
    output_rights: { type: "string", enum: LICENSE_STATUS_VALUES },
    speaker_or_voice_consent: { type: "string" },
    rights_notes: { type: "string" },
    backend: { type: "string", enum: ["mock", "api"] },
    execute: { type: "boolean" },
    accept_cost: { type: "boolean" },
    accept_credit_spend: { type: "boolean" },
    timeout_ms: { type: "number" },
    poll_result: { type: "boolean" },
    poll_interval_seconds: { type: "number" },
    output_dir: { type: "string" },
    download_outputs: { type: "boolean" },
    ingest_outputs: { type: "boolean" },
    writeback_canvas: { type: "boolean" },
    kind: { type: "string", enum: KIND_VALUES },
    tags: { type: "array", items: { type: "string" } },
    classification: { type: "object", additionalProperties: true },
    project_ref: { type: "object", additionalProperties: true },
    provider_parameters: { type: "object", additionalProperties: true },
    actor_id: { type: "string" },
    actor_type: { type: "string" }
  };
}
function localizedToolDescription(name, fallback) {
  const displayName = TOOL_DISPLAY_NAMES[name];
  const description = TOOL_DESCRIPTIONS_ZH[name] ?? fallback;
  return displayName ? `${displayName}：${description}` : description;
}
const KIND_VALUES = Object.freeze(["raw", "working"]);
const LICENSE_STATUS_VALUES = Object.freeze(["unknown", "cleared", "restricted", "rejected"]);
const RISK_LEVEL_VALUES = Object.freeze(["unknown", "low", "medium", "high"]);
const DERIVATIVE_TYPE_VALUES = Object.freeze(["thumbnail", "proxy", "transcode", "audio_proxy", "subtitle", "waveform", "contact_sheet", "metadata", "other"]);
const TARGET_TYPE_VALUES = Object.freeze(["asset", "asset_version", "entity", "project_ref"]);
const ANNOTATION_TYPE_VALUES = Object.freeze(["character_profile", "scene_concept", "costume_spec", "prop_function", "visual_continuity", "source_rights", "production_note", "review_note", "prompt_note", "other"]);
const VISIBILITY_VALUES = Object.freeze(["internal", "project", "public_summary"]);
const TOOL_DISPLAY_NAMES = {
video_asset_ingest: "素材入库",
video_asset_search: "搜索素材",
video_asset_get: "读取素材详情",
video_asset_update_metadata: "更新素材元数据",
video_asset_update_rights: "更新授权与风险",
video_asset_create_version: "创建素材版本",
video_asset_create_branch: "创建素材分支",
video_asset_save_copy: "保存受管副本",
video_asset_lineage: "查看素材谱系",
video_asset_register_derived_file: "登记派生文件",
video_asset_generate_derived_file: "生成派生文件",
video_asset_derived_files: "列出派生文件",
video_asset_integrity_scan: "扫描素材库完整性",
video_asset_classify: "标注素材分类",
video_asset_get_classification: "读取素材分类",
video_asset_taxonomy_report: "生成分类连续性报告",
video_entity_create: "创建制作实体",
video_entity_search: "搜索制作实体",
video_entity_link_asset: "关联实体与素材",
video_asset_annotate: "添加素材批注",
video_asset_annotations: "列出素材批注",
video_asset_update_annotation: "更新素材批注",
video_project_create: "创建视频项目",
video_project_update_spec: "更新项目规格",
video_project_add_asset_ref: "添加项目素材引用",
video_project_update_asset_ref: "更新项目素材引用",
video_project_remove_asset_ref: "移除项目素材引用",
video_project_refs: "列出项目素材引用",
video_project_asset_report: "生成项目素材报告",
video_project_continuity_report: "生成项目连续性报告",
video_audio_doubao_plan: "生成豆包音频请求计划",
video_audio_doubao_generate: "执行豆包音频生成",
video_audio_kie_suno_plan: "生成 KIE Suno 请求计划",
video_audio_kie_suno_generate: "执行 KIE Suno 生成"
};
const TOOL_DESCRIPTIONS_ZH = {
video_asset_ingest: "将本地文件导入视频资产库。",
video_asset_search: "按文本和基础筛选条件搜索视频素材。",
video_asset_get: "读取素材、版本和分支详情。",
video_asset_update_metadata: "修订素材标题、描述和标签，不改动媒体文件或版本谱系。",
video_asset_update_rights: "更新素材授权状态、风险等级并追加来源证据。",
video_asset_create_version: "基于变更说明创建新的素材版本。",
video_asset_create_branch: "从指定素材版本创建分支。",
video_asset_save_copy: "从既有素材版本保存受管副本。",
video_asset_lineage: "查看素材分支、版本和上下游关系。",
video_asset_register_derived_file: "登记缩略图、代理文件、转码、字幕或其他派生文件。",
video_asset_generate_derived_file: "生成缩略图或代理文件并登记为派生文件。",
video_asset_derived_files: "列出素材或素材版本的派生文件。",
video_asset_integrity_scan: "扫描素材元数据、源文件、派生文件和项目引用完整性。",
video_asset_classify: "使用受控生产分类体系标注素材或素材版本。",
video_asset_get_classification: "读取素材分类和实体关联。",
video_asset_taxonomy_report: "扫描素材库中的分类、实体关联和关键批注缺口。",
video_entity_create: "创建角色、场景、服装、道具等制作实体。",
video_entity_search: "按键名、名称、别名、类型或项目搜索制作实体。",
video_entity_link_asset: "把素材或素材版本关联到制作实体。",
video_asset_annotate: "向素材、素材版本、实体或项目引用添加结构化批注。",
video_asset_annotations: "列出指定对象的结构化批注。",
video_asset_update_annotation: "更新既有批注或调整批注状态。",
video_project_create: "创建视频项目记录。",
video_project_update_spec: "更新项目输出规格，用于CLI生成及交付。",
video_project_add_asset_ref: "向项目添加素材版本引用。",
video_project_update_asset_ref: "更新既有项目素材引用。",
video_project_remove_asset_ref: "软移除项目素材引用。",
video_project_refs: "列出项目素材引用。",
video_project_asset_report: "生成项目素材依赖和风险报告。",
video_project_continuity_report: "检查项目分类、实体关联和批注连续性风险。",
video_audio_doubao_plan: "构建豆包音频生成 1.0 标准请求包，不调用模型，不消耗成本。",
video_audio_doubao_generate: "执行豆包音频生成，平台审核通过后入库（授权默认 unknown）",
video_audio_kie_suno_plan: "构建 KIE Suno API 音乐/歌曲生成请求包，不提交任务。",
video_audio_kie_suno_generate: "执行 KIE Suno API 音乐/歌曲生成，下载后按授权未知状态入库。"
};

function spec(name, description, properties, handler, required = []) { const p={...properties}; delete p.writeback_canvas; return { name, description: localizedToolDescription(name, description), properties:p, required, handler }; }
export function buildAgentToolSpecs(service, cli) {
const result = [
spec("video_asset_ingest", "Import a local file into the video asset repository.", {
    file_path: { type: "string" },
    kind: { type: "string", enum: KIND_VALUES },
    title: { type: "string", minLength: 1, maxLength: 512 },
    description: { type: "string", maxLength: 65536 },
    tags: { type: "array", maxItems: 64, items: { type: "string", maxLength: 128 } },
    source: {
      type: "object",
      additionalProperties: false,
      properties: {
        source_type: { type: "string" },
        url: { type: "string" },
        notes: { type: "string" }
      }
    }
  }, (args) => service.ingestAsset(args), ["file_path"]),
spec("video_asset_search", "Search video assets by text and basic filters.", {
    query: { type: "string" },
    limit: { type: "integer", minimum: 1, maximum: 100 },
    offset: { type: "integer", minimum: 0, maximum: 100000 }
  }, (args) => service.searchAssets(args)),
spec("video_asset_get", "Get an asset with versions and branches.", {
    asset_id: { type: "string" }
  }, (args) => service.getAsset(args), ["asset_id"]),
spec("video_asset_update_metadata", "Update asset title, description, and tags without changing media versions.", {
    asset_id: { type: "string" },
    title: { type: "string", minLength: 1, maxLength: 512 },
    description: { type: "string", maxLength: 65536 },
    tags: { type: "array", maxItems: 64, items: { type: "string", maxLength: 128 } },
    notes: { type: "string" }
  }, (args) => service.updateAssetMetadata(args), ["asset_id"]),
spec("video_asset_update_rights", "Update asset license/risk status and append source rights evidence.", {
    asset_id: { type: "string" },
    license_status: { type: "string", enum: LICENSE_STATUS_VALUES },
    risk_level: { type: "string", enum: RISK_LEVEL_VALUES },
    notes: { type: "string" },
    source: {
      type: "object",
      additionalProperties: false,
      properties: {
        source_type: { type: "string" },
        url: { type: "string" },
        captured_at: { type: "string" },
        original_author: { type: "string" },
        license_hint: { type: "string" },
        retrieval_method: { type: "string" },
        notes: { type: "string" }
      }
    }
  }, (args) => service.updateAssetRights(args), ["asset_id"]),
spec("video_asset_create_version", "Create a new asset version. change_items is required.", {
    asset_id: { type: "string" },
    file_path: { type: "string" },
    change_summary: { type: "string" },
    change_items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          category: { type: "string" },
          summary: { type: "string" },
          before: {},
          after: {},
          tool: { type: "string" },
          parameters: { type: "object", additionalProperties: true }
        }
      }
    },
    branch_id: { type: "string" },
    parent_version_id: { type: "string" },
    set_as_default: { type: "boolean" }
  }, (args) => service.createVersion(args), ["asset_id","file_path","change_items"]),
spec("video_asset_create_branch", "Create a branch from an asset version.", {
    asset_id: { type: "string" },
    base_version_id: { type: "string" },
    name: { type: "string" },
    description: { type: "string" }
  }, (args) => service.createBranch(args), ["asset_id","base_version_id","name"]),
spec("video_asset_save_copy", "Save a managed copy from an existing asset version.", {
    source_asset_id: { type: "string" },
    source_version_id: { type: "string" },
    copy_type: { type: "string", enum: ["snapshot_copy", "working_copy", "project_copy", "export_copy"] },
    target_project_id: { type: "string" },
    title: { type: "string" },
    reason: { type: "string" }
  }, (args) => service.saveCopy(args), ["source_asset_id","source_version_id","copy_type"]),
spec("video_asset_lineage", "Inspect asset lineage: branches, versions, incoming and outgoing relations.", {
    asset_id: { type: "string" }
  }, (args) => service.lineage(args), ["asset_id"]),
spec("video_asset_register_derived_file", "Register a thumbnail, proxy, transcode, subtitle, or other derived file for an asset version.", {
    asset_id: { type: "string" },
    asset_version_id: { type: "string" },
    file_path: { type: "string" },
    derivative_type: { type: "string", enum: DERIVATIVE_TYPE_VALUES },
    profile: { type: "string" },
    metadata: { type: "object", additionalProperties: true }
  }, (args) => service.registerDerivedFile(args), ["asset_id","asset_version_id","file_path","derivative_type"]),
spec("video_asset_generate_derived_file", "Generate a thumbnail or proxy from an asset version and register it as a derived file.", {
    asset_id: { type: "string" },
    asset_version_id: { type: "string" },
    derivative_type: { type: "string", enum: ["thumbnail", "proxy", "transcode"] },
    profile: { type: "string" },
    width: { type: "number" },
    crf: { type: "number" },
    preset: { type: "string", enum: ["ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow", "slower", "veryslow"] },
    seek_seconds: { type: "number" },
    max_duration_seconds: { type: "number" },
    metadata: { type: "object", additionalProperties: true }
  }, (args) => service.generateDerivedFile(args), ["asset_version_id"]),
spec("video_asset_derived_files", "List registered derived files for an asset or asset version.", {
    asset_id: { type: "string" },
    asset_version_id: { type: "string" },
    derivative_type: { type: "string", enum: DERIVATIVE_TYPE_VALUES },
    include_inactive: { type: "boolean" }
  }, (args) => service.listDerivedFiles(args)),
spec("video_asset_integrity_scan", "Scan repository metadata, source objects, derived files, and project refs for integrity issues.", {
    deep: { type: "boolean" }
  }, (args) => service.integrityScan(args)),
spec("video_asset_classify", "Classify an asset or asset version with controlled production taxonomy.", {
    asset_id: { type: "string" },
    asset_version_id: { type: "string" },
    domain: { type: "string", enum: ["character", "scene", "costume", "prop", "audio", "reference", "prompt", "document", "delivery", "other"] },
    type: { type: "string" },
    subtype: { type: "string" },
    confidence: { type: "string", enum: ["confirmed", "candidate", "inferred"] },
    source: { type: "string", enum: ["manual", "agent", "import", "migration"] }
  }, (args) => service.classifyAsset(args), ["asset_id","domain","type"]),
spec("video_asset_get_classification", "Get asset taxonomy classifications and entity links.", {
    asset_id: { type: "string" },
    asset_version_id: { type: "string" }
  }, (args) => service.getAssetClassification(args), ["asset_id"]),
spec("video_asset_taxonomy_report", "Scan the asset library for missing taxonomy, entity links, and key annotations.", {
    include_archived: { type: "boolean" },
    limit: { type: "number" }
  }, (args) => service.assetTaxonomyReport(args)),
spec("video_entity_create", "Create a production entity such as a character, scene, costume, or prop.", {
    entity_key: { type: "string" },
    entity_type: { type: "string", enum: ["character", "scene", "costume", "prop", "organization", "style", "other"] },
    canonical_name: { type: "string" },
    aliases: { type: "array", items: { type: "string" } },
    description: { type: "string" },
    project_id: { type: "string" },
    status: { type: "string", enum: ["draft", "active", "locked", "archived"] }
  }, (args) => service.createEntity(args), ["entity_key","entity_type","canonical_name"]),
spec("video_entity_search", "Search production entities by key, name, alias, type, or project.", {
    query: { type: "string" },
    entity_type: { type: "string" },
    project_id: { type: "string" },
    limit: { type: "integer", minimum: 1, maximum: 100 },
    offset: { type: "integer", minimum: 0, maximum: 100000 }
  }, (args) => service.searchEntities(args)),
spec("video_entity_link_asset", "Link an asset or asset version to a production entity.", {
    asset_id: { type: "string" },
    asset_version_id: { type: "string" },
    entity_id: { type: "string" },
    entity_key: { type: "string" },
    relation_type: { type: "string", enum: ["depicts", "costume_for", "prop_for", "scene_for", "style_for", "voice_for", "reference_for"] },
    confidence: { type: "string", enum: ["confirmed", "candidate", "inferred"] },
    notes: { type: "string" }
  }, (args) => service.linkEntityAsset(args), ["asset_id","relation_type"]),
spec("video_asset_annotate", "Add a structured annotation to an asset, asset version, entity, or project reference.", {
    target_type: { type: "string", enum: TARGET_TYPE_VALUES },
    target_id: { type: "string" },
    annotation_type: { type: "string", enum: ANNOTATION_TYPE_VALUES },
    title: { type: "string" },
    body: { type: "string" },
    structured: { type: "object", additionalProperties: true },
    visibility: { type: "string", enum: VISIBILITY_VALUES }
  }, (args) => service.annotateAsset(args), ["target_type","target_id","annotation_type","title","body"]),
spec("video_asset_annotations", "List annotations for an asset, asset version, entity, or project reference.", {
    target_type: { type: "string", enum: TARGET_TYPE_VALUES },
    target_id: { type: "string" },
    include_archived: { type: "boolean" }
  }, (args) => service.listAnnotations(args), ["target_type","target_id"]),
spec("video_asset_update_annotation", "Update an existing annotation or change its status.", {
    annotation_id: { type: "string" },
    title: { type: "string" },
    body: { type: "string" },
    structured: { type: "object", additionalProperties: true },
    status: { type: "string", enum: ["draft", "active", "superseded", "resolved", "archived"] },
    visibility: { type: "string", enum: VISIBILITY_VALUES }
  }, (args) => service.updateAnnotation(args), ["annotation_id"]),
spec("video_project_create", "Create a video project record.", {
    title: { type: "string" },
    description: { type: "string" },
    target_platforms: { type: "array", items: { type: "string" } },
    aspect_ratio: { type: "string" },
    resolution: { type: "string" },
    fps: { type: "number" }
  }, (args) => service.createProject(args), ["title"]),
spec("video_project_update_spec", "Update project output targets used by canvas generation handoff.", {
    project_id: { type: "string" },
    target_platforms: { type: "array", items: { type: "string" } },
    aspect_ratio: { type: "string" },
    resolution: { type: "string" },
    fps: { type: "number" }
  }, (args) => service.updateProjectSpec(args), ["project_id"]),
spec("video_project_add_asset_ref", "Add an asset version reference to a project.", {
    project_id: { type: "string" },
    asset_id: { type: "string" },
    asset_version_id: { type: "string" },
    role: { type: "string" },
    usage_scope: { type: "string" },
    pin_mode: { type: "string", enum: ["pinned", "follow_latest", "candidate"] },
    required: { type: "boolean" },
    notes: { type: "string" }
  }, (args) => service.addProjectRef(args), ["project_id", "asset_id"]),
spec("video_project_update_asset_ref", "Update an existing project asset reference.", {
    reference_id: { type: "string" },
    asset_id: { type: "string" },
    asset_version_id: { type: "string" },
    role: { type: "string" },
    usage_scope: { type: "string" },
    pin_mode: { type: "string", enum: ["pinned", "follow_latest", "candidate"] },
    required: { type: "boolean" },
    notes: { type: "string" }
  }, (args) => service.updateProjectRef(args), ["reference_id"]),
spec("video_project_remove_asset_ref", "Soft-remove a project asset reference.", {
    reference_id: { type: "string" }
  }, (args) => service.removeProjectRef(args), ["reference_id"]),
spec("video_project_refs", "List project asset references.", {
    project_id: { type: "string" }
  }, (args) => service.listProjectRefs(args), ["project_id"]),
spec("video_project_asset_report", "Generate a project asset dependency and risk report.", {
    project_id: { type: "string" }
  }, (args) => service.projectReport(args), ["project_id"]),
spec("video_project_continuity_report", "Check project taxonomy, entity-link, and annotation continuity risks.", {
    project_id: { type: "string" },
    stage: { type: "string", enum: ["research", "production", "review", "delivery"] }
  }, (args) => service.projectContinuityReport(args), ["project_id"]),
spec("video_audio_doubao_plan", "Build a Doubao Audio 1.0 request package without executing generation.", doubaoAudioToolSchema({
    includeCanvas: false
  }), (args) => service.doubaoAudioPlan(args)),
spec("video_audio_doubao_generate", "Run Doubao Audio 1.0 generation and ingest outputs. Platform review is a content review only and does not authorise rights: outputs default to license_status=unknown unless the caller passes an evidenced rights value.", doubaoAudioToolSchema({
    includeCanvas: false
  }), (args) => service.doubaoAudioGenerate(args)),
spec("video_audio_kie_suno_plan", "Build a KIE Suno API music request package without submitting a task.", kieSunoToolSchema({
    includeCanvas: false
  }), (args) => service.kieSunoPlan(args)),
spec("video_audio_kie_suno_generate", "Run KIE Suno API music generation and ingest downloaded outputs as rights-unknown assets.", kieSunoToolSchema({
    includeCanvas: false
  }), (args) => service.kieSunoGenerate(args))
];
for (const x of NARRATIVE_TOOLS) result.push(spec(x.name,x.description,x.properties,args=>service[x.method](args),["project_id","op"]));
return [...result,...buildCliToolSpecs(cli)];
}
