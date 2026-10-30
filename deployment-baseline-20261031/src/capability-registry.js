// ============================================================================
// REN-09 · Provider / Model Capability Registry（唯一真相源）
// ============================================================================
// 目的：把「供应商 → 端点 → 模型 → 参数窗口 → 生命周期 → 成本/授权证据」收束成
// 单一注册表，并由它派生工具 schema enum、文档矩阵与校验逻辑，消除「enum / Set /
// 文档 / README 四处分散写」导致的漂移。
//
// 纪律（与工程任务书、父审证据裁决一致）：
//   1. 每条能力事实必须带来源：`evidence` 引用本文件 EVIDENCE 中的条目（含 URL 与核查时间）。
//   2. 未经真机验证的成本 / 授权一律显式写 `unknown`，不得默认 cleared。
//   3. 不按编号大小猜测「最新」；候选代次（candidate）不得表述为市场最新。
//   4. legacy / read_only_history 只增不删：删除会让历史参数与兼容调用直接失败。
//   5. 只有替代链通过真机验收，才允许停止旧端点/旧模型的「新请求」。
//
// 参考：dreamina CLI 1.4.18（build ec1b9fa / 2026-09-09）各子命令 --help 实测；
//       火山引擎豆包语音官方 HTTP 文档；KIE 官方文档（新 / 旧两套端点）。
// ============================================================================

export const CAPABILITY_REGISTRY_SCHEMA_VERSION = "capability_registry_v1";

// ---------------------------------------------------------------------------
// 0. 官方证据目录（URL + 核查时间 + 载体哈希）
// ---------------------------------------------------------------------------
// checked_at 为本轮实际抓取/实测时间（Asia/Shanghai）。载体文件位于工程档案
// implementation/REN-09/evidence/ 下，可复跑复核。
export const EVIDENCE = Object.freeze({
  "dreamina-cli-help-1.4.18": Object.freeze({
    kind: "vendor_cli_help",
    vendor: "Dreamina / 即梦",
    url: "local:C:\\Users\\Administrator\\bin\\dreamina.exe",
    capture_note: "各子命令 --help 与 version 输出（只读，零积分）",
    artifact: "evidence/cli/*.txt",
    cli_sha256: "13a817e455179ab994495eedb875cf845348d05f526b21c2ef207e1fc47f6014",
    checked_at: "2026-09-20T23:44:39+08:00"
  }),
  "dreamina-cli-version-json": Object.freeze({
    kind: "vendor_cli_distribution",
    vendor: "Dreamina / 即梦",
    url: "https://jimeng.jianying.com/cli",
    capture_note: "CLI 自带 version.json：version 1.4.18 / release_date 2026-09-10 / 官方更新命令",
    artifact: "evidence/cli/00-header.txt",
    checked_at: "2026-09-20T23:52:00+08:00"
  }),
  "dreamina-cli-shipped-skill": Object.freeze({
    kind: "vendor_shipped_doc",
    vendor: "Dreamina / 即梦",
    url: "local:C:\\Users\\Administrator\\.dreamina_cli\\dreamina\\SKILL.md",
    capture_note: "CLI 随包发布的官方技能说明（模型选择以子命令 help 为准、seedance2.5 + image2video 必须省略 ratio）",
    checked_at: "2026-09-20T23:53:00+08:00"
  }),
  "doubao-audio-http-doc": Object.freeze({
    kind: "vendor_official_doc",
    vendor: "Volcengine 豆包语音",
    url: "https://docs.volcengine.com/docs/6561/2550782?lang=zh",
    capture_note: "音频生成 HTTP：POST https://openspeech.bytedance.com/api/v3/tts/create；X-Api-Key 新版鉴权；model 仅 seed-audio-1.0",
    artifact: "evidence/official-docs/volc-doubao-tts-doc.*",
    doc_updated_at: "2026-08-20T21:25:00+08:00",
    checked_at: "2026-09-20T23:48:00+08:00"
  }),
  "kie-docs-getting-started": Object.freeze({
    kind: "vendor_official_doc",
    vendor: "KIE",
    url: "https://docs.kie.ai/",
    capture_note: "异步任务模型、媒体保留 14 天、限流 20 请求/10 秒（超额 429）",
    artifact: "evidence/official-docs/kie-root.*",
    checked_at: "2026-09-20T23:47:00+08:00"
  }),
  "kie-docs-suno-generate-music": Object.freeze({
    kind: "vendor_official_doc",
    vendor: "KIE",
    url: "https://docs.kie.ai/suno-api/generate-music",
    capture_note: "现行端点 POST /api/v1/jobs/createTask；取任务 GET /api/v1/jobs/recordInfo；模型字符上限含 V6 家族；页面明示旧版文档入口",
    artifact: "evidence/official-docs/kie-suno-generate-music.*",
    checked_at: "2026-09-20T23:47:00+08:00"
  }),
  "kie-docs-old-model": Object.freeze({
    kind: "vendor_official_doc_legacy",
    vendor: "KIE",
    url: "https://docs.kie.ai/old-model/suno-api/generate-music",
    capture_note: "旧版（本插件当前实现）端点族：/api/v1/generate、/api/v1/generate/record-info 等；仍在线可访问",
    artifact: "evidence/official-docs/kie-old-model-generate-music.*",
    checked_at: "2026-09-20T23:50:00+08:00"
  }),
  "backend-version-whitelist-20260920": Object.freeze({
    kind: "zero_cost_backend_probe",
    vendor: "Dreamina / 即梦",
    url: "local:dreamina.exe (illegal model value echo)",
    capture_note: "用非法 model 值 + 真实输入文件触发后端回显白名单（零成本，上传阶段不计费）；三类命令白名单互不相同",
    artifact: "docs/notes/channel-notes-dreamina-cli-2026-09-19.md",
    checked_at: "2026-09-20T02:00:00+08:00"
  }),
  "verified-paid-samples-20260920": Object.freeze({
    kind: "real_generation_receipt",
    vendor: "Dreamina / 即梦",
    url: "local:plugin asset db (asset_fc34b3ed / asset_ef0053f9 / asset_c70b38b1)",
    capture_note: "seedance2.5 480p/4s=48、720p/5s=100；Seedream 5.0Pro 2k 出图=8 积分（有产出与入库证据）",
    artifact: "projects/video-platform-renewal-20260920/03-models-skills-audit.md §3.2",
    checked_at: "2026-09-20T02:41:00+08:00"
  }),
  "plugin-source-baseline-36a1c23": Object.freeze({
    kind: "code_baseline",
    vendor: "本插件候选仓库",
    url: "repo:video-assets@36a1c237fcb3ed54503a24e3a2739a66299c5bd8",
    capture_note: "REN-09 候选基线（REN-01 验收提交）",
    checked_at: "2026-09-20T23:45:00+08:00"
  }),
  "bytedance-seed-model-lineup": Object.freeze({
    kind: "vendor_official_site",
    vendor: "ByteDance Seed（模型厂商）",
    url: "https://seed.bytedance.com/en/seedance2_5",
    capture_note: "模型厂商官方页：Seedance 2.5 为音视频联合生成模型、面向 30 秒叙事；官方模型列表含 Seed2.1 / Seedance 2.5 / Seedream 5.0 Pro / SeedRealtime / Seed Audio 1.0",
    artifact: "evidence/official-docs/bytedance-seed-seedance2_5.*",
    checked_at: "2026-09-20T23:56:00+08:00"
  }),
  "dreamina-cli-channel-20260925": Object.freeze({
    kind: "vendor_cli_distribution",
    vendor: "Dreamina / 即梦",
    url: "https://jimeng.jianying.com/cli",
    capture_note: "官方分发渠道复核：该地址返回官方安装脚本（200 / 8869 B），脚本从 lf3-static.bytednsdoc.com/.../dreamina_cli_beta 取二进制、SKILL.md 与 version.json；官方 version.json = 1.4.18 / release_date 2026-09-10，与本机安装**完全一致**（无可用升级）；官方 SKILL.md MD5 fc22c32619bc9e248e7bf8b320462b37 与本机 %USERPROFILE%\\.dreamina_cli\\dreamina\\SKILL.md **逐字节一致**",
    artifact: "live-0925/evidence/official-docs-20260925/、live-0925/evidence/official-dist-20260925/、live-0925/evidence/01-help-*.txt",
    checked_at: "2026-09-25T08:58:00+08:00"
  }),
  "backend-version-whitelist-20260925": Object.freeze({
    kind: "zero_cost_backend_probe",
    vendor: "Dreamina / 即梦",
    url: "local:dreamina.exe（非法值探针 → 后端回显白名单）",
    capture_note: "复测（零成本：探针前后 user_credit 均 17591，tasks.db 对应行 commerce_info 为空）：image2video 白名单已**不含** 3.5pro/3.5_pro/seedance1.5pro；text2video 不含 3.0pro/3.0_pro/3.5*；multimodal2video 与 CLI help 一致；text2image 多出 CLI help 未列的 4.8 / 5.0lite；image_upscale resolution_type 回显 2k/4k/8k",
    artifact: "live-0925/evidence/probe*-*.stdout.txt、live-0925/evidence/probe-raw.json",
    checked_at: "2026-09-25T09:02:00+08:00"
  }),
  "verified-paid-samples-20260925": Object.freeze({
    kind: "real_generation_receipt",
    vendor: "Dreamina / 即梦",
    url: "local:CLI user_credit 差额 + %USERPROFILE%\\.dreamina_cli\\tasks.db 只读行",
    capture_note: "image_upscale 真机：2k→3840×2160 PNG，账户差额 1 = tasks.db credit_count 1（benefit image_pro_hd_vtwo_twok）；4k→4096×2304 PNG，账户差额 0 = credit_count 0（benefit image_pro_hd_vtwo_fourk，工具面因 CLI stdout 非 JSON 误报失败，产出经只读 query_result 恢复）；两档均未重试、未重复计费",
    artifact: "live-0925/output/upscale-2k/evidence/10-upscale-live.json、live-0925/output/upscale-4k/evidence/11-upscale-4k-live.json 与 12-upscale-4k-recover.json",
    checked_at: "2026-09-25T09:05:00+08:00"
  })
});

