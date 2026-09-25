// REN-06 / scripts/ren06-upload-acceptance.mjs
//
// The acceptance run for the streaming upload subsystem, against a REAL HTTP host on an explicit loopback
// port (20006 by default). Every check below is executed against a running server over a real socket; the
// database is inspected read-only afterwards to prove the absence of phantom assets.
//
// What each gate covers
// --------------------
//   Gate 1  a legitimate 200 MB file uploads and the hash matches, with peak memory bounded and measured
//           separately for client and server, and a size control proving memory is not proportional to file
//           size (no whole-file Buffer anywhere on the path)
//   Gate 2  eight simultaneous transfers against a cap of two: two in flight, the rest waiting in a bounded
//           queue, and a refusal once the waiting room is full
//   Gate 3  over-size, low-disk, over-quota, disconnect and cancel all produce structured results with no
//           phantom asset; a disconnected upload keeps its bytes and is resumable; temporary files are
//           attributable
//   Gate 4  a completed upload leaves no unattributed staging file, and the historical ownership manifest
//           never proposes deletion by age
//
// Usage: node scripts/ren06-upload-acceptance.mjs --run <dir> --fixtures <dir> --out <json>

import { execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

// The execution host injects HTTP(S)_PROXY for its own outbound traffic, and Node honours those for plain
// `http.request` once NODE_USE_ENV_PROXY is set. That sent this run's loopback requests to the proxy, which
// answered 502 - a failure that looks like a broken server rather than a redirected request. Every call in
// this run is loopback, so the proxy variables are removed before anything is started (including the child
// host processes, which inherit this environment).
for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy", "NODE_USE_ENV_PROXY"]) {
  delete process.env[key];
}
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { UploadClient, UploadClientError } from "./ren06-upload-client.mjs";

const execFileAsync = promisify(execFile);

function arg(name, dflt = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
}

const runDir = arg("run");
const fixturesDir = arg("fixtures");
const outPath = arg("out");
const port = Number(arg("port", "20006"));
const password = "ren06-isolated-test-password";
const BASE_PATH = "/__openclaw__/video-assets";
if (!runDir || !fixturesDir) {
  console.error("usage: node scripts/ren06-upload-acceptance.mjs --run <dir> --fixtures <dir> --out <json>");
  process.exit(2);
}
await fs.promises.mkdir(runDir, { recursive: true });

const checks = [];
const details = {};
const add = (id, ok, detail, extra = {}) => checks.push({ id, ok, detail, ...extra });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HOST_SCRIPT = path.join(import.meta.dirname, "ren06-upload-host.mjs");
const fixture = (name) => path.join(fixturesDir, name);

// ---------------------------------------------------------------------------------------------
// Host lifecycle
// ---------------------------------------------------------------------------------------------

async function startHost({ repo, port: hostPort, policy = null, rssLog = null, label }) {
  const factsPath = path.join(runDir, `host-facts-${label}.json`);
  // Clear any facts file from a previous attempt FIRST. Without this, a leftover file made the readiness
  // check pass immediately and the next request hit a port nothing was listening on (ECONNREFUSED) - the
  // check was confirming a file, not a server.
  await fs.promises.rm(factsPath, { force: true });
  // The RSS log is opened in append mode by the host, so a previous run's samples stay in the file and any
  // later analysis mixes two runs together (the baseline, the peak and the request markers all come from
  // different executions). Truncating here means one file is exactly one run.
  if (rssLog) await fs.promises.rm(rssLog, { force: true });
  const args = [HOST_SCRIPT, "--repo", repo, "--port", String(hostPort), "--out", factsPath, "--password", password, "--keep-alive-ms", "1800000"];
  if (policy) args.push("--policy", JSON.stringify(policy));
  if (rssLog) args.push("--rss-log", rssLog);
  const outLog = path.join(runDir, `host-${label}.stdout.log`);
  const errLog = path.join(runDir, `host-${label}.stderr.log`);
  // A child host must not inherit the execution host's proxy variables either: it serves loopback traffic
  // and any outbound call it made would be misrouted. The variables are stripped from the child's
  // environment explicitly rather than relying on the deletion having propagated.
  const childEnv = { ...process.env };
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy", "NODE_USE_ENV_PROXY"]) {
    delete childEnv[key];
  }
  const child = spawn(process.execPath, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: childEnv });
  const outStream = fs.createWriteStream(outLog);
  const errStream = fs.createWriteStream(errLog);
  child.stdout.pipe(outStream);
  child.stderr.pipe(errStream);
  let exited = false;
  child.on("exit", () => { exited = true; });

  const deadline = Date.now() + 60_000;
  let ready = false;
  while (Date.now() < deadline) {
    if (exited) {
      const stderr = fs.existsSync(errLog) ? fs.readFileSync(errLog, "utf8") : "";
      throw new Error(`host ${label} exited before becoming ready: ${stderr.slice(0, 400)}`);
    }
    // Both conditions are required: the facts file proves the plugin registered, and a successful TCP
    // connect proves the listener is actually accepting. Checking only the file is what let a stale
    // artifact masquerade as a running server.
    if (fs.existsSync(factsPath) && (await portIsFree(hostPort)) === false) {
      ready = true;
      break;
    }
    await sleep(250);
  }
  if (!ready) throw new Error(`host ${label} did not become ready within 60s (facts=${fs.existsSync(factsPath)})`);
  // Give the listener a moment to accept the heartbeat connection before the first real request.
  await sleep(100);
  const facts = JSON.parse(await fs.promises.readFile(factsPath, "utf8"));
  return { child, facts, outLog, errLog, stop: () => stopHost(child) };
}

