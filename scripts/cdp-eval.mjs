/**
 * cdp-eval.mjs — 工作台页面 DOM 求值取证工具
 * 用法: node cdp-eval.mjs <password> <route> <expression>
 * 登录后导航到路由，等待数据回灌，执行表达式并打印 JSON 结果（截断 800 字符）。
 */
import { createRequire } from "node:module";
const require = createRequire("C:/Users/Administrator/AppData/Roaming/npm/node_modules/openclaw/package.json");
const WebSocket = require("ws");

const [password, route, expression] = process.argv.slice(2);
if (!password || !route || !expression) {
  console.error("usage: node cdp-eval.mjs <password> <route> <expression>");
  process.exit(2);
}

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

try {
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Page.navigate", { url: BASE + "/" });
  await sleep(1500);
  const login = await send("Runtime.evaluate", {
    expression: `fetch('/__openclaw__/video-assets/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:${JSON.stringify(password)}}),credentials:'include'}).then(r=>r.json())`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (!login?.result?.value?.ok) throw new Error("login failed");
  await send("Page.navigate", { url: BASE + route });
  await sleep(3000);
  const out = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  const text = JSON.stringify(out?.result?.value ?? out?.result);
  console.log(text.length > 800 ? text.slice(0, 800) + "…[truncated]" : text);
} finally {
  ws.close();
  await fetch(`${CDP_HTTP}/json/close/${tab.id}`).catch(() => {});
}