// ---------------------------------------------------------------------------
// 1. 生命周期分层
// ---------------------------------------------------------------------------
// default            : 未指定模型时的默认值（仅在显式决策后变更）
// candidate          : 表内可用；分「已真机验收」与「未验收」两种，用 verified 区分
// legacy             : CLI help 不列、后端仍受理；保留以免旧脚本 100% 失败
// disabled_new       : 明确不再受理新请求，但不得从历史中删除
// read_only_history  : 已确认无效/已移除的值，仅作为历史记录可读，永不进入新请求枚举
export const LIFECYCLE_STATES = Object.freeze(["default", "candidate", "legacy", "disabled_new", "read_only_history"]);

/** 只有这些状态允许进入「新请求」的可选枚举 */
export const NEW_REQUEST_LIFECYCLE_STATES = Object.freeze(["default", "candidate", "legacy"]);

// ---------------------------------------------------------------------------
// 2. 即梦视频模型注册表
// ---------------------------------------------------------------------------
// generation_types 决定模型可用于哪些生成型；duration / resolutions 与 CLI 校验规则逐项一致；
// multimodal_limits 仅在 multimodal_to_video 生效。新增或调整模型只改本表。
//
// 【后端 version 白名单核验 2026-09-20】CLI 本地不做 model 白名单校验，统一透传后端：
//   image2video       : 3.0_fast, 3.0_pro, 3.0fast, 3.0pro, 3.5_pro, 3.5pro, seedance1.0, seedance1.0fast, seedance1.5pro, 2.0 家族, seedance2.5
//   text2video        : 3.0_fast, 3.0fast, 3.5_pro, 3.5pro, seedance1.0fast, seedance1.5pro, 2.0 家族, seedance2.5（不含 3.0pro/3.0_pro）
//   multimodal2video  : 2.0 家族, seedance2.5（与 CLI help 完全一致）
// 【后端 version 白名单复测 2026-09-25】（同一手法：非法值探针；探针前后 user_credit 一致 = 0 扣费）
//   image2video       : 3.0_fast, 3.0_pro, 3.0fast, 3.0pro, seedance1.0, seedance1.0fast, 2.0 家族, seedance2.5
//                       → 比 2026-09-20 少 3.5pro / 3.5_pro / seedance1.5pro；差异登记在 contract_gaps，**未据此迁移生命周期**
//   text2video        : 3.0_fast, 3.0fast, seedance1.0fast, 2.0 家族, seedance2.5（不含 3.0pro/3.0_pro，亦不含 3.5*）
//   multimodal2video  : 2.0 家族, seedance2.5（与 CLI help 一致）
//   text2image        : 3.0, 3.1, 4.0, 4.1, 4.5, 4.6, 4.7, 4.8, 5.0, 5.0Pro, 5.0lite（多出 CLI help 未列的 4.8 / 5.0lite → 不入表）
//   image_upscale     : resolution_type 回显 2k, 4k, 8k（与注册表一致）
// ① 裸值 "3.0" 三类均不含 → read_only_history（不删除历史记录，也不出现在新请求枚举）
// ② 3.0*/3.5* 曾见于 i2v 白名单 → legacy，保留（勿误删）；但 2026-09-25 复测白名单已不含 3.5pro/3.5_pro，
//    受理状态存疑 → 保留注册与兼容，恢复或下线前须重测（见 contract_gaps）
// ③ seedance1.0 仅见于后端白名单、CLI help 不列且未验证真实生成 → 不入表（不臆测）
const DREAMINA_SEEDANCE2_GENERATION_TYPES = Object.freeze(["text_to_video", "image_to_video", "multimodal_to_video"]);
export const DREAMINA_MULTIMODAL_LIMITS_2X = Object.freeze({
  image: 9,
  video: 3,
  audio: 3,
  total: 12,
  audio_only: false,
  media_duration: Object.freeze([2, 15])
});
export const DREAMINA_MULTIMODAL_LIMITS_25 = Object.freeze({
  image: 30,
  video: 10,
  audio: 10,
  total: 50,
  audio_only: true,
  media_duration: Object.freeze([2, 30])
});

export const DREAMINA_VIDEO_MODEL_SPECS = Object.freeze({
  "seedance2.5": Object.freeze({ generation_types: DREAMINA_SEEDANCE2_GENERATION_TYPES, duration: Object.freeze([4, 30]), resolutions: Object.freeze(["480p", "720p", "1080p"]), vip_only: true, multimodal_limits: DREAMINA_MULTIMODAL_LIMITS_25 }),
  "seedance2.0": Object.freeze({ generation_types: DREAMINA_SEEDANCE2_GENERATION_TYPES, duration: Object.freeze([4, 15]), resolutions: Object.freeze(["720p"]), multimodal_limits: DREAMINA_MULTIMODAL_LIMITS_2X }),
  "seedance2.0fast": Object.freeze({ generation_types: DREAMINA_SEEDANCE2_GENERATION_TYPES, duration: Object.freeze([4, 15]), resolutions: Object.freeze(["720p"]), multimodal_limits: DREAMINA_MULTIMODAL_LIMITS_2X }),
  "seedance2.0_vip": Object.freeze({ generation_types: DREAMINA_SEEDANCE2_GENERATION_TYPES, duration: Object.freeze([4, 15]), resolutions: Object.freeze(["720p", "1080p", "4k"]), multimodal_limits: DREAMINA_MULTIMODAL_LIMITS_2X }),
  "seedance2.0fast_vip": Object.freeze({ generation_types: DREAMINA_SEEDANCE2_GENERATION_TYPES, duration: Object.freeze([4, 15]), resolutions: Object.freeze(["720p", "1080p"]), multimodal_limits: DREAMINA_MULTIMODAL_LIMITS_2X }),
  "seedance2.0mini": Object.freeze({ generation_types: DREAMINA_SEEDANCE2_GENERATION_TYPES, duration: Object.freeze([4, 15]), resolutions: Object.freeze(["720p"]), multimodal_limits: DREAMINA_MULTIMODAL_LIMITS_2X }),
  "seedance1.5pro": Object.freeze({ generation_types: Object.freeze(["image_to_video"]), duration: Object.freeze([5, 12]), resolutions: Object.freeze(["720p"]) }),
  "seedance1.0fast": Object.freeze({ generation_types: Object.freeze(["image_to_video"]), duration: Object.freeze([5, 10]), resolutions: Object.freeze(["720p"]) }),
  "3.5pro": Object.freeze({ generation_types: Object.freeze(["image_to_video"]), duration: Object.freeze([4, 12]), resolutions: Object.freeze(["720p"]), legacy_cli_unlisted: true }),
  "3.5_pro": Object.freeze({ generation_types: Object.freeze(["image_to_video"]), duration: Object.freeze([4, 12]), resolutions: Object.freeze(["720p"]), legacy_cli_unlisted: true }),
  "3.0fast": Object.freeze({ generation_types: Object.freeze(["image_to_video"]), duration: Object.freeze([3, 10]), resolutions: Object.freeze(["720p"]), legacy_cli_unlisted: true }),
  "3.0pro": Object.freeze({ generation_types: Object.freeze(["image_to_video"]), duration: Object.freeze([3, 10]), resolutions: Object.freeze(["720p"]), legacy_cli_unlisted: true }),
  "3.0_fast": Object.freeze({ generation_types: Object.freeze(["image_to_video"]), duration: Object.freeze([3, 10]), resolutions: Object.freeze(["720p"]), legacy_cli_unlisted: true }),
  "3.0_pro": Object.freeze({ generation_types: Object.freeze(["image_to_video"]), duration: Object.freeze([3, 10]), resolutions: Object.freeze(["720p"]), legacy_cli_unlisted: true })
});

