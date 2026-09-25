import { useEffect, useRef, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { buildLabel } from "../lib/version";
import LiveRegion from "./LiveRegion";
import { useFocusTrap } from "../lib/focus";
import { useInspector } from "../lib/inspector";
import { AssetInspector, EdgeInspector, ProjectInspector, ShapeInspector } from "./inspectors";
import CommandPalette, { usePalette } from "./CommandPalette";

type NavItem = { to: string; label: string; icon: string };

/*
 * Navigation is TWO lists on purpose (REN-07 gate 2).
 *
 * PRODUCT is the production path a user follows, in order: 项目总览 → 素材库 → 镜头画布 → 生成队列 → 审核交付.
 * DIAGNOSTICS is operator material - staging ledgers, audit records, settings. It used to sit in the same list,
 * which made internal state look like a product feature and implied the workbench is further along than it is.
 *
 * A destination that is built is linked; a destination that is NOT built still appears, because hiding it would
 * leave the user wondering where the capability went, and shows an honest placeholder stating what exists. That
 * is the point of gate 2's "未实现能力不伪装可用": the label is a promise, so the page behind it must keep it.
 */
const PRODUCT_NAV: NavItem[] = [
  { to: "/dashboard", label: "项目总览", icon: "▣" },
  { to: "/assets", label: "素材库", icon: "❑" },
  { to: "/canvas", label: "镜头画布", icon: "✦" },
  { to: "/generate", label: "生成准备", icon: "◈" },
  { to: "/jobs", label: "生成队列", icon: "⇄" },
  { to: "/review", label: "审核交付", icon: "◎" },
];

const DIAGNOSTIC_NAV: NavItem[] = [
  { to: "/staging", label: "暂存台账", icon: "⇪" },
  { to: "/audit", label: "审计记录", icon: "☰" },
  { to: "/diagnostics", label: "诊断", icon: "◍" },
  { to: "/settings", label: "设置", icon: "⚙" },
];

/* Shared renderer so the two groups cannot drift in styling. */
function renderNavItem(item: NavItem) {
  return (
    <NavLink
      key={item.to}
      to={item.to}
      className={({ isActive }) =>
        `flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors ${
          isActive ? "bg-accent-dim text-accent" : "text-text-secondary hover:bg-bg-hover hover:text-text-primary"
        }`
      }
    >
      <span className="w-4 text-center text-xs" aria-hidden="true">{item.icon}</span>
      {item.label}
    </NavLink>
  );
}

const CRUMB_MAP: Record<string, string> = {
  dashboard: "仪表盘",
  projects: "项目",
  assets: "资产库",
  canvas: "画布",
  generate: "生成",
  jobs: "生成队列",
  staging: "暂存",
  audit: "审计",
  settings: "设置",
  diagnostics: "诊断",
  review: "审核交付",
};

export default function AppShell() {
  const { actorId, logout } = useAuth();
  const selection = useInspector((s) => s.selection);
  const clearSelection = useInspector((s) => s.clear);
  const location = useLocation();
  const navigate = useNavigate();
  const inspectorRef = useRef<HTMLElement | null>(null);
  const [navOpen, setNavOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(() =>
    typeof window === "undefined" || window.matchMedia("(min-width: 768px)").matches,
  );
  // 抽屉是模态面：Escape 关闭，并在关闭后把焦点归还给打开它的按钮。
  useFocusTrap(inspectorRef, inspectorOpen, () => setInspectorOpen(false));

  const segments = location.pathname.split("/").filter(Boolean);
  const crumbs = segments.map((s) => CRUMB_MAP[s] ?? s);

  useEffect(() => setNavOpen(false), [location.pathname]);
  useEffect(() => {
    const media = window.matchMedia("(min-width: 768px)");
    const syncPanels = () => {
      if (!media.matches) {
        setNavOpen(false);
        setInspectorOpen(false);
      }
    };
    syncPanels();
    media.addEventListener("change", syncPanels);
    return () => media.removeEventListener("change", syncPanels);
  }, []);

  return (
    <div className="flex h-full bg-bg-base">
      {/* 全局唯一的 aria-live 区域：检索结果、上传进度等经 announce() 播报。 */}
      <LiveRegion />
      <CommandPalette />
      {(navOpen || inspectorOpen) && (
        <button
          type="button"
          aria-label="关闭浮层"
          className="fixed inset-0 z-30 bg-black/60 md:hidden"
          onClick={() => {
            setNavOpen(false);
            setInspectorOpen(false);
          }}
        />
      )}
      {/* 窄侧边栏导航 */}
      <aside className={`${navOpen ? "flex" : "hidden"} fixed inset-y-0 left-0 z-40 w-[220px] shrink-0 flex-col border-r border-border-subtle bg-bg-raise1 md:static md:flex`}>
        <div className="flex items-center gap-2 border-b border-border-subtle px-4 py-4">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-accent text-sm font-bold text-white">
            资
          </div>
          <div>
            <div className="text-sm font-semibold text-text-primary">视频资产工作台</div>
            <div className="text-[10px] text-text-faint">video-assets workbench</div>
          </div>
          <button type="button" onClick={() => setNavOpen(false)} className="ml-auto text-xs text-text-faint md:hidden" aria-label="关闭导航">×</button>
        </div>
        <nav className="flex-1 space-y-0.5 overflow-y-auto p-2">
          {PRODUCT_NAV.map(renderNavItem)}
          <div className="px-3 pb-1 pt-4 text-[10px] font-medium uppercase tracking-wider text-text-faint">
            诊断面
          </div>
          {DIAGNOSTIC_NAV.map(renderNavItem)}
        </nav>
        <div className="border-t border-border-subtle p-3 text-[10px] leading-4 text-text-faint">
          {buildLabel}
        </div>
      </aside>

      {/* 主区 */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* 顶栏：面包屑 + 搜索 + 用户 */}
        <header className="flex h-12 shrink-0 items-center gap-4 border-b border-border-subtle bg-bg-raise1 px-4">
          <button type="button" onClick={() => setNavOpen(true)} className="rounded-md border border-border-subtle px-2 py-1 text-xs text-text-secondary md:hidden" aria-label="打开导航">☰</button>
          <nav className="flex min-w-0 items-center gap-1 overflow-hidden text-sm text-text-secondary">
            {crumbs.map((c, i) => (
              <span key={i} className="flex min-w-0 items-center gap-1">
                {i > 0 && <span className="text-text-faint">/</span>}
                <span className={`${i === crumbs.length - 1 ? "text-text-primary" : ""} truncate`}>{c}</span>
              </span>
            ))}
          </nav>
          <div className="flex-1" />
          <button
            aria-label="全局搜索"
            onClick={() => usePalette.getState().setOpen(true)}
            className="hidden w-72 items-center justify-between rounded-md border border-border-subtle bg-bg-raise2 px-3 py-1.5 text-xs text-text-faint transition-colors hover:border-border-strong hover:text-text-secondary sm:flex"
          >
            <span>搜索项目、资产、画布…</span>
            <kbd className="rounded border border-border-subtle px-1 text-[10px]">Ctrl K</kbd>
          </button>
          <button
            onClick={() => setInspectorOpen((v) => !v)}
            title="切换检查器面板"
            className="rounded-md border border-border-subtle px-2 py-1 text-xs text-text-secondary hover:bg-bg-hover"
          >
            {inspectorOpen ? "隐藏面板" : "显示面板"}
          </button>
          <span className="hidden text-xs text-text-secondary lg:inline">{actorId ?? "operator"}</span>
          <button
            onClick={() => void logout().then(() => navigate(0))}
            className="rounded-md border border-border-subtle px-2.5 py-1 text-xs text-text-secondary hover:bg-bg-hover hover:text-text-primary"
          >
            退出
          </button>
        </header>

        {/* 内容 + 检查器 */}
        <div className="flex min-h-0 flex-1">
          <main key={location.pathname} className="animate-page-in min-w-0 flex-1 overflow-y-auto">
            <Outlet />
          </main>
          {/* 抽屉在窄屏下覆盖整页，属于模态面：需要进入移焦、Tab 圈定、Esc 关闭与关闭后归还焦点。 */}
          {inspectorOpen && (
            <aside
              ref={inspectorRef}
              tabIndex={-1}
              className="fixed inset-y-0 right-0 z-40 w-[min(320px,100vw)] shrink-0 overflow-y-auto border-l border-border-subtle bg-bg-raise1 p-4 md:static md:w-[320px]"
              data-testid="inspector-panel"
            >
              <div className="flex items-center justify-between">
                <div className="text-xs font-medium tracking-wide text-text-faint">检查器</div>
                <div className="flex items-center gap-2">
                  {selection && (
                  <button
                    onClick={clearSelection}
                    className="text-[10px] text-text-faint hover:text-text-primary"
                  >
                    清除选择
                  </button>
                  )}
                  <button onClick={() => setInspectorOpen(false)} className="text-xs text-text-faint hover:text-text-primary md:hidden" aria-label="关闭检查器">×</button>
                </div>
              </div>
              <div className="mt-3">
                {!selection && (
                  <div className="rounded-md border border-dashed border-border-subtle p-4 text-xs text-text-secondary">
                    在资产库或项目页点击条目，这里显示上下文详情。
                  </div>
                )}
                {selection?.kind === "asset" && <AssetInspector key={selection.id} id={selection.id} />}
                {selection?.kind === "project" && <ProjectInspector key={selection.id} id={selection.id} />}
                {selection?.kind === "shape" && <ShapeInspector key={selection.id} shape={selection.shape} />}
                {selection?.kind === "edge" && <EdgeInspector key={selection.id} edge={selection.edge} source={selection.source} target={selection.target} />}
              </div>
            </aside>
          )}
        </div>
      </div>
    </div>
  );
}
