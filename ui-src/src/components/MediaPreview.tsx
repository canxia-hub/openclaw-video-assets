import { useEffect, useRef, useState, type ReactNode } from "react";
import { downloadMediaUrl, formatSeconds, inlineMediaUrl, mediaKindOf, thumbnailUrl, type MediaKind } from "../lib/media";

/*
 * MediaPreview —— 素材库与检查器共用的媒体预览。
 *
 * 为什么不是一句 <img>/<video>：
 *  1) 三种媒体（图/视频/音频）的失败方式不同，必须各自有 loading / empty / error 三态，否则
 *     加载失败就是一个空框，用户无法区分"没有文件"和"文件坏了"。
 *  2) 门4 要验证的是**真实媒体状态**（图片天然尺寸、视频 readyState/duration/seek、音频时间头），
 *     不是"DOM 里有标签"。所以真实尺寸/时长/当前时间就写在元素的 data-* 上，由元素自身的事件
 *     回灌，检查脚本读的是浏览器解出来的值，而不是组件算出来的值。
 *  3) 下载与播放在服务端是两个 disposition，URL 不能混用（lib/media.ts 有说明）。
 */

export interface MediaPreviewSource {
  versionId: string;
  title?: string;
  mimeType?: string | null;
  extension?: string | null;
  sizeBytes?: number | null;
  /** 服务端探测到的时长（毫秒）。仅用于预览处显示，真实时长以元素自身为准。 */
  durationMs?: number | null;
  width?: number | null;
  height?: number | null;
}

export type PreviewState = "loading" | "ready" | "error" | "empty";

interface Props {
  source?: MediaPreviewSource | null;
  /** 行内小图（列表用）还是完整预览（检查器用）。 */
  variant?: "thumb" | "full";
  className?: string;
  onStateChange?: (state: PreviewState) => void;
}

function StateBadge({ state, children }: { state: PreviewState; children: ReactNode }) {
  const tone =
    state === "error"
      ? "border-danger/40 bg-danger/10 text-danger"
      : state === "empty"
        ? "border-border-strong bg-bg-raise2 text-text-secondary"
        : "border-border-subtle bg-bg-raise2 text-text-faint";
  return <div className={`rounded-md border ${tone} px-3 py-2 text-xs`}>{children}</div>;
}