export const DREAMINA_VIDEO_MODEL_VALUES = Object.freeze(Object.keys(DREAMINA_VIDEO_MODEL_SPECS));

/** 视频模型生命周期与退役/保留理由（每个在表模型都必须有条目） */
export const DREAMINA_VIDEO_MODEL_LIFECYCLE = Object.freeze({
  "seedance2.5": Object.freeze({
    lifecycle: "candidate",
    verified: true,
    reason: "已真机跑通并入库（480p/4s=48、720p/5s=100 积分），保留并优先推荐",
    replacement: null,
    rollback_to: "seedance2.0fast",
    evidence: ["dreamina-cli-help-1.4.18", "verified-paid-samples-20260920"]
  }),
  "seedance2.0": Object.freeze({ lifecycle: "candidate", verified: false, reason: "CLI help 在列，未真机验收；保留", replacement: null, rollback_to: null, evidence: ["dreamina-cli-help-1.4.18"] }),
  "seedance2.0fast": Object.freeze({
    lifecycle: "default",
    verified: false,
    reason: "本插件视频默认回退值（normalizeDreaminaVideoModel 内 fallback）；CLI text2video 默认值同为 seedance2.0fast，保持一致",
    replacement: null,
    rollback_to: null,
    evidence: ["dreamina-cli-help-1.4.18", "plugin-source-baseline-36a1c23"]
  }),
  "seedance2.0_vip": Object.freeze({
    lifecycle: "candidate",
    verified: false,
    reason: "CLI image2video / multimodal2video 的默认值，且为唯一放行 4k 的模型；4k 未真机验收，不得提升为 default",
    replacement: null,
    rollback_to: null,
    evidence: ["dreamina-cli-help-1.4.18"]
  }),
  "seedance2.0fast_vip": Object.freeze({ lifecycle: "candidate", verified: false, reason: "CLI help 在列，按 CLI 刻意不放 4k；保留", replacement: null, rollback_to: null, evidence: ["dreamina-cli-help-1.4.18"] }),
  "seedance2.0mini": Object.freeze({ lifecycle: "candidate", verified: false, reason: "CLI help 在列，未真机验收；保留", replacement: null, rollback_to: null, evidence: ["dreamina-cli-help-1.4.18"] }),
  "seedance1.5pro": Object.freeze({ lifecycle: "candidate", verified: false, reason: "CLI help 在列（i2v）；保留", replacement: null, rollback_to: null, evidence: ["dreamina-cli-help-1.4.18"] }),
  "seedance1.0fast": Object.freeze({ lifecycle: "candidate", verified: false, reason: "CLI help 在列（i2v）；保留", replacement: null, rollback_to: null, evidence: ["dreamina-cli-help-1.4.18"] }),
  "3.5pro": Object.freeze({ lifecycle: "legacy", verified: false, reason: "CLI help 不再列出；2026-09-20 探针曾在后端 i2v 白名单中出现（故保留），2026-09-25 复测该白名单回显已不含本值 → 受理状态存疑；删除会让兼容旧脚本的调用 100% 失败，故保留注册与兼容，需重测后才可判定去留", replacement: "seedance2.5", rollback_to: null, evidence: ["backend-version-whitelist-20260920", "backend-version-whitelist-20260925"] }),
  "3.5_pro": Object.freeze({ lifecycle: "legacy", verified: false, reason: "同上（下划线别名；2026-09-25 复测白名单已不含本值 → 受理状态存疑，保留兼容但需重测）", replacement: "seedance2.5", rollback_to: null, evidence: ["backend-version-whitelist-20260920", "backend-version-whitelist-20260925"] }),
  "3.0fast": Object.freeze({ lifecycle: "legacy", verified: false, reason: "CLI help 不列、后端 i2v 白名单仍在；保留兼容", replacement: "seedance2.5", rollback_to: null, evidence: ["backend-version-whitelist-20260920"] }),
  "3.0pro": Object.freeze({ lifecycle: "legacy", verified: false, reason: "CLI help 不列、后端 i2v 白名单仍在；保留兼容", replacement: "seedance2.5", rollback_to: null, evidence: ["backend-version-whitelist-20260920"] }),
  "3.0_fast": Object.freeze({ lifecycle: "legacy", verified: false, reason: "同上（下划线别名）", replacement: "seedance2.5", rollback_to: null, evidence: ["backend-version-whitelist-20260920"] }),
  "3.0_pro": Object.freeze({ lifecycle: "legacy", verified: false, reason: "同上（下划线别名）", replacement: "seedance2.5", rollback_to: null, evidence: ["backend-version-whitelist-20260920"] })
});

/**
 * 历史记录（read_only_history）：这些值不再受理新请求，但历史参数必须保持可读。
 * 不得因为「已失效」就从文档/代码中抹掉，否则无法解释既有产出的 model_version。
 */
export const DREAMINA_VIDEO_MODEL_HISTORY = Object.freeze({
  "3.0": Object.freeze({
    lifecycle: "read_only_history",
    reason: "裸值 3.0 在 image2video / text2video / multimodal2video 三类后端 version 白名单中均不存在，属无效值，已从规格表移除；仅作历史记录保留",
    removed_at: "2026-09-20",
    replacement: "3.0fast 或 3.0_pro（legacy）／seedance2.5（推荐）",
    evidence: ["backend-version-whitelist-20260920"]
  })
});

// ---------------------------------------------------------------------------
// 3. 即梦图像模型注册表
// ---------------------------------------------------------------------------
// 对齐 `dreamina text2image|image2image|image_upscale --help` 实测。
// CLI 原值为 5.0Pro（大写 P），此处保留原值，仅在归一化时做大小写容错。
export const DREAMINA_IMAGE_MODEL_SPECS = Object.freeze({
  "3.0": Object.freeze({ generation_types: Object.freeze(["text2image"]), resolutions: Object.freeze(["1k", "2k"]) }),
  "3.1": Object.freeze({ generation_types: Object.freeze(["text2image"]), resolutions: Object.freeze(["1k", "2k"]) }),
  "4.0": Object.freeze({ generation_types: Object.freeze(["text2image", "image2image"]), resolutions: Object.freeze(["2k", "4k"]) }),
  "4.1": Object.freeze({ generation_types: Object.freeze(["text2image", "image2image"]), resolutions: Object.freeze(["2k", "4k"]) }),
  "4.5": Object.freeze({ generation_types: Object.freeze(["text2image", "image2image"]), resolutions: Object.freeze(["2k", "4k"]) }),
  "4.6": Object.freeze({ generation_types: Object.freeze(["text2image", "image2image"]), resolutions: Object.freeze(["2k", "4k"]) }),
  "4.7": Object.freeze({ generation_types: Object.freeze(["text2image", "image2image"]), resolutions: Object.freeze(["2k", "4k"]) }),
  "5.0": Object.freeze({ generation_types: Object.freeze(["text2image", "image2image"]), resolutions: Object.freeze(["2k", "4k"]) }),
  "5.0Pro": Object.freeze({ generation_types: Object.freeze(["text2image", "image2image"]), resolutions: Object.freeze(["1.5k", "2k", "4k"]) })
});

