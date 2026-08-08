/**
 * Cmd+K / Ctrl+K 全局搜索命令面板。
 * 跨项目/资产/画布并行搜索 + 页面快捷跳转，键盘可达（↑↓/Enter/Esc）。
 * 空查询时展示各域最近条目（limit 6），保证开箱即有内容。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { create } from "zustand";
import { rpc, type AssetSummary, type ProjectSummary } from "../lib/rpc";

interface PaletteState {
  open: boolean;
  setOpen: (v: boolean) => void;
  toggle: () => void;
}

export const usePalette = create<PaletteState>((set) => ({
  open: false,
  setOpen: (v) => set({ open: v }),
  toggle: () => set((s) => ({ open: !s.open })),
}));

interface CanvasItem {
  canvas_id: string;
  title?: string;
  shape_count?: number;
  updated_at?: string;
}

interface Item {
  key: string;
  group: string;
  icon: string;
  title: string;
  sub?: string;
  to: string;
}

const PAGES: Item[] = [
  { key: "page-dashboard", group: "页面", icon: "◧", title: "仪表盘", to: "/dashboard" },
  { key: "page-projects", group: "页面", icon: "▣", title: "项目", to: "/projects" },
  { key: "page-assets", group: "页面", icon: "❑", title: "资产库", to: "/assets" },
  { key: "page-canvas", group: "页面", icon: "✦", title: "画布", to: "/canvas" },
  { key: "page-generate", group: "页面", icon: "◈", title: "生成", to: "/generate" },
  { key: "page-staging", group: "页面", icon: "⇪", title: "暂存", to: "/staging" },
  { key: "page-audit", group: "页面", icon: "☰", title: "审计", to: "/audit" },
  { key: "page-settings", group: "页面", icon: "⚙", title: "设置", to: "/settings" },
];

/** RPC 返回可能是数组或 {items}/{projects}/{assets}/{canvases} 包裹，统一归一。 */
function asArray<T>(d: unknown): T[] {
  if (Array.isArray(d)) return d as T[];
  if (d && typeof d === "object") {
    const o = d as Record<string, unknown>;
    for (const k of ["items", "projects", "assets", "canvases", "results"]) {
      if (Array.isArray(o[k])) return o[k] as T[];
    }
  }
  return [];
}

export default function CommandPalette() {
  const { open, setOpen } = usePalette();
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  // 全局热键 Cmd+K / Ctrl+K
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        usePalette.getState().toggle();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // 打开时重置并聚焦；打开期间 Esc 全局可关
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setDebounced("");
    setActive(0);
    requestAnimationFrame(() => inputRef.current?.focus());
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [open, setOpen]);

  // 输入防抖 150ms
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 150);
    return () => clearTimeout(t);
  }, [query]);

  const q = useQuery({
    queryKey: ["palette", debounced],
    enabled: open,
    staleTime: 30_000,
    queryFn: async () => {
      const params: Record<string, unknown> = { limit: 6 };
      if (debounced) params.query = debounced;
      const [projects, assets, canvases] = await Promise.all([
        rpc<unknown>("project.search", params).catch(() => []),
        rpc<unknown>("asset.search", params).catch(() => []),
        rpc<unknown>("canvas.search", params).catch(() => []),
      ]);
      return {
        projects: asArray<ProjectSummary>(projects),
        assets: asArray<AssetSummary>(assets),
        canvases: asArray<CanvasItem>(canvases),
      };
    },
  });

  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];
    const needle = debounced.toLowerCase();
    for (const p of PAGES) {
      if (!needle || p.title.toLowerCase().includes(needle)) out.push(p);
    }
    for (const proj of q.data?.projects ?? []) {
      out.push({
        key: `project-${proj.project_id}`,
        group: "项目",
        icon: "▣",
        title: proj.title || proj.project_id,
        sub: proj.status,
        to: `/projects/${proj.project_id}`,
      });
    }
    for (const a of q.data?.assets ?? []) {
      out.push({
        key: `asset-${a.asset_id}`,
        group: "资产",
        icon: "❑",
        title: a.title || a.asset_id,
        sub: [a.media_type, a.kind].filter(Boolean).join(" · ") || undefined,
        to: `/assets/${a.asset_id}`,
      });
    }
    for (const c of q.data?.canvases ?? []) {
      out.push({
        key: `canvas-${c.canvas_id}`,
        group: "画布",
        icon: "✦",
        title: c.title || c.canvas_id,
        sub: c.shape_count != null ? `${c.shape_count} 节点` : undefined,
        to: `/canvas/${c.canvas_id}`,
      });
    }
    return out;
  }, [debounced, q.data]);

  // 结果集变化时回到第一项
  useEffect(() => setActive(0), [items.length, debounced]);

  // 激活项保持可见
  useEffect(() => {
    const it = items[active];
    if (it) document.getElementById(it.key)?.scrollIntoView({ block: "nearest" });
  }, [active, items]);

  if (!open) return null;

  const run = (item: Item) => {
    setOpen(false);
    navigate(item.to);
  };

  const onInputKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, items.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const it = items[active];
      if (it) run(it);
    }
  };

  let lastGroup = "";

  return (
    <div
      className="animate-fade-in fixed inset-0 z-50 flex items-start justify-center bg-black/60 pt-[18vh]"
      onClick={() => setOpen(false)}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="全局搜索"
        className="animate-palette-in w-[600px] max-w-[92vw] overflow-hidden rounded-lg border border-border-strong bg-bg-raise1"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-border-subtle px-4">
          <span className="text-sm text-text-faint">⌕</span>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onInputKey}
            placeholder="搜索项目、资产、画布，或跳转页面…"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={items[active]?.key}
            className="h-12 flex-1 bg-transparent text-sm text-text-primary placeholder:text-text-faint focus:outline-none"
          />
          <kbd className="rounded border border-border-subtle px-1.5 py-0.5 text-[10px] text-text-faint">Esc</kbd>
        </div>
        <div id="palette-list" role="listbox" className="max-h-[46vh] overflow-y-auto p-1.5">
          {items.length === 0 && (
            <div className="px-3 py-8 text-center text-xs text-text-faint">
              {q.isLoading || q.isFetching ? "搜索中…" : "无匹配结果"}
            </div>
          )}
          {items.map((item, i) => {
            const header = item.group !== lastGroup ? item.group : null;
            lastGroup = item.group;
            return (
              <div key={item.key}>
                {header && (
                  <div className="px-3 pb-1 pt-2 text-[10px] tracking-wide text-text-faint">{header}</div>
                )}
                <button
                  id={item.key}
                  role="option"
                  aria-selected={i === active}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => run(item)}
                  className={`flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors ${
                    i === active ? "bg-accent-dim text-text-primary" : "text-text-secondary"
                  }`}
                >
                  <span className="w-4 text-center text-xs text-text-faint">{item.icon}</span>
                  <span className="min-w-0 flex-1 truncate">{item.title}</span>
                  {item.sub && <span className="shrink-0 text-[10px] text-text-faint">{item.sub}</span>}
                </button>
              </div>
            );
          })}
        </div>
        <div className="flex items-center gap-3 border-t border-border-subtle px-4 py-2 text-[10px] text-text-faint">
          <span>↑↓ 选择</span>
          <span>Enter 打开</span>
          <span>Esc 关闭</span>
          <span className="ml-auto">{q.isFetching ? "搜索中…" : `${items.length} 项`}</span>
        </div>
      </div>
    </div>
  );
}
