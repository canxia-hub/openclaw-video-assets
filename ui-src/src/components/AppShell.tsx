import { useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { useInspector } from "../lib/inspector";
import { AssetInspector, ProjectInspector, ShapeInspector } from "./inspectors";
import CommandPalette, { usePalette } from "./CommandPalette";

const NAV_ITEMS = [
  { to: "/dashboard", label: "仪表盘", icon: "◧" },
  { to: "/projects", label: "项目", icon: "▣" },
  { to: "/assets", label: "资产库", icon: "❑" },
  { to: "/canvas", label: "画布", icon: "✦" },
  { to: "/generate", label: "生成", icon: "◈" },
  { to: "/staging", label: "暂存", icon: "⇪" },
  { to: "/audit", label: "审计", icon: "☰" },
  { to: "/settings", label: "设置", icon: "⚙" },
];

const CRUMB_MAP: Record<string, string> = {
  dashboard: "仪表盘",
  projects: "项目",
  assets: "资产库",
  canvas: "画布",
  generate: "生成",
  staging: "暂存",
  audit: "审计",
  settings: "设置",
};

export default function AppShell() {
  const { actorId, logout } = useAuth();
  const selection = useInspector((s) => s.selection);
  const clearSelection = useInspector((s) => s.clear);
  const location = useLocation();
  const navigate = useNavigate();
  const [inspectorOpen, setInspectorOpen] = useState(true);

  const segments = location.pathname.split("/").filter(Boolean);
  const crumbs = segments.map((s) => CRUMB_MAP[s] ?? s);

  return (
    <div className="flex h-full bg-bg-base">
      <CommandPalette />
      {/* 窄侧边栏导航 */}
      <aside className="flex w-[220px] shrink-0 flex-col border-r border-border-subtle bg-bg-raise1">
        <div className="flex items-center gap-2 border-b border-border-subtle px-4 py-4">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-accent text-sm font-bold text-white">
            资
          </div>
          <div>
            <div className="text-sm font-semibold text-text-primary">视频资产工作台</div>
            <div className="text-[10px] text-text-faint">video-assets workbench</div>
          </div>
        </div>
        <nav className="flex-1 space-y-0.5 overflow-y-auto p-2">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                `flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors ${
                  isActive
                    ? "bg-accent-dim text-accent"
                    : "text-text-secondary hover:bg-bg-hover hover:text-text-primary"
                }`
              }
            >
              <span className="w-4 text-center text-xs">{item.icon}</span>
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-border-subtle p-3 text-[10px] leading-4 text-text-faint">
          v1.4 · P4 打磨版
        </div>
      </aside>

      {/* 主区 */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* 顶栏：面包屑 + 搜索 + 用户 */}
        <header className="flex h-12 shrink-0 items-center gap-4 border-b border-border-subtle bg-bg-raise1 px-4">
          <nav className="flex items-center gap-1 text-sm text-text-secondary">
            {crumbs.map((c, i) => (
              <span key={i} className="flex items-center gap-1">
                {i > 0 && <span className="text-text-faint">/</span>}
                <span className={i === crumbs.length - 1 ? "text-text-primary" : ""}>{c}</span>
              </span>
            ))}
          </nav>
          <div className="flex-1" />
          <button
            aria-label="全局搜索"
            onClick={() => usePalette.getState().setOpen(true)}
            className="flex w-72 items-center justify-between rounded-md border border-border-subtle bg-bg-raise2 px-3 py-1.5 text-xs text-text-faint transition-colors hover:border-border-strong hover:text-text-secondary"
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
          <span className="text-xs text-text-secondary">{actorId ?? "operator"}</span>
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
          {inspectorOpen && (
            <aside className="w-[320px] shrink-0 overflow-y-auto border-l border-border-subtle bg-bg-raise1 p-4">
              <div className="flex items-center justify-between">
                <div className="text-xs font-medium tracking-wide text-text-faint">检查器</div>
                {selection && (
                  <button
                    onClick={clearSelection}
                    className="text-[10px] text-text-faint hover:text-text-primary"
                  >
                    清除选择
                  </button>
                )}
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
              </div>
            </aside>
          )}
        </div>
      </div>
    </div>
  );
}
