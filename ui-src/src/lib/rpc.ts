/**
 * RPC 客户端 —— 与后端 /rpc/call 单端点对接。
 * 真相源：extensions/video-assets/src/service.js + index.js 的 allRpc()/uiBrowserRpc()。
 */

export const PLUGIN_BASE = "/__openclaw__/video-assets";

export class RpcError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "RpcError";
  }

  /**
   * REN-08：服务端以 409 报告画布版本冲突，并且是**唯一**需要用户介入的写入失败。
   * 把它做成一个可判定的属性而不是靠字符串匹配，是因为“冲突”与“网络断了”对用户的含义
   * 完全不同：前者要重新读取文档，后者可以重试。混为一谈会让重试覆盖别人的编辑。
   */
  get isRevisionConflict(): boolean {
    return this.status === 409;
  }
}

async function http<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    credentials: "include",
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    ...init,
  });
  const body = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    result?: T;
    error?: string;
  };
  if (!res.ok || body.ok === false) {
    throw new RpcError(body.error || `请求失败：${res.status}`, res.status);
  }
  return body.result as T;
}

/** 调用插件 RPC。method 支持全名（videoAssets.canvas.get）或短别名（canvas.get）。 */
export async function rpc<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  return http<T>(`${PLUGIN_BASE}/rpc/call`, {
    method: "POST",
    body: JSON.stringify({ method, params }),
  });
}

export const authApi = {
  status: () => http<{ actor_id?: string }>(`${PLUGIN_BASE}/auth/status`),
  login: (password: string) =>
    http<{ ok: true }>(`${PLUGIN_BASE}/auth/login`, {
      method: "POST",
      body: JSON.stringify({ password }),
    }),
  logout: () => http(`${PLUGIN_BASE}/auth/logout`, { method: "POST", body: "{}" }),
};

/** 媒体路由（带 Cookie，可直接作为 <img src>） */
export const mediaUrl = {
  file: (versionId: string) => `${PLUGIN_BASE}/file/${versionId}`,
  thumb: (versionId: string) => `${PLUGIN_BASE}/thumb/${versionId}`,
  proxy: (versionId: string) => `${PLUGIN_BASE}/proxy/${versionId}`,
};

/* ---------- 领域类型（P0 最小集，随分期扩充） ---------- */

export interface ProjectSummary {
  project_id: string;
  title: string;
  status?: string;
  description?: string;
  aspect_ratio?: string | null;
  resolution?: string | null;
  fps?: number | null;
  spec?: { platforms?: string[]; aspect_ratio?: string; resolution?: string; fps?: number };
  ref_count?: number;
  error_count?: number;
  warning_count?: number;
  created_at?: string;
  updated_at?: string;
}

export interface ProjectIssue {
  level: "error" | "warning" | "info" | string;
  code: string;
  message: string;
  reference_id?: string | null;
  asset_id?: string | null;
  asset_version_id?: string | null;
}

export interface AssetSummary {
  asset_id: string;
  title?: string;
  description?: string;
  kind?: string;
  media_type?: string;
  format_family?: string;
  lifecycle?: string;
  classification?: { domain?: string; type?: string; subtype?: string };
  license_status?: "unknown" | "cleared" | "restricted" | "rejected";
  risk_level?: "unknown" | "low" | "medium" | "high";
  default_version_id?: string;
  tags?: string[];
  created_at?: string;
  updated_at?: string;
}

export interface AssetVersion {
  asset_version_id: string;
  asset_id: string;
  version_label?: string;
  file_name?: string;
  /**
   * 服务端 asset_versions 表实际返回的字段。旧声明里缺了 extension 与 duration_ms，预览组件因此取不到
   * 扩展名与毫秒时长，只能靠 mime_type 猜类型、靠秒数字段猜时长。
   */
  extension?: string | null;
  mime_type?: string;
  container?: string | null;
  size_bytes?: number;
  sha256?: string | null;
  width?: number | null;
  height?: number | null;
  /** 毫秒（表列 duration_ms）。 */
  duration_ms?: number | null;
  frame_rate?: number | null;
  sample_rate?: number | null;
  channels?: number | null;
  codec?: string | null;
  change_summary?: string | null;
  created_at?: string;
}

export interface ProjectRef {
  reference_id: string;
  project_id: string;
  asset_id: string;
  asset_version_id?: string;
  role?: string;
  pin_mode?: "pinned" | "follow_latest" | "candidate";
  required?: boolean;
  asset?: AssetSummary;
}

export interface ProjectDetail extends ProjectSummary {
  refs?: ProjectRef[];
  report?: { issues?: ProjectIssue[]; warnings?: ProjectIssue[] };
  continuity?: {
    issues?: ProjectIssue[];
    errors?: ProjectIssue[];
    warnings?: ProjectIssue[];
  };
}

export interface AnnotationSummaryDetail {
  annotation_id: string;
  annotation_type?: string;
  title?: string;
  body?: string;
  status?: string;
  visibility?: string;
  created_at?: string;
  structured?: {
    severity?: string;
    requested_change?: string;
    [key: string]: unknown;
  };
}

