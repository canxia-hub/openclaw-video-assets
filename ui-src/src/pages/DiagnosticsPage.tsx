import { useState } from "react";
import { buildInfo } from "../lib/version";

/*
 * DiagnosticsPage —— 诊断面（不是产品功能）。
 *
 * 它做两件事，都值得说明为什么放进产品里：
 *
 * 1) **显示构建身份**（版本 + commit）。界面上的版本号以前是手写字符串，出现过 v1.5 与 v1.3 并存；
 *    现在读的是构建注入值，这个页面把两个值都摊开，任何人都能核对"界面声称的版本"与"实际构建它的提交"。
 *
 * 2) **渲染错误自检**。门3 要求"组件抛错时显示降级 UI 而非白屏"，而这件事**只能靠真的抛一次错**来验证：
 *    控件存在、代码里有 ErrorBoundary 字样，都不等于白屏被真的挡住了。所以这里放一个开关，按下后本页
 *    在渲染期抛出异常，由路由级 ErrorBoundary 接住。这是自检面，不是功能——不放进产品导航，也不改变
 *    任何业务数据。
 */

// 返回类型显式标为 never：无条件抛出时 TS 会把返回类型推断成 void，而 void 不是合法的 JSX 组件类型。
function FaultyPanel(): never {
  // 抛在渲染期（不是事件处理器里）：只有渲染期错误会被 ErrorBoundary 捕获，事件处理器里的抛错不会。
  throw new Error("诊断面故意抛出的渲染期异常（错误边界自检）");
}

export default function DiagnosticsPage() {
  const [boom, setBoom] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);

  return (
    <div className="p-6" data-testid="diagnostics-page">
      <h1 className="mb-1 text-lg font-semibold text-text-primary">诊断</h1>
      <p className="mb-4 text-sm text-text-secondary">构建身份与降级自检。这里没有业务数据，也不会修改任何素材。</p>

      <section className="mb-4 rounded-lg border border-border-subtle bg-bg-raise1 p-4">
        <h2 className="mb-2 text-sm font-medium text-text-primary">构建身份</h2>
        <dl className="grid grid-cols-[8rem_1fr] gap-y-1 text-xs">
          <dt className="text-text-faint">前端版本</dt>
          <dd className="font-mono text-text-secondary" data-testid="diag-version">{buildInfo.appVersion}</dd>
          <dt className="text-text-faint">构建提交</dt>
          <dd className="font-mono text-text-secondary" data-testid="diag-commit">{buildInfo.commit}</dd>
          <dt className="text-text-faint">页面地址</dt>
          <dd className="break-all font-mono text-text-secondary">{typeof window === "undefined" ? "-" : window.location.pathname}</dd>
          <dt className="text-text-faint">视口</dt>
          <dd className="font-mono text-text-secondary" data-testid="diag-viewport">
            {typeof window === "undefined" ? "-" : `${window.innerWidth}×${window.innerHeight} @${window.devicePixelRatio}x`}
          </dd>
          <dt className="text-text-faint">UA</dt>
          <dd className="break-all font-mono text-text-faint">{typeof navigator === "undefined" ? "-" : navigator.userAgent}</dd>
        </dl>
      </section>

      <section className="rounded-lg border border-border-subtle bg-bg-raise1 p-4">
        <h2 className="mb-2 text-sm font-medium text-text-primary">降级自检（渲染期抛错 → 错误边界）</h2>
        <p className="mb-3 text-xs leading-5 text-text-secondary">
          按下后本页会在渲染期抛出一个异常。若错误边界工作正常，你看到的应是带原始错误信息与「重试」按钮的降级面板，
          而不是白屏；「重试」会重新挂载本页并回到这个状态。
        </p>
        <button
          type="button"
          data-testid="diag-throw"
          onClick={() => {
            setAcknowledged(true);
            setBoom(true);
          }}
          className="rounded-md border border-danger/50 bg-danger/10 px-3 py-1.5 text-xs text-danger"
        >
          触发渲染期异常
        </button>
        {acknowledged && !boom && <span className="ml-3 text-xs text-text-faint">（重试后回到本状态；再按一次可再次触发）</span>}
        {boom && <FaultyPanel />}
      </section>
    </div>
  );
}
