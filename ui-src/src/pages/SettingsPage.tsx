import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { rpc } from "../lib/rpc";
import { useAuth } from "../lib/auth";
import { Field } from "../components/ui";

interface FileRoot {
  root_key: string;
  label?: string;
  kind?: string;
  relative_path?: string;
  exists?: boolean;
}

export default function SettingsPage() {
  const { actorId, logout } = useAuth();
  const navigate = useNavigate();

  const rootsQ = useQuery({
    queryKey: ["file.roots"],
    queryFn: () => rpc<FileRoot[]>("file.roots", {}),
  });
  const roots = Array.isArray(rootsQ.data) ? rootsQ.data : [];

  return (
    <div className="p-6">
      <h1 className="mb-1 text-lg font-semibold text-text-primary">设置</h1>
      <p className="mb-6 text-sm text-text-secondary">会话、存储根与版本信息。</p>

      <div className="max-w-2xl space-y-5">
        {/* 账号 */}
        <section className="rounded-lg border border-border-subtle bg-bg-raise1 p-4">
          <div className="mb-2 text-sm font-medium text-text-primary">账号</div>
          <div className="divide-y divide-border-subtle">
            <Field label="当前身份">{actorId ?? "operator"}</Field>
            <Field label="认证方式">管理员密码（Cookie 会话）</Field>
          </div>
          <button
            onClick={() => void logout().then(() => navigate(0))}
            className="mt-3 rounded-md border border-danger/40 bg-danger/10 px-3 py-1.5 text-xs text-danger hover:bg-danger/20"
          >
            退出登录
          </button>
        </section>

        {/* 存储根 */}
        <section className="rounded-lg border border-border-subtle bg-bg-raise1 p-4">
          <div className="mb-2 text-sm font-medium text-text-primary">文件存储根</div>
          {rootsQ.isLoading && <div className="text-xs text-text-faint">加载中…</div>}
          {rootsQ.isError && (
            <div className="text-xs text-danger">{rootsQ.error instanceof Error ? rootsQ.error.message : "加载失败"}</div>
          )}
          {roots.length > 0 ? (
            <div className="divide-y divide-border-subtle">
              {roots.map((r) => (
                <div key={r.root_key} className="flex items-center justify-between gap-3 py-1.5">
                  <div className="min-w-0">
                    <div className="text-xs font-medium text-text-primary">
                      {r.label ?? r.root_key}
                      <span className="ml-2 font-mono text-[10px] font-normal text-text-faint">{r.root_key}</span>
                    </div>
                    <div className="break-all font-mono text-[10px] text-text-faint">{r.relative_path ?? "—"}</div>
                  </div>
                  <span className={`shrink-0 text-[10px] ${r.exists ? "text-success" : "text-danger"}`}>
                    {r.exists ? "● 存在" : "● 缺失"}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            !rootsQ.isLoading && <div className="text-xs text-text-faint">无存储根信息</div>
          )}
        </section>

        {/* 关于 */}
        <section className="rounded-lg border border-border-subtle bg-bg-raise1 p-4">
          <div className="mb-2 text-sm font-medium text-text-primary">关于</div>
          <div className="divide-y divide-border-subtle">
            <Field label="工作台">视频资产工作台（video-assets workbench）</Field>
            <Field label="前端版本">v1.3 · P3 生成暂存版</Field>
            <Field label="技术栈">Vite 6 · React 18 · TypeScript · Tailwind v4 · React Flow</Field>
          </div>
        </section>
      </div>
    </div>
  );
}