export interface CanvasSubjectContext {
  subject_type?: string;
  subject_id?: string | null;
  asset?: AssetSummary;
  ref?: ProjectRef;
  annotation_summary?: {
    active_count?: number;
    details?: AnnotationSummaryDetail[];
  };
  [key: string]: unknown;
}

export interface CanvasShape {
  shape_id: string;
  canvas_id: string;
  shape_type: string;
  subject_type?: string;
  subject_id?: string;
  title?: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  rotation?: number;
  z_index?: number;
  props?: Record<string, unknown>;
  props_json?: string;
  subject_context?: CanvasSubjectContext;
}

export interface CanvasEdge {
  edge_id: string;
  canvas_id: string;
  source_shape_id: string;
  target_shape_id: string;
  relation_type: string;
  label?: string;
  props?: Record<string, unknown>;
}

export interface CanvasDocument {
  canvas_id: string;
  project_id?: string;
  title?: string;
  status?: string;
  /**
   * REN-08：文档版本号。只在画布卡片/连线发生变化时递增；视口与选择属于视图状态，不参与此计数。
   * 客户端每次写入都必须引用它（expected_revision），否则并发编辑会被静默覆盖。
   */
  revision?: number;
  /**
   * REN-08：服务端解析出的编辑策略。editing=false 时服务端会拒绝一切画布命令（回滚开关），
   * 客户端读同一个值来决定要不要给出编辑手势。
   */
  editing?: {
    editing: boolean;
    viewportDebounceMs: number;
    readOnlyReason: string | null;
    clamped?: string[];
  };
  shape_count?: number;
  edge_count?: number;
  viewport?: { x: number; y: number; zoom: number; width?: number; height?: number };
  shapes: CanvasShape[];
  edges: CanvasEdge[];
}

/** REN-08：一条画布命令。字段随 type 变化，由服务端 canvas-commands.js 校验。 */
export interface CanvasCommand {
  type?:
    | "move_shapes"
    | "update_shapes"
    | "create_shapes"
    | "delete_shapes"
    | "create_edges"
    | "delete_edges"
    | string;
  positions?: { shape_id: string; x: number; y: number }[];
  updates?: { shape_id: string; [key: string]: unknown }[];
  shapes?: Record<string, unknown>[];
  shape_ids?: string[];
  edges?: Record<string, unknown>[];
  edge_ids?: string[];
  [key: string]: unknown;
}

/** 应用一条命令的结果。undo_commands 是服务端记录的逆命令，撤销即“把逆命令当新命令应用”。 */
export interface CanvasCommandResult {
  canvas_id: string;
  command_id: string;
  command_type: string;
  base_revision: number;
  revision: number;
  applied: { [key: string]: unknown };
  created_shape_ids: string[];
  created_edge_ids: string[];
  removed_shape_ids: string[];
  removed_edge_ids: string[];
  undo_commands: CanvasCommand[];
  updated_at: string;
  /** true 表示这条命令此前已应用过（重试/离线队列重复投递），本次未重复生效。 */
  replayed: boolean;
}

export interface CanvasCommandLogEntry {
  command_id: string;
  revision: number;
  base_revision: number;
  command_type: string;
  command: CanvasCommand;
  inverse_commands: CanvasCommand[];
  actor_id: string;
  client_id?: string | null;
  created_at: string;
}

export interface CanvasCommandLog {
  version?: number;
  canvas_id: string;
  revision: number;
  command_count: number;
  limit: number;
  order: string;
  commands: CanvasCommandLogEntry[];
}

export interface CanvasSelectionState {
  canvas_id: string;
  selected_shape_ids: string[];
  primary_shape_id?: string | null;
  selected_shapes: CanvasShape[];
  source?: string | null;
  updated_at?: string | null;
}

export interface CanvasViewState {
  version?: number;
  canvas_id: string;
  view_state?: {
    viewport?: { x: number; y: number; zoom: number; width?: number; height?: number };
    source?: string | null;
    updated_at?: string | null;
  } | null;
  fallback_viewport?: { x: number; y: number; zoom: number; width?: number; height?: number };
}

export interface CanvasIssue extends ProjectIssue {
  shape_id?: string | null;
  subject_type?: string | null;
  subject_id?: string | null;
  edge_id?: string | null;
}

export interface CanvasLint {
  canvas_id: string;
  issue_count: number;
  issues: CanvasIssue[];
  errors: CanvasIssue[];
  warnings: CanvasIssue[];
  infos: CanvasIssue[];
}

export interface AuditEvent {
  event_id: string;
  scope: "asset" | "project" | "system" | string;
  action: string;
  detail?: string;
  actor?: string;
  created_at: string;
}

export interface GenerationJob {
  job_id: string;
  idempotency_key: string;
  entry: string;
  provider: string;
  surface: string;
  actor_id: string;
  state: string;
  phase: string;
  estimated_credits: number;
  actual_credits?: number | null;
  budget_state: string;
  provider_request_id?: string | null;
  provider_submit_state: string;
  local_cancel_requested: boolean;
  remote_cancel_state: string;
  error_code?: string | null;
  error_message?: string | null;
  created_at: string;
  updated_at: string;
}

export interface GenerationJobEvent {
  event_id: string;
  job_id: string;
  seq: number;
  event_type: string;
  state: string;
  phase: string;
  data: Record<string, unknown>;
  created_at: string;
}
