import { useEffect, useState } from "react";
import { subscribeToAnnouncements } from "../lib/announcer";

/**
 * 全局播报区域（aria-live）。
 *
 * 放在 AppShell 里挂一次，整个应用共用。用 `polite` 而不是 `assertive`：检索结果、上传进度这类消息
 * 不该打断用户正在读的内容；真正紧急的失败也仍然值得用户听完当前一句。
 *
 * 消息前加一个自增序号：连续两次相同文本（例如"无匹配结果"）如果文本完全相同，部分屏幕阅读器不会重读，
 * 用户会以为操作没生效。序号让每次播报在文本上都是新的。
 */
export default function LiveRegion() {
  const [entry, setEntry] = useState<{ seq: number; message: string } | null>(null);

  useEffect(() => {
    let seq = 0;
    return subscribeToAnnouncements((message) => {
      seq += 1;
      setEntry({ seq, message });
    });
  }, []);

  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      data-testid="live-region"
      data-announce-seq={entry?.seq ?? 0}
      className="sr-only"
    >
      {entry ? `${entry.message}` : ""}
    </div>
  );
}
