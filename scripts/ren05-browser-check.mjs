// REN-05 / scripts/ren05-browser-check.mjs
//
// REAL BROWSER verification of local media playback, driven over CDP against the Chrome instance the
// project already runs (127.0.0.1:18800).
//
// WHAT MAKES THIS EVIDENCE RATHER THAN A DOM ASSERTION
//   * The check drives media ELEMENTS and reports their state: readyState, duration, videoWidth /
//     videoHeight, currentTime before and after a seek, the seeked event, and whether the playhead
//     actually advanced. "A <video> tag exists" proves nothing and is not used here.
//   * The play is triggered by a REAL mouse event through Input.dispatchMouseEvent, because a browser
//     only grants playback in response to a user gesture.
//   * The Network domain records the HTTP exchanges the page caused, so the 206 responses the seek
//     produced are captured as network evidence alongside the element state.
//   * A screenshot is saved, so the frame is on record.
//
// The page under test is the minimal harness page (host/render-check.html). This is NOT a workbench
// UI acceptance run and says nothing about the UI's own layout.
//
// Usage: node scripts/ren05-browser-check.mjs --url <renderCheckUrl> --out <json> --shot <png> [--cdp http://127.0.0.1:18800]

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

function arg(name, dflt = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
}

const targetUrl = arg("url");
const outPath = arg("out");
const shotPath = arg("shot");
const cdpHttp = arg("cdp", "http://127.0.0.1:18800");
if (!targetUrl) {
  console.error("usage: node scripts/ren05-browser-check.mjs --url <renderCheckUrl> --out <json> --shot <png>");
  process.exit(2);
}

// Loopback must not be proxied - the exec host injects proxy variables that would otherwise send
// these requests to the proxy instead of to the test host.
for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) delete process.env[key];
process.env.NO_PROXY = "127.0.0.1,localhost";

const require = createRequire("C:/Users/Administrator/AppData/Roaming/npm/node_modules/openclaw/package.json");
const WebSocket = require("ws");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const checks = [];
const add = (id, ok, detail, extra = {}) => checks.push({ id, ok, detail, ...extra });

