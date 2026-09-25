/**
 * 全局播报通道 —— 屏幕阅读器用。
 *
 * 为什么需要：素材检索、上传、取消这些操作的结果只体现在视觉上（列表变了、进度条走了），屏幕阅读器
 * 用户得不到任何反馈。aria-live 区域把结果读出来，且必须由**一个**区域承担，否则多处同时播报会互相
 * 打断，听感上比不播报更糟。
 *
 * 实现是订阅式的：业务代码调用 announce()，由 AppShell 里挂载的那一个 LiveRegion 负责渲染。
 * 这样组件不需要知道播报区域在哪里，也不会各自造一个。
 */

type Listener = (message: string) => void;

const listeners = new Set<Listener>();

/**
 * 播报一条消息。
 *
 * 空字符串与纯空白不播报：否则调用方一个手滑就会让屏幕阅读器读到空白，而调用方还以为播报成功了。
 */
export function announce(message: string): void {
  const text = String(message ?? "").trim();
  if (!text) return;
  for (const listener of listeners) listener(text);
}

/** 订阅播报，返回取消订阅函数。 */
export function subscribeToAnnouncements(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