export const DREAMINA_IMAGE_MODEL_VALUES = Object.freeze(Object.keys(DREAMINA_IMAGE_MODEL_SPECS));
export const DREAMINA_IMAGE_DEFAULT_MODEL = "5.0";

export const DREAMINA_IMAGE_MODEL_LIFECYCLE = Object.freeze({
  "3.0": Object.freeze({ lifecycle: "candidate", verified: false, reason: "CLI text2image 支持集内，未真机验收；保留", replacement: null, rollback_to: null, evidence: ["dreamina-cli-help-1.4.18"] }),
  "3.1": Object.freeze({ lifecycle: "candidate", verified: false, reason: "CLI text2image 支持集内，未真机验收；保留", replacement: null, rollback_to: null, evidence: ["dreamina-cli-help-1.4.18"] }),
  "4.0": Object.freeze({ lifecycle: "candidate", verified: false, reason: "CLI 支持集内，未真机验收；保留", replacement: null, rollback_to: null, evidence: ["dreamina-cli-help-1.4.18"] }),
  "4.1": Object.freeze({ lifecycle: "candidate", verified: false, reason: "CLI 支持集内，未真机验收；保留", replacement: null, rollback_to: null, evidence: ["dreamina-cli-help-1.4.18"] }),
  "4.5": Object.freeze({ lifecycle: "candidate", verified: false, reason: "CLI 支持集内，未真机验收；保留", replacement: null, rollback_to: null, evidence: ["dreamina-cli-help-1.4.18"] }),
  "4.6": Object.freeze({ lifecycle: "candidate", verified: false, reason: "CLI 支持集内，未真机验收；保留", replacement: null, rollback_to: null, evidence: ["dreamina-cli-help-1.4.18"] }),
  "4.7": Object.freeze({ lifecycle: "candidate", verified: false, reason: "CLI 支持集内，未真机验收；保留", replacement: null, rollback_to: null, evidence: ["dreamina-cli-help-1.4.18"] }),
  "5.0": Object.freeze({
    lifecycle: "default",
    verified: false,
    reason: "本插件图像默认值（与 CLI text2image/image2image 默认值一致）；CLI help 同时说明其为 2k/4k 档默认",
    replacement: null,
    rollback_to: null,
    evidence: ["dreamina-cli-help-1.4.18", "plugin-source-baseline-36a1c23"]
  }),
  "5.0Pro": Object.freeze({
    lifecycle: "candidate",
    verified: true,
    reason: "已真机出图（2560×1440 PNG，2k=8 积分）并入库；保留并优先推荐；1.5k/4k 档未真机验收",
    replacement: null,
    rollback_to: "5.0",
    evidence: ["dreamina-cli-help-1.4.18", "verified-paid-samples-20260920"]
  })
});

/** 图像放大（image_upscale）：CLI 不暴露 model_version，只有分辨率档 */
export const DREAMINA_IMAGE_UPSCALE_SPEC = Object.freeze({
  provider: "dreamina_cli",
  command: "image_upscale",
  resolutions: Object.freeze(["2k", "4k", "8k"]),
  default_resolution: "2k",
  lifecycle: "candidate",
  verified: true,
  verified_at: "2026-09-25",
  reason: "已真机出图并入库：2k→3840×2160（实测 1 积分）、4k→4096×2304（实测 0 积分）；8k 未真机。CLI 不暴露 model_version，resolution_type 由后端校验为 2k/4k/8k。保留 candidate，未提升为默认路径",
  measured_samples: Object.freeze([
    Object.freeze({ resolution_type: "2k", submit_id: "1fd271b8-afd5-4ec5-ab89-06f3594f71c5", credits: 1, benefit_type: "image_pro_hd_vtwo_twok", width: 3840, height: 2160, bytes: 2071075, output_kind: "png", status: "verified", evidence: ["verified-paid-samples-20260925"] }),
    Object.freeze({ resolution_type: "4k", submit_id: "ad1f0d87-4c12-44cf-9641-f2d24bf73d35", credits: 0, benefit_type: "image_pro_hd_vtwo_fourk", width: 4096, height: 2304, bytes: 1483589, output_kind: "png", status: "verified", note: "工具面因 CLI stdout 非 JSON 误报失败，产出经只读 query_result 恢复；账户余额未变动（实测 0 积分，仅代表本账号 2026-09-25 观测）", evidence: ["verified-paid-samples-20260925"] }),
    Object.freeze({ resolution_type: "8k", credits: "unknown", status: "unknown", evidence: [] })
  ]),
  evidence: ["dreamina-cli-help-1.4.18", "backend-version-whitelist-20260925", "verified-paid-samples-20260925"]
});

