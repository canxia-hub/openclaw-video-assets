import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { VideoAssetService } from "./service.js";
import {
  SecurityManager,
  applySecurityHeaders,
  clearSessionCookie,
  getClientIp,
  getRequestToken,
  readJsonBody,
  sendJson,
  setSessionCookie
} from "./security.js";

let service;
let security;
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const UI_DIST_DIR = path.resolve(MODULE_DIR, "..", "ui-dist");
const VIDEO_ASSETS_WIDGET_URI = "ui://widget/video-assets/canvas.html";
const VIDEO_ASSETS_WORKBENCH_URL = "/__openclaw__/video-assets/workbench/";
const UI_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'"
].join("; ");

export default definePluginEntry({
  id: "video-assets",
  name: "视频资产库",
  description: "面向视频生产的项目资产库、制作画布与生成写回工具集。",
  register(api) {
    service = new VideoAssetService({ pluginConfig: api.pluginConfig, logger: api.logger });
    security = new SecurityManager({ pluginConfig: api.pluginConfig });
    service.init();
    if (!security.isConfigured()) {
      api.logger.warn?.("[video-assets] plugin auth is enabled but adminPasswordHash is not configured; HTTP login will reject requests.");
    }

    api.registerService({
      id: "video-assets-repository",
      async start(ctx) {
        ctx.logger.info?.(`[video-assets] repository ready: ${service.root}`);
      },
      async stop() {
        service?.close();
      }
    });

    service.setCanvasWidgetRuntimeSupport(registerNativeWidgetResource(api));
    registerTools(api);
    registerRpc(api);
    registerSecurityRoutes(api);
    registerUiApiRoute(api);
    registerSecureFileRoutes(api);
    registerUiRoutes(api);
  }
});