let ws;
let send;
try {
  const tab = await (await fetch(`${cdpHttp}/json/new?url=about:blank`, { method: "PUT" })).json();
  ws = new WebSocket(tab.webSocketDebuggerUrl, { perMessageDeflate: false });
  let idc = 0;
  const pending = new Map();
  const events = [];
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? p.rej(new Error(msg.error.message)) : p.res(msg.result);
      return;
    }
    if (msg.method) events.push(msg);
  });
  send = (method, params = {}) =>
    new Promise((res, rej) => {
      const id = ++idc;
      pending.set(id, { res, rej });
      ws.send(JSON.stringify({ id, method, params }));
    });
  await new Promise((r) => ws.on("open", r));

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Network.enable");
  await send("DOM.enable");

  await send("Page.navigate", { url: targetUrl });
  await sleep(2500);

  const ready = await send("Runtime.evaluate", { expression: "({ ready: Boolean(window.REN05), status: document.getElementById('status')?.textContent })", returnByValue: true });
  add("harness_page_loaded", ready.result?.value?.ready === true, `page reported status "${ready.result?.value?.status}"`, { value: ready.result?.value });

  // A real click on the button: a synthesised mouse event is a genuine user gesture for autoplay.
  const box = await send("Runtime.evaluate", {
    expression: "(() => { const r = document.getElementById('run').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()",
    returnByValue: true
  });
  const { x, y } = box.result.value;
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", clickCount: 0 });
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });

  // Wait for the page's own sequence to finish.
  let result = null;
  for (let i = 0; i < 60; i += 1) {
    await sleep(500);
    const poll = await send("Runtime.evaluate", { expression: "window.REN05?.result ?? null", returnByValue: true });
    if (poll.result?.value) {
      result = poll.result.value;
      break;
    }
  }
  add("media_check_sequence_completed", result !== null, result ? "the page completed its media sequence" : "the page never produced a result (timeout)", {});

  if (result) {
    add("page_logged_in_against_the_plugin", result.login_status === 200, `the page logged in through the plugin's own /auth/login (status ${result.login_status})`, { login_status: result.login_status });

    const v = result.video ?? {};
    add("video_metadata_loaded",
      v.meta_event === "loadedmetadata" && Number.isFinite(v.duration) && v.duration > 1,
      `video loadedmetadata: duration ${v.duration}s, ${v.videoWidth}x${v.videoHeight}, readyState ${v.readyState}, source ${v.src}`,
      { video: v });
    add("video_playback_started",
      v.played === true && (v.readyState >= 2),
      `video.play() resolved (played=${v.played}), readyState ${v.readyState}, paused ${v.paused}`,
      { played: v.played, ready_state: v.readyState });
    add("video_seek_moved_the_playhead",
      v.seek_event === "seeked" && v.seek_moved === true,
      `seeking to ${v.seek_target}s raised "seeked" and the playhead is at ${v.currentTime_after_seek}s (before the seek it was ${v.playhead_before_seek}s)`,
      { seek_target: v.seek_target, current_time_after_seek: v.currentTime_after_seek, seek_event: v.seek_event, buffered: v.buffered });
    add("video_reported_no_media_error",
      !v.error,
      v.error ? `the video element reported error code ${v.error.code}: ${v.error.message}` : "the video element reported no MediaError",
      { error: v.error ?? null });

    const a = result.audio ?? {};
    add("audio_metadata_loaded",
      a.meta_event === "loadedmetadata" && Number.isFinite(a.duration) && a.duration > 1,
      `audio loadedmetadata: duration ${a.duration}s, readyState ${a.readyState}, source ${a.src}`,
      { audio: a });
    add("audio_playback_advanced_the_playhead",
      a.playhead_advanced === true,
      `audio.play() resolved and currentTime advanced from ${a.currentTime_start}s to ${a.currentTime_after_play}s`,
      { advanced: a.playhead_advanced, start: a.currentTime_start, after: a.currentTime_after_play, played: a.played });
    add("audio_reported_no_media_error",
      !a.error,
      a.error ? `the audio element reported error code ${a.error.code}: ${a.error.message}` : "the audio element reported no MediaError",
      { error: a.error ?? null });

    const img = result.image ?? {};
    add("image_preview_has_real_pixels",
      img.event === "load" && img.naturalWidth > 0 && img.naturalHeight > 0,
      `image loaded with natural size ${img.naturalWidth}x${img.naturalHeight} (complete=${img.complete}), source ${img.src}`,
      { image: img });
  }

  // ---- network evidence ---------------------------------------------------------------------
  const mediaResponses = events
    .filter((e) => e.method === "Network.responseReceived")
    .map((e) => e.params.response)
    .filter((r) => /video-assets\/(proxy|thumb|inline|file)\//.test(r.url))
    .map((r) => ({ url: r.url.replace(/^https?:\/\/127\.0\.0\.1:\d+/, ""), status: r.status, mimeType: r.mimeType, contentRange: r.headers?.["content-range"] ?? r.headers?.["Content-Range"] ?? null, protocol: r.protocol, fromDiskCache: r.fromDiskCache === true, encodedDataLength: r.encodedDataLength }));
  const partial = mediaResponses.filter((r) => r.status === 206);
  add("network_shows_media_requests_were_served",
    mediaResponses.length > 0 && mediaResponses.every((r) => r.status === 200 || r.status === 206),
    `${mediaResponses.length} media response(s) captured: ${mediaResponses.map((r) => `${r.status} ${r.mimeType} ${r.contentRange ?? "(full)"}`).join(" | ")}`,
    { media_responses: mediaResponses });
  add("seek_was_served_as_partial_content",
    partial.length > 0,
    partial.length > 0
      ? `the browser issued range requests and the server answered ${partial.length} of them with 206 + content-range (${partial.map((r) => r.contentRange).join(", ")})`
      : "no 206 response was captured: the seek did not produce a range request in this run",
    { partial_count: partial.length, partial });

  // ---- screenshot ---------------------------------------------------------------------------
  if (shotPath) {
    await fs.promises.mkdir(path.dirname(shotPath), { recursive: true });
    const shot = await send("Page.captureScreenshot", { format: "png" });
    await fs.promises.writeFile(shotPath, Buffer.from(shot.data, "base64"));
    const stat = await fs.promises.stat(shotPath);
    add("screenshot_captured", stat.size > 1000, `screenshot written (${stat.size} B) -> ${shotPath}`, { screenshot_bytes: stat.size });
  }

  const failed = checks.filter((c) => !c.ok);
  const report = {
    report: "REN-05 real browser media verification (minimal harness page, not the workbench UI)",
    generated_at: new Date().toISOString(),
    target_url: targetUrl,
    cdp: cdpHttp,
    result,
    checks,
    failed: failed.map((c) => `${c.id}: ${c.detail}`),
    all_pass: failed.length === 0
  };
  if (outPath) {
    await fs.promises.mkdir(path.dirname(outPath), { recursive: true });
    await fs.promises.writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  for (const c of checks) console.log(`[${c.ok ? "PASS" : "FAIL"}] ${c.id}: ${c.detail}`);
  console.log(`browser checks: ${checks.length - failed.length}/${checks.length} pass${outPath ? ` -> ${outPath}` : ""}`);
  process.exitCode = failed.length === 0 ? 0 : 1;
} catch (error) {
  console.error(`browser check aborted: ${error?.stack ?? error}`);
  process.exitCode = 4;
} finally {
  try {
    await send?.("Page.close");
  } catch {
    /* the tab may already be gone */
  }
  ws?.close();
}
