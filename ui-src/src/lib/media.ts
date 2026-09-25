/**
 * 媒体工具 —— 播放/下载 URL 与类型判定。
 *
 * 两个 URL 的区别是真实的、不是风格：
 *   - `/file/<version_id>`                   默认 content-disposition: attachment（下载）
 *   - `/file/<version_id>?disposition=inline` 同一对象以内联方式返回（播放器用）
 * 播放器用下载 URL 会拿到 attachment，浏览器不会播放；下载按钮用内联 URL 则会被浏览器按
 * 媒体类型直接展示而不是保存。服务端已把这条规则写在一处（index.js 的 disposition 参数），
 * 这里只做选择，不重复实现。
 */

export type MediaKind = "image" | "video" | "audio" | "other";

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "webp", "gif", "bmp", "avif", "svg"]);
const VIDEO_EXT = new Set(["mp4", "mov", "webm", "mkv", "m4v", "avi"]);
const AUDIO_EXT = new Set(["wav", "mp3", "aac", "m4a", "flac", "ogg", "opus"]);

/**
 * 判定媒体类型：先看 mime_type，再看扩展名。
 *
 * 只看扩展名会漏掉 mime 已知但没有扩展名的对象；只看 mime 会漏掉 `application/octet-stream`
 * 这类没信息的值。两者都看，任一能判定即可。
 */
export function mediaKindOf(mimeType?: string | null, extension?: string | null): MediaKind {
  const mime = String(mimeType ?? "").toLowerCase();
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  const ext = String(extension ?? "").replace(/^\./, "").toLowerCase();
  if (IMAGE_EXT.has(ext)) return "image";
  if (VIDEO_EXT.has(ext)) return "video";
  if (AUDIO_EXT.has(ext)) return "audio";
  return "other";
}

export const PLUGIN_BASE = "/__openclaw__/video-assets";

/** 播放器可用的内联 URL。 */
export function inlineMediaUrl(versionId: string): string {
  return `${PLUGIN_BASE}/file/${encodeURIComponent(versionId)}?disposition=inline`;
}

/** 下载 URL（服务端默认 attachment）。 */
export function downloadMediaUrl(versionId: string): string {
  return `${PLUGIN_BASE}/file/${encodeURIComponent(versionId)}`;
}

/** 缩略图 URL（图片与视频封面用）。 */
export function thumbnailUrl(versionId: string): string {
  return `${PLUGIN_BASE}/thumb/${encodeURIComponent(versionId)}`;
}

/** 有秒数就显示 mm:ss，没有就明确显示“未知”，而不是显示 0:00。 */
export function formatSeconds(value?: number | null): string {
  if (value === undefined || value === null || !Number.isFinite(value)) return "时长未知";
  const total = Math.max(0, value);
  const minutes = Math.floor(total / 60);
  const seconds = Math.floor(total % 60);
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