// ---------------------------------------------------------------------------
// 4. Provider 注册表
// ---------------------------------------------------------------------------
// 每个 provider 记录：传输方式 / 现行端点 / 鉴权 / 计费语义 / 超时策略 / 授权默认值 / 证据。
// 成本与授权证据字段：无证据一律显式 unknown（禁止默认 cleared）。
export const PROVIDER_REGISTRY = Object.freeze({
  dreamina_cli: Object.freeze({
    provider_id: "dreamina_cli",
    display_name: "即梦 Dreamina CLI",
    transport: "local_subprocess",
    commands: Object.freeze(["text2image", "image2image", "image_upscale", "text2video", "image2video", "multimodal2video"]),
    /** 官方现行端点族：本机可执行体 + 官方分发地址（version.json release_notes 明示） */
    endpoints: Object.freeze([
      Object.freeze({ kind: "cli_executable", ref: "%USERPROFILE%\\bin\\dreamina.exe", lifecycle: "default", evidence: ["dreamina-cli-help-1.4.18"] }),
      Object.freeze({ kind: "cli_distribution", ref: "https://jimeng.jianying.com/cli", lifecycle: "default", evidence: ["dreamina-cli-version-json"] })
    ]),
    cli_release: Object.freeze({
      version: "1.4.18",
      build: "ec1b9fa",
      build_time: "2026-09-09T09:09:35Z",
      release_date: "2026-09-10",
      release_notes: "视频生成支持比例控制",
      verified_at: "2026-09-20T23:44:39+08:00"
    }),
    auth: Object.freeze({
      mode: "oauth_device_flow",
      headless_supported: true,
      note: "dreamina login / login --headless + login checklogin --device_code；旧浏览器回调与手工导入登录流程已废弃"
    }),
    billing: Object.freeze({
      unit: "credits",
      upload_failure_charged: false,
      cost_status: "partially_verified",
      verified_samples: Object.freeze([
        Object.freeze({ model: "seedance2.5", spec: "480p/4s", credits: 48, cost_status: "verified", evidence: ["verified-paid-samples-20260920"] }),
        Object.freeze({ model: "seedance2.5", spec: "720p/5s", credits: 100, cost_status: "verified", evidence: ["verified-paid-samples-20260920"] }),
        Object.freeze({ model: "5.0Pro", spec: "2k/2560x1440", credits: 8, cost_status: "verified", evidence: ["verified-paid-samples-20260920"] }),
        Object.freeze({ model: "seedance2.0_vip", spec: "1080p/4k", credits: "unknown", cost_status: "unknown", evidence: [] }),
        Object.freeze({ model: "image_upscale", spec: "2k/3840x2160", credits: 1, cost_status: "verified", evidence: ["verified-paid-samples-20260925"] }),
        Object.freeze({ model: "image_upscale", spec: "4k/4096x2304", credits: 0, cost_status: "verified", note: "实测 0 积分（账户余额未变动 + commerce_info.credit_count=0）；仅代表本账号 2026-09-25 观测，不构成长期免费承诺", evidence: ["verified-paid-samples-20260925"] }),
        Object.freeze({ model: "image_upscale", spec: "8k", credits: "unknown", cost_status: "unknown", evidence: [] })
      ])
    }),
    timeout: Object.freeze({ cli_poll_default_seconds: 180, cli_poll_max_seconds: 600, error_normalization: "external-call" }),
    rights: Object.freeze({
      license_status_default: "unknown",
      risk_level_default: "unknown",
      note: "自有账号 AI 生成物的授权口径需家主以可引用形式确认；本包已把新产物的授权默认值改为 unknown（不再默认 cleared），仅当调用方显式传入有据授权值时才登记为 cleared；历史资产不做回填。"
    }),
    /**
     * 命名映射：官方产品名 ↔ CLI 值。
     * 纪律：CLI 值是契约值，必须原样使用；**不为官方产品名发明插件别名**（如不得写 seedream-5.0-pro）。
     * 本表只用于在文档/UI 里解释「这个名字对应哪个值」，不参与任何校验。
     */
    naming: Object.freeze({
      "Seedance 2.5": "seedance2.5",
      "Seedream 5.0 Pro": "5.0Pro",
      "Seedance 2.0": "seedance2.0",
      "Seedance 2.0 Fast": "seedance2.0fast",
      "Seedance 2.0 Mini": "seedance2.0mini",
      "Seedance 1.5 Pro": "seedance1.5pro"
    }),
    /**
     * 已知契约差异：CLI help ↔ 后端白名单 / CLI 输出契约。
     * 只记录**已实测的差异**；参数权威仍是 CLI help（不据白名单新增 CLI help 未列的值）。
     */
    contract_gaps: Object.freeze([
      Object.freeze({
        gap: "image2video 的 CLI help 支持集与后端 version 白名单不一致",
        cli_help: "CLI help 列 seedance1.0fast / seedance1.5pro / 2.0 家族 / seedance2.5（不含 3.0*/3.5*）",
        backend_probe: "2026-09-25 探针回显：3.0_fast, 3.0_pro, 3.0fast, 3.0pro, seedance1.0, seedance1.0fast, 2.0 家族, seedance2.5 —— 不含 seedance1.5pro，且不含 2026-09-20 曾出现的 3.5pro / 3.5_pro",
        action: "参数权威仍为 CLI help；legacy 兼容项保留但受理状态存疑（须重测后再定去留）；不得据白名单新增 CLI help 未列的值。seedance1.5pro 的受理状态同样待重测",
        evidence: ["dreamina-cli-help-1.4.18", "backend-version-whitelist-20260920", "backend-version-whitelist-20260925"]
      }),
      Object.freeze({
        gap: "后端受理但 CLI help 未列的图像模型值",
        cli_help: "text2image 支持集：3.0, 3.1, 4.0, 4.1, 4.5, 4.6, 4.7, 5.0, 5.0Pro",
        backend_probe: "2026-09-25 探针回显：3.0, 3.1, 4.0, 4.1, 4.5, 4.6, 4.7, 4.8, 5.0, 5.0Pro, 5.0lite（多出 4.8 / 5.0lite）",
        action: "按既有纪律不入表、不臆测其参数与档位；仅登记差异，待官方 CLI help 收录后再评估",
        evidence: ["dreamina-cli-help-1.4.18", "backend-version-whitelist-20260925"]
      }),
      Object.freeze({
        gap: "image_upscale 提交被受理时，CLI stdout 可能不是可解析 JSON",
        cli_help: "各生成子命令在提交后输出 JSON（submit_id / gen_status / fail_reason）",
        backend_probe: "2026-09-25 4k 真机：后端已受理（tasks.db 有 image_upscale 记录、benefit image_pro_hd_vtwo_fourk、产出 4096×2304 可下载），但 CLI stdout 非 JSON → 插件 parseDreaminaJson 抛错，工具面把**已受理的付费任务**报成失败，且错误对象不含原始 stdout",
        action: "工具面须保留原始 stdout 并支持只读 query_result 对账兜底；阻塞轮询（--poll>0）已在 REN-11 实测不可靠，建议默认「异步提交 + 只读收敛」；本轮未改代码，仅登记",
        evidence: ["verified-paid-samples-20260925"]
      })
    ]),
    evidence: ["dreamina-cli-help-1.4.18", "dreamina-cli-version-json", "dreamina-cli-shipped-skill", "backend-version-whitelist-20260920", "bytedance-seed-model-lineup", "dreamina-cli-channel-20260925", "backend-version-whitelist-20260925", "verified-paid-samples-20260925"]
  }),

  doubao_seed_audio: Object.freeze({
    provider_id: "doubao_seed_audio",
    display_name: "火山引擎豆包语音 · 音频生成 HTTP",
    transport: "https_rest",
    endpoints: Object.freeze([
      Object.freeze({ kind: "http", method: "POST", ref: "https://openspeech.bytedance.com/api/v3/tts/create", lifecycle: "default", evidence: ["doubao-audio-http-doc"] })
    ]),
    models: Object.freeze([
      Object.freeze({ model_id: "seed-audio-1.0", lifecycle: "default", verified: false, reason: "官方文档列出的当前唯一模型（页面 model 参数仅 seed-audio-1.0）；本插件强制该校验", evidence: ["doubao-audio-http-doc"] })
    ]),
    auth: Object.freeze({
      mode: "header_api_key",
      header: "X-Api-Key",
      legacy_headers: Object.freeze(["X-Api-App-Id", "X-Api-Access-Key"]),
      legacy_status: "官方文档明示旧版控制台后续会下线，建议尽快切换到新版控制台获取 API Key；本插件已使用 X-Api-Key",
      credential_source: "host secretInputs materialized string (audio.doubao.apiKey) 或环境变量 VOLCENGINE_DOUBAO_AUDIO_API_KEY；插件不接受凭证对象",
      evidence: ["doubao-audio-http-doc"]
    }),
    billing: Object.freeze({
      unit: "platform_billing",
      basis: "original_duration（模型输出的原始音频时长，上限 120 秒）",
      cost_status: "unknown",
      note: "本轮未做付费调用，单价未取证",
      evidence: ["doubao-audio-http-doc"]
    }),
    limits: Object.freeze({
      max_output_seconds: 120,
      text_prompt_max_chars: 3000,
      output_formats: Object.freeze(["wav", "mp3", "pcm", "ogg_opus"]),
      official_sample_rates: Object.freeze([8000, 16000, 24000, 32000, 40000, 44100, 48000]),
      max_audio_references: 3,
      max_image_references: 1,
      reference_mixing_allowed: false,
      output_url_ttl_hours: 2
    }),
    timeout: Object.freeze({ min_ms: 30000, default_ms: 600000, max_ms: 1800000, error_normalization: "external-call" }),
    rights: Object.freeze({
      license_status_default: "unknown",
      risk_level_default: "unknown",
      note: "平台审核通过是**内容审核**结论，不是版权授权依据；新产物授权默认 unknown，仅调用方显式传入有据授权值时才登记为 cleared。"
    }),
    /** 官方产品名（ByteDance Seed 模型列表）↔ 官方 HTTP 文档 model 值 */
    naming: Object.freeze({
      "Seed Audio 1.0": "seed-audio-1.0"
    }),
    /**
     * 已知校验差异：官方限制 vs 插件当前实现。
     * 只记录「尚未落地」的项；本包已按官方原文落地的（参考条数、图文混用、内联 base64 体积、
     * 逐格式采样率、text_prompt 中 @音频N 引用悬空）不再列在这里，避免把已修项当成缺口。
     */
    validation_gaps: Object.freeze([
      Object.freeze({
        gap: "远端 URL 形式的参考资源无法离线判定时长与体积",
        official_limits: "参考音频 ≤30s / ≤10MB，参考图片 ≤10MB",
        plugin_behaviour: "内联 base64 参考已做解码体积校验；远端 URL（audio_url / image_url）不做下载与探测",
        action: "保持缺口登记；如需覆盖须引入真实下载/探测或受控小样（blocked-verification B9）",
        evidence: ["doubao-audio-http-doc"]
      }),
      Object.freeze({
        gap: "单条参考音频的时长上限未校验",
        official_limits: "单条参考音频时长 ≤30s",
        plugin_behaviour: "内联 base64 可解码体积，但无法可靠推定时长（需解码音频容器探测）",
        action: "需引入媒体探测步骤后才能落地（blocked-verification B9）",
        evidence: ["doubao-audio-http-doc"]
      })
    ]),
    evidence: ["doubao-audio-http-doc", "bytedance-seed-model-lineup"]
  }),

  "kie.ai/suno-api": Object.freeze({
    provider_id: "kie.ai/suno-api",
    display_name: "KIE Suno API",
    transport: "https_rest_polling",
    endpoints: Object.freeze([
      Object.freeze({
        kind: "http",
        method: "POST",
        ref: "https://api.kie.ai/api/v1/generate",
        lifecycle: "legacy",
        in_use: true,
        reason: "本插件当前默认端点（KIE 旧版模型文档族）；官方已把新集成指向 /api/v1/jobs/createTask，但本插件尚无真机验收的新端点替代链 → 保留现网行为，不擅自切换",
        replacement: "https://api.kie.ai/api/v1/jobs/createTask",
        evidence: ["kie-docs-suno-generate-music", "kie-docs-old-model"]
      }),
      Object.freeze({
        kind: "http",
        method: "GET",
        ref: "https://api.kie.ai/api/v1/generate/record-info",
        lifecycle: "legacy",
        in_use: true,
        reason: "与旧端点族配套的任务查询",
        replacement: "https://api.kie.ai/api/v1/jobs/recordInfo",
        evidence: ["kie-docs-old-model"]
      }),
      Object.freeze({
        kind: "http",
        method: "POST",
        ref: "https://api.kie.ai/api/v1/jobs/createTask",
        lifecycle: "candidate",
        in_use: false,
        reason: "官方现行文档端点；未在本插件真机验收，且切换需付费调用 → 列为候选，未经验收不得成为新请求默认",
        evidence: ["kie-docs-suno-generate-music"]
      }),
      Object.freeze({
        kind: "http",
        method: "GET",
        ref: "https://api.kie.ai/api/v1/jobs/recordInfo",
        lifecycle: "candidate",
        in_use: false,
        reason: "官方现行任务查询端点；同上，未验收",
        evidence: ["kie-docs-suno-generate-music"]
      })
    ]),
    models: Object.freeze([
      Object.freeze({ model_id: "V4", lifecycle: "candidate", verified: false, reason: "官方与旧文档均在列；保留", evidence: ["kie-docs-suno-generate-music", "kie-docs-old-model"] }),
      Object.freeze({ model_id: "V4_5", lifecycle: "candidate", verified: false, reason: "官方与旧文档均在列；保留", evidence: ["kie-docs-suno-generate-music"] }),
      Object.freeze({ model_id: "V4_5PLUS", lifecycle: "candidate", verified: false, reason: "官方与旧文档均在列；保留", evidence: ["kie-docs-suno-generate-music"] }),
      Object.freeze({ model_id: "V4_5ALL", lifecycle: "candidate", verified: false, reason: "官方与旧文档均在列；保留", evidence: ["kie-docs-suno-generate-music"] }),
      Object.freeze({ model_id: "V5", lifecycle: "candidate", verified: false, reason: "官方文档在列，但同页 persona_model 说明标注 V5 (Discontinued) → 存在冲突信号，需真机核验；本轮不改行为", evidence: ["kie-docs-suno-generate-music"] }),
      Object.freeze({
        model_id: "V5_5",
        lifecycle: "default",
        verified: false,
        reason: "本插件默认模型；官方文档在列，但同页 persona_model 说明标注 V5.5 (Discontinued)，且 duration 段仍把 V5_5 列为有效 → 官方材料自相矛盾，未取得替代链真机验收前保持现状不改默认",
        evidence: ["kie-docs-suno-generate-music"]
      }),
      Object.freeze({ model_id: "V6", lifecycle: "candidate", verified: false, reason: "官方现行文档在列（V6/V6_MINI/V6_WILD），本插件枚举尚未覆盖；未真机验收，故列为候选而非默认", evidence: ["kie-docs-suno-generate-music"] }),
      Object.freeze({ model_id: "V6_MINI", lifecycle: "candidate", verified: false, reason: "同上", evidence: ["kie-docs-suno-generate-music"] }),
      Object.freeze({ model_id: "V6_WILD", lifecycle: "candidate", verified: false, reason: "同上", evidence: ["kie-docs-suno-generate-music"] })
    ]),
    auth: Object.freeze({
      mode: "bearer_token",
      header: "Authorization",
      credential_source: "host secretInputs materialized string (audio.kie.apiKey) 或环境变量 KIE_API_KEY；插件不接受凭证对象",
      evidence: ["kie-docs-getting-started"]
    }),
    billing: Object.freeze({
      unit: "vendor_credits",
      cost_status: "unknown",
      note: "官方定价页 https://kie.ai/pricing（本轮未取证具体单价）；第三方网关，单价随上游调整",
      evidence: ["kie-docs-getting-started"]
    }),
    limits: Object.freeze({
      rate_limit: "20 个新生成请求 / 10 秒（超额返回 429，且不入队）",
      media_retention_days: 14,
      log_retention_days: 60,
      prompt_chars_default: 5000,
      prompt_chars_v4: 3000,
      style_chars_default: 1000,
      style_chars_v4: 200,
      title_chars: 80
    }),
    timeout: Object.freeze({ min_ms: 30000, default_ms: 900000, max_ms: 3600000, error_normalization: "external-call" }),
    rights: Object.freeze({
      license_status_default: "unknown",
      risk_level_default: "unknown",
      note: "第三方网关生成物，授权与商用边界未清权 → 运行时默认 unknown 为正确口径"
    }),
    evidence: ["kie-docs-getting-started", "kie-docs-suno-generate-music", "kie-docs-old-model"]
  })
});

