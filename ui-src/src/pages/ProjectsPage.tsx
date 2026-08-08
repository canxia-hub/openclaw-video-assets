import { useQuery } from "@tanstack/react-query";
import { rpc, type ProjectSummary } from "../lib/rpc";
import { useInspector } from "../lib/inspector";
import { Badge, EmptyState, fmtTime } from "../components/ui";

export default function ProjectsPage() {
  const selection = useInspector((s) => s.selection);
  const select = useInspector((s) => s.select);

  const q = useQuery({
    queryKey: ["project.search"],
    queryFn: () => rpc<ProjectSummary[]>("project.search", {}),
  });

  const items = Array.isArray(q.data) ? q.data : [];

  return (
    <div className="p-6">
      <h1 className="mb-1 text-lg font-semibold text-text-primary">项目</h1>
      <p className="mb-4 text-sm text-text-secondary">视频项目与资产引用、风险概览；点击卡片在右侧检查器查看详情。</p>

      {q.isLoading && <div className="text-sm text-text-secondary">加载中…</div>}
      {q.isError && (
        <div className="rounded-md border border-danger/40 bg-danger/10 p-3 text-sm text-danger">
          {q.error instanceof Error ? q.error.message : "加载失败"}
        </div>
      )}

      <div className="grid max-w-4xl grid-cols-1 gap-4 lg:grid-cols-2">
        {items.map((p) => {
          const active = selection?.kind === "project" && selection.id === p.project_id;
          return (
            <button
              key={p.project_id}
              onClick={() => select({ kind: "project", id: p.project_id })}
              className={`rounded-lg border p-4 text-left transition-colors ${
                active
                  ? "border-accent/50 bg-accent-dim"
                  : "border-border-subtle bg-bg-raise1 hover:bg-bg-hover"
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 text-sm font-medium text-text-primary">{p.title || p.project_id}</div>
                <Badge label={p.status ?? "—"} cls="text-accent border-accent/40 bg-accent-dim shrink-0" />
              </div>
              {p.description && (
                <p className="mt-2 line-clamp-2 text-[11px] leading-4 text-text-secondary">{p.description}</p>
              )}
              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                <Badge label={`引用 ${p.ref_count ?? 0}`} cls="text-text-secondary border-border-subtle" />
                {(p.error_count ?? 0) > 0 ? (
                  <Badge label={`${p.error_count} 错误`} cls="text-danger border-danger/40 bg-danger/10" />
                ) : (
                  <Badge label="无错误" cls="text-success border-success/40 bg-success/10" />
                )}
                {(p.warning_count ?? 0) > 0 && (
                  <Badge label={`${p.warning_count} 警告`} cls="text-warn border-warn/40 bg-warn/10" />
                )}
              </div>
              <div className="mt-3 text-[10px] text-text-faint">更新 {fmtTime(p.updated_at)}</div>
            </button>
          );
        })}
      </div>

      {q.data && items.length === 0 && (
        <EmptyState icon="▣" title="暂无项目" hint="通过插件 RPC 或画布创建项目后，会显示在这里。" />
      )}
    </div>
  );
}
