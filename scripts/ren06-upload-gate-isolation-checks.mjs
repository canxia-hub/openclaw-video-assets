// REN-06 / scripts/ren06-upload-gate-isolation-checks.mjs
//
// The small, targeted checks that the main acceptance run could NOT make, because its own fixture was
// deliberately sized to fit inside the queue: with 8 concurrent requests against a cap of 2 and a waiting
// room of 8, every request is either active or WAITING - none is ever refused, so "the waiting room is
// bounded and a full one refuses" was asserted, not demonstrated.
//
// Two gaps are closed here, both with a strict policy host and small fixtures:
//
//   1. QUEUE BOUNDARY. Cap 1 / waiting room 2. Three simultaneous appends fit (1 active + 2 waiting) and all
//      succeed; a FOURTH is refused with UPLOAD_QUEUE_FULL (429). The negative control (three succeed,
//      nothing refused) is what makes the refusal meaningful: without it, a refusal could just mean the host
//      was broken.
//   2. WAITING CANCELLATION. A waiter that is cancelled must release what it holds - and it must not consume
//      the permit when the slot frees up. Cancelling a waiter, then letting the holder finish, proves the
//      remaining waiter is still admitted and that the cancelled one did not swallow the permit. A fresh
//      transfer afterwards proves no permit leaked.
//   3. IDENTITY. The plugin's auth model is checked for how many identities it can express, because the
//      owner check ("another identity gets 403") can only be exercised end-to-end if a second identity can
//      authenticate. See the notes on the `identity_*` checks for what that means for what is and is not
//      proven.
//
// Usage:
//   node scripts/ren06-upload-gate-isolation-checks.mjs --run <dir> --fixtures <dir> --out <json> [--port N]

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { UploadClient } from "./ren06-upload-client.mjs";

// Loopback-only. The execution host injects HTTP(S)_PROXY and sets NODE_USE_ENV_PROXY, which would route
// these requests to a proxy and return 502 (that failure mode looks like a broken server, not a redirect).
for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy", "NODE_USE_ENV_PROXY"]) {
  delete process.env[key];
}

const BASE_PATH = "/__openclaw__/video-assets";
const PASSWORD = "ren06-gate-isolation-password";

function arg(name, dflt = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
}

const runDir = arg("run");
const fixturesDir = arg("fixtures");
const outPath = arg("out");
const port = Number(arg("port", "20011"));
if (!runDir || !fixturesDir) {
  console.error("usage: node scripts/ren06-upload-gate-isolation-checks.mjs --run <dir> --fixtures <dir> --out <json> [--port N]");
  process.exit(2);
}
await fs.promises.mkdir(runDir, { recursive: true });

const checks = [];
const details = {};
const add = (id, ok, detail, extra = {}) => checks.push({ id, ok, detail, ...extra });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const fixture = (name) => path.join(fixturesDir, name);
const HOST_SCRIPT = path.join(import.meta.dirname, "ren06-upload-host.mjs");
const SRC = path.join(import.meta.dirname, "..", "src");

async function portIsFree(targetPort) {
  const net = await import("node:net");
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen(targetPort, "127.0.0.1");
  });
}

async function startHost({ repo, policy, rssLog = null, label }) {
  const factsPath = path.join(runDir, `gate-host-facts-${label}.json`);
  await fs.promises.rm(factsPath, { force: true });
  if (rssLog) await fs.promises.rm(rssLog, { force: true });
  const args = [HOST_SCRIPT, "--repo", repo, "--port", String(port), "--out", factsPath, "--password", PASSWORD, "--keep-alive-ms", "900000"];
  if (policy) args.push("--policy", JSON.stringify(policy));
  if (rssLog) args.push("--rss-log", rssLog);
  const outLog = path.join(runDir, `gate-host-${label}.stdout.log`);
  const errLog = path.join(runDir, `gate-host-${label}.stderr.log`);
  const childEnv = { ...process.env };
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy", "NODE_USE_ENV_PROXY"]) delete childEnv[key];
  const child = spawn(process.execPath, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: childEnv });
  child.stdout.pipe(fs.createWriteStream(outLog));
  child.stderr.pipe(fs.createWriteStream(errLog));
  let exited = false;
  child.on("exit", () => { exited = true; });

  const deadline = Date.now() + 60_000;
  let ready = false;
  while (Date.now() < deadline) {
    if (exited) {
      const stderr = fs.existsSync(errLog) ? fs.readFileSync(errLog, "utf8") : "";
      throw new Error(`gate host exited before ready: ${stderr.slice(0, 300)}`);
    }
    // Both conditions: the facts file proves registration, the refused TCP connect proves a listener.
    if (fs.existsSync(factsPath) && (await portIsFree(port)) === false) { ready = true; break; }
    await sleep(200);
  }
  if (!ready) throw new Error("gate host did not become ready within 60s");
  await sleep(100);
  const facts = JSON.parse(await fs.promises.readFile(factsPath, "utf8"));
  return {
    facts, child, outLog, errLog,
    stop: async () => {
      if (child.exitCode === null) {
        child.kill();
        const until = Date.now() + 5000;
        while (child.exitCode === null && Date.now() < until) await sleep(100);
        if (child.exitCode === null) child.kill("SIGKILL");
      }
    }
  };
}