// ---------------------------------------------------------------------------
// 5. 派生视图（供 service.js / index.js / 文档 / 测试共用）
// ---------------------------------------------------------------------------
export const dreaminaVideoModelsFor = (generation_type) => DREAMINA_VIDEO_MODEL_VALUES.filter((model) => DREAMINA_VIDEO_MODEL_SPECS[model].generation_types.includes(generation_type));
export const DREAMINA_TEXT2VIDEO_MODELS = new Set(dreaminaVideoModelsFor("text_to_video"));
export const DREAMINA_IMAGE2VIDEO_MODELS = new Set(dreaminaVideoModelsFor("image_to_video"));
export const DREAMINA_MULTIMODAL2VIDEO_MODELS = new Set(dreaminaVideoModelsFor("multimodal_to_video"));
export const DREAMINA_VIDEO_RATIOS = new Set(["1:1", "3:4", "16:9", "4:3", "9:16", "21:9"]);
export const DREAMINA_VIDEO_RESOLUTIONS = new Set([...new Set(DREAMINA_VIDEO_MODEL_VALUES.flatMap((model) => [...DREAMINA_VIDEO_MODEL_SPECS[model].resolutions]))]);

export const dreaminaImageModelsFor = (cli_kind) => DREAMINA_IMAGE_MODEL_VALUES.filter((model) => DREAMINA_IMAGE_MODEL_SPECS[model].generation_types.includes(cli_kind));
export const DREAMINA_TEXT2IMAGE_MODELS = new Set(dreaminaImageModelsFor("text2image"));
export const DREAMINA_IMAGE2IMAGE_MODELS = new Set(dreaminaImageModelsFor("image2image"));
export const DREAMINA_IMAGE_RESOLUTION_TYPES = Object.freeze(["1k", "1.5k", "2k", "4k"]);
export const DREAMINA_IMAGE_RATIOS = Object.freeze(["21:9", "16:9", "3:2", "4:3", "1:1", "3:4", "2:3", "9:16"]);
export const DREAMINA_IMAGE_DEFAULT_RATIO = "16:9";
export const DREAMINA_IMAGE_UPSCALE_RESOLUTIONS = Object.freeze([...DREAMINA_IMAGE_UPSCALE_SPEC.resolutions]);
export const DREAMINA_IMAGE_MAX_GENERATE_NUM = 10;
export const DREAMINA_IMAGE_MAX_INPUT_IMAGES = 10;
export const DREAMINA_IMAGE_GENERATION_TYPES = Object.freeze(["image", "cover", "edit"]);
export const dreaminaImageCliKind = (generation_type) => (generation_type === "edit" ? "image2image" : "text2image");