export default function MediaPreview({ source, variant = "full", className = "", onStateChange }: Props) {
  const [state, setState] = useState<PreviewState>(source?.versionId ? "loading" : "empty");
  const [failure, setFailure] = useState<string | null>(null);
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const [duration, setDuration] = useState<number | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [readyState, setReadyState] = useState<number | null>(null);
  const mediaRef = useRef<HTMLVideoElement | HTMLAudioElement | null>(null);

  const kind: MediaKind = mediaKindOf(source?.mimeType, source?.extension);

  // 换源即回到 loading：否则上一个素材的"已就绪"会挂在新素材上，看起来像新素材已经加载好了。
  useEffect(() => {
    setState(source?.versionId ? "loading" : "empty");
    setFailure(null);
    setNatural(null);
    setDuration(null);
    setCurrentTime(0);
    setReadyState(null);
  }, [source?.versionId]);

  useEffect(() => {
    onStateChange?.(state);
  }, [state, onStateChange]);

  if (!source?.versionId) {
    return (
      <div className={className} data-media-state="empty" data-media-kind={kind}>
        <StateBadge state="empty">该素材没有可预览的版本（无默认版本或版本未落盘）。</StateBadge>
      </div>
    );
  }

  const inlineSrc = inlineMediaUrl(source.versionId);
  const downloadHref = downloadMediaUrl(source.versionId);
  const alt = source.title ?? source.versionId;

  const link = (
    <a
      href={downloadHref}
      download
      className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-border-subtle px-2.5 py-1 text-xs text-text-secondary hover:border-border-strong hover:text-text-primary"
      data-testid="media-download"
    >
      <span aria-hidden="true">↓</span>
      下载原文件
      {source.sizeBytes ? <span className="text-text-faint">{Math.round(source.sizeBytes / 1024)} KB</span> : null}
    </a>
  );

  if (kind === "image") {
    return (
      <div className={className} data-media-state={state} data-media-kind="image">
        {state === "loading" && <StateBadge state="loading">图片加载中…</StateBadge>}
        {state === "error" && (
          <StateBadge state="error">
            图片加载失败，无法预览：{failure ?? "未知原因"}。文件可能已丢失或损坏；下载链接仍指向服务端原始对象。
          </StateBadge>
        )}
        {/* 图片始终挂载：卸载它就没有 onLoad/onError 可听，loading 态将永远停在那里。 */}
        <img
          src={inlineSrc}
          alt={alt}
          data-testid="media-image"
          data-natural-width={natural?.width ?? ""}
          data-natural-height={natural?.height ?? ""}
          className={`${state === "error" ? "hidden" : ""} ${variant === "thumb" ? "h-12 w-16 rounded border border-border-subtle object-cover" : "max-h-[420px] w-full rounded-md border border-border-subtle object-contain"}`}
          onLoad={(event) => {
            const element = event.currentTarget;
            setNatural({ width: element.naturalWidth, height: element.naturalHeight });
            setState("ready");
          }}
          onError={() => {
            setFailure("响应不是可解码的图片");
            setState("error");
          }}
        />
        {/* 缩略图变体不显示尺寸事实行：列表是用来扫的，细节在检查器里。 */}
        {variant !== "thumb" && state === "ready" && natural && (
          <div className="mt-1 font-mono text-[10px] text-text-faint" data-testid="media-image-facts">
            原始尺寸 {natural.width}×{natural.height}px
            {source.width && source.height && (source.width !== natural.width || source.height !== natural.height)
              ? `（元数据记录 ${source.width}×${source.height}，与解码结果不一致）`
              : ""}
          </div>
        )}
        {variant !== "thumb" && state !== "loading" && link}
      </div>
    );
  }

  if (kind === "video" && variant === "thumb") {
    // 列表里只放封面图，不放播放器：表格单元里塞一个 <video controls> 会把行撑爆，而播放器在检查器里。
    return (
      <div className={className} data-media-state={state} data-media-kind="video">
        <div className="relative">
          <img
            src={thumbnailUrl(source.versionId)}
            alt={alt}
            data-testid="media-video-poster"
            data-natural-width={natural?.width ?? ""}
            data-natural-height={natural?.height ?? ""}
            className={`h-12 w-16 rounded border border-border-subtle object-cover ${state === "error" ? "hidden" : ""}`}
            onLoad={(event) => { setNatural({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight }); setState("ready"); }}
            onError={() => { setFailure("封面图不可用"); setState("error"); }}
          />
          <span className="pointer-events-none absolute inset-0 flex h-12 w-16 items-center justify-center text-xs text-white drop-shadow" aria-hidden="true">
            ▶
          </span>
        </div>
        {state === "error" && <span className="text-[10px] text-danger">封面不可用</span>}
      </div>
    );
  }

  if (kind === "video") {
    return (
      <div className={className} data-media-state={state} data-media-kind="video">
        {state === "loading" && <StateBadge state="loading">视频元数据加载中…（只取元数据，不整段下载）</StateBadge>}
        {state === "error" && <StateBadge state="error">视频无法播放：{failure ?? "未知原因"}。文件可能损坏或编码不受支持。</StateBadge>}
        <video
          ref={mediaRef as React.RefObject<HTMLVideoElement>}
          src={inlineSrc}
          poster={thumbnailUrl(source.versionId)}
          controls
          preload="metadata"
          playsInline
          data-testid="media-video"
          data-duration={duration ?? ""}
          data-ready-state={readyState ?? ""}
          data-current-time={currentTime}
          className={`${state === "error" ? "hidden" : ""} max-h-[420px] w-full rounded-md border border-border-subtle bg-black`}
          onLoadedMetadata={(event) => {
            const element = event.currentTarget;
            setDuration(Number.isFinite(element.duration) ? element.duration : null);
            setReadyState(element.readyState);
            setState("ready");
          }}
          onTimeUpdate={(event) => {
            setCurrentTime(event.currentTarget.currentTime);
            setReadyState(event.currentTarget.readyState);
          }}
          onSeeked={(event) => {
            setCurrentTime(event.currentTarget.currentTime);
            setReadyState(event.currentTarget.readyState);
          }}
          onError={() => {
            setFailure(`解码失败（媒体错误码 ${mediaRef.current?.error?.code ?? "?"}）`);
            setState("error");
          }}
        />
        {variant !== "thumb" && state === "ready" && (
          <div className="mt-1 font-mono text-[10px] text-text-faint" data-testid="media-video-facts">
            时长 {formatSeconds(duration)} · readyState {readyState ?? "-"} · 当前 {currentTime.toFixed(2)}s
          </div>
        )}
        {variant !== "thumb" && state !== "loading" && link}
      </div>
    );
  }

  if (kind === "audio" && variant === "thumb") {
    // 同理：列表里放一个音符记号，播放器留给检查器。
    return (
      <div className={className} data-media-state="ready" data-media-kind="audio">
        <span
          className="flex h-12 w-16 items-center justify-center rounded border border-border-subtle bg-bg-raise2 text-sm text-text-faint"
          title={source.mimeType ?? "audio"}
          data-testid="media-audio-glyph"
        >
          <span aria-hidden="true">♪</span>
        </span>
      </div>
    );
  }

  if (kind === "audio") {
    return (
      <div className={className} data-media-state={state} data-media-kind="audio">
        {state === "loading" && <StateBadge state="loading">音频元数据加载中…</StateBadge>}
        {state === "error" && <StateBadge state="error">音频无法播放：{failure ?? "未知原因"}。</StateBadge>}
        <audio
          ref={mediaRef as React.RefObject<HTMLAudioElement>}
          src={inlineSrc}
          controls
          preload="metadata"
          data-testid="media-audio"
          data-duration={duration ?? ""}
          data-ready-state={readyState ?? ""}
          data-current-time={currentTime}
          className={`${state === "error" ? "hidden" : ""} w-full`}
          onLoadedMetadata={(event) => {
            const element = event.currentTarget;
            setDuration(Number.isFinite(element.duration) ? element.duration : null);
            setReadyState(element.readyState);
            setState("ready");
          }}
          onTimeUpdate={(event) => {
            setCurrentTime(event.currentTarget.currentTime);
            setReadyState(event.currentTarget.readyState);
          }}
          onSeeked={(event) => {
            setCurrentTime(event.currentTarget.currentTime);
            setReadyState(event.currentTarget.readyState);
          }}
          onError={() => {
            setFailure(`解码失败（媒体错误码 ${mediaRef.current?.error?.code ?? "?"}）`);
            setState("error");
          }}
        />
        {variant !== "thumb" && state === "ready" && (
          <div className="mt-1 font-mono text-[10px] text-text-faint" data-testid="media-audio-facts">
            时长 {formatSeconds(duration)} · 当前 {currentTime.toFixed(2)}s
          </div>
        )}
        {variant !== "thumb" && state !== "loading" && link}
      </div>
    );
  }

  return (
    <div className={className} data-media-state="empty" data-media-kind="other">
      <StateBadge state="empty">
        非图/视/音媒体（{source.mimeType ?? source.extension ?? "未知类型"}），浏览器无法内联预览；可下载查看。
      </StateBadge>
      {link}
    </div>
  );
}
