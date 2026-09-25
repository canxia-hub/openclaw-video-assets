import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { UploadCancelledError, UploadPausedError, UploadController, cancelUpload, listUploads, uploadFile, uploadStatus, type UploadProgress } from "../lib/upload-client";
import { announce } from "../lib/announcer";

/*
 * UploadPanel —— 文件上传界面：进度、取消、断点续传。
 *
 * 三个动作都对应真实的服务端语义，而不是本地状态：
 *   进度  以服务端回执的 received_bytes 为准（不是本地累加）：服务端确认过才算到位
 *   取消  先中断正在飞的分片，再 DELETE 会话；服务端保留会计行，所以"取消过什么"仍可审计
 *   续传  先 GET 状态拿服务端断点，再从那个 offset 继续；本地不缓存位置
 *
 * "可续传会话"列表来自 GET /upload（服务端只返回本会话自己的会话），所以刷新页面后仍可续传，而不是
 * 只能在同一个标签页里续传。
 */

export default function UploadPanel() {
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [resumable, setResumable] = useState<Array<{ upload_id: string; file_name: string; state: string; received_bytes: number; declared_bytes: number }>>([]);
  const controllerRef = useRef<UploadController | null>(null);
  const queryClient = useQueryClient();

  const refreshResumable = useCallback(async () => {
    try {
      const listing = await listUploads();
      setResumable(listing.sessions.filter((session) => session.state === "uploading" || session.state === "created"));
    } catch {
      // 列表失败不应挡住主流程：上传本身仍可用，这里只是少了"续传入口"。
      setResumable([]);
    }
  }, []);

  useEffect(() => {
    void refreshResumable();
  }, [refreshResumable]);

  const start = async (target: File, resumeUploadId: string | null) => {
    setFailure(null);
    setResult(null);
    const controller = new UploadController();
    controllerRef.current = controller;
    try {
      const uploaded = await uploadFile(target, {
        resumeUploadId,
        chunkBytes: 512 * 1024,
        onProgress: (update) => setProgress(update)
      }, controller);
      setResult(`已入库：${uploaded.assetId ?? "（服务端未返回资产号）"}，服务端确认 sha256=${(uploaded.sha256 ?? "").slice(0, 16)}…，共 ${uploaded.chunksSent} 片`);
      announce(`上传完成，已入库 ${target.name}`);
      await queryClient.invalidateQueries({ queryKey: ["asset.browse"] });
      await refreshResumable();
    } catch (error) {
      if (error instanceof UploadCancelledError) {
        // 原句写的是"服务端会话保留，可从可续传会话继续"，与服务端状态机不符：cancel 会删除暂存字节并把
        // 会话置为终态（UPLOAD_SESSION_CLOSED），根本接不上。承诺服务端做不到的事比不提示更糟。
        setFailure("已取消。服务端已释放暂存字节并终止该会话，此会话不可续传；如需继续请重新选择文件上传。");
      } else if (error instanceof UploadPausedError) {
        setFailure(`已暂停：${error.message}`);
        announce("上传已暂停，可从「可续传会话」继续");
      } else {
        const message = error instanceof Error ? error.message : String(error);
        setFailure(message);
        announce(`上传失败：${message}`);
      }
      await refreshResumable();
    } finally {
      controllerRef.current = null;
    }
  };

  const cancel = async () => {
    const uploadId = progress?.uploadId;
    controllerRef.current?.cancel();
    if (uploadId) {
      try {
        await cancelUpload(uploadId);
      } catch {
        // 取消失败也要让人看得见：否则界面会显示"已取消"而服务端仍在收。
        setFailure("取消请求未成功（会话可能仍在服务端保留）");
      }
    }
    await refreshResumable();
  };

  const pct = progress && progress.totalBytes > 0 ? Math.min(100, Math.round((progress.sentBytes / progress.totalBytes) * 100)) : 0;
  const busy = progress?.state === "uploading" || progress?.state === "creating" || progress?.state === "completing";

  return (
    <section className="mb-4 rounded-lg border border-border-subtle bg-bg-raise1 p-4" data-testid="upload-panel">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-medium text-text-primary">上传素材</h2>
        <span className="text-[10px] text-text-faint">分片上传 · 可暂停可续传</span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input
          type="file"
          data-testid="upload-file-input"
          onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          className="text-xs text-text-secondary file:mr-2 file:rounded-md file:border file:border-border-subtle file:bg-bg-raise2 file:px-2 file:py-1 file:text-xs file:text-text-primary"
        />
        <button
          type="button"
          data-testid="upload-start"
          disabled={!file || busy}
          onClick={() => file && void start(file, null)}
          className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
        >
          开始上传
        </button>
        <button
          type="button"
          data-testid="upload-cancel"
          disabled={!busy}
          onClick={() => void cancel()}
          className="rounded-md border border-danger/50 px-3 py-1.5 text-xs text-danger disabled:opacity-40"
        >
          取消
        </button>
        {/* 暂停与取消的区别是真实的：暂停保留服务端会话（可续传），取消释放字节并终止会话（不可续传）。 */}
        <button
          type="button"
          data-testid="upload-pause"
          disabled={!busy}
          onClick={() => {
            controllerRef.current?.pause();
            void refreshResumable();
          }}
          className="rounded-md border border-border-subtle px-3 py-1.5 text-xs text-text-secondary disabled:opacity-40"
        >
          暂停（可续传）
        </button>
      </div>

      {progress && (
        <div className="mt-3" data-testid="upload-progress" data-upload-state={progress.state} data-upload-sent={progress.sentBytes} data-upload-total={progress.totalBytes} data-upload-chunks={progress.chunksSent}>
          <div className="mb-1 flex items-center justify-between text-[11px] text-text-secondary">
            <span>
              {progress.state === "creating" && "正在建会话…"}
              {progress.state === "uploading" && `上传中 ${pct}%`}
              {progress.state === "completing" && "服务端校验中…"}
              {progress.state === "completed" && "已完成"}
              {progress.state === "cancelled" && "已取消"}
              {progress.state === "error" && "失败"}
            </span>
            <span className="font-mono text-text-faint">
              {progress.sentBytes} / {progress.totalBytes} 字节 · {progress.chunksSent} 片 / {progress.chunkBytes} 字节每片
              {progress.serverReceivedBytes !== null ? ` · 服务端确认 ${progress.serverReceivedBytes}` : ""}
            </span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-bg-raise2">
            <div className="h-full rounded-full bg-accent transition-[width] duration-150" style={{ width: `${pct}%` }} />
          </div>
          {progress.uploadId && <div className="mt-1 font-mono text-[10px] text-text-faint">会话 {progress.uploadId}</div>}
        </div>
      )}

      {result && (
        <p className="mt-3 rounded-md border border-success/40 bg-success/10 px-3 py-2 text-xs text-success" data-testid="upload-result">
          {result}
        </p>
      )}
      {failure && (
        <p className="mt-3 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger" data-testid="upload-error">
          {failure}
        </p>
      )}

      {resumable.length > 0 && (
        <div className="mt-3 border-t border-border-subtle pt-3">
          <div className="mb-1 text-[11px] text-text-secondary">可续传会话（服务端记录）</div>
          <ul className="space-y-1">
            {resumable.map((session) => (
              <li key={session.upload_id} className="flex items-center justify-between gap-2 text-[11px] text-text-faint">
                <span className="truncate font-mono">{session.file_name}</span>
                <span className="font-mono">
                  {session.received_bytes}/{session.declared_bytes}
                </span>
                <button
                  type="button"
                  data-testid={`resume-${session.upload_id}`}
                  disabled={busy || !file}
                  onClick={() => {
                    // One handler, not onClick plus onClickCapture: reading the server's offset is part of resuming,
                    // not a side effect bolted onto the click. The displayed byte count before the transfer starts
                    // then comes from the server's own view of the session rather than from a local list snapshot.
                    void (async () => {
                      try {
                        const status = await uploadStatus(session.upload_id);
                        setProgress({
                          uploadId: session.upload_id,
                          sentBytes: status.next_offset,
                          totalBytes: status.declared_bytes,
                          chunkBytes: 0,
                          chunksSent: 0,
                          state: "idle",
                          serverReceivedBytes: status.next_offset,
                          message: "服务端断点已读取"
                        });
                      } catch {
                        // A failed status read must not stop the resume attempt: uploadFile re-reads the offset
                        // itself and reports the real error. Swallowing it here is safe *because* it is re-read.
                      }
                      if (file) await start(file, session.upload_id);
                    })();
                  }}
                  className="rounded border border-border-subtle px-2 py-0.5 text-text-secondary disabled:opacity-40"
                  title="需要选择同名文件后从服务端断点继续"
                >
                  续传
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
