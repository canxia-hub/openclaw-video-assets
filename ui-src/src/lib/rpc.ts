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
  mime_type?: string;
  size_bytes?: number;
  width?: number;
  height?: number;
  duration_seconds?: number;
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
  shape_count?: number;
  edge_count?: number;
  viewport?: { x: number; y: number; zoom: number; width?: number; height?: number };
  shapes: CanvasShape[];
  edges: CanvasEdge[];
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
