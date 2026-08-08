/** 展示辅助：可读性规则（哈希永不作主文本）、语义色板、格式化。 */

export function shortId(id?: string | null): string {
  if (!id) return "—";
  const clean = id.replace(/^(asset_|ver_|ref_|project_|canvas_|shape_|edge_|branch_|source_)/, "");
  return clean.length > 8 ? `${clean.slice(0, 8)}…` : clean;
}

export function formatBytes(n?: number | null): string {
  if (n == null) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function formatTime(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("zh-CN", { hour12: false });
}

export type LicenseStatus = "unknown" | "cleared" | "restricted" | "rejected" | string | undefined;

export const LICENSE_META: Record<string, { label: string; className: string }> = {
  cleared: { label: "已授权", className: "border-success/50 bg-success/10 text-success" },
  unknown: { label: "授权未确认", className: "border-warning/50 bg-warning/10 text-warning" },
  restricted: { label: "授权受限", className: "border-restricted/50 bg-restricted/10 text-restricted" },
  rejected: { label: "授权拒绝", className: "border-danger/50 bg-danger/10 text-danger" },
};

export function licenseMeta(status: LicenseStatus) {
  return LICENSE_META[status ?? "unknown"] ?? LICENSE_META.unknown;
}

export const RISK_META: Record<string, { label: string; className: string }> = {
  low: { label: "低风险", className: "text-success" },
  unknown: { label: "风险未知", className: "text-warning" },
  medium: { label: "中风险", className: "text-restricted" },
  high: { label: "高风险", className: "text-danger" },
};

export const MEDIA_ICON: Record<string, string> = {
  image: "🖼",
  video: "🎬",
  audio: "🎵",
  document: "📄",
  subtitle: "💬",
  other: "📦",
};

export function mediaIcon(mediaType?: string): string {
  return MEDIA_ICON[mediaType ?? "other"] ?? MEDIA_ICON.other;
}

export const MEDIA_LABEL: Record<string, string> = {
  image: "图像",
  video: "视频",
  audio: "音频",
  document: "文档",
  subtitle: "字幕",
  other: "其他",
};

export function mediaLabel(mediaType?: string): string {
  return MEDIA_LABEL[mediaType ?? "other"] ?? "其他";
}