const baseUrl = `http://127.0.0.1:${port}`;
const agent = new http.Agent({ keepAlive: false, maxSockets: 64 });

/**
 * Send an append whose body is written in paced pieces, so the transfer GATE PERMIT is held for a known
 * duration. Without a slow holder the other requests would find a free permit and never queue, which is
 * exactly why the main acceptance run could not observe the boundary.
 */
function pacedAppend({ cookie, upload_id, filePath, offset, length, pieceBytes = 64 * 1024, paceMs = 100 }) {
  return new Promise((resolve) => {
    const target = new URL(baseUrl);
    const request = http.request({
      method: "PATCH",
      hostname: target.hostname,
      port: target.port,
      path: `${BASE_PATH}/upload/${encodeURIComponent(upload_id)}`,
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(length),
        "upload-offset": String(offset),
        origin: baseUrl,
        cookie
      },
      agent
    }, (response) => {
      let text = "";
      response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => {
        let json = null;
        try { json = JSON.parse(text); } catch { /* reported as text */ }
        resolve({ status: response.statusCode, json, body: text });
      });
    });
    request.on("error", (error) => resolve({ status: 0, json: null, error: String(error?.message ?? error) }));

    const piece = Buffer.alloc(Math.min(pieceBytes, length), 0x41);
    let written = 0;
    const pump = () => {
      if (written >= length) { request.end(); return; }
      const size = Math.min(piece.length, length - written);
      written += size;
      const ok = request.write(piece.subarray(0, size));
      if (ok) setTimeout(pump, paceMs);
      else request.once("drain", () => setTimeout(pump, paceMs));
    };
    pump();
  });
}

/** One small append with a normal client (used for waiters and controls). */
function plainAppend({ cookie, upload_id, filePath, offset, length, declaredTotal }) {
  return new Promise((resolve) => {
    const target = new URL(baseUrl);
    const stream = fs.createReadStream(filePath, { start: offset, end: offset + length - 1, highWaterMark: 64 * 1024 });
    const request = http.request({
      method: "PATCH",
      hostname: target.hostname,
      port: target.port,
      path: `${BASE_PATH}/upload/${encodeURIComponent(upload_id)}`,
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(length),
        "upload-offset": String(offset),
        "content-range": `bytes ${offset}-${offset + length - 1}/${declaredTotal}`,
        origin: baseUrl,
        cookie
      },
      agent
    }, (response) => {
      let text = "";
      response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => {
        let json = null;
        try { json = JSON.parse(text); } catch { /* reported as text */ }
        resolve({ status: response.statusCode, json, body: text });
      });
    });
    request.on("error", (error) => resolve({ status: 0, json: null, error: String(error?.message ?? error) }));
    stream.pipe(request);
  });
}

/** A raw request with an arbitrary method/token, to probe the auth boundary per verb. */
function rawRequest({ method, urlPath, cookie = null, body = null, extraHeaders = {} }) {
  return new Promise((resolve) => {
    const target = new URL(baseUrl);
    const headers = { ...extraHeaders };
    if (cookie) headers.cookie = cookie;
    if (body !== null) {
      headers["content-type"] = "application/json";
      headers["content-length"] = String(Buffer.byteLength(body));
    }
    headers.origin = baseUrl;
    const request = http.request({ method, hostname: target.hostname, port: target.port, path: `${BASE_PATH}${urlPath}`, headers, agent }, (response) => {
      let text = "";
      response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => {
        let json = null;
        try { json = JSON.parse(text); } catch { /* reported as text */ }
        resolve({ status: response.statusCode, json, body: text });
      });
    });
    request.on("error", (error) => resolve({ status: 0, json: null, error: String(error?.message ?? error) }));
    request.end(body ?? undefined);
  });
}