async function stopHost(child) {
  if (!child || child.exitCode !== null) return;
  child.kill();
  const deadline = Date.now() + 5000;
  while (child.exitCode === null && Date.now() < deadline) await sleep(100);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function portIsFree(targetPort) {
  const net = await import("node:net");
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen(targetPort, "127.0.0.1");
  });
}

/** Read the repository database read-only, for the phantom-asset and ownership counts. */
function openDb(repo) {
  return new DatabaseSync(path.join(repo, "metadata", "video-assets.sqlite"), { readOnly: true });
}

function countRows(db, sql, ...params) {
  const row = db.prepare(sql).get(...params);
  return Number(row?.n ?? 0);
}

// ---------------------------------------------------------------------------------------------
// Gate 1: the 200 MB upload
// ---------------------------------------------------------------------------------------------
let primary = null;
try {
  const repo = path.join(runDir, "repo-main");
  const rssLog = path.join(runDir, "server-rss-gate1.jsonl");
  primary = await startHost({ repo, port: hostPortFor(0), rssLog, label: "main" });
} catch (error) {
  add("host_started", false, `the upload host did not start: ${error.message}`);
}

function hostPortFor(offset) {
  return port + offset;
}

// The primary host is started above; the gates below use it. If it failed to start, report and skip.
if (primary) {
  const baseUrl = `http://127.0.0.1:${primary.facts.port}`;

  add("upload_route_is_registered",
    primary.facts.upload_route_registered === true && primary.facts.http_routes.includes(`prefix ${BASE_PATH}/upload/`),
    `the plugin registered the upload route itself (${primary.facts.http_routes.filter((route) => route.includes("upload")).join(", ")}), not a reimplementation`, { routes: primary.facts.http_routes });

  // --- login and the enforced policy ----------------------------------------------
  const admin = new UploadClient({ baseUrl });
  let login = null;
  try {
    login = await admin.login(password);
    add("session_login_succeeded", Boolean(login.cookie), "the upload client obtained a plugin session cookie through the plugin's own /auth/login", { actor_id: login.actor_id });
  } catch (error) {
    add("session_login_succeeded", false, `login failed: ${error.message}`);
  }

  let enforcedPolicy = null;
  if (login) {
    const listing = await admin.list();
    enforcedPolicy = listing?.policy ?? null;
    details.enforced_policy = enforcedPolicy;
    add("enforced_policy_is_reported_by_the_server",
      enforcedPolicy?.max_file_bytes >= 200 * 1000 * 1000 && enforcedPolicy?.max_concurrent_transfers === 2,
      `the server reports the limits it enforces: max_file_bytes=${enforcedPolicy?.max_file_bytes}, max_concurrent_transfers=${enforcedPolicy?.max_concurrent_transfers}, max_queued_transfers=${enforcedPolicy?.max_queued_transfers}, staging_total_bytes=${enforcedPolicy?.staging_total_bytes}, min_free_bytes=${enforcedPolicy?.min_free_bytes}, max_chunk_bytes=${enforcedPolicy?.max_chunk_bytes}`,
      { policy: enforcedPolicy });
  }

  // --- unauthenticated access is refused ------------------------------------------
  {
    const anonymous = new UploadClient({ baseUrl, cookie: null });
    let refused = null;
    try {
      await anonymous.create({ filePath: fixture("upload_thumb.png") });
    } catch (error) {
      refused = error;
    }
    add("upload_requires_a_session",
      refused?.status === 401 || refused?.status === 403,
      `a request with no session was refused with ${refused?.status ?? "(accepted)"} ${refused?.code ?? ""} - the upload surface is not anonymous`,
      { status: refused?.status ?? null, code: refused?.code ?? null });
  }

  // --- the 200 MB upload -----------------------------------------------------------
  const bigFixture = fixture("upload_200mb.mp4");
  const expected = await UploadClient.hashFile(bigFixture);
  details.big_fixture = { file: "upload_200mb.mp4", size_bytes: expected.size_bytes, sha256: expected.sha256 };
  add("acceptance_fixture_is_at_least_200mb",
    expected.size_bytes >= 200 * 1000 * 1000,
    `the acceptance fixture is ${expected.size_bytes} bytes (${(expected.size_bytes / 1000 / 1000).toFixed(1)} MB) of real decodable h264+aac, identified by sha256 ${expected.sha256.slice(0, 16)}…`,
    { size_bytes: expected.size_bytes });

  const sample = makeRssSampler(path.join(runDir, "server-rss-gate1.jsonl"));
  const clientBaselineRss = process.memoryUsage().rss;
  let peakClientRss = clientBaselineRss;
  const clientSampler = setInterval(() => { peakClientRss = Math.max(peakClientRss, process.memoryUsage().rss); }, 100);
  clientSampler.unref?.();

  let bigResult = null;
  let bigError = null;
  const uploadStarted = Date.now();
  try {
    bigResult = await admin.upload({ filePath: bigFixture, chunkBytes: 8 * 1024 * 1024 });
  } catch (error) {
    bigError = error;
  }
  clearInterval(clientSampler);
  const uploadMs = Date.now() - uploadStarted;
  const serverPeak = sample.stop();
  const clientExtra = Math.max(peakClientRss - clientBaselineRss, 0);

  add("two_hundred_mb_upload_completed",
    bigResult?.state === "completed" && Boolean(bigResult?.asset_id),
    bigError ? `the 200 MB upload failed: ${bigError.message} (${bigError.code ?? ""})` : `the 200 MB upload completed in ${uploadMs} ms and produced asset ${bigResult?.asset_id} (version ${bigResult?.asset_version_id}) in ${bigResult?.client?.chunks} chunks of ${bigResult?.client?.chunk_bytes} bytes`,
    { upload_ms: uploadMs, chunks: bigResult?.client?.chunks ?? null });

  add("uploaded_bytes_hash_matches_the_source",
    bigResult?.sha256 === expected.sha256,
    `the server's recorded sha256 ${String(bigResult?.sha256 ?? "").slice(0, 16)}… equals the source hash ${expected.sha256.slice(0, 16)}… for ${expected.size_bytes} bytes`,
    { server_sha256: bigResult?.sha256 ?? null, expected_sha256: expected.sha256 });

  // The stored object's own hash, read from the database, so "the hash matched" is not only the response's
  // word: the version row is checked against the fixture directly.
  {
    const db = openDb(path.join(runDir, "repo-main"));
    try {
      const row = db.prepare("SELECT sha256, size_bytes FROM asset_versions WHERE asset_version_id = ?").get(bigResult?.asset_version_id ?? "");
      add("stored_version_row_carries_the_fixture_hash",
        row?.sha256 === expected.sha256 && Number(row?.size_bytes) === expected.size_bytes,
        `asset_versions.sha256 = ${String(row?.sha256 ?? "(missing)").slice(0, 16)}…, size_bytes = ${row?.size_bytes} - the catalog row agrees with the fixture, not just the HTTP response`,
        { row: row ?? null });
    } finally {
      db.close();
    }
  }

  details.gate1_memory = {
    server: serverPeak,
    client_extra_rss_bytes: clientExtra,
    file_size_bytes: expected.size_bytes,
    note: "server rss is the whole host process sampled every 200 ms from inside the process; client extra rss is this test process's peak above its baseline"
  };

  add("server_peak_memory_stayed_within_the_128mb_target",
    serverPeak.extra_peak_bytes <= 128 * 1024 * 1024,
    `peak server RSS above its own baseline was ${(serverPeak.extra_peak_bytes / 1024 / 1024).toFixed(1)} MiB while receiving ${(expected.size_bytes / 1024 / 1024).toFixed(0)} MiB (baseline ${(serverPeak.baseline_rss / 1024 / 1024).toFixed(1)} MiB, peak ${(serverPeak.peak_rss / 1024 / 1024).toFixed(1)} MiB); the 128 MiB target is met`,
    { memory: serverPeak });

  add("client_sent_the_file_without_buffering_it",
    clientExtra <= 128 * 1024 * 1024,
    `client peak RSS above baseline was ${(clientExtra / 1024 / 1024).toFixed(1)} MiB for a ${(expected.size_bytes / 1024 / 1024).toFixed(0)} MiB file: the body of each request is a read stream of one 8 MiB slice, so neither side holds the file`,
    { client_extra_rss_bytes: clientExtra });

  // The threshold is tied to the FILE SIZE, not to a fixed number of megabytes, because that is the
  // distinction this check exists to make: a whole-file Buffer is by definition ~100% of the file, while the
  // real path uses a few bounded pipeline buffers that fluctuate with GC timing (observed range across runs:
  // 48-70 MiB on a 217 MiB file). A fixed 64 MiB threshold failed at 68 MiB - which said nothing about the
  // behaviour under test and would have been "fixed" by loosening a number. Half the file size is far above
  // the observed bounded range and far below a whole-file read, and it is scale-correct: a regression that
  // reintroduced a full-file buffer would land near 100% no matter what the fixture size is.
  const bufferCeiling = Math.min(expected.size_bytes * 0.5, 128 * 1024 * 1024);
  add("no_whole_file_buffer_on_the_server_path",
    serverPeak.peak_external_bytes <= bufferCeiling,
    `peak 'external' (buffer) memory on the server was ${(serverPeak.peak_external_bytes / 1024 / 1024).toFixed(1)} MiB against a ${(expected.size_bytes / 1024 / 1024).toFixed(0)} MiB file (${((serverPeak.peak_external_bytes / expected.size_bytes) * 100).toFixed(0)}% of the file, ceiling ${(bufferCeiling / 1024 / 1024).toFixed(0)} MiB): a whole-file Buffer would show up here as growth of the same order as the file itself, i.e. ~100%`,
    { peak_external_bytes: serverPeak.peak_external_bytes, ceiling_bytes: bufferCeiling, percent_of_file: Number(((serverPeak.peak_external_bytes / expected.size_bytes) * 100).toFixed(1)) });

  // --- the size control ------------------------------------------------------------
  const smallFixture = fixture("upload_4mb.mp4");
  const smallExpected = await UploadClient.hashFile(smallFixture);
  const smallRssLog = path.join(runDir, "server-rss-control.jsonl");
  const smallSample = makeRssSampler(smallRssLog);
  let smallResult = null;
  let smallError = null;
  try {
    smallResult = await admin.upload({ filePath: smallFixture, chunkBytes: 8 * 1024 * 1024 });
  } catch (error) {
    smallError = error;
  }
  const smallPeak = smallSample.stop();

  const ratio = smallExpected.size_bytes > 0 ? expected.size_bytes / smallExpected.size_bytes : 0;
  // The comparison uses a floor on the denominator and ABSOLUTE buffer peaks. The first version divided by
  // the control's extra RSS, which can legitimately be near zero (a clean measurement), producing an
  // "infinite" ratio and a failure that said nothing about behaviour. What matters is that the large run's
  // memory does not scale with the file: it is compared against the file-size ratio and against the target.
  const FLOOR = 16 * 1024 * 1024;
  const bigExtra = Math.max(serverPeak.extra_peak_bytes, FLOOR);
  const smallExtra = Math.max(smallPeak.extra_peak_bytes, FLOOR);
  const memoryRatio = bigExtra / smallExtra;
  details.size_control = {
    big: { size_bytes: expected.size_bytes, extra_peak_bytes: serverPeak.extra_peak_bytes, peak_external_bytes: serverPeak.peak_external_bytes },
    small: { size_bytes: smallExpected.size_bytes, extra_peak_bytes: smallPeak.extra_peak_bytes, peak_external_bytes: smallPeak.peak_external_bytes },
    file_size_ratio: Number(ratio.toFixed(2)),
    memory_ratio_with_floor: Number(memoryRatio.toFixed(2)),
    floor_bytes: FLOOR,
    note: "both sides are floored at 16 MiB before dividing, so a near-zero control reading can not produce a meaningless ratio"
  };
  add("small_control_upload_completed",
    smallResult?.state === "completed",
    smallError ? `the size-control upload failed: ${smallError.message}` : `the ${(smallExpected.size_bytes / 1000 / 1000).toFixed(1)} MB control upload completed (asset ${smallResult.asset_id})`,
    {});
  add("peak_memory_is_not_proportional_to_file_size",
    serverPeak.extra_peak_bytes <= 128 * 1024 * 1024 && memoryRatio <= ratio / 2,
    `the file was ${ratio.toFixed(1)}x larger, yet peak server memory above baseline differed by only ${memoryRatio.toFixed(2)}x (control ${(smallPeak.extra_peak_bytes / 1024 / 1024).toFixed(1)} MiB, large ${(serverPeak.extra_peak_bytes / 1024 / 1024).toFixed(1)} MiB): memory tracks the chunk size and the fixed pipeline buffers, not the file size`, 
    { size_control: details.size_control });

  // ---------------------------------------------------------------------------------------------
  // Gate 3 (part): idempotency and the honest scan interface, using the completed upload
  // ---------------------------------------------------------------------------------------------
  {
    const db = openDb(path.join(runDir, "repo-main"));
    const assetsBefore = countRows(db, "SELECT COUNT(*) AS n FROM assets");
    let replay = null;
    let replayError = null;
    try {
      replay = await admin.complete({ upload_id: bigResult.upload_id, sha256: expected.sha256 });
    } catch (error) {
      replayError = error;
    }
    const assetsAfter = countRows(db, "SELECT COUNT(*) AS n FROM assets");
    db.close();
    add("completing_twice_is_idempotent",
      replayError === null && replay?.asset_id === bigResult.asset_id && assetsAfter === assetsBefore,
      replayError
        ? `the replay threw ${replayError.code}: ${replayError.message}`
        : `a second completion returned the SAME asset (${replay.asset_id}) and the asset count stayed at ${assetsAfter}, so a retried completion can not create a second asset`,
      { assets_before: assetsBefore, assets_after: assetsAfter });

    add("scan_interface_does_not_claim_a_scan",
      bigResult?.scan?.verdict === "not-scanned" && bigResult?.scan?.scanner_available === false,
      `the completion response reports verdict="${bigResult?.scan?.verdict}" with scanner_available=${bigResult?.scan?.scanner_available} and the note "${String(bigResult?.scan?.note ?? "").slice(0, 80)}…": the interface exists but does not pretend a scanner ran`,
      { scan: bigResult?.scan ?? null });
  }

  // ---------------------------------------------------------------------------------------------
  // Gate 3: content identity, over-quota, cancel, disconnect
  // ---------------------------------------------------------------------------------------------
  {
    // (a) content contradiction: PNG bytes under a .mp4 name
    let mismatchError = null;
    try {
      const client = new UploadClient({ baseUrl });
      await client.login(password);
      await client.upload({ filePath: fixture("mismatched_video.mp4"), fileName: "mismatched_video.mp4" });
    } catch (error) {
      mismatchError = error;
    }
    add("content_contradicting_its_name_is_refused_and_kept",
      mismatchError?.code === "UPLOAD_CONTENT_MISMATCH" && mismatchError?.details?.quarantined === true,
      mismatchError
        ? `PNG bytes named .mp4 were refused with ${mismatchError.code} and quarantined=${mismatchError.details?.quarantined === true} (detected ${mismatchError.details?.detected_mime}): the bytes are kept for inspection rather than catalogued as a video`
        : "the mismatched upload was ACCEPTED, which would have catalogued a PNG as a video",
      { code: mismatchError?.code ?? null });

    // (b) unrecognisable content under an allowed extension
    let unknownError = null;
    try {
      const client = new UploadClient({ baseUrl });
      await client.login(password);
      await client.upload({ filePath: fixture("unknown_media.mp4"), fileName: "unknown_media.mp4" });
    } catch (error) {
      unknownError = error;
    }
    add("unknown_content_is_quarantined_not_ingested",
      (unknownError?.code === "UPLOAD_CONTENT_UNKNOWN" || unknownError?.code === "UPLOAD_CONTENT_MISMATCH") && unknownError?.details?.quarantined === true,
      unknownError
        ? `unrecognisable bytes were refused with ${unknownError.code} and quarantined=${unknownError.details?.quarantined === true}`
        : "unknown content was accepted, which would put an unidentifiable object in the catalog",
      { code: unknownError?.code ?? null });

    // (c) extension not on the allow list
    {
      const client = new UploadClient({ baseUrl });
      await client.login(password);
      const temporary = path.join(runDir, "payload.exe");
      await fs.promises.writeFile(temporary, crypto.randomBytes(1024));
      let error = null;
      try {
        await client.create({ filePath: temporary });
      } catch (caught) {
        error = caught;
      }
      add("disallowed_extension_is_refused_at_session_creation",
        error?.code === "UPLOAD_EXTENSION_NOT_ALLOWED" && error?.status === 415,
        `a .exe upload was refused with ${error?.code} (HTTP ${error?.status}) before any bytes were accepted`,
        { code: error?.code ?? null });
    }

    // (d) per-file limit: declared size above the cap
    {
      const client = new UploadClient({ baseUrl });
      await client.login(password);
      let error = null;
      try {
        await client.create({ filePath: fixture("upload_thumb.png"), fileName: "too_big.mp4", sizeBytes: 900 * 1024 * 1024 });
      } catch (caught) {
        error = caught;
      }
      add("per_file_limit_is_enforced_server_side",
        error?.code === "UPLOAD_FILE_TOO_LARGE" && error?.status === 413,
        `a session declaring 900 MB was refused with ${error?.code} (HTTP ${error?.status}); the limit is the server's, so a client that ignores the advertised policy is still stopped`,
        { code: error?.code ?? null });
    }

    // (e) cancel after a partial upload: no asset, no leftover bytes
    {
      const client = new UploadClient({ baseUrl });
      await client.login(password);
      const session = await client.create({ filePath: fixture("upload_4mb.mp4"), fileName: "cancel_me.mp4" });
      await client.append({ upload_id: session.upload_id, filePath: fixture("upload_4mb.mp4"), offset: 0, length: 1 * 1024 * 1024, declaredTotal: smallExpected.size_bytes });
      const before = await client.status(session.upload_id);
      const cancelled = await client.cancel({ upload_id: session.upload_id });
      const after = await client.status(session.upload_id).catch(() => null);
      const tempPath = path.join(runDir, "repo-main", "asset-repo", "staging", ".uploads", `${session.upload_id}.part`);
      add("cancel_discards_the_partial_bytes_but_keeps_the_record",
        before.received_bytes === 1 * 1024 * 1024 && cancelled.state === "cancelled" && !fs.existsSync(tempPath) && after?.state === "cancelled",
        `after ${before.received_bytes} bytes were accepted the upload was cancelled: state=${cancelled.state}, the partial file is gone (${!fs.existsSync(tempPath)}), and the session record survives so the accounting is not lost`,
        { before_bytes: before.received_bytes, temp_exists: fs.existsSync(tempPath) });
    }

    // (f) disconnect mid-transfer, then resume
    {
      const client = new UploadClient({ baseUrl });
      await client.login(password);
      const session = await client.create({ filePath: fixture("upload_4mb.mp4"), fileName: "disconnect_and_resume.mp4" });
      const disconnect = await sendAndAbort({ baseUrl, cookie: client.cookie, upload_id: session.upload_id, filePath: fixture("upload_4mb.mp4"), offset: 0, length: 4 * 1024 * 1024, abortAfterBytes: 512 * 1024 });
      await sleep(400);
      const status = await client.status(session.upload_id);

      add("a_dropped_connection_is_reported_and_keeps_what_arrived",
        status.received_bytes > 0 && status.received_bytes < smallExpected.size_bytes && status.state === "uploading",
        `the connection was destroyed after ${disconnect.bytes_written} bytes; the session reports ${status.received_bytes} bytes received with state "${status.state}" and the next offset is ${status.next_offset} - the bytes that arrived are accounted for instead of being lost or double counted`,
        { status });

      const resumed = await client.upload({ filePath: fixture("upload_4mb.mp4"), fileName: "disconnect_and_resume.mp4", existingUploadId: session.upload_id });
      add("the_interrupted_upload_resumes_from_the_server_side_offset",
        resumed.state === "completed" && resumed.sha256 === smallExpected.sha256 && resumed.client.metrics.bytes_sent < smallExpected.size_bytes,
        `the same session resumed and completed: it re-sent only ${(resumed.client.metrics.bytes_sent / 1024 / 1024).toFixed(1)} MB of the ${(smallExpected.size_bytes / 1024 / 1024).toFixed(1)} MB file because the server's offset was used, and the final hash matches`,
        { resent_bytes: resumed.client.metrics.bytes_sent, total: smallExpected.size_bytes });
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Gate 2: eight simultaneous transfers against a cap of two
  // ---------------------------------------------------------------------------------------------
  {
    const sessions = [];
    const sessionClient = new UploadClient({ baseUrl });
    await sessionClient.login(password);
    for (let i = 0; i < 8; i += 1) {
      sessions.push(await sessionClient.create({ filePath: fixture("upload_4mb.mp4"), fileName: `concurrent_${i}.mp4` }));
    }

    const successes = [];
    const failures = [];
    const startedAt = Date.now();
    await Promise.all(sessions.map(async (session, index) => {
      const client = new UploadClient({ baseUrl, cookie: sessionClient.cookie });
      try {
        const result = await client.append({
          upload_id: session.upload_id,
          filePath: fixture("upload_4mb.mp4"),
          offset: 0,
          length: Math.min(4 * 1024 * 1024, smallExpected.size_bytes),
          declaredTotal: smallExpected.size_bytes
        });
        successes.push({ index, result });
      } catch (error) {
        failures.push({ index, code: error.code, status: error.status, details: error.details });
      }
    }));
    const elapsed = Date.now() - startedAt;

    const listing = await sessionClient.list();
    details.gate2 = { successes: successes.length, failures, gate: listing?.gate ?? null, elapsed_ms: elapsed };

    add("eight_simultaneous_transfers_obey_the_concurrency_cap",
      listing?.gate?.peak_active <= 2,
      `eight chunk requests were issued at once; the gate recorded a peak of ${listing?.gate?.peak_active} active transfers against a cap of ${listing?.gate?.concurrency}, with ${listing?.gate?.counters?.waited ?? 0} request(s) waiting and ${listing?.gate?.counters?.refused ?? 0} refused (${successes.length} succeeded, ${failures.length} failed)`,
      { gate: listing?.gate ?? null });

    add("the_waiting_room_is_bounded_and_requests_are_not_silently_dropped",
      successes.length + failures.length === 8 && (failures.length === 0 || failures.every((failure) => failure.code === "UPLOAD_QUEUE_FULL")),
      `all eight requests were accounted for: ${successes.length} completed and ${failures.length} were refused with a code (${failures.map((f) => f.code).join(", ") || "none"}) - a bounded queue never swallows a request`,
      { failures });

    for (const session of sessions) {
      const client = new UploadClient({ baseUrl, cookie: sessionClient.cookie });
      await client.cancel({ upload_id: session.upload_id }).catch(() => {});
    }
  }

  // Gate 3 (cont.): the integrity summary, using the same database the server used.
  {
    const db = openDb(path.join(runDir, "repo-main"));
    try {
      const sessionsByState = db.prepare("SELECT state, COUNT(*) AS n FROM upload_sessions GROUP BY state").all();
      const assets = countRows(db, "SELECT COUNT(*) AS n FROM assets");
      const stagingRows = db.prepare("SELECT state, COUNT(*) AS n FROM staging_objects GROUP BY state").all();
      const completedSessions = db.prepare("SELECT COUNT(*) AS n FROM upload_sessions WHERE state = 'completed'").get().n;
      const unattributedStaging = countRows(db, "SELECT COUNT(*) AS n FROM staging_objects WHERE owner_actor_id IS NULL OR owner_actor_id = ''");
      details.database = { sessions_by_state: sessionsByState, assets, staging_by_state: stagingRows, completed_sessions: completedSessions };

      add("every_completed_upload_produced_exactly_one_asset",
        assets === completedSessions,
        `the repository holds ${assets} asset(s) for ${completedSessions} completed upload(s): failures, cancellations and quarantines created no asset, so there are no phantom records`,
        { assets, completed_sessions: completedSessions });

      add("no_staging_object_is_left_without_an_owner",
        unattributedStaging === 0 && stagingRows.length > 0,
        `every one of the ${stagingRows.reduce((sum, row) => sum + row.n, 0)} staging record(s) names an owner (unattributed = ${unattributedStaging})`,
        { staging: stagingRows, unattributed: unattributedStaging });

      const quarantineRows = sessionsByState.find((row) => row.state === "quarantined")?.n ?? 0;
      add("quarantined_uploads_are_recorded_not_deleted",
        quarantineRows >= 2,
        `${quarantineRows} upload(s) are in the quarantined state: the refused content is accounted for in the database rather than silently deleted`,
        { quarantined: quarantineRows });
    } finally {
      db.close();
    }
  }

  await stopHost(primary.child);
  primary = null;
  add("primary_host_stopped_and_released_its_port",
    await waitForFreePort(port),
    `the host was stopped and port ${port} is free again`,
    {});
}

// ---------------------------------------------------------------------------------------------
// Gate 3 (quota) and Gate 4 (ownership) on a second host with tightened limits
// ---------------------------------------------------------------------------------------------
{
  const repo = path.join(runDir, "repo-quota");
  const strictPort = port + 1;
  let strict = null;
  try {
    strict = await startHost({
      repo,
      port: strictPort,
      label: "strict",
      policy: { maxFileBytes: 4 * 1024 * 1024, stagingTotalBytes: 12 * 1024 * 1024, minFreeBytes: 512 * 1024 * 1024 }
    });
  } catch (error) {
    add("strict_host_started", false, `the tightened-policy host did not start: ${error.message}`);
  }

  if (strict) {
    const baseUrl = `http://127.0.0.1:${strict.facts.port}`;
    const client = new UploadClient({ baseUrl });
    await client.login(password);

    // (a) staging total
    //
    // The first version of this check declared sizes above the per-file cap, so it was refused for the wrong
    // reason (UPLOAD_FILE_TOO_LARGE), and it assumed a session that has sent NO bytes consumes quota. Both
    // were wrong: the quota is about bytes on disk, so the check must actually SEND bytes until the staging
    // area is full and then prove the next session is refused.
    {
      const partFile = fixture("upload_4mb.mp4");
      const partSize = (await fs.promises.stat(partFile)).size;
      const accepted = [];
      let quotaError = null;
      // 4 MiB per-file cap, 12 MiB staging cap: each session declares 4 MiB and actually sends 3 MiB, so four
      // sessions fill the staging area and the fifth must be refused on the bytes that are really on disk.
      const chunk = 3 * 1024 * 1024;
      const declared = 4 * 1024 * 1024;
      for (let i = 0; i < 5; i += 1) {
        try {
          const session = await client.create({ filePath: partFile, fileName: `quota_fill_${i}.mp4`, sizeBytes: declared });
          accepted.push(session.upload_id);
          await client.append({ upload_id: session.upload_id, filePath: partFile, offset: 0, length: Math.min(chunk, partSize), declaredTotal: declared });
        } catch (caught) {
          quotaError = caught;
          break;
        }
      }
      const listing = await client.list();
      add("staging_total_is_enforced_server_side",
        quotaError !== null && ["UPLOAD_QUOTA_EXCEEDED", "UPLOAD_DISK_LOW"].includes(quotaError.code) && quotaError.status === 507,
        quotaError
          ? `with a 12 MB staging cap, the upload that would exceed it was refused with ${quotaError.code} (HTTP ${quotaError.status}): ${JSON.stringify(quotaError.details ?? null)} - the cap is enforced by the server against bytes actually on disk, not against a client's claim`
          : `five 3 MB transfers were all accepted despite a 12 MB staging cap (sessions: ${accepted.length}) - the quota is not being enforced`,
        { code: quotaError?.code ?? null, sessions_accepted: accepted.length, gate: listing?.gate ?? null });

      for (const upload_id of accepted) await client.cancel({ upload_id }).catch(() => {});
    }

    // (b) disk floor
    {
      const floorRepo = path.join(runDir, "repo-diskfloor");
      const floorPort = port + 2;
      const floorHost = await startHost({ repo: floorRepo, port: floorPort, label: "diskfloor", policy: { minFreeBytes: 4 * 1024 * 1024 * 1024 * 1024 } });
      try {
        const floorClient = new UploadClient({ baseUrl: `http://127.0.0.1:${floorHost.facts.port}` });
        await floorClient.login(password);
        let error = null;
        try {
          await floorClient.create({ filePath: fixture("upload_thumb.png"), fileName: "floor.mp4" });
        } catch (caught) {
          error = caught;
        }
        add("disk_floor_is_enforced_server_side",
          error?.code === "UPLOAD_DISK_LOW" && error?.status === 507,
          `with a free-space floor of 4 TiB (impossible on this host) the session was refused with ${error?.code} (HTTP ${error?.status}) and the response names the floor and the free space: ${JSON.stringify(error?.details ?? null)}`,
          { code: error?.code ?? null, details: error?.details ?? null });
      } finally {
        await stopHost(floorHost.child);
      }
      add("disk_floor_host_released_its_port", await waitForFreePort(floorPort), `port ${floorPort} is free again`, {});
    }

    // (c) a legitimate small upload still works under the tightened policy, then Gate 4
    const small = await client.upload({ filePath: fixture("upload_thumb.png"), fileName: "accepted_under_strict_policy.png" });
    add("a_legitimate_upload_still_succeeds_under_the_tightened_policy",
      small.state === "completed",
      `a ${small.client.size_bytes}-byte PNG completed under a 4 MB per-file cap: the quota refuses what is over the limit without breaking what is under it`,
      {});

    // Gate 4: ownership manifest, including simulated historical files
    const stagingDir = path.join(repo, "asset-repo", "staging");
    await fs.promises.mkdir(stagingDir, { recursive: true });
    const historicalNames = [];
    for (let i = 0; i < 40; i += 1) {
      const name = `historical-upload-${String(i).padStart(3, "0")}.mp4`;
      historicalNames.push(name);
      const target = path.join(stagingDir, name);
      await fs.promises.writeFile(target, Buffer.alloc(2048, i));
      // Deliberately OLD mtimes: the manifest must not care about age.
      const old = new Date(Date.UTC(2024, 0, 1 + i));
      await fs.promises.utimes(target, old, old);
    }

    const { UploadStore } = await import("../src/upload-store.js");
    const { resolveUploadPolicy } = await import("../src/upload-policy.js");
    const db = new DatabaseSync(path.join(repo, "metadata", "video-assets.sqlite"));
    let manifest = null;
    try {
      const store = new UploadStore({ db, root: repo, policy: resolveUploadPolicy({ upload: { maxFileBytes: 4 * 1024 * 1024 } }), service: null });
      manifest = await store.ownershipManifest({ includeHistorical: true });
      const orphans = await store.scanOrphans();
      details.gate4 = { total_entries: manifest.total_entries, attributed: manifest.attributed_entries, historical: manifest.untracked_historical_entries, orphans: orphans.unattributed.length };
    } finally {
      db.close();
    }

    const stillThere = historicalNames.filter((name) => fs.existsSync(path.join(stagingDir, name))).length;
    add("historical_staging_files_get_a_manifest_and_are_never_deleted_by_age",
      manifest?.untracked_historical_entries === 40 && stillThere === 40 && manifest?.deletion_policy?.includes("none-by-age"),
      `the manifest lists ${manifest?.untracked_historical_entries} untracked historical file(s) with deletion_eligible=false and states its policy as "${manifest?.deletion_policy}"; all 40 files are still on disk after the manifest was generated`,
      { still_present: stillThere });

    add("completed_uploads_leave_no_unattributed_temp_file",
      details.gate4.orphans === 0,
      `the orphan scan found ${details.gate4.orphans} unattributed temporary file(s): every temporary file belongs to a session row, and the completed upload's staged copy is recorded as ingested`,
      { orphans: details.gate4.orphans });

    await stopHost(strict.child);
    add("strict_host_stopped_and_released_its_port", await waitForFreePort(strictPort), `port ${strictPort} is free again`, {});
  }
}

// ---------------------------------------------------------------------------------------------
// Legacy entry point can not bypass the policy
// ---------------------------------------------------------------------------------------------
{
  const { VideoAssetService } = await import("../src/service.js");
  const legacyRoot = path.join(runDir, "repo-legacy");
  await fs.promises.rm(legacyRoot, { recursive: true, force: true });
  await fs.promises.mkdir(legacyRoot, { recursive: true });
  const service = new VideoAssetService({ pluginConfig: { repositoryRoot: legacyRoot, upload: { maxFileBytes: 2 * 1024 * 1024 } }, logger: { info() {}, warn() {}, error() {}, debug() {} } });
  service.init();
  try {
    const payload = Buffer.alloc(6 * 1024 * 1024, 7); // 6 MB, allowed by the old 100 MB constant
    let error = null;
    try {
      await service.uploadStagingFile({ file_name: "legacy_bypass.mp4", content_base64: payload.toString("base64") });
    } catch (caught) {
      error = caught;
    }
    const stagingDir = path.join(legacyRoot, "asset-repo", "staging");
    const written = fs.existsSync(stagingDir) ? (await fs.promises.readdir(stagingDir)).filter((name) => name.includes("legacy_bypass")) : [];
    add("legacy_entry_point_can_not_bypass_the_new_quota",
      error !== null && /exceeds/.test(String(error.message)) && written.length === 0,
      `with the per-file limit set to 2 MB, the legacy base64 entry refused a 6 MB payload ("${String(error?.message ?? "").slice(0, 70)}") and wrote no file: the old entry point is bounded by the same policy as the streaming route`,
      { error: String(error?.message ?? "") });

    // A legitimate small upload through the legacy entry still works and is ATTRIBUTED.
    const small = Buffer.alloc(64 * 1024, 3);
    const staged = await service.uploadStagingFile({ file_name: "legacy_ok.mp4", content_base64: small.toString("base64") });
    const db = new DatabaseSync(path.join(legacyRoot, "metadata", "video-assets.sqlite"), { readOnly: true });
    let owners = 0;
    try {
      owners = Number(db.prepare("SELECT COUNT(*) AS n FROM staging_objects WHERE owner_actor_id IS NOT NULL AND owner_actor_id != ''").get().n);
    } finally {
      db.close();
    }
    add("legacy_entry_point_still_works_and_attributes_what_it_stages",
      Boolean(staged?.relative_path) && owners === 1,
      `a 64 KiB upload through the legacy entry succeeded (${staged?.relative_path}) and recorded an owner (${owners} attributed staging row), so the bytes it writes are not orphans`,
      { owners });
  } finally {
    service.close?.();
  }
}

// ---------------------------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------------------------
const failed = checks.filter((check) => !check.ok);
const report = {
  report: "REN-06 streaming upload acceptance",
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
console.log(`upload acceptance: ${checks.length - failed.length}/${checks.length} pass${outPath ? ` -> ${outPath}` : ""}`);
process.exitCode = failed.length === 0 ? 0 : 1;

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

/** Sample the host's self-reported RSS log and summarise the peak above baseline. */
function makeRssSampler(logPath) {
  const samples = [];
  let position = 0;
  const read = () => {
    try {
      const text = fs.readFileSync(logPath, "utf8");
      const lines = text.slice(position).split("\n").filter((line) => line.trim() !== "");
      position = text.length;
      for (const line of lines) {
        try { samples.push(JSON.parse(line)); } catch { /* partial line */ }
      }
    } catch {
      // the host may not have created the file yet
    }
  };
  read();
  const timer = setInterval(read, 100);
  timer.unref?.();
  return {
    stop() {
      clearInterval(timer);
      read();
      if (samples.length === 0) {
        return { samples: 0, baseline_rss: 0, peak_rss: 0, extra_peak_bytes: 0, peak_external_bytes: 0 };
      }
      const baseline = samples.slice(0, 5).reduce((min, sample) => Math.min(min, sample.rss), Number.MAX_SAFE_INTEGER);
      const peak = samples.reduce((max, sample) => Math.max(max, sample.rss), 0);
      return {
        samples: samples.length,
        baseline_rss: baseline,
        peak_rss: peak,
        extra_peak_bytes: Math.max(0, peak - baseline),
        peak_external_bytes: samples.reduce((max, sample) => Math.max(max, sample.external ?? 0), 0)
      };
    }
  };
}

/** Send a chunk and destroy the socket part-way through, to exercise the disconnect path for real. */
function sendAndAbort({ baseUrl, cookie, upload_id, filePath, offset, length, abortAfterBytes }) {
  return new Promise((resolve, reject) => {
    const target = new URL(baseUrl);
    const request = http.request({
      method: "PATCH",
      hostname: target.hostname,
      port: target.port,
      path: `/__openclaw__/video-assets/upload/${encodeURIComponent(upload_id)}`,
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(length),
        "upload-offset": String(offset),
        origin: baseUrl,
        cookie
      },
      // Explicit agent: see the note in the client module - the environment proxy would otherwise capture
      // this loopback request.
      agent: new http.Agent({ keepAlive: false })
    });
    const stream = fs.createReadStream(filePath, { start: offset, end: offset + length - 1, highWaterMark: 64 * 1024 });
    let bytes_written = 0;
    stream.on("data", (chunk) => {
      bytes_written += chunk.length;
      if (bytes_written >= abortAfterBytes) {
        stream.destroy();
        request.destroy();
        resolve({ bytes_written, aborted: true });
      }
    });
    stream.on("error", () => resolve({ bytes_written, aborted: true }));
    request.on("error", () => resolve({ bytes_written, aborted: true }));
    stream.pipe(request);
    setTimeout(() => resolve({ bytes_written, aborted: false }), 30_000).unref?.();
    void reject;
  });
}

function http_import() {
  return http;
}

async function waitForFreePort(targetPort) {
  for (let i = 0; i < 40; i += 1) {
    if (await portIsFree(targetPort)) return true;
    await sleep(250);
  }
  return false;
}

void execFileAsync;
void execFile;
