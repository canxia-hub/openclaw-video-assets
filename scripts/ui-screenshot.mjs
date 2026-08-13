/**
 * ui-screenshot.mjs — 视频资产工作台 CDP 截图验收工具
 * 用法: node ui-screenshot.mjs <outDir> <prefix> <password> <route1> [route2 ...]
 * 流程: 新建 CDP 标签 → 登录(真实 auth/login) → 逐路由导航+截图 → 关闭标签
 * 输出仅打印保存文件与大小，避免大日志灌入上下文。
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire("C:/Users/Administrator/AppData/Roaming/npm/node_modules/openclaw/package.json");
const WebSocket = require("ws");

const [outDir, prefix, password, ...routes] = process.argv.slice(2);
if (!outDir || !prefix || !password || routes.length === 0) {
  console.error("usage: node ui-screenshot.mjs <outDir> <prefix> <password> <route...>");
  process.exit(2);
}

const BASE = "http://127.0.0.1:33979/__openclaw__/video-assets/workbench";
const CDP_HTTP = "http://127.0.0.1:18800";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function newTab() {
  const res = await fetch(`${CDP_HTTP}/json/new?url=about:blank`, { method: "PUT" });
  if (!res.ok) throw new Error(`json/new failed: ${res.status}`);
  return res.json();
}

async function closeTab(id) {
  await fetch(`${CDP_HTTP}/json/close/${id}`).catch(() => {});
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { perMessageDeflate: false });
    let idc = 0;
    const pending = new Map();
    const listeners = [];
    ws.on("open", () => {
      resolve({
        send(method, params = {}) {
          return new Promise((res2, rej2) => {
            const id = ++idc;
            pending.set(id, { res2, rej2 });
            ws.send(JSON.stringify({ id, method, params }));
          });
        },
        once(method, timeoutMs = 15000) {
          return new Promise((res2, rej2) => {
            const timer = setTimeout(() => rej2(new Error(`timeout waiting ${method}`)), timeoutMs);
            listeners.push({ method, fn: (msg) => { clearTimeout(timer); res2(msg.params); } });
          });
        },
        close: () => ws.close(),
      });
    });
    ws.on("error", reject);
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? p.rej2(new Error(msg.error.message)) : p.res2(msg.result);
      } else if (msg.method === "Page.javascriptDialogOpening") {
        // 自动接受 window.confirm / alert，避免截图脚本挂起
        ws.send(JSON.stringify({ id: ++idc, method: "Page.handleJavaScriptDialog", params: { accept: true } }));
      } else if (msg.method) {
        for (let i = listeners.length - 1; i >= 0; i--) {
          if (listeners[i].method === msg.method) {
            const l = listeners.splice(i, 1)[0];
            l.fn(msg);
          }
        }
      }
    });
  });
}

async function main() {
  mkdirSync(outDir, { recursive: true });
  const tab = await newTab();
  const cdp = await connect(tab.webSocketDebuggerUrl);
  try {
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });

    // 登录页加载
    let loaded = cdp.once("Page.loadEventFired");
    await cdp.send("Page.navigate", { url: BASE + "/" });
    await loaded;
    await sleep(800);

    // 真实登录（同源 fetch，写入 Cookie）
    const login = await cdp.send("Runtime.evaluate", {
      expression: `fetch('/__openclaw__/video-assets/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:${JSON.stringify(password)}}),credentials:'include'}).then(r=>r.json())`,
      awaitPromise: true,
      returnByValue: true,
    });
    const loginResult = login?.result?.value;
    if (!loginResult?.ok) throw new Error(`login failed: ${JSON.stringify(loginResult)}`);
    console.log("login: ok");

    for (const route of routes) {
      const [path, clickSelector] = route.split("@@");
      loaded = cdp.once("Page.loadEventFired");
      await cdp.send("Page.navigate", { url: `${BASE}${path}` });
      await loaded;
      await sleep(2600); // 等待 React Query 数据回灌
      if (clickSelector) {
        const m = /^(.*)\*(\d+)$/.exec(clickSelector);
        const selector = m ? m[1] : clickSelector;
        const times = m ? Number(m[2]) : 1;
        for (let i = 0; i < times; i++) {
          await cdp.send("Runtime.evaluate", {
            expression: `document.querySelector(${JSON.stringify(selector)})?.click()`,
          });
          await sleep(600);
        }
        await sleep(1600); // 等待检查器详情拉取/视图动画
      }
      const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
      const name = `${prefix}-${path.replaceAll("/", "").replace(/[^a-z0-9-]/gi, "") || "root"}${clickSelector ? "-inspector" : ""}.png`;
      const file = join(outDir, name);
      writeFileSync(file, Buffer.from(shot.data, "base64"));
      console.log(`saved: ${name}`);
    }
  } finally {
    cdp.close();
    await closeTab(tab.id);
  }
}

main().catch((e) => {
  console.error(`FAIL: ${e.message}`);
  process.exit(1);
});