function registerNativeWidgetResource(api) {
  const attemptedApis = [];
  const diagnostics = [];
  const html = readNativeWidgetHtml();
  const candidates = [
    { name: "registerAppResource", build: () => [{ uri: VIDEO_ASSETS_WIDGET_URI, mimeType: "text/html", text: html }] },
    { name: "registerResource", build: () => [{ uri: VIDEO_ASSETS_WIDGET_URI, mimeType: "text/html", text: html }] },
    { name: "registerUiResource", build: () => [{ uri: VIDEO_ASSETS_WIDGET_URI, mimeType: "text/html", text: html }] },
    { name: "registerWidgetResource", build: () => [{ uri: VIDEO_ASSETS_WIDGET_URI, mimeType: "text/html", text: html }] }
  ];

  for (const candidate of candidates) {
    const register = api?.[candidate.name];
    if (typeof register !== "function") continue;
    attemptedApis.push(candidate.name);
    try {
      register.apply(api, candidate.build());
      api.logger.info?.(`[video-assets] native canvas widget resource registered through ${candidate.name}: ${VIDEO_ASSETS_WIDGET_URI}`);
      return {
        nativeResource: true,
        resourceRegistration: candidate.name,
        fallback: "protected_workbench_route",
        resourceUri: VIDEO_ASSETS_WIDGET_URI,
        fallbackUrl: VIDEO_ASSETS_WORKBENCH_URL,
        attemptedApis,
        diagnostics
      };
    } catch (error) {
      diagnostics.push(`${candidate.name}: ${error instanceof Error ? error.message : String(error)}`);
      api.logger.warn?.(`[video-assets] native widget resource registration failed through ${candidate.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (!attemptedApis.length) diagnostics.push("No registerAppResource/registerResource/registerUiResource/registerWidgetResource function was exposed by the current OpenClaw plugin API.");
  return {
    nativeResource: false,
    resourceRegistration: "not_available_in_current_openclaw_plugin_api",
    fallback: "protected_workbench_route",
    resourceUri: VIDEO_ASSETS_WIDGET_URI,
    fallbackUrl: VIDEO_ASSETS_WORKBENCH_URL,
    attemptedApis,
    diagnostics
  };
}

function readNativeWidgetHtml() {
  const indexPath = path.join(UI_DIST_DIR, "index.html");
  if (!fs.existsSync(indexPath)) {
    return [
      "<!doctype html>",
      "<html><head><meta charset=\"UTF-8\"><title>视频资产画布</title></head>",
      "<body><p>视频资产画布界面构建缺失，请打开受保护的工作台备用界面。</p></body></html>"
    ].join("");
  }
  return fs.readFileSync(indexPath, "utf8");
}

// 工具注册名是插件契约，必须保持英文；这里统一规范工具发现、说明与汇报层的中文名称。
const TOOL_DISPLAY_NAMES = {
  video_asset_ingest: "素材入库",
  video_asset_search: "搜索素材",
  video_asset_get: "读取素材详情",
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
  video_canvas_create: "创建制作画布",
  video_canvas_search: "搜索制作画布",
  video_canvas_apply_production_template: "套用制作画布模板",
  video_canvas_get: "读取制作画布",
  video_canvas_save_snapshot: "保存画布快照",
  video_canvas_upsert_shape: "创建或更新画布卡片",
  video_canvas_create_generation_slot: "创建画布生成槽",
  video_canvas_update_generation_slot: "更新画布生成槽",
  video_canvas_delete_shape: "移除画布卡片",
  video_canvas_link_shapes: "连接画布卡片",
  video_canvas_unlink_shapes: "取消画布连接",
  video_canvas_agent_context: "读取画布协作上下文",
  video_canvas_widget_context: "读取画布组件上下文",
  render_video_assets_canvas_widget: "渲染视频资产画布",
  video_canvas_save_selection: "保存画布选择",
  video_canvas_get_selection: "读取画布选择",
  video_canvas_save_view_state: "保存画布视图",
  video_canvas_get_view_state: "读取画布视图",
  video_canvas_generation_package: "生成准备包",
  video_canvas_generation_handoff: "生成交接包",
  video_canvas_export_annotation_brief: "导出批注简报",
  video_canvas_register_review_annotation: "登记审片批注",
  video_canvas_create_revision_card: "创建返修卡",
  video_canvas_update_revision_card_status: "更新返修卡状态",
  video_canvas_insert_generated_asset: "插入生成资产",
  video_canvas_fill_generation_slot: "填入画布生成槽",
  video_audio_doubao_plan: "生成豆包音频请求计划",
  video_audio_doubao_generate: "执行豆包音频生成",
  video_canvas_doubao_audio_plan: "生成画布豆包音频计划",
  video_canvas_doubao_audio_generate: "执行画布豆包音频生成",
  video_audio_kie_suno_plan: "生成 KIE Suno 请求计划",
  video_audio_kie_suno_generate: "执行 KIE Suno 生成",
  video_canvas_kie_suno_audio_plan: "生成画布 KIE Suno 计划",
  video_canvas_kie_suno_audio_generate: "执行画布 KIE Suno 生成",
  video_canvas_dreamina_cli_plan: "生成即梦命令计划",
  video_canvas_dreamina_cli_generate_video: "执行即梦视频生成",
  video_canvas_lint: "检查画布生产就绪度"
};

const TOOL_DESCRIPTIONS_ZH = {
  video_asset_ingest: "将本地文件导入视频资产库。",
  video_asset_search: "按文本和基础筛选条件搜索视频素材。",
  video_asset_get: "读取素材、版本和分支详情。",
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
  video_project_update_spec: "更新项目输出规格，供画布生成交接使用。",
  video_project_add_asset_ref: "向项目添加素材版本引用。",
  video_project_update_asset_ref: "更新既有项目素材引用。",
  video_project_remove_asset_ref: "软移除项目素材引用。",
  video_project_refs: "列出项目素材引用。",
  video_project_asset_report: "生成项目素材依赖和风险报告。",
  video_project_continuity_report: "检查项目分类、实体关联和批注连续性风险。",
  video_canvas_create: "创建项目制作画布。",
  video_canvas_search: "搜索项目制作画布。",
  video_canvas_apply_production_template: "套用包含阶段分区、项目引用、实体和生成槽的制作模板。",
  video_canvas_get: "读取制作画布及其卡片和连线。",
  video_canvas_save_snapshot: "保存画布视口或文档快照。",
  video_canvas_upsert_shape: "创建或更新画布卡片，不改动底层素材。",
  video_canvas_create_generation_slot: "创建带目标尺寸、比例、时长和必需参考的画布生成槽。",
  video_canvas_update_generation_slot: "更新画布生成槽的目标规格或流程状态。",
  video_canvas_delete_shape: "从画布移除卡片，不删除素材库资产。",
  video_canvas_link_shapes: "创建或更新两个画布卡片之间的关系连线。",
  video_canvas_unlink_shapes: "删除画布关系连线。",
  video_canvas_agent_context: "返回可供协作方读取的画布上下文、可见卡片、离屏分组和检查问题。",
  video_canvas_widget_context: "返回画布组件可用的上下文、选择状态和视图状态。",
  render_video_assets_canvas_widget: "返回视频资产无限画布的原生组件渲染描述。",
  video_canvas_save_selection: "保存临时画布选择状态，不创建审计提交。",
  video_canvas_get_selection: "读取当前临时画布选择状态。",
  video_canvas_save_view_state: "保存临时画布视口状态，不创建审计提交。",
  video_canvas_get_view_state: "读取当前临时画布视口状态。",
  video_canvas_generation_package: "从制作画布构建生成准备输入包。",
  video_canvas_generation_handoff: "从制作画布构建可执行的生成交接包。",
  video_canvas_export_annotation_brief: "从画布卡片构建审片批注或返修规划简报。",
  video_canvas_register_review_annotation: "在选中素材、版本、实体或项目引用上登记画布审片批注。",
  video_canvas_create_revision_card: "基于审片批注或生成输出谱系创建画布返修卡。",
  video_canvas_update_revision_card_status: "更新画布返修卡流程状态，不改动来源批注或输出谱系。",
  video_canvas_insert_generated_asset: "导入生成文件，加入项目，并写回到生成槽旁边。",
  video_canvas_fill_generation_slot: "按先入库再写回的默认策略，用生成文件填入画布生成槽。",
  video_audio_doubao_plan: "构建豆包音频生成 1.0 标准请求包，不调用模型，不消耗成本。",
  video_audio_doubao_generate: "执行豆包音频生成，平台审核通过后自动以 cleared 状态入库。",
  video_canvas_doubao_audio_plan: "从画布音频生成槽构建豆包音频请求包，不调用模型。",
  video_canvas_doubao_audio_generate: "从画布音频生成槽执行豆包音频生成，入库后写回画布。",
  video_audio_kie_suno_plan: "构建 KIE Suno API 音乐/歌曲生成请求包，不提交任务。",
  video_audio_kie_suno_generate: "执行 KIE Suno API 音乐/歌曲生成，下载后按授权未知状态入库。",
  video_canvas_kie_suno_audio_plan: "从画布音频生成槽构建 KIE Suno 请求包，不提交任务。",
  video_canvas_kie_suno_audio_generate: "从画布音频生成槽执行 KIE Suno 生成，入库后写回画布。",
  video_canvas_dreamina_cli_plan: "从画布交接包构建即梦命令执行计划，不消耗积分。",
  video_canvas_dreamina_cli_generate_video: "依据画布交接包执行即梦视频生成，并严格校验视频模型参数。",
  video_canvas_lint: "检查画布绑定缺口和生产就绪度警告。"
};

function localizedToolDescription(name, fallback) {
  const displayName = TOOL_DISPLAY_NAMES[name];
  const description = TOOL_DESCRIPTIONS_ZH[name] ?? fallback;
  return displayName ? `${displayName}：${description}` : description;
}

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
    kind: { type: "string", enum: ["raw", "working"] },
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
    input_rights: { type: "string", enum: ["unknown", "cleared", "restricted", "rejected"] },
    output_rights: { type: "string", enum: ["unknown", "cleared", "restricted", "rejected"] },
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
    kind: { type: "string", enum: ["raw", "working"] },
    tags: { type: "array", items: { type: "string" } },
    classification: { type: "object", additionalProperties: true },
    project_ref: { type: "object", additionalProperties: true },
    provider_parameters: { type: "object", additionalProperties: true },
    actor_id: { type: "string" },
    actor_type: { type: "string" }
  };
}

function registerTools(api) {
  api.registerTool(tool("video_asset_ingest", "Import a local file into the video asset repository.", {
    file_path: { type: "string" },
    kind: { type: "string", enum: ["raw", "working"] },
    title: { type: "string" },
    description: { type: "string" },
    tags: { type: "array", items: { type: "string" } },
    source: {
      type: "object",
      additionalProperties: false,
      properties: {
        source_type: { type: "string" },
        url: { type: "string" },
        notes: { type: "string" }
      }
    }
  }, (args) => service.ingestAsset(args)));

  api.registerTool(tool("video_asset_search", "Search video assets by text and basic filters.", {
    query: { type: "string" },
    limit: { type: "number" }
  }, (args) => service.searchAssets(args)));

  api.registerTool(tool("video_asset_get", "Get an asset with versions and branches.", {
    asset_id: { type: "string" }
  }, (args) => service.getAsset(args)));

  api.registerTool(tool("video_asset_update_rights", "Update asset license/risk status and append source rights evidence.", {
    asset_id: { type: "string" },
    license_status: { type: "string", enum: ["unknown", "cleared", "restricted", "rejected"] },
    risk_level: { type: "string", enum: ["unknown", "low", "medium", "high"] },
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
  }, (args) => service.updateAssetRights(args)));

  api.registerTool(tool("video_asset_create_version", "Create a new asset version. change_items is required.", {
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
  }, (args) => service.createVersion(args)));

  api.registerTool(tool("video_asset_create_branch", "Create a branch from an asset version.", {
    asset_id: { type: "string" },
    base_version_id: { type: "string" },
    name: { type: "string" },
    description: { type: "string" }
  }, (args) => service.createBranch(args)));

  api.registerTool(tool("video_asset_save_copy", "Save a managed copy from an existing asset version.", {
    source_asset_id: { type: "string" },
    source_version_id: { type: "string" },
    copy_type: { type: "string", enum: ["snapshot_copy", "working_copy", "project_copy", "export_copy"] },
    target_project_id: { type: "string" },
    title: { type: "string" },
    reason: { type: "string" }
  }, (args) => service.saveCopy(args)));

  api.registerTool(tool("video_asset_lineage", "Inspect asset lineage: branches, versions, incoming and outgoing relations.", {
    asset_id: { type: "string" }
  }, (args) => service.lineage(args)));

  api.registerTool(tool("video_asset_register_derived_file", "Register a thumbnail, proxy, transcode, subtitle, or other derived file for an asset version.", {
    asset_id: { type: "string" },
    asset_version_id: { type: "string" },
    file_path: { type: "string" },
    derivative_type: { type: "string", enum: ["thumbnail", "proxy", "transcode", "audio_proxy", "subtitle", "waveform", "contact_sheet", "metadata", "other"] },
    profile: { type: "string" },
    metadata: { type: "object", additionalProperties: true }
  }, (args) => service.registerDerivedFile(args)));

  api.registerTool(tool("video_asset_generate_derived_file", "Generate a thumbnail or proxy from an asset version and register it as a derived file.", {
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
  }, (args) => service.generateDerivedFile(args)));

  api.registerTool(tool("video_asset_derived_files", "List registered derived files for an asset or asset version.", {
    asset_id: { type: "string" },
    asset_version_id: { type: "string" },
    derivative_type: { type: "string", enum: ["thumbnail", "proxy", "transcode", "audio_proxy", "subtitle", "waveform", "contact_sheet", "metadata", "other"] },
    include_inactive: { type: "boolean" }
  }, (args) => service.listDerivedFiles(args)));

  api.registerTool(tool("video_asset_integrity_scan", "Scan repository metadata, source objects, derived files, and project refs for integrity issues.", {
    deep: { type: "boolean" }
  }, (args) => service.integrityScan(args)));

  api.registerTool(tool("video_asset_classify", "Classify an asset or asset version with controlled production taxonomy.", {
    asset_id: { type: "string" },
    asset_version_id: { type: "string" },
    domain: { type: "string", enum: ["character", "scene", "costume", "prop", "audio", "reference", "prompt", "document", "delivery", "other"] },
    type: { type: "string" },
    subtype: { type: "string" },
    confidence: { type: "string", enum: ["confirmed", "candidate", "inferred"] },
    source: { type: "string", enum: ["manual", "agent", "import", "migration"] }
  }, (args) => service.classifyAsset(args)));

  api.registerTool(tool("video_asset_get_classification", "Get asset taxonomy classifications and entity links.", {
    asset_id: { type: "string" },
    asset_version_id: { type: "string" }
  }, (args) => service.getAssetClassification(args)));

  api.registerTool(tool("video_asset_taxonomy_report", "Scan the asset library for missing taxonomy, entity links, and key annotations.", {
    include_archived: { type: "boolean" },
    limit: { type: "number" }
  }, (args) => service.assetTaxonomyReport(args)));

  api.registerTool(tool("video_entity_create", "Create a production entity such as a character, scene, costume, or prop.", {
    entity_key: { type: "string" },
    entity_type: { type: "string", enum: ["character", "scene", "costume", "prop", "organization", "style", "other"] },
    canonical_name: { type: "string" },
    aliases: { type: "array", items: { type: "string" } },
    description: { type: "string" },
    project_id: { type: "string" },
    status: { type: "string", enum: ["draft", "active", "locked", "archived"] }
  }, (args) => service.createEntity(args)));

  api.registerTool(tool("video_entity_search", "Search production entities by key, name, alias, type, or project.", {
    query: { type: "string" },
    entity_type: { type: "string" },
    project_id: { type: "string" },
    limit: { type: "number" }
  }, (args) => service.searchEntities(args)));

  api.registerTool(tool("video_entity_link_asset", "Link an asset or asset version to a production entity.", {
    asset_id: { type: "string" },
    asset_version_id: { type: "string" },
    entity_id: { type: "string" },
    entity_key: { type: "string" },
    relation_type: { type: "string", enum: ["depicts", "costume_for", "prop_for", "scene_for", "style_for", "voice_for", "reference_for"] },
    confidence: { type: "string", enum: ["confirmed", "candidate", "inferred"] },
    notes: { type: "string" }
  }, (args) => service.linkEntityAsset(args)));

  api.registerTool(tool("video_asset_annotate", "Add a structured annotation to an asset, asset version, entity, or project reference.", {
    target_type: { type: "string", enum: ["asset", "asset_version", "entity", "project_ref"] },
    target_id: { type: "string" },
    annotation_type: { type: "string", enum: ["character_profile", "scene_concept", "costume_spec", "prop_function", "visual_continuity", "source_rights", "production_note", "review_note", "prompt_note", "other"] },
    title: { type: "string" },
    body: { type: "string" },
    structured: { type: "object", additionalProperties: true },
    visibility: { type: "string", enum: ["internal", "project", "public_summary"] }
  }, (args) => service.annotateAsset(args)));

  api.registerTool(tool("video_asset_annotations", "List annotations for an asset, asset version, entity, or project reference.", {
    target_type: { type: "string", enum: ["asset", "asset_version", "entity", "project_ref"] },
    target_id: { type: "string" },
    include_archived: { type: "boolean" }
  }, (args) => service.listAnnotations(args)));

  api.registerTool(tool("video_asset_update_annotation", "Update an existing annotation or change its status.", {
    annotation_id: { type: "string" },
    title: { type: "string" },
    body: { type: "string" },
    structured: { type: "object", additionalProperties: true },
    status: { type: "string", enum: ["draft", "active", "superseded", "resolved", "archived"] },
    visibility: { type: "string", enum: ["internal", "project", "public_summary"] }
  }, (args) => service.updateAnnotation(args)));

  api.registerTool(tool("video_project_create", "Create a video project record.", {
    title: { type: "string" },
    description: { type: "string" },
    target_platforms: { type: "array", items: { type: "string" } },
    aspect_ratio: { type: "string" },
    resolution: { type: "string" },
    fps: { type: "number" }
  }, (args) => service.createProject(args)));

  api.registerTool(tool("video_project_update_spec", "Update project output targets used by canvas generation handoff.", {
    project_id: { type: "string" },
    target_platforms: { type: "array", items: { type: "string" } },
    aspect_ratio: { type: "string" },
    resolution: { type: "string" },
    fps: { type: "number" }
  }, (args) => service.updateProjectSpec(args)));

  api.registerTool(tool("video_project_add_asset_ref", "Add an asset version reference to a project.", {
    project_id: { type: "string" },
    asset_id: { type: "string" },
    asset_version_id: { type: "string" },
    role: { type: "string" },
    usage_scope: { type: "string" },
    pin_mode: { type: "string", enum: ["pinned", "follow_latest", "candidate"] },
    required: { type: "boolean" },
    notes: { type: "string" }
  }, (args) => service.addProjectRef(args)));

  api.registerTool(tool("video_project_update_asset_ref", "Update an existing project asset reference.", {
    reference_id: { type: "string" },
    asset_id: { type: "string" },
    asset_version_id: { type: "string" },
    role: { type: "string" },
    usage_scope: { type: "string" },
    pin_mode: { type: "string", enum: ["pinned", "follow_latest", "candidate"] },
    required: { type: "boolean" },
    notes: { type: "string" }
  }, (args) => service.updateProjectRef(args)));

  api.registerTool(tool("video_project_remove_asset_ref", "Soft-remove a project asset reference.", {
    reference_id: { type: "string" }
  }, (args) => service.removeProjectRef(args)));

  api.registerTool(tool("video_project_refs", "List project asset references.", {
    project_id: { type: "string" }
  }, (args) => service.listProjectRefs(args)));

  api.registerTool(tool("video_project_asset_report", "Generate a project asset dependency and risk report.", {
    project_id: { type: "string" }
  }, (args) => service.projectReport(args)));

  api.registerTool(tool("video_project_continuity_report", "Check project taxonomy, entity-link, and annotation continuity risks.", {
    project_id: { type: "string" },
    stage: { type: "string", enum: ["research", "production", "review", "delivery"] }
  }, (args) => service.projectContinuityReport(args)));

  api.registerTool(tool("video_canvas_create", "Create a project infinite canvas.", {
    project_id: { type: "string" },
    title: { type: "string" },
    viewport: { type: "object", additionalProperties: true },
    document: { type: "object", additionalProperties: true }
  }, (args) => service.createCanvas(args)));

  api.registerTool(tool("video_canvas_search", "Search project canvases.", {
    project_id: { type: "string" },
    query: { type: "string" },
    limit: { type: "number" }
  }, (args) => service.searchCanvases(args)));

  api.registerTool(tool("video_canvas_apply_production_template", "Apply a production pilot canvas template with stage sections, project refs, entities, and generation slots.", {
    canvas_id: { type: "string" },
    project_id: { type: "string" },
    title: { type: "string" },
    viewport: { type: "object", additionalProperties: true },
    actor_id: { type: "string" },
    actor_type: { type: "string" }
  }, (args) => service.applyProductionCanvasTemplate(args)));

  api.registerTool(tool("video_canvas_get", "Get an infinite canvas with shapes and edges.", {
    canvas_id: { type: "string" }
  }, (args) => service.getCanvas(args)));

  api.registerTool(tool("video_canvas_save_snapshot", "Save a canvas viewport/document snapshot.", {
    canvas_id: { type: "string" },
    viewport: { type: "object", additionalProperties: true },
    document: { type: "object", additionalProperties: true },
    state: { type: "object", additionalProperties: true }
  }, (args) => service.saveCanvasSnapshot(args)));

  api.registerTool(tool("video_canvas_upsert_shape", "Create or update a canvas card/shape without modifying the underlying asset.", {
    canvas_id: { type: "string" },
    shape_id: { type: "string" },
    shape_type: { type: "string", enum: ["project_card", "asset_card", "entity_card", "reference_card", "note", "section"] },
    subject_type: { type: "string", enum: ["project", "asset", "asset_version", "project_ref", "entity", "note", "section"] },
    subject_id: { type: "string" },
    title: { type: "string" },
    x: { type: "number" },
    y: { type: "number" },
    width: { type: "number" },
    height: { type: "number" },
    rotation: { type: "number" },
    z_index: { type: "number" },
    props: { type: "object", additionalProperties: true }
  }, (args) => service.upsertCanvasShape(args)));

  api.registerTool(tool("video_canvas_create_generation_slot", "Create a production generation slot with target size, ratio, duration, and required references.", {
    canvas_id: { type: "string" },
    slot: { type: "string", enum: ["main_reference", "character_reference", "scene_reference", "motion_reference", "style_reference", "video_clip", "audio", "subtitle", "project_config", "draft_output"] },
    generation_type: { type: "string", enum: ["image", "image_to_video", "text_to_video", "multimodal_to_video", "edit", "voice", "subtitle", "cover", "export"] },
    target_width: { type: "number" },
    target_height: { type: "number" },
    target_aspect_ratio: { type: "string" },
    duration_seconds: { type: "number" },
    replace_policy: { type: "string", enum: ["insert_beside", "replace_slot", "new_revision", "append_timeline"] },
    required_refs: { type: "array", items: { type: "string" } },
    status: { type: "string", enum: ["empty", "ready", "generating", "filled", "blocked"] },
    title: { type: "string" },
    x: { type: "number" },
    y: { type: "number" },
    width: { type: "number" },
    height: { type: "number" }
  }, (args) => service.createGenerationSlot(args)));

  api.registerTool(tool("video_canvas_update_generation_slot", "Update a production generation slot target spec or workflow state.", {
    shape_id: { type: "string" },
    slot: { type: "string", enum: ["main_reference", "character_reference", "scene_reference", "motion_reference", "style_reference", "video_clip", "audio", "subtitle", "project_config", "draft_output"] },
    generation_type: { type: "string", enum: ["image", "image_to_video", "text_to_video", "multimodal_to_video", "edit", "voice", "subtitle", "cover", "export"] },
    target_width: { type: "number" },
    target_height: { type: "number" },
    target_aspect_ratio: { type: "string" },
    duration_seconds: { type: "number" },
    replace_policy: { type: "string", enum: ["insert_beside", "replace_slot", "new_revision", "append_timeline"] },
    required_refs: { type: "array", items: { type: "string" } },
    status: { type: "string", enum: ["empty", "ready", "generating", "filled", "blocked"] },
    title: { type: "string" },
    x: { type: "number" },
    y: { type: "number" },
    width: { type: "number" },
    height: { type: "number" }
  }, (args) => service.updateGenerationSlot(args)));

  api.registerTool(tool("video_canvas_delete_shape", "Remove a card from a canvas without deleting repository assets.", {
    shape_id: { type: "string" }
  }, (args) => service.deleteCanvasShape(args)));

  api.registerTool(tool("video_canvas_link_shapes", "Create or update a relationship edge between two canvas shapes.", {
    canvas_id: { type: "string" },
    edge_id: { type: "string" },
    source_shape_id: { type: "string" },
    target_shape_id: { type: "string" },
    relation_type: { type: "string", enum: ["uses", "depends_on", "references", "derived_from", "revises", "replaces", "continues", "belongs_to", "appears_in", "blocks", "contains", "related_to"] },
    label: { type: "string" },
    props: { type: "object", additionalProperties: true }
  }, (args) => service.linkCanvasShapes(args)));

  api.registerTool(tool("video_canvas_unlink_shapes", "Delete a canvas relationship edge.", {
    edge_id: { type: "string" }
  }, (args) => service.unlinkCanvasShapes(args)));

  api.registerTool(tool("video_canvas_agent_context", "Return Agent-readable canvas context, visible shapes, offscreen clusters, and lint issues.", {
    canvas_id: { type: "string" },
    viewport: { type: "object", additionalProperties: true }
  }, (args) => service.canvasAgentContext(args)));

  api.registerTool(tool("video_canvas_widget_context", "Return native-widget-ready canvas context with selection and view state.", {
    canvas_id: { type: "string" },
    viewport: { type: "object", additionalProperties: true }
  }, (args) => service.canvasWidgetContext(args)));

  api.registerTool(rawTool("render_video_assets_canvas_widget", "Return a Cowart-style native widget render descriptor for the Video Assets infinite canvas.", {
    canvas_id: { type: "string" },
    project_id: { type: "string" },
    title: { type: "string" },
    display_mode: { type: "string", enum: ["inline", "fullscreen", "pip"] },
    viewport: { type: "object", additionalProperties: true }
  }, (args) => service.renderCanvasWidget(args)));

  api.registerTool(tool("video_canvas_save_selection", "Save transient canvas widget selection without creating an audit commit.", {
    canvas_id: { type: "string" },
    selected_shape_ids: { type: "array", items: { type: "string" } },
    primary_shape_id: { type: "string" },
    source: { type: "string" }
  }, (args) => service.saveCanvasSelection(args)));

  api.registerTool(tool("video_canvas_get_selection", "Get the current transient canvas widget selection.", {
    canvas_id: { type: "string" }
  }, (args) => service.getCanvasSelection(args)));

  api.registerTool(tool("video_canvas_save_view_state", "Save transient canvas widget viewport state without creating an audit commit.", {
    canvas_id: { type: "string" },
    viewport: { type: "object", additionalProperties: true },
    source: { type: "string" }
  }, (args) => service.saveCanvasViewState(args)));

  api.registerTool(tool("video_canvas_get_view_state", "Get the current transient canvas widget viewport state.", {
    canvas_id: { type: "string" }
  }, (args) => service.getCanvasViewState(args)));

  api.registerTool(tool("video_canvas_generation_package", "Build a generation-prep input package from a production canvas.", {
    canvas_id: { type: "string" },
    generation_type: { type: "string", enum: ["image", "image_to_video", "text_to_video", "multimodal_to_video", "edit", "voice", "subtitle", "cover", "export"] }
  }, (args) => service.canvasGenerationPackage(args)));

  api.registerTool(tool("video_canvas_generation_handoff", "Build an executable generation handoff package from a production canvas.", {
    canvas_id: { type: "string" },
    generation_type: { type: "string", enum: ["image", "image_to_video", "text_to_video", "multimodal_to_video", "edit", "voice", "subtitle", "cover", "export"] }
  }, (args) => service.canvasGenerationHandoff(args)));

  api.registerTool(tool("video_canvas_export_annotation_brief", "Build a review brief from a canvas shape for annotation or revision planning.", {
    canvas_id: { type: "string" },
    shape_id: { type: "string" },
    title: { type: "string" },
    body: { type: "string" },
    severity: { type: "string" },
    requested_change: { type: "string" },
    screenshot_asset_version_id: { type: "string" },
    annotation_type: { type: "string", enum: ["review_note", "prompt_note", "visual_continuity", "production_note", "other"] },
    visibility: { type: "string", enum: ["internal", "project", "public_summary"] }
  }, (args) => service.canvasReviewBrief(args)));

  api.registerTool(tool("video_canvas_register_review_annotation", "Register a canvas review note on the selected asset, version, entity, or project reference.", {
    canvas_id: { type: "string" },
    shape_id: { type: "string" },
    title: { type: "string" },
    body: { type: "string" },
    severity: { type: "string" },
    requested_change: { type: "string" },
    screenshot_asset_version_id: { type: "string" },
    annotation_type: { type: "string", enum: ["review_note", "prompt_note", "visual_continuity", "production_note", "other"] },
    visibility: { type: "string", enum: ["internal", "project", "public_summary"] },
    structured: { type: "object", additionalProperties: true }
  }, (args) => service.registerCanvasReviewAnnotation(args)));

  api.registerTool(tool("video_canvas_create_revision_card", "Create a canvas revision card from a review annotation or generated output lineage.", {
    canvas_id: { type: "string" },
    source_shape_id: { type: "string" },
    shape_id: { type: "string" },
    annotation_id: { type: "string" },
    title: { type: "string" },
    body: { type: "string" },
    requested_change: { type: "string" },
    severity: { type: "string" },
    status: { type: "string" },
    screenshot_asset_version_id: { type: "string" },
    stage: { type: "string" },
    x: { type: "number" },
    y: { type: "number" },
    width: { type: "number" },
    height: { type: "number" }
  }, (args) => service.createCanvasRevisionCard(args)));

  api.registerTool(tool("video_canvas_update_revision_card_status", "Update a canvas revision card workflow status without changing its source annotation or output lineage.", {
    shape_id: { type: "string" },
    status: { type: "string", enum: ["open", "in_progress", "resolved", "rejected"] },
    status_note: { type: "string" },
    title: { type: "string" }
  }, (args) => service.updateCanvasRevisionCardStatus(args)));

  api.registerTool(tool("video_canvas_insert_generated_asset", "Ingest a generated file, add it to the project, and write it back beside a generation slot.", {
    canvas_id: { type: "string" },
    slot_shape_id: { type: "string" },
    file_path: { type: "string" },
    title: { type: "string" },
    description: { type: "string" },
    kind: { type: "string", enum: ["raw", "working"] },
    tags: { type: "array", items: { type: "string" } },
    license_status: { type: "string", enum: ["unknown", "cleared", "restricted", "rejected"] },
    risk_level: { type: "string", enum: ["unknown", "low", "medium", "high"] },
    source: { type: "object", additionalProperties: true },
    classification: { type: "object", additionalProperties: true },
    project_ref: { type: "object", additionalProperties: true },
    writeback: { type: "object", additionalProperties: true },
    slot_status: { type: "string", enum: ["empty", "ready", "generating", "filled", "blocked"] }
  }, (args) => service.insertGeneratedAsset(args)));

  api.registerTool(tool("video_canvas_fill_generation_slot", "Fill a generation slot with a generated file using ingest-first asset writeback defaults.", {
    canvas_id: { type: "string" },
    slot_shape_id: { type: "string" },
    file_path: { type: "string" },
    title: { type: "string" },
    description: { type: "string" },
    kind: { type: "string", enum: ["raw", "working"] },
    tags: { type: "array", items: { type: "string" } },
    license_status: { type: "string", enum: ["unknown", "cleared", "restricted", "rejected"] },
    risk_level: { type: "string", enum: ["unknown", "low", "medium", "high"] },
    rights_notes: { type: "string" },
    source: { type: "object", additionalProperties: true },
    classification: { type: "object", additionalProperties: true },
    project_ref: { type: "object", additionalProperties: true },
    writeback: { type: "object", additionalProperties: true },
    slot_status: { type: "string", enum: ["empty", "ready", "generating", "filled", "blocked"] }
  }, (args) => service.fillGenerationSlot(args)));

  api.registerTool(tool("video_audio_doubao_plan", "Build a Doubao Audio 1.0 request package without executing generation.", doubaoAudioToolSchema({
    includeCanvas: false
  }), (args) => service.doubaoAudioPlan(args)));

  api.registerTool(tool("video_audio_doubao_generate", "Run Doubao Audio 1.0 generation and ingest outputs as cleared assets after platform review.", doubaoAudioToolSchema({
    includeCanvas: false
  }), (args) => service.doubaoAudioGenerate(args)));

  api.registerTool(tool("video_canvas_doubao_audio_plan", "Build a Doubao Audio 1.0 request package from a canvas audio generation slot.", doubaoAudioToolSchema({
    includeCanvas: true
  }), (args) => service.canvasDoubaoAudioPlan(args)));

  api.registerTool(tool("video_canvas_doubao_audio_generate", "Run Doubao Audio 1.0 generation from a canvas audio slot and write outputs back to canvas.", doubaoAudioToolSchema({
    includeCanvas: true
  }), (args) => service.canvasDoubaoAudioGenerate(args)));

  api.registerTool(tool("video_audio_kie_suno_plan", "Build a KIE Suno API music request package without submitting a task.", kieSunoToolSchema({
    includeCanvas: false
  }), (args) => service.kieSunoPlan(args)));

  api.registerTool(tool("video_audio_kie_suno_generate", "Run KIE Suno API music generation and ingest downloaded outputs as rights-unknown assets.", kieSunoToolSchema({
    includeCanvas: false
  }), (args) => service.kieSunoGenerate(args)));

  api.registerTool(tool("video_canvas_kie_suno_audio_plan", "Build a KIE Suno request package from a canvas audio generation slot.", kieSunoToolSchema({
    includeCanvas: true
  }), (args) => service.canvasKieSunoPlan(args)));

  api.registerTool(tool("video_canvas_kie_suno_audio_generate", "Run KIE Suno generation from a canvas audio slot and write outputs back to canvas.", kieSunoToolSchema({
    includeCanvas: true
  }), (args) => service.canvasKieSunoGenerate(args)));

  api.registerTool(tool("video_canvas_dreamina_cli_plan", "Build a Dreamina CLI execution plan from a canvas handoff without consuming credits.", {
    canvas_id: { type: "string" },
    generation_type: { type: "string", enum: ["image", "image_to_video", "text_to_video", "multimodal_to_video", "edit", "voice", "subtitle", "cover", "export"] }
  }, (args) => service.canvasDreaminaCliPlan(args)));

  api.registerTool(tool("video_canvas_dreamina_cli_generate_video", "Run Dreamina CLI video generation from a canvas handoff with strict video model parameter validation.", {
    canvas_id: { type: "string" },
    generation_type: { type: "string", enum: ["image_to_video", "text_to_video", "multimodal_to_video"] },
    prompt: { type: "string" },
    model_version: { type: "string", enum: ["3.0", "3.0fast", "3.0pro", "3.0_fast", "3.0_pro", "3.5pro", "3.5_pro", "seedance2.0", "seedance2.0fast", "seedance2.0_vip", "seedance2.0fast_vip", "seedance2.0mini"] },
    duration: { type: "number" },
    video_resolution: { type: "string", enum: ["720p", "1080p"] },
    ratio: { type: "string", enum: ["1:1", "3:4", "16:9", "4:3", "9:16", "21:9"] },
    poll: { type: "number" },
    session: { type: "number" },
    output_dir: { type: "string" },
    execute: { type: "boolean" },
    accept_credit_spend: { type: "boolean" },
    run_preflight: { type: "boolean" },
    download_outputs: { type: "boolean" },
    ingest_outputs: { type: "boolean" },
    writeback_canvas: { type: "boolean" },
    output_title: { type: "string" },
    license_status: { type: "string", enum: ["unknown", "cleared", "restricted", "rejected"] },
    risk_level: { type: "string", enum: ["unknown", "low", "medium", "high"] },
    timeout_ms: { type: "number" },
    actor_id: { type: "string" },
    actor_type: { type: "string" }
  }, (args) => service.canvasDreaminaCliGenerateVideo(args)));

  api.registerTool(tool("video_canvas_lint", "Lint a canvas for missing bindings and production readiness warnings.", {
    canvas_id: { type: "string" }
  }, (args) => service.lintCanvas(args)));
}

function registerSecurityRoutes(api) {
  api.registerHttpRoute({
    path: "/__openclaw__/video-assets/auth/login",
    auth: "plugin",
    match: "exact",
    handler: async (req, res) => {
      if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "method not allowed" });
      const origin = security.checkOrigin(req);
      if (!origin.ok) return sendJson(res, origin.status, { ok: false, error: origin.error });
      try {
        const body = await readJsonBody(req);
        const result = await security.login({
          password: body.password,
          ip: getClientIp(req),
          userAgent: String(req.headers["user-agent"] ?? "")
        });
        if (!result.ok) return sendJson(res, result.status, { ok: false, error: result.error });
        setSessionCookie(res, result.token, security.sessionTtlMs);
        return sendJson(res, 200, { ok: true });
      } catch (error) {
        return sendJson(res, error.status ?? 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
  });

  api.registerHttpRoute({
    path: "/__openclaw__/video-assets/auth/logout",
    auth: "plugin",
    match: "exact",
    handler: async (req, res) => {
      const auth = security.authenticateRequest(req);
      if (!auth.ok) return sendJson(res, auth.status, { ok: false, error: auth.error });
      security.logout(getRequestToken(req));
      clearSessionCookie(res);
      return sendJson(res, 200, { ok: true });
    }
  });

  api.registerHttpRoute({
    path: "/__openclaw__/video-assets/auth/status",
    auth: "plugin",
    match: "exact",
    handler: async (req, res) => {
      const auth = security.authenticateRequest(req);
      if (!auth.ok) return sendJson(res, auth.status, { ok: false, error: auth.error });
      return sendJson(res, 200, { ok: true, actor_id: auth.actor_id });
    }
  });
}

function registerUiApiRoute(api) {
  api.registerHttpRoute({
    path: "/__openclaw__/video-assets/rpc/",
    auth: "plugin",
    match: "prefix",
    handler: async (req, res) => {
      if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "method not allowed" });
      const origin = security.checkOrigin(req);
      if (!origin.ok) return sendJson(res, origin.status, { ok: false, error: origin.error });
      const auth = security.authenticateRequest(req);
      if (!auth.ok) return sendJson(res, auth.status, { ok: false, error: auth.error });
      try {
        const body = await readJsonBody(req, 120 * 1024 * 1024);
        const method = String(body.method ?? "");
        const handler = uiBrowserRpc()[method];
        if (!handler) return sendJson(res, 404, { ok: false, error: `unknown ui rpc method: ${method}` });
        return sendJson(res, 200, { ok: true, result: await handler(body.params ?? {}) });
      } catch (error) {
        return sendJson(res, error.status ?? 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
  });
}

function registerSecureFileRoutes(api) {
  api.registerHttpRoute({
    path: "/__openclaw__/video-assets/file/",
    auth: "plugin",
    match: "prefix",
    handler: async (req, res) => handleVersionFileRequest(req, res)
  });
  api.registerHttpRoute({
    path: "/__openclaw__/video-assets/thumb/",
    auth: "plugin",
    match: "prefix",
    handler: async (req, res) => handleDerivedFileRequest(req, res, "/__openclaw__/video-assets/thumb/", ["thumbnail", "contact_sheet"], "thumbnail")
  });
  api.registerHttpRoute({
    path: "/__openclaw__/video-assets/proxy/",
    auth: "plugin",
    match: "prefix",
    handler: async (req, res) => handleDerivedFileRequest(req, res, "/__openclaw__/video-assets/proxy/", ["proxy", "transcode", "audio_proxy"], "proxy")
  });
}

function registerUiRoutes(api) {
  api.registerHttpRoute({
    path: "/__openclaw__/video-assets/workbench/",
    auth: "plugin",
    match: "prefix",
    handler: async (req, res) => handleUiAssetRequest(req, res)
  });
}

async function handleUiAssetRequest(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return sendJson(res, 405, { ok: false, error: "method not allowed" });
  }
  const origin = security.checkOrigin(req);
  if (!origin.ok) return sendJson(res, origin.status, { ok: false, error: origin.error });
  try {
    const url = new URL(req.url ?? "/__openclaw__/video-assets/workbench/", "http://127.0.0.1");
    let relativePath = decodeURIComponent(url.pathname.slice("/__openclaw__/video-assets/workbench/".length));
    if (!relativePath || relativePath.endsWith("/")) relativePath = `${relativePath}index.html`;
    let filePath = safeResolveUiPath(relativePath);
    if (!fs.existsSync(filePath) || (await fs.promises.stat(filePath)).isDirectory()) {
      filePath = safeResolveUiPath("index.html");
    }
    const stat = await fs.promises.stat(filePath);
    applySecurityHeaders(res, { contentSecurityPolicy: UI_CONTENT_SECURITY_POLICY });
    res.statusCode = 200;
    res.setHeader("content-type", contentTypeFor(filePath));
    res.setHeader("content-length", String(stat.size));
    if (req.method === "HEAD") return res.end();
    return fs.createReadStream(filePath).pipe(res);
  } catch (error) {
    return sendJson(res, error.status ?? 404, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

function safeResolveUiPath(relativePath) {
  const cleaned = String(relativePath ?? "").replaceAll("\\", "/").replace(/^\/+/, "");
  if (path.isAbsolute(relativePath) || cleaned.split("/").includes("..")) {
    throw new Error("invalid ui path");
  }
  const filePath = path.resolve(UI_DIST_DIR, cleaned);
  const relative = path.relative(UI_DIST_DIR, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("invalid ui path");
  return filePath;
}

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp"
  }[ext] ?? "application/octet-stream";
}

async function handleVersionFileRequest(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return sendJson(res, 405, { ok: false, error: "method not allowed" });
  }
  const origin = security.checkOrigin(req);
  if (!origin.ok) return sendJson(res, origin.status, { ok: false, error: origin.error });
  const auth = security.authenticateRequest(req);
  if (!auth.ok) return sendJson(res, auth.status, { ok: false, error: auth.error });

  try {
    const assetVersionId = extractRouteId(req.url, "/__openclaw__/video-assets/file/");
    const file = service.resolveVersionFile(assetVersionId);
    const stat = await fs.promises.stat(file.file_path);
    if (!stat.isFile()) return sendJson(res, 404, { ok: false, error: "file object is missing" });

    applySecurityHeaders(res, { contentSecurityPolicy: null });
    res.statusCode = 200;
    res.setHeader("content-type", file.mime_type || "application/octet-stream");
    res.setHeader("content-length", String(stat.size));
    res.setHeader("content-disposition", `attachment; filename="${sanitizeDownloadName(file.file_name)}"`);
    res.setHeader("x-openclaw-asset-version-id", file.asset_version_id);
    res.setHeader("x-openclaw-content-sha256", file.sha256);
    if (req.method === "HEAD") return res.end();
    return fs.createReadStream(file.file_path).pipe(res);
  } catch (error) {
    return sendJson(res, error.status ?? 404, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

async function handleDerivedFileRequest(req, res, prefix, allowedTypes, label) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return sendJson(res, 405, { ok: false, error: "method not allowed" });
  }
  const origin = security.checkOrigin(req);
  if (!origin.ok) return sendJson(res, origin.status, { ok: false, error: origin.error });
  const auth = security.authenticateRequest(req);
  if (!auth.ok) return sendJson(res, auth.status, { ok: false, error: auth.error });

  try {
    const identifier = extractRouteId(req.url, prefix);
    const file = service.resolveDerivedFile(identifier, allowedTypes);
    const stat = await fs.promises.stat(file.file_path);
    if (!stat.isFile()) return sendJson(res, 404, { ok: false, error: `${label} object is missing` });

    applySecurityHeaders(res, { contentSecurityPolicy: null });
    res.statusCode = 200;
    res.setHeader("content-type", file.mime_type || "application/octet-stream");
    res.setHeader("content-length", String(stat.size));
    res.setHeader("content-disposition", `inline; filename="${sanitizeDownloadName(file.file_name)}"`);
    res.setHeader("x-openclaw-asset-id", file.asset_id);
    res.setHeader("x-openclaw-asset-version-id", file.asset_version_id);
    res.setHeader("x-openclaw-derived-file-id", file.derived_file_id);
    res.setHeader("x-openclaw-derivative-type", file.derivative_type);
    res.setHeader("x-openclaw-content-sha256", file.sha256);
    if (req.method === "HEAD") return res.end();
    return fs.createReadStream(file.file_path).pipe(res);
  } catch (error) {
    return sendJson(res, error.status ?? 404, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

function extractRouteId(rawUrl, prefix) {
  const url = new URL(rawUrl ?? prefix, "http://127.0.0.1");
  if (!url.pathname.startsWith(prefix)) throw new Error("invalid route");
  const id = decodeURIComponent(url.pathname.slice(prefix.length));
  if (!/^[A-Za-z0-9_:-]+$/.test(id)) throw new Error("invalid route id");
  return id;
}

function sanitizeDownloadName(name) {
  return path.basename(String(name)).replace(/["\r\n]/g, "_") || "asset.bin";
}

function registerRpc(api) {
  const rpc = allRpc();

  for (const [name, definition] of Object.entries(rpc)) {
    api.registerGatewayMethod(name, async ({ params, respond }) => {
      try {
        respond({ ok: true, result: await definition.handler(params ?? {}) });
      } catch (error) {
        respond({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    }, { scope: definition.scope });
  }
}

function allRpc() {
  return {
    "videoAssets.asset.search": read((params) => service.searchAssets(params)),
    "videoAssets.asset.get": read((params) => service.getAsset(params)),
    "videoAssets.asset.updateRights": write((params) => service.updateAssetRights(params)),
    "videoAssets.asset.create": write((params) => service.ingestAsset(params)),
    "videoAssets.asset.createVersion": write((params) => service.createVersion(params)),
    "videoAssets.asset.createBranch": write((params) => service.createBranch(params)),
    "videoAssets.asset.saveCopy": write((params) => service.saveCopy(params)),
    "videoAssets.asset.lineage": read((params) => service.lineage(params)),
    "videoAssets.asset.registerDerivedFile": write((params) => service.registerDerivedFile(params)),
    "videoAssets.asset.generateDerivedFile": write((params) => service.generateDerivedFile(params)),
    "videoAssets.asset.derivedFiles": read((params) => service.listDerivedFiles(params)),
    "videoAssets.asset.integrityScan": read((params) => service.integrityScan(params)),
    "videoAssets.asset.classify": write((params) => service.classifyAsset(params)),
    "videoAssets.asset.getClassification": read((params) => service.getAssetClassification(params)),
    "videoAssets.asset.taxonomyReport": read((params) => service.assetTaxonomyReport(params)),
    "videoAssets.entity.create": write((params) => service.createEntity(params)),
    "videoAssets.entity.search": read((params) => service.searchEntities(params)),
    "videoAssets.entity.linkAsset": write((params) => service.linkEntityAsset(params)),
    "videoAssets.annotation.create": write((params) => service.annotateAsset(params)),
    "videoAssets.annotation.list": read((params) => service.listAnnotations(params)),
    "videoAssets.annotation.update": write((params) => service.updateAnnotation(params)),
    "videoAssets.project.create": write((params) => service.createProject(params)),
    "videoAssets.project.updateSpec": write((params) => service.updateProjectSpec(params)),
    "videoAssets.project.search": read((params) => service.searchProjects(params)),
    "videoAssets.project.get": read((params) => service.getProjectDetail(params)),
    "videoAssets.project.addRef": write((params) => service.addProjectRef(params)),
    "videoAssets.project.updateRef": write((params) => service.updateProjectRef(params)),
    "videoAssets.project.removeRef": write((params) => service.removeProjectRef(params)),
    "videoAssets.project.listRefs": read((params) => service.listProjectRefs(params)),
    "videoAssets.project.report": read((params) => service.projectReport(params)),
    "videoAssets.project.continuityReport": read((params) => service.projectContinuityReport(params)),
    "videoAssets.canvas.create": write((params) => service.createCanvas(params)),
    "videoAssets.canvas.search": read((params) => service.searchCanvases(params)),
    "videoAssets.canvas.applyProductionTemplate": write((params) => service.applyProductionCanvasTemplate(params)),
    "videoAssets.canvas.get": read((params) => service.getCanvas(params)),
    "videoAssets.canvas.saveSnapshot": write((params) => service.saveCanvasSnapshot(params)),
    "videoAssets.canvas.upsertShape": write((params) => service.upsertCanvasShape(params)),
    "videoAssets.canvas.createGenerationSlot": write((params) => service.createGenerationSlot(params)),
    "videoAssets.canvas.updateGenerationSlot": write((params) => service.updateGenerationSlot(params)),
    "videoAssets.canvas.deleteShape": write((params) => service.deleteCanvasShape(params)),
    "videoAssets.canvas.linkShapes": write((params) => service.linkCanvasShapes(params)),
    "videoAssets.canvas.unlinkShapes": write((params) => service.unlinkCanvasShapes(params)),
    "videoAssets.canvas.agentContext": read((params) => service.canvasAgentContext(params)),
    "videoAssets.canvas.widgetContext": read((params) => service.canvasWidgetContext(params)),
    "videoAssets.canvas.saveSelection": write((params) => service.saveCanvasSelection(params)),
    "videoAssets.canvas.getSelection": read((params) => service.getCanvasSelection(params)),
    "videoAssets.canvas.saveViewState": write((params) => service.saveCanvasViewState(params)),
    "videoAssets.canvas.getViewState": read((params) => service.getCanvasViewState(params)),
    "videoAssets.canvas.generationPackage": read((params) => service.canvasGenerationPackage(params)),
    "videoAssets.canvas.generationHandoff": read((params) => service.canvasGenerationHandoff(params)),
    "videoAssets.canvas.reviewBrief": read((params) => service.canvasReviewBrief(params)),
    "videoAssets.canvas.registerReviewAnnotation": write((params) => service.registerCanvasReviewAnnotation(params)),
    "videoAssets.canvas.createRevisionCard": write((params) => service.createCanvasRevisionCard(params)),
    "videoAssets.canvas.updateRevisionCardStatus": write((params) => service.updateCanvasRevisionCardStatus(params)),
    "videoAssets.canvas.insertGeneratedAsset": write((params) => service.insertGeneratedAsset(params)),
    "videoAssets.canvas.fillGenerationSlot": write((params) => service.fillGenerationSlot(params)),
    "videoAssets.audio.doubaoPlan": read((params) => service.doubaoAudioPlan(params)),
    "videoAssets.audio.doubaoGenerate": write((params) => service.doubaoAudioGenerate(params)),
    "videoAssets.canvas.doubaoAudioPlan": read((params) => service.canvasDoubaoAudioPlan(params)),
    "videoAssets.canvas.doubaoAudioGenerate": write((params) => service.canvasDoubaoAudioGenerate(params)),
    "videoAssets.audio.kieSunoPlan": read((params) => service.kieSunoPlan(params)),
    "videoAssets.audio.kieSunoGenerate": write((params) => service.kieSunoGenerate(params)),
    "videoAssets.canvas.kieSunoAudioPlan": read((params) => service.canvasKieSunoPlan(params)),
    "videoAssets.canvas.kieSunoAudioGenerate": write((params) => service.canvasKieSunoGenerate(params)),
    "videoAssets.canvas.dreaminaCliPlan": read((params) => service.canvasDreaminaCliPlan(params)),
    "videoAssets.canvas.dreaminaCliGenerateVideo": write((params) => service.canvasDreaminaCliGenerateVideo(params)),
    "videoAssets.canvas.lint": read((params) => service.lintCanvas(params)),
    "videoAssets.file.roots": read(() => service.fileRoots()),
    "videoAssets.file.list": read((params) => service.listFiles(params)),
    "videoAssets.file.inspect": read((params) => service.inspectFile(params)),
    "videoAssets.file.search": read((params) => service.searchFiles(params)),
    "videoAssets.staging.upload": write((params) => service.uploadStagingFile(params)),
    "videoAssets.staging.ingest": write((params) => service.ingestStagingFile(params)),
    "videoAssets.staging.reject": write((params) => service.rejectStagingFile(params)),
    "videoAssets.audit.commits": read((params) => service.listCommits(params)),
    "videoAssets.ui.dashboardSummary": read(() => service.uiDashboardSummary())
  };
}

function uiBrowserRpc() {
  const methods = allRpc();
  const browserWriteAllowlist = new Set([
    "videoAssets.staging.upload",
    "videoAssets.staging.ingest",
    "videoAssets.staging.reject",
    "videoAssets.project.updateSpec",
    "videoAssets.project.addRef",
    "videoAssets.project.updateRef",
    "videoAssets.project.removeRef",
    "videoAssets.asset.updateRights",
    "videoAssets.asset.classify",
    "videoAssets.annotation.create",
    "videoAssets.annotation.update",
    "videoAssets.canvas.create",
    "videoAssets.canvas.applyProductionTemplate",
    "videoAssets.canvas.saveSnapshot",
    "videoAssets.canvas.saveSelection",
    "videoAssets.canvas.saveViewState",
    "videoAssets.canvas.upsertShape",
    "videoAssets.canvas.createGenerationSlot",
    "videoAssets.canvas.updateGenerationSlot",
    "videoAssets.canvas.registerReviewAnnotation",
    "videoAssets.canvas.createRevisionCard",
    "videoAssets.canvas.updateRevisionCardStatus",
    "videoAssets.canvas.insertGeneratedAsset",
    "videoAssets.canvas.fillGenerationSlot",
    "videoAssets.audio.kieSunoGenerate",
    "videoAssets.canvas.kieSunoAudioGenerate",
    "videoAssets.canvas.deleteShape",
    "videoAssets.canvas.linkShapes",
    "videoAssets.canvas.unlinkShapes"
  ]);
  const browserMethods = Object.entries(methods)
    .filter(([name, definition]) => definition.scope === "operator.read" || browserWriteAllowlist.has(name))
    .map(([name, definition]) => [name, definition.handler]);
  const map = Object.fromEntries(browserMethods);
  // Add short aliases (strip "videoAssets." prefix) for browser UI convenience
  for (const [name, handler] of browserMethods) {
    if (name.startsWith("videoAssets.")) {
      const short = name.slice("videoAssets.".length);
      if (!(short in map)) map[short] = handler;
    }
  }
  return map;
}

function read(handler) {
  return { scope: "operator.read", handler };
}

function write(handler) {
  return { scope: "operator.write", handler };
}

function tool(name, description, properties, handler) {
  const localizedDescription = localizedToolDescription(name, description);
  return {
    name,
    description: localizedDescription,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties
    },
    async execute(_toolCallId, args) {
      try {
        const result = await handler(args ?? {});
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return { content: [{ type: "text", text: `ERROR: ${error instanceof Error ? error.message : String(error)}` }] };
      }
    }
  };
}

function rawTool(name, description, properties, handler) {
  const localizedDescription = localizedToolDescription(name, description);
  return {
    name,
    description: localizedDescription,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties
    },
    async execute(_toolCallId, args) {
      try {
        return await handler(args ?? {});
      } catch (error) {
        return { content: [{ type: "text", text: `ERROR: ${error instanceof Error ? error.message : String(error)}` }] };
      }
    }
  };
}
