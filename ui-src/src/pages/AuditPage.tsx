import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { rpc } from "../lib/rpc";
import { useInspector } from "../lib/inspector";
import { Badge, fmtTime } from "../components/ui";

interface CommitEntry {
  commit_id: string;
  scope: string;
  target_id?: string;
  action: string;
  message?: string;
  actor_id?: string;
  created_at: string;
}

const SCOPE_STYLE: Record<string, string> = {
  asset: "text-success border-success/40 bg-success/10",
  project: "text-accent border-accent/40 bg-accent-dim",
  system: "text-text-secondary border-border-subtle",
};

export default function AuditPage() {
  const [scope, setScope] = useState("");
  const [queryInput, setQueryInput] = useState("");
  const [query, setQuery] = useState("");
  const select = useInspector((s) => s.select);

  const q = useQuery({
    queryKey: ["audit.commits", scope, query],
    queryFn: () =>
      rpc<CommitEntry[]>("audit.commits", {
        limit: 120,
        ...(scope ? { scope } : {}),
        ...(query ? { query } : {}),
      }),
  });

  const items = Array.isArray(q.data) ? q.data : [];

  function jumpTarget(targetId?: string) {
    if (!targetId) return;
    if (targetId.startsWith("asset_")) select({ kind: "asset", id: targetId });
    else if (targetId.startsWith("project_")) select({ kind: "project", id: targetId });
  }

  const isJumpable = (id?: string) => !!id && (id.startsWith("asset_") || id.startsWith("project_"));

  return (
    <div className="p-6">
      <h1 className="mb-1 text-lg font-semibold text-text-primary">审计</h1>
      <p className="mb-4 text-sm text-text-secondary">资产/项目/系统操作日志；支持范围筛选与关键词检索，目标可跳转检查器。</p>

      {/* 筛选条 */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <select
          value={scope}
          onChange={(e) => setScope(e.target.value)}
          className="rounded-md border border-border-subtle bg-bg-raise2 px-2.5 py-1.5 text-xs text-text-primary focus:border-accent focus:outline-none"
        >
          <option value="">全部范围</option>
          <option value="asset">资产 asset</option>
          <option value="project">项目 project</option>
          <option value="system">系统 system</option>
        </select>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setQuery(queryInput.trim());
          }}
          className="flex gap-2"
        >
          <input
            value={queryInput}
            onChange={(e) => setQueryInput(e.target.value)}
            placeholder="检索 commit / scope / 消息…"
            className="w-64 rounded-md border border-border-subtle bg-bg-raise2 px-3 py-1.5 text-xs text-text-primary placeholder:text-text-faint focus:border-accent focus:outline-none"
          />
          <button type="submit" className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:opacity-90">
            检索
          </button>
        </form>
        <span className="text-xs text-text-faint">{items.length} 条</span>
      </div>

      {q.isLoading && <div className="text-sm text-text-secondary">加载中…</div>}
      {q.isError && (
        <div className="rounded-md border border-danger/40 bg-danger/10 p-3 text-sm text-danger">
          {q.error instanceof Error ? q.error.message : "加载失败"}
        </div>
      )}

      {q.data && (
        <div className="overflow-hidden rounded-lg border border-border-subtle">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-border-subtle bg-bg-raise2 text-text-faint">
                <th className="w-36 px-3 py-2 font-medium">时间</th>
                <th className="w-20 px-3 py-2 font-medium">范围</th>
                <th className="w-36 px-3 py-2 font-medium">动作</th>
                <th className="px-3 py-2 font-medium">消息</th>
                <th className="w-28 px-3 py-2 font-medium">操作者</th>
                <th className="w-20 px-3 py-2 font-medium">目标</th>
              </tr>
            </thead>
            <tbody>
              {items.map((c) => (
                <tr key={c.commit_id} className="border-b border-border-subtle last:border-0 hover:bg-bg-hover">
                  <td className="px-3 py-2 text-text-faint">{fmtTime(c.created_at)}</td>
                  <td className="px-3 py-2">
                    <Badge label={c.scope} cls={SCOPE_STYLE[c.scope] ?? SCOPE_STYLE.system} />
                  </td>
                  <td className="max-w-0 truncate px-3 py-2 font-mono text-[10px] text-text-secondary" title={c.action}>
                    {c.action}
                  </td>
                  <td className="max-w-0 truncate px-3 py-2 text-text-primary" title={c.message ?? ""}>
                    {c.message ?? "—"}
                  </td>
                  <td className="max-w-0 truncate px-3 py-2 text-text-faint" title={c.actor_id ?? ""}>
                    {c.actor_id ?? "—"}
                  </td>
                  <td className="px-3 py-2">
                    {isJumpable(c.target_id) ? (
                      <button
                        onClick={() => jumpTarget(c.target_id)}
                        className="rounded border border-accent/40 bg-accent-dim px-2 py-0.5 text-[10px] text-accent hover:opacity-80"
                      >
                        查看
                      </button>
                    ) : (
                      <span className="text-[10px] text-text-faint">—</span>
                    )}
                  </td>
                </tr>
              ))}
              {items.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-3 py-8 text-center text-text-faint">
                    无匹配日志
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