const gateSnapshot = async (client) => (await client.list())?.gate ?? null;
const counterDeltas = (before, after) => {
  const keys = ["accepted", "started", "completed", "failed", "refused", "waited", "cancelled_while_waiting"];
  const deltas = {};
  for (const key of keys) deltas[key] = (after?.counters?.[key] ?? 0) - (before?.counters?.[key] ?? 0);
  return deltas;
};

// ---------------------------------------------------------------------------------------------
// Host: strict enough that three requests reach the boundary
// ---------------------------------------------------------------------------------------------
const strictRepo = path.join(runDir, "repo-gate");
let host = null;
try {
  host = await startHost({
    repo: strictRepo,
    policy: { maxConcurrentTransfers: 1, maxQueuedTransfers: 2, maxFileBytes: 64 * 1024 * 1024, stagingTotalBytes: 256 * 1024 * 1024, minFreeBytes: 64 * 1024 * 1024 },
    label: "gate"
  });
  add("gate_host_started_with_a_one_slot_policy",
    host.facts.upload_route_registered === true,
    `a real host started on port ${port} with maxConcurrentTransfers=1 and maxQueuedTransfers=2, so the transfer boundary is reachable with a handful of small requests`,
    { port });
} catch (error) {
  add("gate_host_started_with_a_one_slot_policy", false, `the gate host did not start: ${error.message}`);
}