/** 兼容视图：index.js 现有工具 schema 依赖该形状 */
export const dreaminaModelCatalog = Object.freeze({
  video: Object.freeze({
    models: DREAMINA_VIDEO_MODEL_VALUES,
    resolutions: Object.freeze([...DREAMINA_VIDEO_RESOLUTIONS]),
    ratios: Object.freeze([...DREAMINA_VIDEO_RATIOS]),
    generation_types: Object.freeze(["image_to_video", "text_to_video", "multimodal_to_video"])
  }),
  image: Object.freeze({
    models: DREAMINA_IMAGE_MODEL_VALUES,
    resolutions: DREAMINA_IMAGE_RESOLUTION_TYPES,
    ratios: DREAMINA_IMAGE_RATIOS,
    generation_types: DREAMINA_IMAGE_GENERATION_TYPES,
    upscale_resolutions: DREAMINA_IMAGE_UPSCALE_RESOLUTIONS
  })
});

// ---------------------------------------------------------------------------
// 6. 查询 / 派生接口
// ---------------------------------------------------------------------------

/** 按 kind + generation_type 派生「允许新请求」的模型枚举（排除 disabled_new / read_only_history） */
export function selectableModels(kind, generation_type = null) {
  const states = new Set(NEW_REQUEST_LIFECYCLE_STATES);
  if (kind === "video") {
    const models = generation_type ? dreaminaVideoModelsFor(generation_type) : [...DREAMINA_VIDEO_MODEL_VALUES];
    return models.filter((model) => states.has(DREAMINA_VIDEO_MODEL_LIFECYCLE[model]?.lifecycle ?? "candidate"));
  }
  if (kind === "image") {
    const models = generation_type ? dreaminaImageModelsFor(generation_type) : [...DREAMINA_IMAGE_MODEL_VALUES];
    return models.filter((model) => states.has(DREAMINA_IMAGE_MODEL_LIFECYCLE[model]?.lifecycle ?? "candidate"));
  }
  throw new Error(`unknown capability kind: ${kind}`);
}

/** 生命周期记录（含未收录值 → null） */
export function lifecycleOf(kind, model) {
  if (kind === "video") return DREAMINA_VIDEO_MODEL_LIFECYCLE[model] ?? DREAMINA_VIDEO_MODEL_HISTORY[model] ?? null;
  if (kind === "image") return DREAMINA_IMAGE_MODEL_LIFECYCLE[model] ?? null;
  throw new Error(`unknown capability kind: ${kind}`);
}

/** 工具 schema enum 派生入口（kind: video|image；generation_type 可选） */
export function schemaEnums({ kind, generation_type = null } = {}) {
  if (kind === "video") {
    return {
      model_version: selectableModels("video", generation_type),
      video_resolution: generation_type
        ? [...new Set((generation_type ? dreaminaVideoModelsFor(generation_type) : [...DREAMINA_VIDEO_MODEL_VALUES]).flatMap((model) => [...DREAMINA_VIDEO_MODEL_SPECS[model].resolutions]))]
        : [...DREAMINA_VIDEO_RESOLUTIONS],
      ratio: [...DREAMINA_VIDEO_RATIOS]
    };
  }
  if (kind === "image") {
    return {
      model_version: selectableModels("image", generation_type),
      resolution_type: [...DREAMINA_IMAGE_RESOLUTION_TYPES],
      ratio: [...DREAMINA_IMAGE_RATIOS],
      upscale_resolution: [...DREAMINA_IMAGE_UPSCALE_RESOLUTIONS]
    };
  }
  throw new Error(`unknown capability kind: ${kind}`);
}

/**
 * 历史参数只读查询：**永不抛错**。
 * 用于解释既有产出里出现的 model_version（含已移除的裸值 3.0），保证历史可读。
 */
export function describeHistoricalModel(kind, value) {
  const raw = String(value ?? "").trim();
  if (kind === "video") {
    const canonical = DREAMINA_VIDEO_MODEL_VALUES.find((item) => item.toLowerCase() === raw.toLowerCase()) ?? raw;
    const entry = DREAMINA_VIDEO_MODEL_LIFECYCLE[canonical] ?? DREAMINA_VIDEO_MODEL_HISTORY[canonical] ?? null;
    return {
      kind,
      value: raw,
      canonical: entry ? canonical : null,
      recognized: Boolean(entry),
      lifecycle: entry?.lifecycle ?? "unrecognized",
      verified: entry?.verified ?? null,
      selectable_for_new_request: Boolean(entry && NEW_REQUEST_LIFECYCLE_STATES.includes(entry.lifecycle)),
      reason: entry?.reason ?? "该值不在当前视频模型注册表与其历史记录中；历史产出仍可原样读取，不做改写",
      replacement: entry?.replacement ?? null
    };
  }
  if (kind === "image") {
    const canonical = DREAMINA_IMAGE_MODEL_VALUES.find((item) => item.toLowerCase() === raw.toLowerCase()) ?? raw;
    const entry = DREAMINA_IMAGE_MODEL_LIFECYCLE[canonical] ?? null;
    return {
      kind,
      value: raw,
      canonical: entry ? canonical : null,
      recognized: Boolean(entry),
      lifecycle: entry?.lifecycle ?? "unrecognized",
      verified: entry?.verified ?? null,
      selectable_for_new_request: Boolean(entry && NEW_REQUEST_LIFECYCLE_STATES.includes(entry.lifecycle)),
      reason: entry?.reason ?? "该值不在当前图像模型注册表中；历史产出仍可原样读取，不做改写",
      replacement: null
    };
  }
  throw new Error(`unknown capability kind: ${kind}`);
}

/** 退役 / 替代 / 回退映射（供文档与迁移脚本使用） */
export function retirementMapping() {
  const rows = [];
  for (const [model, entry] of Object.entries(DREAMINA_VIDEO_MODEL_LIFECYCLE)) {
    if (entry.lifecycle === "legacy" || entry.lifecycle === "disabled_new") {
      rows.push({ kind: "video", model, lifecycle: entry.lifecycle, replacement: entry.replacement ?? null, rollback_to: entry.rollback_to ?? null, reason: entry.reason });
    }
  }
  for (const [model, entry] of Object.entries(DREAMINA_VIDEO_MODEL_HISTORY)) {
    rows.push({ kind: "video", model, lifecycle: entry.lifecycle, replacement: entry.replacement ?? null, rollback_to: null, reason: entry.reason });
  }
  for (const [endpointId, provider] of Object.entries(PROVIDER_REGISTRY)) {
    for (const endpoint of provider.endpoints ?? []) {
      if (endpoint.lifecycle === "legacy" || endpoint.lifecycle === "disabled_new") {
        rows.push({ kind: "endpoint", provider: endpointId, model: `${endpoint.method ?? "RUN"} ${endpoint.ref}`, lifecycle: endpoint.lifecycle, replacement: endpoint.replacement ?? null, rollback_to: null, reason: endpoint.reason ?? "" });
      }
    }
  }
  return rows;
}

/** 结构化能力矩阵（文档与测试的共同输入） */
export function providerModelMatrix() {
  return {
    schema_version: CAPABILITY_REGISTRY_SCHEMA_VERSION,
    generated_from: "src/capability-registry.js",
    lifecycle_states: LIFECYCLE_STATES,
    new_request_lifecycle_states: NEW_REQUEST_LIFECYCLE_STATES,
    evidence: EVIDENCE,
    providers: PROVIDER_REGISTRY,
    models: {
      dreamina_video: DREAMINA_VIDEO_MODEL_LIFECYCLE,
      dreamina_video_history: DREAMINA_VIDEO_MODEL_HISTORY,
      dreamina_image: DREAMINA_IMAGE_MODEL_LIFECYCLE,
      dreamina_image_upscale: DREAMINA_IMAGE_UPSCALE_SPEC
    },
    defaults: {
      video: "seedance2.0fast",
      image: DREAMINA_IMAGE_DEFAULT_MODEL,
      video_cli_defaults: { image2video: "seedance2.0_vip", text2video: "seedance2.0fast", multimodal2video: "seedance2.0_vip" },
      image_cli_default: DREAMINA_IMAGE_DEFAULT_MODEL
    },
    retirement_mapping: retirementMapping()
  };
}

