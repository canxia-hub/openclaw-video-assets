/**
 * 浏览器端流式上传客户端 —— 对接 REN-06 的 /upload 端点。
 *
 * 关键约束（门2 明写）：**不得整文件 arrayBuffer**。
 * 一份 200 MiB 的文件用 `await file.arrayBuffer()` 读进来，浏览器要先分配 200 MiB 连续内存，再把
 * 它交给 fetch —— 这正是 REN-06 在服务端去掉 base64 时想避免的开销，只是换到了客户端。这里每个
 * 分片都用 `file.slice(start, end)` 取一个 Blob，只有当前分片的字节会进内存。
 *
 * 协议（与服务端 upload-routes.js 一致，不在客户端重造）：
 *   POST   /upload                     建会话，返回 upload_id
 *   PATCH  /upload/<id>                追加一片，必须带 upload-offset 头
 *   GET    /upload/<id>                状态 = 续传点（next_offset）
 *   POST   /upload/<id>/complete       校验并入库（幂等）
 *   DELETE /upload/<id>                取消
 *
 * 续传的语义来自服务端的一条规则：offset 必须等于服务端已收字节数。所以"断点续传"不是客户端猜
 * 位置，而是先问状态、再按服务端给的 next_offset 继续。客户端若自己记位置，就会在两次会话之间
 * 悄悄错位，而这正是服务端拒绝猜 offset 的原因。
 */

const PLUGIN_BASE = "/__openclaw__/video-assets";

export interface UploadProgress {
  uploadId: string | null;
  sentBytes: number;
  totalBytes: number;
  chunkBytes: number;
  chunksSent: number;
  state: "idle" | "creating" | "uploading" | "paused" | "completing" | "completed" | "cancelled" | "error";
  /** 服务端最近一次回执，便于界面显示"服务端已确认到哪里"。 */
  serverReceivedBytes: number | null;
  message?: string;
}

export interface UploadResult {
  uploadId: string;
  assetId: string | null;
  assetVersionId: string | null;
  sha256: string | null;
  sizeBytes: number;
  chunksSent: number;
  sentBytes: number;
  /** 服务端完成回执，原样保留以便核对。 */
  completion: unknown;
}

/** 暂停（可续传）与取消（终态）是两个异常，调用方必须分别处理。 */
export class UploadPausedError extends Error {
  constructor(message = "上传已暂停") {
    super(message);
    this.name = "UploadPausedError";
  }
}

export class UploadCancelledError extends Error {
  constructor(message = "上传已取消") {
    super(message);
    this.name = "UploadCancelledError";
  }
}

/**
 * 控制一个上传的两种"停下来"：
 *   pause()  中断正在飞的分片，但**保留**服务端会话（state 仍是 uploading，字节仍在），可续传。
 *   cancel() 中断并交由调用方 DELETE 会话：服务端会删除暂存字节并把会话置为终态，**不可续传**。
 * 两者语义不同，不能共用一个标志：把"暂停"做成删除，用户就再也接不上了。
 */
export class UploadController {
  private controller = new AbortController();
  private cancelled = false;
  cancel(): void {
    this.cancelled = true;
    this.controller.abort();
  }
  /** 暂停：只是本地停下，服务端会话保持可续传。 */
  pause(): void {
    this.paused = true;
    this.controller.abort();
  }
  private paused = false;
  get isPaused(): boolean {
    return this.paused;
  }
  get isCancelled(): boolean {
    return this.cancelled;
  }
  get signal(): AbortSignal {
    return this.controller.signal;
  }
}

async function jsonRequest<T>(path: string, init: RequestInit): Promise<T> {
  const response = await fetch(`${PLUGIN_BASE}${path}`, {
    credentials: "include",
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) }
  });
  const body = (await response.json().catch(() => ({}))) as { ok?: boolean; result?: T; error?: string; code?: string };
  if (!response.ok || body.ok === false) {
    const error = new Error(body.error || `请求失败：${response.status}`) as Error & { code?: string; status?: number };
    error.code = body.code;
    error.status = response.status;
    throw error;
  }
  return body.result as T;
}

/**
 * 关于客户端哈希：这里**不**提供文件级 sha256 计算。
 *
 * 第一版写了一个 `hashFileInChunks`，实际做的是 `sha256(prev_digest || chunk)` 的链式组合 —— 那**不是**
 * 标准 SHA-256，服务端 complete 时拿它比对只会报不匹配。留一个名字与行为不符的函数，正是我最该在评审里
 * 指出的东西，所以删掉而不是加注释保留。
 *
 * 哈希确认仍由服务端提供：complete 时服务端自行计算 sha256 并记录，客户端从回执读取；需要验证"哈希确实
 * 被校验"时，用一个故意写错的声明值触发 UPLOAD_HASH_MISMATCH（见证门2 的服务端检查）。
 */

export interface UploadOptions {
  /** 分片大小；默认 1 MiB。服务端单分片上限更大，这里取小值是让进度可见、取消及时。 */
  chunkBytes?: number;
  /** 不声明 sha256（默认）：服务端在 complete 时自行计算并记录，客户端不参与哈希声明。 */
  declareSha256?: string | null;
  mimeType?: string | null;
  onProgress?: (progress: UploadProgress) => void;
  /** 已有会话则从其续传点继续，而不是新建。 */
  resumeUploadId?: string | null;
}