if (host) {
  const owner = new UploadClient({ baseUrl });
  const login = await owner.login(PASSWORD);
  const cookie = owner.cookie;
  const policy = (await owner.list())?.policy ?? null;
  details.enforced_policy = policy;
  add("policy_reports_the_strict_limits_it_enforces",
    policy?.max_concurrent_transfers === 1 && policy?.max_queued_transfers === 2,
    `the server reports the limits it actually enforces (max_concurrent_transfers=${policy?.max_concurrent_transfers}, max_queued_transfers=${policy?.max_queued_transfers})`,
    { policy, actor: login.actor_id ?? null });

  // -------------------------------------------------------------------------------------------
  // 1. The auth boundary, per verb (the main run only probed create)
  // -------------------------------------------------------------------------------------------
  {
    const verbs = [
      { action: "create", method: "POST", path: "/upload", body: JSON.stringify({ file_name: "a.png", total_bytes: 1024 }) },
      { action: "status", method: "GET", path: "/upload/upl_does_not_exist", body: null },
      { action: "append", method: "PATCH", path: "/upload/upl_does_not_exist", body: null },
      { action: "complete", method: "POST", path: "/upload/upl_does_not_exist/complete", body: "{}" },
      { action: "cancel", method: "DELETE", path: "/upload/upl_does_not_exist", body: null },
      { action: "list", method: "GET", path: "/upload", body: null }
    ];
    const results = [];
    for (const verb of verbs) {
      const response = await rawRequest({ method: verb.method, urlPath: verb.path, cookie: null, body: verb.body });
      results.push({ action: verb.action, status: response.status, code: response.json?.code ?? null });
    }
    const allRefused = results.every((row) => row.status === 401);
    add("every_upload_verb_requires_a_session",
      allRefused,
      `all six actions were refused with 401 when no session was presented (${results.map((row) => row.action + ":" + row.status).join(", ")}) - the upload surface has no anonymous verb`,
      { results });

    const foreign = await rawRequest({ method: "GET", urlPath: "/upload", cookie: "openclaw_video_assets_session=not-a-real-token" });
    add("a_malformed_session_token_is_not_accepted_by_shape",
      foreign.status === 401,
      `a well-formed-looking but unknown session cookie was refused with ${foreign.status}, so a session is validated against the server's session store rather than by its shape`,
      { status: foreign.status, code: foreign.json?.code ?? null });
  }

  // -------------------------------------------------------------------------------------------
  // 2a. NEGATIVE CONTROL: three requests fit (1 active + 2 waiting) and nothing is refused
  // -------------------------------------------------------------------------------------------
  let negativeControl = null;
  {
    const before = await gateSnapshot(owner);
    const sessions = [];
    for (let i = 0; i < 3; i += 1) {
      sessions.push(await owner.create({ filePath: fixture("upload_thumb.png"), fileName: `neg_${i}.png` }));
    }
    // The holder must be created from the LARGE file, because a session's declared total comes from the file
    // it was created with: creating it from the 26 KB PNG and then sending megabytes is refused with 413
    // before anything reaches the gate, which is why the first version of this control saw an idle gate.
    const holderSession = await owner.create({ filePath: fixture("upload_4mb.mp4"), fileName: "neg_holder.mp4" });
    const holderTotal = holderSession.total_bytes ?? null;
    const holder = pacedAppend({ cookie, upload_id: holderSession.upload_id, filePath: fixture("upload_4mb.mp4"), offset: 0, length: 2 * 1024 * 1024, pieceBytes: 64 * 1024, paceMs: 60 });
    await sleep(400); // let the holder take the only permit
    const waiters = sessions.slice(1).map((session) => plainAppend({ cookie, upload_id: session.upload_id, filePath: fixture("upload_thumb.png"), offset: 0, length: 16384, declaredTotal: 16384 }));
    // Sample AFTER the waiters have had time to arrive. Sampling immediately measured the moment before the
    // requests reached the server, which reported an idle queue and said nothing about the bound.
    await sleep(400);
    const midFlight = await gateSnapshot(owner);
    const results = await Promise.all([holder, ...waiters]);
    const after = await gateSnapshot(owner);
    const deltas = counterDeltas(before, after);

    negativeControl = {
      mid_flight: { active: midFlight?.active, queued: midFlight?.queued },
      statuses: results.map((row) => row.status),
      holder_declared_total: holderTotal,
      deltas
    };
    details.negative_control = negativeControl;

    add("three_requests_within_the_bound_all_succeed_and_none_is_refused",
      results.every((row) => row.status === 200) && deltas.refused === 0 && midFlight?.active === 1 && midFlight?.queued === 2,
      `with one slot and a waiting room of two, the observed state mid-flight was ${midFlight?.active} active / ${midFlight?.queued} waiting, all ${results.length} requests succeeded (statuses ${results.map((row) => row.status).join(",")}) and nothing was refused: this is the control that makes the refusal below attributable to the bound rather than to a broken host`,
      { negative_control: negativeControl });
  }

  // -------------------------------------------------------------------------------------------
  // 2b. POSITIVE: a fourth request is refused; a cancelled waiter frees its place
  // -------------------------------------------------------------------------------------------
  {
    const before = await gateSnapshot(owner);
    const sessions = [];
    for (let i = 0; i < 4; i += 1) {
      sessions.push(await owner.create({ filePath: fixture("upload_thumb.png"), fileName: `pos_${i}.png` }));
    }
    // Holder session from the large file (see the note in the negative control): 4 MB at 100 ms per 64 KB
    // piece holds the single permit for roughly six seconds, which is long enough for the waiters and the
    // refusal to happen while it is still in flight.
    const holderSession = await owner.create({ filePath: fixture("upload_4mb.mp4"), fileName: "pos_holder.mp4" });
    const holderPromise = pacedAppend({ cookie, upload_id: holderSession.upload_id, filePath: fixture("upload_4mb.mp4"), offset: 0, length: 4 * 1024 * 1024, pieceBytes: 64 * 1024, paceMs: 100 });
    await sleep(500); // holder owns the only permit

    const waiterA = plainAppend({ cookie, upload_id: sessions[1].upload_id, filePath: fixture("upload_thumb.png"), offset: 0, length: 16384, declaredTotal: 16384 });
    await sleep(150);
    const waiterB = plainAppend({ cookie, upload_id: sessions[2].upload_id, filePath: fixture("upload_thumb.png"), offset: 0, length: 16384, declaredTotal: 16384 });
    await sleep(150);
    const full = await gateSnapshot(owner);

    // The fourth request must be refused, not queued without bound.
    const refused = await plainAppend({ cookie, upload_id: sessions[3].upload_id, filePath: fixture("upload_thumb.png"), offset: 0, length: 16384, declaredTotal: 16384 });

    add("a_full_waiting_room_refuses_the_next_transfer_with_a_code",
      refused.status === 429 && refused.json?.code === "UPLOAD_QUEUE_FULL" && refused.json?.details?.gate?.max_queue === 2 && refused.json?.details?.gate?.queued === 2,
      `with 1 active and ${full?.queued} waiting against a waiting room of ${full?.max_queue}, the next transfer was refused with HTTP ${refused.status} and code ${refused.json?.code} (message: "${String(refused.json?.error ?? "").slice(0, 90)}") - a refusal the client can act on, and it carries the gate state that caused it (queued ${refused.json?.details?.gate?.queued}/${refused.json?.details?.gate?.max_queue})`,
      { refused_status: refused.status, refused_code: refused.json?.code ?? null, gate: refused.json?.details?.gate ?? null });

    // Cancel the FIRST waiter while it waits. Its place must be released, and its permit must not be
    // silently consumed when the holder finishes.
    const cancelled = await owner.cancel({ upload_id: sessions[1].upload_id });
    const cancelResponse = await waiterA;
    const afterCancel = await gateSnapshot(owner);

    add("cancelling_a_waiting_transfer_releases_its_place",
      cancelResponse.status !== 200 && String(cancelResponse.json?.code ?? "").includes("CANCELLED") && afterCancel?.queued === (full?.queued ?? 0) - 1,
      `the waiting transfer was cancelled (DELETE returned state "${cancelled?.state}"); its in-flight request ended with HTTP ${cancelResponse.status} / ${cancelResponse.json?.code}, and the waiting count dropped from ${full?.queued} to ${afterCancel?.queued}`,
      { cancel_response: { status: cancelResponse.status, code: cancelResponse.json?.code ?? null, error: cancelResponse.json?.error ?? null }, queued_after: afterCancel?.queued });

    // Let the holder finish: the REMAINING waiter must still be admitted (the cancelled one must not
    // have consumed the permit), and the holder must complete normally.
    const holderResult = await holderPromise;
    const waiterBResult = await waiterB;
    const settled = await gateSnapshot(owner);
    const deltas = counterDeltas(before, settled);
    details.queue_boundary = { full, after_cancel: afterCancel, settled, deltas };

    add("the_remaining_waiter_is_admitted_and_the_holder_completes",
      holderResult.status === 200 && waiterBResult.status === 200 && settled?.active === 0 && settled?.queued === 0,
      `after the holder finished (HTTP ${holderResult.status}) the remaining waiter was admitted and completed (HTTP ${waiterBResult.status}); the gate is back to ${settled?.active} active / ${settled?.queued} waiting`,
      { holder_status: holderResult.status, waiter_status: waiterBResult.status });

    add("the_gate_accounts_for_the_cancelled_waiter_it_did_not_admit",
      deltas.cancelled_while_waiting === 1 && deltas.refused === 1 && deltas.waited === 2 && deltas.started === 2,
      `over this phase the gate recorded ${deltas.accepted} accepted, ${deltas.waited} waiting, ${deltas.started} started, ${deltas.refused} refused, ${deltas.cancelled_while_waiting} cancelled while waiting. Those numbers are the semantics in one line: TWO requests queued, only ONE of them ever started (the cancelled one never consumed a permit), and the refused request was neither started nor made to wait`,
      { deltas });

    // No permit leaked: a fresh transfer must start immediately rather than wait.
    const fresh = await owner.create({ filePath: fixture("upload_thumb.png"), fileName: "after_release.png" });
    const startedAt = Date.now();
    const freshResult = await plainAppend({ cookie, upload_id: fresh.upload_id, filePath: fixture("upload_thumb.png"), offset: 0, length: 16384, declaredTotal: 16384 });
    const freshMs = Date.now() - startedAt;
    const finalGate = await gateSnapshot(owner);
    add("no_transfer_permit_was_leaked",
      freshResult.status === 200 && finalGate?.active === 0 && finalGate?.available === finalGate?.concurrency && freshMs < 3000,
      `a fresh transfer started immediately (${freshMs} ms, HTTP ${freshResult.status}) and the gate reports ${finalGate?.active} active with ${finalGate?.available}/${finalGate?.concurrency} permits available: the releases added up, so no request holds a permit it should have returned`,
      { fresh_ms: freshMs, gate: finalGate });
  }

  // -------------------------------------------------------------------------------------------
  // 2c. The permit is released on the FAILURE path too
  // -------------------------------------------------------------------------------------------
  {
    const before = await gateSnapshot(owner);
    const session = await owner.create({ filePath: fixture("upload_thumb.png"), fileName: "failure_release.png" });
    // A wrong offset is refused by the store AFTER the permit was taken, which is precisely the path where
    // a missed release would leak a slot.
    const mismatched = await plainAppend({ cookie, upload_id: session.upload_id, filePath: fixture("upload_thumb.png"), offset: 4096, length: 16384, declaredTotal: 65536 });
    const after = await gateSnapshot(owner);
    const deltas = counterDeltas(before, after);
    const freshOk = await plainAppend({ cookie, upload_id: session.upload_id, filePath: fixture("upload_thumb.png"), offset: 0, length: 16384, declaredTotal: 65536 });

    add("the_permit_is_released_when_the_transfer_fails",
      mismatched.status === 409 && after?.active === 0 && after?.available === after?.concurrency && freshOk.status === 200,
      `an append with a mismatched offset was refused (HTTP ${mismatched.status} / ${mismatched.json?.code}) and the permit came back (${after?.active} active, ${after?.available}/${after?.concurrency} available); the very next append on the same session succeeded (HTTP ${freshOk.status}), which it could not do if the failed request had kept the only slot`,
      { deltas, gate: after, retry_status: freshOk.status });
  }

  // -------------------------------------------------------------------------------------------
  // 3. Identity: how many identities can this plugin's auth actually express?
  // -------------------------------------------------------------------------------------------
  {
    // Two INDEPENDENT logins (separate sessions, separate cookies), then read back the identity each one
    // authenticates as, from the server's own response.
    const first = new UploadClient({ baseUrl });
    await first.login(PASSWORD);
    const second = new UploadClient({ baseUrl });
    await second.login(PASSWORD);
    const firstList = await first.list();
    const secondList = await second.list();
    const firstIdentity = firstList?.owner_actor_id ?? null;
    const secondIdentity = secondList?.owner_actor_id ?? null;

    // Corroborate from the repository: the owner recorded on each session row.
    const db = new DatabaseSync(path.join(strictRepo, "metadata", "video-assets.sqlite"), { readOnly: true });
    let ownerIds = [];
    try {
      ownerIds = db.prepare("SELECT DISTINCT owner_actor_id FROM upload_sessions").all().map((row) => row.owner_actor_id);
    } finally {
      db.close();
    }
    details.identity = { first_login: firstIdentity, second_login: secondIdentity, distinct_owners_recorded: ownerIds };

    add("two_independent_logins_authenticate_as_the_same_identity",
      Boolean(firstIdentity) && firstIdentity === secondIdentity && ownerIds.length === 1,
      `two separate logins produced the same authenticated identity "${firstIdentity}" (read back from the server's own GET /upload response), and every session row in the repository records exactly one distinct owner (${ownerIds.join(", ")}): this plugin's auth exposes a SINGLE identity, so a second identity can not be authenticated through it`,
      { identity: details.identity });

    // Static evidence for the same claim, read from the source rather than asserted by the test author.
    const securitySource = await fs.promises.readFile(path.join(SRC, "security.js"), "utf8");
    const constantMatch = securitySource.match(/const ADMIN_ACTOR_ID = "([^"]+)"/);
    const createSessionAssignsConstant = /createSession\([^)]*\)\s*{[\s\S]{0,400}?actor_id:\s*ADMIN_ACTOR_ID/.test(securitySource);
    details.identity_source = { constant: constantMatch?.[1] ?? null, create_session_assigns_the_constant: createSessionAssignsConstant };
    add("the_single_identity_is_visible_in_the_source_not_just_observed",
      createSessionAssignsConstant && constantMatch?.[1] === firstIdentity,
      `security.js declares a single admin identity (ADMIN_ACTOR_ID = "${constantMatch?.[1]}") and assigns it to every session created by createSession(); the identity observed over HTTP matches that constant, so the single-identity behaviour is structural, not a configuration accident`,
      { identity_source: details.identity_source });

    // The 403 path itself, exercised for all six actions with two DISTINCT actor records at the store
    // level. LABELLED HONESTLY: this is a mechanism check, NOT identity evidence - the actor objects are
    // constructed by the test, which is exactly what the auth layer would have supplied, and no
    // second-identity credential path exists to drive it end to end.
    const { VideoAssetService } = await import(pathToFileUrl(path.join(SRC, "service.js")));
    const { UploadStore } = await import(pathToFileUrl(path.join(SRC, "upload-store.js")));
    const isolationRepo = path.join(runDir, "repo-isolation");
    await fs.promises.rm(isolationRepo, { recursive: true, force: true });
    await fs.promises.mkdir(isolationRepo, { recursive: true });
    const service = new VideoAssetService({ pluginConfig: { repositoryRoot: isolationRepo }, logger: { info() {}, warn() {}, error() {}, debug() {} } });
    service.init();
    let matrix = null;
    try {
      const store = new UploadStore({ db: service.db, root: service.root, policy: service.uploadPolicy, service });
      const alice = { actor_id: "human:isolation-alice", actor_type: "human" };
      const bob = { actor_id: "human:isolation-bob", actor_type: "human" };
      const session = await store.createSession({ actor: alice, file_name: "owned_by_alice.png", declared_mime: null, total_bytes: 32768 });

      const deny = async (fn) => {
        try { await fn(); return { refused: false }; } catch (error) { return { refused: true, code: error?.code ?? null, status: error?.status ?? null }; }
      };
      matrix = {
        status: await deny(() => store.status({ upload_id: session.upload_id, actor: bob })),
        append: await deny(() => store.appendChunk({ upload_id: session.upload_id, actor: bob, offset: 0, chunk: Buffer.alloc(64) })),
        complete: await deny(() => store.complete({ upload_id: session.upload_id, actor: bob })),
        cancel: await deny(() => store.cancel({ upload_id: session.upload_id, actor: bob })),
        list: (() => {
          const seen = store.listSessions({ owner_actor_id: bob.actor_id }).map((row) => row.upload_id);
          return { refused: !seen.includes(session.upload_id), visible_to_other: seen.length };
        })(),
        owner_can_read_its_own_session: (await store.status({ upload_id: session.upload_id, actor: alice }))?.upload_id === session.upload_id
      };
      details.owner_matrix = matrix;
    } finally {
      service.close?.();
    }

    const deniedActions = ["status", "append", "complete", "cancel"];
    const allDeniedWithNotOwner = deniedActions.every((action) => matrix?.[action]?.refused === true && matrix[action].code === "UPLOAD_NOT_OWNER");
    add("every_action_is_owner_bound_and_returns_upload_not_owner",
      allDeniedWithNotOwner && matrix?.list?.refused === true && matrix?.owner_can_read_its_own_session === true,
      `MECHANISM CHECK, NOT identity evidence: with two distinct actor records supplied at the store layer, status/append/complete/cancel were each refused for the non-owner with UPLOAD_NOT_OWNER (${deniedActions.map((a) => a + ":" + (matrix?.[a]?.code ?? "?")).join(", ")}), the non-owner's session list did not contain the other's upload, and the owner could still read its own session. This proves the owner binding itself; it does NOT prove cross-identity authorization end to end, because no second identity can authenticate (see the two checks above)`,
      { owner_matrix: matrix });
  }

  await host.stop();
  add("gate_host_stopped_and_released_its_port", await waitForFree(port), `the host was stopped and port ${port} is free again`, { port });
  host = null;
}

async function waitForFree(targetPort) {
  for (let i = 0; i < 40; i += 1) {
    if (await portIsFree(targetPort)) return true;
    await sleep(250);
  }
  return false;
}

function pathToFileUrl(p) {
  return new URL(`file:///${p.replace(/\\/g, "/")}`).href;
}

const failed = checks.filter((check) => !check.ok);
const report = {
  report: "REN-06 transfer-gate boundary and identity checks",
  generated_at: new Date().toISOString(),
  port,
  run_dir: runDir,
  fixtures_dir: fixturesDir,
  checks,
  details,
  failed: failed.map((check) => `${check.id}: ${check.detail}`),
  all_pass: failed.length === 0
};
if (outPath) {
  await fs.promises.mkdir(path.dirname(outPath), { recursive: true });
  await fs.promises.writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}
for (const check of checks) console.log(`[${check.ok ? "PASS" : "FAIL"}] ${check.id}: ${check.detail}`);
console.log(`gate/isolation checks: ${checks.length - failed.length}/${checks.length} pass${outPath ? ` -> ${outPath}` : ""}`);
process.exitCode = failed.length === 0 ? 0 : 1;