function mdTable(headers, rows) {
  const esc = (v) => String(v ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(esc).join(" | ")} |`)
  ].join("\n");
}

/** 由注册表派生 provider-model-matrix.md 正文（禁止手工维护第二份矩阵） */
export function renderProviderModelMatrixMarkdown() {
  const out = [];
  out.push("<!-- GENERATED FILE — 请勿手工编辑；由 src/capability-registry.js#renderProviderModelMatrixMarkdown 生成 -->");
  out.push(`<!-- registry_schema: ${CAPABILITY_REGISTRY_SCHEMA_VERSION} -->`);
  out.push("");
  out.push("# Provider / Model 能力矩阵（REN-09 派生）");
  out.push("");
  out.push("本文件由能力注册表自动派生，是注册表当前内容的投影；任何手工修改都会在下一次生成或漂移检查中暴露。");
  out.push("");
  out.push("## 1. 生命周期分层");
  out.push("");
  out.push(mdTable(["状态", "含义", "是否允许新请求"], [
    ["default", "未指定模型时的默认值，仅在显式决策后变更", "是"],
    ["candidate", "表内可用；verified 区分是否已真机验收", "是"],
    ["legacy", "CLI help 不列但后端仍受理；保留以免旧调用 100% 失败", "是"],
    ["disabled_new", "明确不再受理新请求，历史不得删除", "否"],
    ["read_only_history", "已失效/已移除的值，仅历史可读", "否"]
  ]));
  out.push("");
  out.push("## 2. 官方证据（URL + 核查时间）");
  out.push("");
  out.push(mdTable(["证据 ID", "类型", "供应商", "来源", "产物路径", "核查时间", "要点"], Object.entries(EVIDENCE).map(([id, e]) => [
    id, e.kind, e.vendor, e.url, e.artifact ?? "-", e.checked_at, e.capture_note
  ])));
  out.push("");
  out.push("## 3. Provider 现状");
  out.push("");
  for (const [id, provider] of Object.entries(PROVIDER_REGISTRY)) {
    out.push(`### ${id} — ${provider.display_name}`);
    out.push("");
    out.push(`- 传输：\`${provider.transport}\``);
    if (provider.cli_release) out.push(`- CLI 版本：${provider.cli_release.version}（build ${provider.cli_release.build} / ${provider.cli_release.release_date}），核查于 ${provider.cli_release.verified_at}`);
    out.push(`- 鉴权：${provider.auth.mode}${provider.auth.header ? `（${provider.auth.header}）` : ""}`);
    out.push(`- 计费：${provider.billing.unit}（状态：${provider.billing.cost_status ?? "n/a"}）`);
    out.push(`- 授权默认：license_status=${provider.rights.license_status_default} / risk_level=${provider.rights.risk_level_default}`);
    out.push("");
    out.push(mdTable(["端点/类型", "方法", "地址", "生命周期", "当前在用", "替代", "理由"], (provider.endpoints ?? []).map((ep) => [
      ep.kind, ep.method ?? "-", ep.ref, ep.lifecycle, ep.in_use ? "是" : "否", ep.replacement ?? "-", ep.reason ?? "-"
    ])));
    if (provider.naming) {
      out.push("");
      out.push(mdTable(["官方产品名", "插件/CLI 契约值"], Object.entries(provider.naming).map(([official, value]) => [official, `\`${value}\``])));
    }
    if (provider.validation_gaps?.length) {
      out.push("");
      out.push("已知校验差异（官方限制 vs 插件实现，仅记录）：");
      out.push("");
      out.push(mdTable(["差异", "官方限制", "插件实现", "处置"], provider.validation_gaps.map((gap) => [gap.gap, gap.official_limits, gap.plugin_behaviour, gap.action])));
    }
    if (provider.contract_gaps?.length) {
      out.push("");
      out.push("已知契约差异（CLI help ↔ 后端白名单 / CLI 输出契约，仅记录）：");
      out.push("");
      out.push(mdTable(["差异", "CLI help / 预期", "后端探针 / 实测", "处置"], provider.contract_gaps.map((gap) => [gap.gap, gap.cli_help, gap.backend_probe, gap.action])));
    }
    if (provider.models?.length) {
      out.push("");
      out.push(mdTable(["模型", "生命周期", "已真机验收", "理由"], provider.models.map((m) => [m.model_id, m.lifecycle, m.verified ? "是" : "否", m.reason])));
    }
    out.push("");
  }
  out.push("## 4. 即梦视频模型矩阵");
  out.push("");
  out.push(mdTable(["model_version", "可用生成型", "时长(s)", "分辨率", "生命周期", "已真机验收", "替代", "回退到"], DREAMINA_VIDEO_MODEL_VALUES.map((model) => {
    const spec = DREAMINA_VIDEO_MODEL_SPECS[model];
    const life = DREAMINA_VIDEO_MODEL_LIFECYCLE[model];
    return [model, spec.generation_types.join("/"), spec.duration.join("-"), spec.resolutions.join("/"), life.lifecycle, life.verified ? "是" : "否", life.replacement ?? "-", life.rollback_to ?? "-"];
  })));
  out.push("");
  out.push("### 历史（只读，不再受理新请求）");
  out.push("");
  out.push(mdTable(["model_version", "生命周期", "移除时间", "替代", "理由"], Object.entries(DREAMINA_VIDEO_MODEL_HISTORY).map(([model, entry]) => [
    model, entry.lifecycle, entry.removed_at, entry.replacement, entry.reason
  ])));
  out.push("");
  out.push("## 5. 即梦图像模型矩阵");
  out.push("");
  out.push(mdTable(["model_version", "可用生成型", "resolution_type", "生命周期", "已真机验收", "回退到"], DREAMINA_IMAGE_MODEL_VALUES.map((model) => {
    const spec = DREAMINA_IMAGE_MODEL_SPECS[model];
    const life = DREAMINA_IMAGE_MODEL_LIFECYCLE[model];
    return [model, spec.generation_types.join("/"), spec.resolutions.join("/"), life.lifecycle, life.verified ? "是" : "否", life.rollback_to ?? "-"];
  })));
  out.push("");
  out.push("### image_upscale");
  out.push("");
  out.push(`- 分辨率档：${DREAMINA_IMAGE_UPSCALE_SPEC.resolutions.join(" / ")}；生命周期：${DREAMINA_IMAGE_UPSCALE_SPEC.lifecycle}；真机验收：${DREAMINA_IMAGE_UPSCALE_SPEC.verified ? "是" : "否"}${DREAMINA_IMAGE_UPSCALE_SPEC.verified_at ? `（${DREAMINA_IMAGE_UPSCALE_SPEC.verified_at}）` : ""}`);
  out.push(`- 理由：${DREAMINA_IMAGE_UPSCALE_SPEC.reason}`);
  if (DREAMINA_IMAGE_UPSCALE_SPEC.measured_samples?.length) {
    out.push("");
    out.push(mdTable(["resolution_type", "submit_id", "实测积分", "benefit_type", "产出规格", "状态", "证据"], DREAMINA_IMAGE_UPSCALE_SPEC.measured_samples.map((sample) => [
      sample.resolution_type,
      sample.submit_id ?? "-",
      typeof sample.credits === "number" ? String(sample.credits) : "unknown",
      sample.benefit_type ?? "-",
      sample.width ? `${sample.width}×${sample.height}` : "-",
      sample.status,
      (sample.evidence ?? []).join(", ") || "-"
    ])));
  }
  out.push("");
  out.push("## 6. 默认值");
  out.push("");
  const defaults = providerModelMatrix().defaults;
  out.push(mdTable(["作用域", "默认值", "说明"], [
    ["本插件视频", defaults.video, "normalizeDreaminaVideoModel 的回退值；模型始终显式透传 argv"],
    ["本插件图像", defaults.image, "DREAMINA_IMAGE_DEFAULT_MODEL，与 CLI 默认一致"],
    ["CLI image2video", defaults.video_cli_defaults.image2video, "CLI 自带默认（仅当未显式传 model_version 时生效）"],
    ["CLI text2video", defaults.video_cli_defaults.text2video, "与本插件回退值一致"],
    ["CLI multimodal2video", defaults.video_cli_defaults.multimodal2video, "CLI 自带默认"]
  ]));
  out.push("");
  out.push("## 7. 退役 / 替代 / 回退映射");
  out.push("");
  out.push(mdTable(["类型", "对象", "生命周期", "替代", "回退到", "理由"], retirementMapping().map((row) => [
    row.kind, row.model, row.lifecycle, row.replacement ?? "-", row.rollback_to ?? "-", row.reason
  ])));
  out.push("");
  return out.join("\n");
}
