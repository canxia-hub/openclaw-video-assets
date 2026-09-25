import { useEffect, useMemo, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import { rpc, type AssetSummary } from "../lib/rpc";
import { useInspector } from "../lib/inspector";
import { Badge, fmtTime, licenseBadge, riskBadge } from "../components/ui";
import MediaPreview from "../components/MediaPreview";
import UploadPanel from "../components/UploadPanel";
import { announce } from "../lib/announcer";

/*
 * AssetsPage —— 素材库列表。
 *
 * 相对旧版的三处实质变化（都对应门3）：
 *
 * 1) **分页/筛选/排序/总数全部在服务端**（videoAssets.asset.browse）。旧版向 asset.search 要
 *    `limit: 100` 再在浏览器里过滤：超过 100 条时筛选只作用于前 100 行，而且界面上没有任何提示。
 *    现在总数来自服务端 COUNT，分页按钮按总数走，最后一条能被翻到。
 *
 * 2) **计数如实**：显示"共 N 条，当前显示第 a–b 条"。只有 N=0 才说"无匹配"，避免把"截断"说成"没有"。
 *
 * 3) **窄屏可横向滚动**：表格容器由 `overflow-hidden` 改为 `overflow-x-auto`。旧版在 390px 下
 *    右侧列直接消失且无法滚动查看。
 *
 * 另外列表首列给出缩略预览，检索结果变化与分页动作都经 aria-live 播报（门3 的可访问性要求）。
 */

const MEDIA_TYPES = ["image", "video", "audio", "document", "other"];
const LICENSES = ["unknown", "cleared", "restricted", "rejected"];
const RISKS = ["unknown", "low", "medium", "high"];
const PAGE_SIZES = [25, 50, 100, 200];
const SORT_FIELDS: Array<{ value: string; label: string }> = [
  { value: "updated_at", label: "更新时间" },
  { value: "created_at", label: "创建时间" },
  { value: "title", label: "标题" },
  { value: "asset_id", label: "资产编号" }
];

interface BrowseResponse {
  items: AssetSummary[];
  total: number;
  limit: number;
  offset: number;
  returned: number;
  has_more: boolean;
  sort: { by: string; dir: string; requested_by: string; applied_default: boolean };
  filters: Record<string, string[]>;
  query: string | null;
}

function FilterSelect({
  label,
  value,
  options,
  onChange,
  labels
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (v: string) => void;
  labels?: Record<string, string>;
}) {
  return (
    <label className="flex items-center gap-1 text-xs text-text-faint">
      <span className="sr-only">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-md border border-border-subtle bg-bg-raise2 px-2 py-1.5 text-xs text-text-secondary focus:border-accent focus:outline-none"
        title={label}
        aria-label={label}
      >
        <option value="">{label}：全部</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {labels?.[o] ?? o}
          </option>
        ))}
      </select>
    </label>
  );
}

