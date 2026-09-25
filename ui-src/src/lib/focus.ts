import { useEffect, type RefObject } from "react";

/**
 * useFocusTrap —— 覆盖层（命令面板、检查器抽屉）的键盘可达性。
 *
 * 三件事，每件都对应一个具体的坏体验：
 *
 * 1) **进入时移焦**：覆盖层打开后焦点留在触发按钮上，键盘用户按 Tab 会走到覆盖层**背后**的页面里，
 *    看不见却可操作。
 * 2) **圈定范围**：焦点必须在覆盖层内部循环，不能跑到后面的页面。
 * 3) **关闭后归还**：关闭时把焦点还给打开它的元素。少了这一步，焦点会掉到 document.body，
 *    下一次 Tab 从页面开头重新开始 —— 用户"位置感"丢失，这是键盘可用性最常见的破口。
 *
 * Escape 关闭也在里面：它不是可选项，而是"能退出"的最低要求。
 */
export function useFocusTrap(
  containerRef: RefObject<HTMLElement | null>,
  open: boolean,
  onClose: () => void
): void {
  useEffect(() => {
    if (!open) return undefined;

    // 记录打开前的焦点元素，关闭时归还。放在 effect 里而不是 onClick 里，是因为覆盖层也可能由
    // 键盘快捷键打开，那时没有"点击的按钮"可取。
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const container = containerRef.current;
    const focusableSelector = [
      "a[href]",
      "button:not([disabled])",
      "input:not([disabled])",
      "select:not([disabled])",
      "textarea:not([disabled])",
      '[tabindex]:not([tabindex="-1"])'
    ].join(",");

    const focusablesOf = (): HTMLElement[] =>
      container ? Array.from(container.querySelectorAll<HTMLElement>(focusableSelector)).filter((element) => element.offsetParent !== null || element === document.activeElement) : [];

    // 进入：优先聚焦容器内第一个可聚焦元素；没有则聚焦容器本身（tabIndex=-1 时）。
    const first = focusablesOf()[0];
    if (first) first.focus();
    else container?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusables = focusablesOf();
      if (focusables.length === 0) {
        event.preventDefault();
        return;
      }
      const firstFocusable = focusables[0];
      const lastFocusable = focusables[focusables.length - 1];
      const active = document.activeElement;
      // 正向 Tab 在最后一个元素上、反向 Tab 在第一个元素上时回绕，形成闭环。
      if (!event.shiftKey && active === lastFocusable) {
        event.preventDefault();
        firstFocusable.focus();
      } else if (event.shiftKey && active === firstFocusable) {
        event.preventDefault();
        lastFocusable.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      // 归还焦点。若原元素已从文档移除（例如它所在的列表被刷新掉了），退回 body，
      // 而不是让浏览器自己决定 —— 显式处理过的情况比默认行为更容易解释。
      if (previouslyFocused && document.contains(previouslyFocused)) previouslyFocused.focus();
      else document.body.focus();
    };
  }, [containerRef, open, onClose]);
}
