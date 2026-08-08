import { useQuery } from "@tanstack/react-query";
import { rpc, type AssetSummary, type ProjectSummary } from "../lib/rpc";

interface SearchResult<T> {
  items?: T[];
  total?: number;
}

/** 后端 search 返回形态不统一（数组或 {items}），统一归一化。 */
function normalizeList<T>(data: SearchResult<T> | T[] | undefined): T[] {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  return data.items ?? [];
}

function StatCard({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="rounded-lg border border-border-subtle bg-bg-raise1 p-4">
      <div className="text-xs text-text-faint">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-text-primary">{value}</div>
      {hint && <div className="mt-1 text-[11px] text-text-secondary">{hint}</div>}
    </div>
  );
}

export default function DashboardPage() {
  const projects = useQuery({
    queryKey: ["project.search"],
    queryFn: () => rpc<SearchResult<ProjectSummary> | ProjectSummary[]>("project.search", {}),
  });
  const assets = useQuery({
    queryKey: ["asset.search"],
    queryFn: () => rpc<SearchResult<AssetSummary> | AssetSummary[]>("asset.search", {}),
  });

  const loading = projects.isLoading || assets.isLoading;
  const failed = projects.isError || assets.isError;

  return (
    <div className="p-6">
      <h1 className="mb-1 text-lg font-semibold text-text-primary">仪表盘</h1>
      <p className="mb-6 text-sm text-text-secondary">仓库概览与健康状况（P0 实时 RPC 联通验证）。</p>

      {loading && <div className="text-sm text-text-secondary">加载中…</div>}
      {failed && (
        <div className="rounded-md border border-danger/40 bg-danger/10 p-3 text-sm text-danger">
          RPC 联通失败：{String((projects.error ?? assets.error) instanceof Error ? (projects.error ?? assets.error) : "未知错误")}
        </div>
      )}

      {projects.data && assets.data && (() => {
        const projectItems = normalizeList(projects.data);
        const assetItems = normalizeList(assets.data);
        return (
        <div className="grid max-w-3xl grid-cols-2 gap-4 lg:grid-cols-4">
          <StatCard label="项目" value={projectItems.length} />
          <StatCard label="资产" value={assetItems.length} />
          <StatCard label="引用" value={projectItems.reduce((n, p) => n + (p.ref_count ?? 0), 0)} />
          <StatCard
            label="风险（错误/警告）"
            value={`${projectItems.reduce((n, p) => n + (p.error_count ?? 0), 0)} / ${projectItems.reduce((n, p) => n + (p.warning_count ?? 0), 0)}`}
          />
        </div>
        );
      })()}

      {normalizeList(projects.data).length > 0 && (
        <section className="mt-8 max-w-3xl">
          <h2 className="mb-3 text-sm font-medium text-text-primary">项目速览</h2>
          <div className="space-y-2">
            {normalizeList(projects.data).map((p) => (
              <div
                key={p.project_id}
                className="flex items-center justify-between rounded-md border border-border-subtle bg-bg-raise1 px-4 py-3"
              >
                <span className="text-sm text-text-primary">{p.title || p.project_id}</span>
                <span className="text-xs">
                  {(p.error_count ?? 0) > 0 ? (
                    <span className="text-danger">{p.error_count} 错误</span>
                  ) : (
                    <span className="text-success">无错误</span>
                  )}
                  <span className="ml-2 text-text-faint">{p.status ?? "—"}</span>
                </span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
