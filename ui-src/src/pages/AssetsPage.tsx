import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { rpc, type AssetSummary } from "../lib/rpc";
import { useInspector } from "../lib/inspector";
import { Badge, fmtTime, licenseBadge, riskBadge } from "../components/ui";

const MEDIA_TYPES = ["image", "video", "audio", "document", "other"];
const LICENSES = ["unknown", "cleared", "restricted", "rejected"];
const RISKS = ["unknown", "low", "medium", "high"];

function FilterSelect({
  label,
  value,
  options,
  onChange,
  labels,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (v: string) => void;
  labels?: Record<string, string>;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="rounded-md border border-border-subtle bg-bg-raise2 px-2 py-1.5 text-xs text-text-secondary focus:border-accent focus:outline-none"
      title={label}
    >
      <option value="">{label}：全部</option>
      {options.map((o) => (
        <option key={o} value={o}>
          {labels?.[o] ?? o}
        </option>
      ))}
    </select>
  );
}

export default function AssetsPage() {
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [mediaType, setMediaType] = useState("");
  const [license, setLicense] = useState("");
  const [risk, setRisk] = useState("");
  const selection = useInspector((s) => s.selection);
  const select = useInspector((s) => s.select);

  const q = useQuery({
    queryKey: ["asset.search", submitted],
    queryFn: () => rpc<AssetSummary[]>("asset.search", { query: submitted, limit: 100 }),
  });

  const items = useMemo(() => {
    let list = Array.isArray(q.data) ? q.data : [];
    if (mediaType) list = list.filter((a) => a.media_type === mediaType);
    if (license) list = list.filter((a) => (a.license_status ?? "unknown") === license);
    if (risk) list = list.filter((a) => (a.risk_level ?? "unknown") === risk);
    return list;
  }, [q.data, mediaType, license, risk]);

  return (
    <div className="p-6">
      <h1 className="mb-1 text-lg font-semibold text-text-primary">资产库</h1>
      <p className="mb-4 text-sm text-text-secondary">检索、筛选与查看资产；点击行在右侧检查器查看详情。</p>

      {/* 搜索 + 筛选条 */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setSubmitted(query.trim());
          }}
          className="flex gap-2"
        >
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索标题 / 描述…"
            className="w-64 rounded-md border border-border-subtle bg-bg-raise2 px-3 py-1.5 text-xs text-text-primary placeholder:text-text-faint focus:border-accent focus:outline-none"
          />
          <button
            type="submit"
            className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:opacity-90"
          >
            搜索
          </button>
        </form>
        <FilterSelect label="类型" value={mediaType} options={MEDIA_TYPES} onChange={setMediaType} />
        <FilterSelect
          label="授权"
          value={license}
          options={LICENSES}
          onChange={setLicense}
          labels={{ unknown: "未知", cleared: "已清权", restricted: "受限", rejected: "禁用" }}
        />
        <FilterSelect
          label="风险"
          value={risk}
          options={RISKS}
          onChange={setRisk}
          labels={{ unknown: "未知", low: "低", medium: "中", high: "高" }}
        />
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
                <th className="px-3 py-2 font-medium">标题</th>
                <th className="w-20 px-3 py-2 font-medium">类型</th>
                <th className="w-16 px-3 py-2 font-medium">种类</th>
                <th className="w-24 px-3 py-2 font-medium">授权</th>
                <th className="w-24 px-3 py-2 font-medium">风险</th>
                <th className="w-28 px-3 py-2 font-medium">更新</th>
              </tr>
            </thead>
            <tbody>
              {items.map((a) => {
                const active = selection?.kind === "asset" && selection.id === a.asset_id;
                const lic = licenseBadge(a.license_status);
                const rk = riskBadge(a.risk_level);
                return (
                  <tr
                    key={a.asset_id}
                    onClick={() => select({ kind: "asset", id: a.asset_id })}
                    className={`cursor-pointer border-b border-border-subtle transition-colors last:border-0 ${
                      active ? "bg-accent-dim" : "hover:bg-bg-hover"
                    }`}
                  >
                    <td className="max-w-0 truncate px-3 py-2.5 text-text-primary" title={a.title ?? a.asset_id}>
                      {a.title || <span className="font-mono text-[10px]">{a.asset_id}</span>}
                    </td>
                    <td className="px-3 py-2.5 text-text-secondary">{a.media_type ?? "—"}</td>
                    <td className="px-3 py-2.5 text-text-secondary">{a.kind ?? "—"}</td>
                    <td className="px-3 py-2.5"><Badge label={lic.label} cls={lic.cls} /></td>
                    <td className="px-3 py-2.5"><Badge label={rk.label} cls={rk.cls} /></td>
                    <td className="px-3 py-2.5 text-text-faint">{fmtTime(a.updated_at)}</td>
                  </tr>
                );
              })}
              {items.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-3 py-8 text-center text-text-faint">
                    无匹配资产
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