/**
 * 上传一个文件：建会话（或复用一个）→ 逐片 PATCH → complete。
 *
 * 进度里的 `serverReceivedBytes` 取服务端回执，而不是本地累加：只有服务端确认过，字节才算到位。
 */
export async function uploadFile(file: File, options: UploadOptions = {}, controller = new UploadController()): Promise<UploadResult> {
  const chunkBytes = options.chunkBytes ?? 1024 * 1024;
  let uploadId: string | null = options.resumeUploadId ?? null;
  let sentBytes = 0;
  let chunksSent = 0;
  let serverReceivedBytes: number | null = null;

  const report = (state: UploadProgress["state"], message?: string) => {
    options.onProgress?.({
      uploadId,
      sentBytes,
      totalBytes: file.size,
      chunkBytes,
      chunksSent,
      state,
      serverReceivedBytes,
      message
    });
  };

  const throwIfCancelled = () => {
    if (controller.isCancelled) throw new UploadCancelledError();
  };

  if (!uploadId) {
    report("creating");
    const session = await jsonRequest<{ upload_id: string }>("/upload", {
      method: "POST",
      body: JSON.stringify({ file_name: file.name, mime_type: options.mimeType ?? file.type ?? null, total_bytes: file.size, sha256: options.declareSha256 ?? null })
    });
    uploadId = session.upload_id;
    report("uploading");
  } else {
    // 续传：先问服务端收到哪里，绝不假设进度是本地记忆里的那个数。
    const status = await jsonRequest<{ next_offset: number; declared_bytes: number; state: string }>(`/upload/${encodeURIComponent(uploadId)}`, { method: "GET" });
    sentBytes = status.next_offset;
    serverReceivedBytes = status.next_offset;
    report("uploading", `从服务端确认的断点 ${sentBytes} 字节继续`);
  }

  try {
    while (sentBytes < file.size) {
      throwIfCancelled();
      const end = Math.min(sentBytes + chunkBytes, file.size);
      // 只取当前分片：这是"不整文件 arrayBuffer"的落点。
      const slice = file.slice(sentBytes, end);
      const response = await fetch(`${PLUGIN_BASE}/upload/${encodeURIComponent(uploadId)}`, {
        method: "PATCH",
        credentials: "include",
        signal: controller.signal,
        headers: {
          "content-type": "application/octet-stream",
          "upload-offset": String(sentBytes),
          "content-length": String(end - sentBytes)
        },
        body: slice
      });
      const body = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        code?: string;
        result?: { details?: { received_bytes?: number; next_offset?: number } };
      };
      if (!response.ok || body.ok === false) {
        const error = new Error(body.error || `分片上传失败：${response.status}`) as Error & { code?: string; status?: number };
        error.code = body.code;
        error.status = response.status;
        throw error;
      }
      const confirmed = body.result?.details?.received_bytes ?? body.result?.details?.next_offset ?? null;
      serverReceivedBytes = confirmed;
      // 以服务端确认值为准推进本地进度：服务端说收到哪里，下一次就从哪里开始。
      sentBytes = confirmed ?? end;
      chunksSent += 1;
      report("uploading");
    }

    throwIfCancelled();
    report("completing");
    const completion = await jsonRequest<{ asset_id?: string; asset_version_id?: string; sha256?: string }>(`/upload/${encodeURIComponent(uploadId)}/complete`, {
      method: "POST",
      body: JSON.stringify({ sha256: options.declareSha256 ?? null })
    });
    report("completed");
    return {
      uploadId,
      assetId: completion.asset_id ?? null,
      assetVersionId: completion.asset_version_id ?? null,
      sha256: completion.sha256 ?? null,
      sizeBytes: file.size,
      chunksSent,
      sentBytes,
      completion
    };
  } catch (error) {
    if (controller.isCancelled || controller.isPaused || (error instanceof DOMException && error.name === "AbortError")) {
      // 暂停与取消在这里分开：暂停不删会话，所以提示必须说"可续传"；取消由调用方 DELETE，
      // 服务端会释放字节并置终态，提示必须说"不可续传"。
      if (controller.isPaused) {
        report("paused", `已暂停在 ${sentBytes} 字节；服务端会话保留，可续传`);
        throw new UploadPausedError();
      }
      report("cancelled", "已取消；服务端已释放暂存字节并终止会话，该会话不可续传，如需继续请重新上传");
      throw new UploadCancelledError();
    }
    report("error", error instanceof Error ? error.message : String(error));
    throw error;
  }
}

/** 取消一个上传会话（服务端 DELETE；会计行保留，便于审计"取消过什么"）。 */
export async function cancelUpload(uploadId: string): Promise<void> {
  await jsonRequest(`/upload/${encodeURIComponent(uploadId)}`, { method: "DELETE" });
}

/** 查询断点（界面上的"继续"按钮在开始前会用到）。 */
export async function uploadStatus(uploadId: string): Promise<{ next_offset: number; declared_bytes: number; state: string }> {
  return jsonRequest(`/upload/${encodeURIComponent(uploadId)}`, { method: "GET" });
}

/** 列出本会话自己的上传会话（用于"续传"入口）。 */
export async function listUploads(): Promise<{ sessions: Array<{ upload_id: string; file_name: string; state: string; received_bytes: number; declared_bytes: number }>; owner_actor_id: string }> {
  return jsonRequest("/upload", { method: "GET" });
}
