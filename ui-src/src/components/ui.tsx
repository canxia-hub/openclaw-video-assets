/** 小型展示辅助：徽标、字段行、字节/时间格式化。 */

export function fmtBytes(n?: number | null): string {
  if (n == null) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function fmtTime(iso?: string | null): string {
  if (!iso) return "—";
  return iso.slice(0, 16).replace("T", " ");
}

const LICENSE_STYLE: Record<string, string> = {
  unknown: "text-text-faint border-border-subtle",
  cleared: "text-success border-success/40 bg-success/10",
  restricted: "text-warn border-warn/40 bg-warn/10",
  rejected: "text-danger border-danger/40 bg-danger/10",
};
const LICENSE_LABEL: Record<string, string> = {
  unknown: "授权未知",
  cleared: "已清权",
  restricted: "受限",
  rejected: "禁用",
};
const RISK_STYLE: Record<string, string> = {
  unknown: "text-text-faint border-border-subtle",
  low: "text-success border-success/40 bg-success/10",
  medium: "text-warn border-warn/40 bg-warn/10",
  high: "text-danger border-danger/40 bg-danger/10",
};
const RISK_LABEL: Record<string, string> = {
  unknown: "风险未知",
  low: "低风险",
  medium: "中风险",
  high: "高风险",
};

export function licenseBadge(status?: string) {
  const k = status ?? "unknown";
  return { label: LICENSE_LABEL[k] ?? k, cls: LICENSE_STYLE[k] ?? LICENSE_STYLE.unknown };
}
export function riskBadge(level?: string) {
  const k = level ?? "unknown";
  return { label: RISK_LABEL[k] ?? k, cls: RISK_STYLE[k] ?? RISK_STYLE.unknown };
}

export function Badge({ label, cls }: { label: string; cls: string }) {
  return (
    <span className={`inline-block rounded border px-1.5 py-0.5 text-[10px] leading-3 ${cls}`}>
      {label}
    </span>
  );
}

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1">
      <span className="shrink-0 text-[11px] text-text-faint">{label}</span>
      <span className="min-w-0 break-all text-right text-[11px] text-text-primary">{children}</span>
    </div>
  );
}

/** 空状态占位：图标 + 标题 + 提示，可选动作按钮。 */
export function EmptyState({
  icon = "❑",
  title,
  hint,
  action,
}: {
  icon?: string;
  title: string;
  hint?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex min-h-[220px] flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border-subtle p-8 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-bg-raise2 text-xl text-text-faint">
        {icon}
      </div>
      <div className="text-sm text-text-secondary">{title}</div>
      {hint && <div className="max-w-sm text-xs leading-5 text-text-faint">{hint}</div>}
      {action}
    </div>
  );
}