export default function AssetsPage() {
  const { assetId } = useParams<{ assetId?: string }>();
  const navigate = useNavigate();
  const [queryInput, setQueryInput] = useState("");
  const [query, setQuery] = useState("");
  const [mediaType, setMediaType] = useState("");
  const [license, setLicense] = useState("");
  const [risk, setRisk] = useState("");
  const [sortBy, setSortBy] = useState("updated_at");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [pageSize, setPageSize] = useState(50);
  const [offset, setOffset] = useState(0);
  const selection = useInspector((s) => s.selection);
  const select = useInspector((s) => s.select);

  // 任何筛选/排序/页大小变化都必须把 offset 归零：否则会停在一个对新的结果集并不存在的页上，
  // 界面显示"共 3 条，第 500–510 条"这种自相矛盾的状态。
  useEffect(() => {
    setOffset(0);
  }, [query, mediaType, license, risk, sortBy, sortDir, pageSize]);

  const params = useMemo(
    () => ({
      query,
      media_type: mediaType || undefined,
      license_status: license || undefined,
      risk_level: risk || undefined,
      sort_by: sortBy,
      sort_dir: sortDir,
      limit: pageSize,
      offset
    }),
    [query, mediaType, license, risk, sortBy, sortDir, pageSize, offset]
  );

  const q = useQuery({
    queryKey: ["asset.browse", params],
    queryFn: () => rpc<BrowseResponse>("asset.browse", params),
    // 翻页时保留上一页数据：否则每翻一页表格先清空再填充，视觉上是闪烁。
    placeholderData: keepPreviousData
  });

  const data = q.data;
  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const firstShown = items.length === 0 ? 0 : (data?.offset ?? offset) + 1;
  const lastShown = (data?.offset ?? offset) + items.length;
  const hasPrev = (data?.offset ?? 0) > 0;
  const hasNext = Boolean(data?.has_more);
  const pageIndex = Math.floor((data?.offset ?? 0) / pageSize) + 1;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  // 检索完成即播报结果规模 —— 屏幕阅读器用户看不到"共 N 条"被刷新。
  useEffect(() => {
    if (!data) return;
    const filters = [mediaType && `类型=${mediaType}`, license && `授权=${license}`, risk && `风险=${risk}`].filter(Boolean).join("、");
    announce(
      `共 ${data.total} 条${data.query ? `匹配“${data.query}”` : ""}${filters ? `（${filters}）` : ""}，当前显示第 ${data.offset + (data.items.length ? 1 : 0)}–${data.offset + data.items.length} 条，排序 ${data.sort.by} ${data.sort.dir}`
    );
  }, [data, mediaType, license, risk]);

  useEffect(() => {
    if (assetId && (selection?.kind !== "asset" || selection.id !== assetId)) {
      select({ kind: "asset", id: assetId });
    }
  }, [assetId, select, selection]);

  const routeAssetMissing = Boolean(assetId && data && !items.some((item) => item.asset_id === assetId));

  return (
    <div className="p-6">
      <h1 className="mb-1 text-lg font-semibold text-text-primary">素材库</h1>
      <p className="mb-4 text-sm text-text-secondary">检索、筛选与查看素材；点击行在右侧检查器查看详情与预览。</p>

      <UploadPanel />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setQuery(queryInput.trim());
          }}
          className="flex gap-2"
          role="search"
        >
          <input
            value={queryInput}
            onChange={(e) => setQueryInput(e.target.value)}
            placeholder="搜索标题 / 描述 / 编号…"
            aria-label="搜索素材"
            data-testid="asset-search-input"
            className="w-64 rounded-md border border-border-subtle bg-bg-raise2 px-3 py-1.5 text-xs text-text-primary placeholder:text-text-faint focus:border-accent focus:outline-none"
          />
          <button type="submit" data-testid="asset-search-submit" className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:opacity-90">
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
        <FilterSelect label="风险" value={risk} options={RISKS} onChange={setRisk} labels={{ unknown: "未知", low: "低", medium: "中", high: "高" }} />

        <label className="flex items-center gap-1 text-xs text-text-faint">
          <span className="sr-only">排序字段</span>
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value)}
            aria-label="排序字段"
            data-testid="asset-sort-field"
            className="rounded-md border border-border-subtle bg-bg-raise2 px-2 py-1.5 text-xs text-text-secondary focus:border-accent focus:outline-none"
          >
            {SORT_FIELDS.map((f) => (
              <option key={f.value} value={f.value}>
                排序：{f.label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          data-testid="asset-sort-dir"
          onClick={() => setSortDir((current) => (current === "desc" ? "asc" : "desc"))}
          className="rounded-md border border-border-subtle px-2 py-1.5 text-xs text-text-secondary"
          aria-label={`切换排序方向（当前 ${sortDir === "desc" ? "降序" : "升序"}）`}
        >
          {sortDir === "desc" ? "↓ 降序" : "↑ 升序"}
        </button>

        <label className="flex items-center gap-1 text-xs text-text-faint">
          <span className="sr-only">每页条数</span>
          <select
            value={String(pageSize)}
            onChange={(e) => setPageSize(Number(e.target.value))}
            aria-label="每页条数"
            data-testid="asset-page-size"
            className="rounded-md border border-border-subtle bg-bg-raise2 px-2 py-1.5 text-xs text-text-secondary focus:border-accent focus:outline-none"
          >
            {PAGE_SIZES.map((size) => (
              <option key={size} value={size}>
                每页 {size} 条
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-3 text-xs text-text-faint" data-testid="asset-counts">
        <span data-testid="asset-total">
          共 <span className="font-mono text-text-secondary">{total}</span> 条
        </span>
        <span data-testid="asset-shown">
          {total === 0 ? "无匹配" : `第 ${firstShown}–${lastShown} 条`}
        </span>
        <span className="font-mono">
          第 {pageIndex} / {pageCount} 页
        </span>
        {data?.sort?.applied_default === false && <span>排序：{data.sort.by} {data.sort.dir}</span>}
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            data-testid="asset-page-prev"
            disabled={!hasPrev}
            onClick={() => setOffset(Math.max(0, (data?.offset ?? 0) - pageSize))}
            className="rounded-md border border-border-subtle px-2 py-1 text-text-secondary disabled:opacity-40"
          >
            上一页
          </button>
          <button
            type="button"
            data-testid="asset-page-next"
            disabled={!hasNext}
            onClick={() => setOffset((data?.offset ?? 0) + pageSize)}
            className="rounded-md border border-border-subtle px-2 py-1 text-text-secondary disabled:opacity-40"
          >
            下一页
          </button>
        </div>
      </div>

      {q.isLoading && (
        <div className="text-sm text-text-secondary" data-testid="asset-loading">
          加载中…
        </div>
      )}
      {q.isError && (
        <div className="rounded-md border border-danger/40 bg-danger/10 p-3 text-sm text-danger" data-testid="asset-error">
          {q.error instanceof Error ? q.error.message : "加载失败"}
        </div>
      )}
      {routeAssetMissing && (
        <div className="mb-4 rounded-md border border-danger/40 bg-danger/10 p-3 text-sm text-danger" data-testid="asset-route-missing">
          当前列表未找到路由指定资产：<span className="font-mono text-xs">{assetId}</span>。右侧检查器会按资产编号读取，不会静默选中其他资产。
        </div>
      )}

      {data && (
        // overflow-x-auto（不是 overflow-hidden）：窄屏下右侧列可横向滚动查看，而不是被裁掉。
        <div className="overflow-x-auto rounded-lg border border-border-subtle" data-testid="asset-table-scroll">
          <table className="w-full min-w-[720px] text-left text-xs">
            <thead>
              <tr className="border-b border-border-subtle bg-bg-raise2 text-text-faint">
                <th className="w-24 px-3 py-2 font-medium">预览</th>
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
                const previewSource = a.default_version_id
                  ? { versionId: a.default_version_id, title: a.title, mimeType: a.media_type ? `${a.media_type}/` : null, extension: null }
                  : null;
                return (
                  <tr
                    key={a.asset_id}
                    data-asset-id={a.asset_id}
                    data-testid="asset-row"
                    tabIndex={0}
                    aria-selected={active}
                    onClick={() => {
                      select({ kind: "asset", id: a.asset_id });
                      navigate(`/assets/${a.asset_id}`);
                    }}
                    onKeyDown={(event) => {
                      // 行是可达的：键盘用户按 Enter/空格等同点击。可点击但不可聚焦的行，键盘用户用不了。
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        select({ kind: "asset", id: a.asset_id });
                        navigate(`/assets/${a.asset_id}`);
                      }
                    }}
                    className={`cursor-pointer border-b border-border-subtle transition-colors last:border-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                      active ? "bg-accent-dim" : "hover:bg-bg-hover"
                    }`}
                  >
                    <td className="px-3 py-2">
                      <MediaPreview source={previewSource} variant="thumb" />
                    </td>
                    <td className="max-w-0 truncate px-3 py-2.5 text-text-primary" title={a.title ?? a.asset_id}>
                      {a.title || <span className="font-mono text-[10px]">{a.asset_id}</span>}
                    </td>
                    <td className="px-3 py-2.5 text-text-secondary">{a.media_type ?? "—"}</td>
                    <td className="px-3 py-2.5 text-text-secondary">{a.kind ?? "—"}</td>
                    <td className="px-3 py-2.5">
                      <Badge label={lic.label} cls={lic.cls} />
                    </td>
                    <td className="px-3 py-2.5">
                      <Badge label={rk.label} cls={rk.cls} />
                    </td>
                    <td className="px-3 py-2.5 text-text-faint">{fmtTime(a.updated_at)}</td>
                  </tr>
                );
              })}
              {items.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-3 py-8 text-center text-text-faint" data-testid="asset-empty">
                    {query || mediaType || license || risk ? "当前筛选条件下没有匹配素材（总数 0）" : "素材库为空"}
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
