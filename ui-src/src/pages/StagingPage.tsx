import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { rpc } from "../lib/rpc";
import { Badge, fmtBytes, fmtTime } from "../components/ui";

interface FileEntry {
  root_key: string;
  relative_path: string;
  name: string;
  extension?: string | null;
  is_directory: boolean;
  size_bytes: number;
  modified_at?: string;
  binding_state?: string;
}

interface FileListResult {
  root_key: string;
  relative_path: string;
  entries: FileEntry[];
}

interface UploadResult {
  name: string;
  ok: boolean;
  message: string;
}

function bufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export default function StagingPage() {
  const queryClient = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [uploads, setUploads] = useState<UploadResult[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // 暂存根 + uploads 子目录两级列表
  const listQ = useQuery({
    queryKey: ["staging.list"],
    queryFn: async () => {
      const root = await rpc<FileListResult>("file.list", { root_key: "asset-staging" });
      const files: FileEntry[] = [];
      for (const e of root.entries ?? []) {
        if (e.is_directory) {
          const sub = await rpc<FileListResult>("file.list", { root_key: "asset-staging", relative_path: e.relative_path });
          files.push(...(sub.entries ?? []).filter((x) => !x.is_directory));
        } else {
          files.push(e);
        }
      }
      return files;
    },
  });

  const refetch = () => queryClient.invalidateQueries({ queryKey: ["staging.list"] });

  async function handleFiles(files: FileList | File[]) {
    setBusy(true);
    setNotice(null);
    const results: UploadResult[] = [];
    for (const f of Array.from(files)) {
      try {
        const buf = await f.arrayBuffer();
        await rpc("staging.upload", { file_name: f.name, content_base64: bufferToBase64(buf) });
        results.push({ name: f.name, ok: true, message: "上传成功" });
      } catch (e) {
        results.push({ name: f.name, ok: false, message: e instanceof Error ? e.message : "上传失败" });
      }
    }
    setUploads((prev) => [...results, ...prev].slice(0, 20));
    setBusy(false);
    void refetch();
  }

  async function ingest(entry: FileEntry) {
    setBusy(true);
    setNotice(null);
    try {
      const r = await rpc<{ ok: boolean; asset?: { asset_id?: string } }>("staging.ingest", {
        relative_path: entry.relative_path,
        title: entry.name,
      });
      setNotice(`已入库：${entry.name} → ${r.asset?.asset_id ?? "asset"}`);
      void refetch();
    } catch (e) {
      setNotice(`入库失败：${e instanceof Error ? e.message : "未知错误"}`);
    }
    setBusy(false);
  }

  async function reject(entry: FileEntry) {
    if (!window.confirm(`确认移除暂存文件「${entry.name}」？`)) return;
    setBusy(true);
    setNotice(null);
    try {
      await rpc("staging.reject", { relative_path: entry.relative_path });
      setNotice(`已移除：${entry.name}`);
      void refetch();
    } catch (e) {
      setNotice(`移除失败：${e instanceof Error ? e.message : "未知错误"}`);
    }
    setBusy(false);
  }

  const entries = listQ.data ?? [];

  return (
    <div className="p-6">
      <h1 className="mb-1 text-lg font-semibold text-text-primary">暂存</h1>
      <p className="mb-4 text-sm text-text-secondary">拖拽上传文件到暂存区，检查后再入库为正式资产。</p>

      {/* 拖拽上传区 */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (e.dataTransfer.files.length) void handleFiles(e.dataTransfer.files);
        }}
        onClick={() => fileInput.current?.click()}
        className={`mb-4 flex h-32 cursor-pointer items-center justify-center rounded-lg border-2 border-dashed transition-colors ${
          dragOver ? "border-accent bg-accent-dim" : "border-border-subtle bg-bg-raise1 hover:border-text-faint"
        }`}
      >
        <div className="text-center">
          <div className="text-sm text-text-secondary">{busy ? "处理中…" : "拖拽文件到这里，或点击选择"}</div>
          <div className="mt-1 text-[11px] text-text-faint">上传后进入暂存区，入库前可检查</div>
        </div>
        <input
          ref={fileInput}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files?.length) void handleFiles(e.target.files);
            e.target.value = "";
          }}
        />
      </div>

      {/* 通知 + 上传结果 */}
      {notice && (
        <div className="mb-3 rounded-md border border-accent/40 bg-accent-dim px-3 py-2 text-xs text-text-primary">{notice}</div>
      )}
      {uploads.length > 0 && (
        <div className="mb-4 space-y-1">
          {uploads.map((u, i) => (
            <div key={i} className={`flex items-center gap-2 text-xs ${u.ok ? "text-success" : "text-danger"}`}>
              <span>{u.ok ? "✓" : "✕"}</span>
              <span className="text-text-primary">{u.name}</span>
              <span className="text-text-faint">{u.message}</span>
            </div>
          ))}
        </div>
      )}

      {/* 暂存文件列表 */}
      {listQ.isLoading && <div className="text-sm text-text-secondary">加载中…</div>}
      {listQ.isError && (
        <div className="rounded-md border border-danger/40 bg-danger/10 p-3 text-sm text-danger">
          {listQ.error instanceof Error ? listQ.error.message : "加载失败"}
        </div>
      )}
      {listQ.data && (
        <div className="overflow-hidden rounded-lg border border-border-subtle">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-border-subtle bg-bg-raise2 text-text-faint">
                <th className="px-3 py-2 font-medium">文件名</th>
                <th className="w-24 px-3 py-2 font-medium">大小</th>
                <th className="w-32 px-3 py-2 font-medium">修改时间</th>
                <th className="w-40 px-3 py-2 font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.relative_path} className="border-b border-border-subtle last:border-0 hover:bg-bg-hover">
                  <td className="max-w-0 truncate px-3 py-2.5 text-text-primary" title={e.relative_path}>
                    {e.name}
                    <span className="ml-2 text-[10px] text-text-faint">{e.relative_path}</span>
                  </td>
                  <td className="px-3 py-2.5 text-text-secondary">{fmtBytes(e.size_bytes)}</td>
                  <td className="px-3 py-2.5 text-text-faint">{fmtTime(e.modified_at)}</td>
                  <td className="px-3 py-2.5">
                    <div className="flex gap-1.5">
                      <button
                        disabled={busy}
                        onClick={() => void ingest(e)}
                        className="rounded border border-success/40 bg-success/10 px-2 py-0.5 text-[10px] text-success hover:bg-success/20 disabled:opacity-40"
                      >
                        入库
                      </button>
                      <button
                        disabled={busy}
                        onClick={() => void reject(e)}
                        className="rounded border border-danger/40 bg-danger/10 px-2 py-0.5 text-[10px] text-danger hover:bg-danger/20 disabled:opacity-40"
                      >
                        移除
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {entries.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-3 py-8 text-center text-text-faint">
                    暂存区为空
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      <div className="mt-2 text-[10px] text-text-faint">
        <Badge label="说明" cls="text-text-faint border-border-subtle" /> 入库 = 转为正式资产并保留暂存记录；移除 = 从暂存区删除。
      </div>
    </div>
  );
}
