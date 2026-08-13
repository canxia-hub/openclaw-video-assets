/**
 * cdp-check-p4.mjs — P4 打磨期 DOM 取证（Cmd+K 面板 / 对比度 token / 页面渲染 / 面板跳转）
 * 用法: node cdp-check-p4.mjs <password>
 * 输出: 单行 JSON（截断打印，证据同时写入 stdout）
 */
import { createRequire } from "node:module";
const require = createRequire("C:/Users/Administrator/AppData/Roaming/npm/node_modules/openclaw/package.json");
const WebSocket = require("ws");

const [password] = process.argv.slice(2);
if (!password) { console.error("usage: node cdp-check-p4.mjs <password>"); process.exit(2); }

const BASE = "http://127.0.0.1:33979/__openclaw__/video-assets/workbench";
const CDP_HTTP = "http://127.0.0.1:18800";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tab = await (await fetch(`${CDP_HTTP}/json/new?url=about:blank`, { method: "PUT" })).json();
const ws = new WebSocket(tab.webSocketDebuggerUrl, { perMessageDeflate: false });
let idc = 0;
const pending = new Map();
const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const id = ++idc;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });
ws.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? p.rej(new Error(msg.error.message)) : p.res(msg.result);
  }
});
await new Promise((r) => ws.on("open", r));

async function evalJs(expression) {
  const out = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (out?.exceptionDetails) throw new Error("page exception: " + JSON.stringify(out.exceptionDetails).slice(0, 300));
  return out?.result?.value;
}

const CHECKS = `
(async () => {
  const s = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = { route: location.pathname, checks: {} };
  // 1) 页面渲染
  out.checks.h1 = (document.querySelector("h1") || {}).innerText || null;
  out.checks.bodyHasContent = document.body.innerText.length > 50;
  // 2) 对比度 token（Tailwind v4 @theme → :root CSS 变量）
  out.checks.tokenFaint = getComputedStyle(document.documentElement).getPropertyValue("--color-text-faint").trim();
  // 3) Cmd+K 面板：点击顶栏搜索按钮打开
  const trig = document.querySelector('button[aria-label="全局搜索"]');
  out.checks.triggerExists = !!trig;
  if (!trig) return out;
  trig.click();
  await s(400);
  const pin = [...document.querySelectorAll("input")].find((i) => (i.placeholder || "").includes("跳转页面"));
  out.checks.paletteOpen = !!pin;
  if (!pin) return out;
  // 4) 面板内搜索 "中文"
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  setter.call(pin, "中文");
  pin.dispatchEvent(new Event("input", { bubbles: true }));
  await s(1600);
  const list = document.querySelector("#palette-list");
  const btns = list ? [...list.querySelectorAll("button")] : [];
  out.checks.itemCount = btns.length;
  out.checks.firstTitles = btns.slice(0, 5).map((b) => b.innerText.replace(/\\n/g, " | ").slice(0, 70));
  // 5) 点击首项验证跳转
  if (btns.length) {
    btns[0].click();
    await s(900);
    out.checks.afterNavPath = location.pathname;
    out.checks.afterNavH1 = (document.querySelector("h1") || {}).innerText || null;
  }
  return out;
})()
`;

try {
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Page.navigate", { url: BASE + "/" });
  await sleep(1500);
  const login = await evalJs(
    `fetch('/__openclaw__/video-assets/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:${JSON.stringify(password)}}),credentials:'include'}).then(r=>r.json())`
  );
  if (!login?.ok) throw new Error("login failed");

  // 检查点 A：仪表盘 + 面板
  await send("Page.navigate", { url: BASE + "/" });
  await sleep(3000);
  const dashboard = await evalJs(CHECKS);

  // 检查点 B：键盘 Ctrl+K 打开（在项目页）
  await send("Page.navigate", { url: BASE + "/projects" });
  await sleep(2500);
  const kbd = await (async () => {
    // 真实按键：Ctrl 修饰（modifiers: Alt=1 Ctrl=2 Meta=4 Shift=8）
    const key = { key: "k", code: "KeyK", windowsVirtualKeyCode: 75, nativeVirtualKeyCode: 75, modifiers: 2 };
    await send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...key });
    await send("Input.dispatchKeyEvent", { type: "keyUp", ...key });
    await sleep(500);
    return await evalJs(`(async () => {
      const pin = [...document.querySelectorAll("input")].find((i) => (i.placeholder || "").includes("跳转页面"));
      const out = { ctrlKOpens: !!pin };
      if (pin) {
        const list = document.querySelector("#palette-list");
        out.emptyQueryItems = list ? list.querySelectorAll("button").length : 0;
        out.emptyQuerySample = list ? [...list.querySelectorAll("button")].slice(0, 3).map((b) => b.innerText.replace(/\\n/g, " | ").slice(0, 50)) : [];
      }
      return out;
    })()`);
  })();

  console.log(JSON.stringify({ ok: true, dashboard, kbd }, null, 1).slice(0, 1600));
} finally {
  ws.close();
  await fetch(`${CDP_HTTP}/json/close/${tab.id}`).catch(() => {});
}
