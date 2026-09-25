import { Component, type ErrorInfo, type ReactNode } from "react";
import { announce } from "../lib/announcer";

/*
 * ErrorBoundary —— 组件抛错时显示降级界面，而不是白屏。
 *
 * 审计问题 12 记的是"无错误边界"：一个渲染期异常会把整个工作台变成空白页，用户既看不到出了什么事，
 * 也不知道该不该重试。降级界面因此必须给出三件事：出错范围、原始错误、可执行动作（重试 / 返回）。
 *
 * 它**不**吞掉错误：错误同时通过 announce() 播报，并保留原始 message 在界面上，便于直接抄进缺陷报告。
 * 一个只显示"出错了"的边界会把可诊断信息删掉。
 */

interface Props {
  children: ReactNode;
  /** 出错范围的名字，用于说明"哪里坏了"，例如 "素材库"。 */
  scope: string;
}

interface State {
  error: Error | null;
  info: string | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.setState({ info: info.componentStack ?? null });
    announce(`${this.props.scope} 渲染出错：${error.message}`);
  }

  render(): ReactNode {
    const { error, info } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="m-6 rounded-lg border border-danger/50 bg-danger/10 p-5" data-testid="error-boundary" data-error-scope={this.props.scope}>
        <h2 className="mb-1 text-sm font-semibold text-danger">{this.props.scope} 渲染出错，已降级显示</h2>
        <p className="mb-3 text-xs text-text-secondary">
          工作台其余部分仍可使用。下方是原始错误信息（未做美化，便于直接复制进缺陷报告）。
        </p>
        <pre className="mb-3 overflow-x-auto rounded-md border border-border-subtle bg-bg-canvas p-3 font-mono text-[11px] text-text-secondary" data-testid="error-boundary-message">
          {error.message}
        </pre>
        {info && (
          <details className="mb-3 text-[11px] text-text-faint">
            <summary className="cursor-pointer">组件栈</summary>
            <pre className="mt-2 overflow-x-auto font-mono">{info}</pre>
          </details>
        )}
        <div className="flex gap-2">
          <button
            type="button"
            data-testid="error-boundary-retry"
            onClick={() => this.setState({ error: null, info: null })}
            className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white"
          >
            重试
          </button>
          <a href="/__openclaw__/video-assets/workbench/dashboard" className="rounded-md border border-border-subtle px-3 py-1.5 text-xs text-text-secondary">
            返回项目总览
          </a>
        </div>
      </div>
    );
  }
}
