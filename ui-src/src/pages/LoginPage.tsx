import { useState } from "react";
import { useAuth } from "../lib/auth";

export default function LoginPage() {
  const { login } = useAuth();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    try {
      await login(password);
    } catch (err) {
      setError(err instanceof Error ? err.message : "登录失败");
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full items-center justify-center bg-bg-base">
      <form
        onSubmit={submit}
        className="w-[360px] rounded-xl border border-border-subtle bg-bg-raise1 p-8"
      >
        <div className="mb-1 text-xs tracking-widest text-accent">视频资产库 · 本地门禁</div>
        <h1 className="mb-2 text-2xl font-semibold text-text-primary">视频资产工作台</h1>
        <p className="mb-6 text-sm text-text-secondary">
          登录后可读取项目、资产、画布与受保护媒体。
        </p>
        <label className="mb-1 block text-xs text-text-secondary" htmlFor="pwd">
          插件密码
        </label>
        <input
          id="pwd"
          type="password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="输入插件密码"
          className="mb-4 w-full rounded-md border border-border-subtle bg-bg-raise2 px-3 py-2 text-sm text-text-primary placeholder:text-text-faint focus:border-accent focus:outline-none"
        />
        {error && (
          <div className="mb-3 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
            {error}
          </div>
        )}
        <button
          type="submit"
          disabled={busy || !password}
          className="w-full rounded-md bg-accent px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? "登录中…" : "登录"}
        </button>
      </form>
    </div>
  );
}
