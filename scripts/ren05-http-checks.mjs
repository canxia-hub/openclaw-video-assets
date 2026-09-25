// REN-05 / scripts/ren05-http-checks.mjs
//
// HTTP acceptance for the protected media surface, run against the REAL host on a real socket.
//
// Each check records what was sent and what came back, and the byte-level checks compare the
// returned bytes against the local object file, so "the range was correct" is proven by content and
// not by the presence of a 206 status.
//
// Usage: node scripts/ren05-http-checks.mjs --base <origin> --seed <seed.json> --out <json> --password <pw>

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function arg(name, dflt = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
}

// The exec host injects HTTP_PROXY/HTTPS_PROXY pointing at a local proxy, and Node's fetch honours
// them: every loopback request then went to the proxy and came back as a 502 instead of reaching
// this test host. Loopback traffic must never be proxied, so the proxy variables are dropped here.
// (Same discipline the media adapter applies to its child environment.)
for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) delete process.env[key];
process.env.NO_PROXY = "127.0.0.1,localhost";
process.env.no_proxy = "127.0.0.1,localhost";

const base = arg("base");
const seedPath = arg("seed");
const outPath = arg("out");
const password = arg("password");
const basePath = arg("base-path", "/__openclaw__/video-assets/");
if (!base || !seedPath) {
  console.error("usage: node scripts/ren05-http-checks.mjs --base <origin> --seed <seed.json> --out <json> --password <pw>");
  process.exit(2);
}

const seed = JSON.parse(fs.readFileSync(seedPath, "utf8"));
const checks = [];
const add = (id, ok, detail, extra = {}) => checks.push({ id, ok, detail, ...extra });
const url = (suffix) => `${base}${basePath}${String(suffix).replace(/^\//, "")}`;

const videoAsset = seed.assets.find((a) => a.file === "clip_720p_2s.mp4");
const imageAsset = seed.assets.find((a) => a.file === "still_1024x768.png");
const proxyDerived = seed.derivations.find((d) => d.derivative_type === "proxy" && d.source_file === "clip_720p_2s.mp4");
const thumbDerived = seed.derivations.find((d) => d.derivative_type === "thumbnail" && d.source_file === "clip_720p_2s.mp4");
const audioDerived = seed.derivations.find((d) => d.derivative_type === "audio_proxy");

/** The local object file behind a version, so response bytes can be compared with the source. */
function objectFileFor(versionId) {
  const root = seed.repository_root;
  const row = { id: versionId };
  void row;
  return root;
}

let cookie = null;

async function login() {
  const response = await fetch(url("auth/login"), {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ password })
  });
  const setCookie = response.headers.getSetCookie?.() ?? [];
  const sessionCookie = setCookie.map((c) => c.split(";")[0]).find((c) => c.startsWith("ova_session="));
  const body = await response.text();
  return { status: response.status, cookie: sessionCookie, body: body.slice(0, 300), setCookie };
}

async function request(pathSuffix, { method = "GET", headers = {}, useCookie = true, body = null } = {}) {
  const response = await fetch(url(pathSuffix), {
    method,
    headers: { origin: base, ...(useCookie && cookie ? { cookie } : {}), ...headers },
    body,
    redirect: "manual"
  });
  const buffer = Buffer.from(await response.arrayBuffer());
  return {
    status: response.status,
    headers: Object.fromEntries([...response.headers.entries()].map(([k, v]) => [k, v])),
    setCookie: response.headers.getSetCookie?.() ?? [],
    bytes: buffer,
    bytes_sent: buffer.length
  };
}

// Resolve the local object file for the video version so returned bytes can be verified.
// Declared here because the inline-form checks below already need the object length.
const size = videoAsset.size_bytes;

const videoObjectPath = (() => {
  const sha = videoAsset.sha256;
  return path.join(seed.repository_root, "asset-repo", "objects", "sha256", sha.slice(0, 2), `${sha}.blob`);
})();

try {
  // ---- authentication ------------------------------------------------------------------------
  const unauth = await request(`file/${videoAsset.asset_version_id}`, { useCookie: false });
  add("no_session_is_refused", unauth.status === 401, `GET /file/<version> with no session -> ${unauth.status} (expected 401)`, { status: unauth.status, body: unauth.bytes.toString("utf8").slice(0, 200) });

  const loginResult = await login();
  cookie = loginResult.cookie;
  add("login_mints_session_cookie", loginResult.status === 200 && Boolean(cookie), `POST /auth/login -> ${loginResult.status}; session cookie ${cookie ? "issued" : "MISSING"}`, { status: loginResult.status, cookie_name: cookie?.split("=")[0] ?? null, body: loginResult.body });

  const authed = await request(`file/${videoAsset.asset_version_id}`);
  add("authed_full_download_ok", authed.status === 200 && authed.bytes_sent === videoAsset.size_bytes, `GET /file/<version> with session -> ${authed.status}, ${authed.bytes_sent} B (object ${videoAsset.size_bytes} B)`, { status: authed.status, bytes: authed.bytes_sent, disposition: authed.headers["content-disposition"] ?? null });

  // ---- download vs inline semantics ----------------------------------------------------------
  add("file_route_is_attachment", /attachment/.test(String(authed.headers["content-disposition"] ?? "")), `GET /file/ -> content-disposition: ${authed.headers["content-disposition"] ?? "(none)"}`, { disposition: authed.headers["content-disposition"] ?? null });

  // The playback form is /file/<version>?disposition=inline. A separate /inline/ route was tried and
  // REVERTED: the REN-01 registration contract freezes the HTTP route surface at 8 routes, and this
  // package does not own that contract. The download/inline split is therefore a query parameter on
  // the existing route, which is asserted here - including that the inline form is fully range-capable,
  // because a player URL that can not seek would not be a playback surface.
  const queryInline = await request(`file/${videoAsset.asset_version_id}?disposition=inline`);
  add("file_with_inline_query_is_inline", queryInline.status === 200 && /inline/.test(String(queryInline.headers["content-disposition"] ?? "")), `GET /file/<version>?disposition=inline -> ${queryInline.status}, disposition: ${queryInline.headers["content-disposition"] ?? "(none)"}`, { status: queryInline.status, disposition: queryInline.headers["content-disposition"] ?? null });

  const inlineRange = await request(`file/${videoAsset.asset_version_id}?disposition=inline`, { headers: { range: "bytes=1024-2047" } });
  add("inline_form_is_range_capable",
    inlineRange.status === 206 && inlineRange.headers["content-range"] === `bytes 1024-2047/${size}` && inlineRange.bytes_sent === 1024 && /inline/.test(String(inlineRange.headers["content-disposition"] ?? "")),
    `Range bytes=1024-2047 on the inline form -> ${inlineRange.status}, content-range ${inlineRange.headers["content-range"] ?? "(none)"}, ${inlineRange.bytes_sent} B, disposition ${inlineRange.headers["content-disposition"] ?? "(none)"}`,
    { status: inlineRange.status, content_range: inlineRange.headers["content-range"] ?? null, bytes: inlineRange.bytes_sent });

  // The inline form must not become a way to sidestep the session.
  const inlineNoSession = await request(`file/${videoAsset.asset_version_id}?disposition=inline`, { useCookie: false });
  add("inline_form_without_session_is_refused", inlineNoSession.status === 401, `GET the inline form with no session -> ${inlineNoSession.status}`, { status: inlineNoSession.status });

  // ---- HEAD ----------------------------------------------------------------------------------
  const head = await request(`file/${videoAsset.asset_version_id}`, { method: "HEAD" });
  add("head_returns_headers_without_body",
    head.status === 200 && head.bytes_sent === 0 && Number(head.headers["content-length"]) === videoAsset.size_bytes && head.headers["accept-ranges"] === "bytes",
    `HEAD /file/<version> -> ${head.status}, body ${head.bytes_sent} B, content-length ${head.headers["content-length"]}, accept-ranges ${head.headers["accept-ranges"]}`,
    { status: head.status, body_bytes: head.bytes_sent, content_length: head.headers["content-length"], accept_ranges: head.headers["accept-ranges"] });

  // ---- ranges --------------------------------------------------------------------------------
  const first = await request(`file/${videoAsset.asset_version_id}`, { headers: { range: "bytes=0-1023" } });
  const expectedFirst = fs.readFileSync(videoObjectPath).subarray(0, 1024);
  add("range_0_1023_returns_206_with_content_range",
    first.status === 206 && first.headers["content-range"] === `bytes 0-1023/${size}` && first.bytes_sent === 1024 && first.bytes.equals(expectedFirst),
    `Range bytes=0-1023 -> ${first.status}, content-range ${first.headers["content-range"]}, ${first.bytes_sent} B, bytes match object = ${first.bytes.equals(expectedFirst)}`,
    { status: first.status, content_range: first.headers["content-range"], bytes: first.bytes_sent, bytes_match_object: first.bytes.equals(expectedFirst), accept_ranges: first.headers["accept-ranges"] });

  const mid = Math.floor(size / 2);
  const middle = await request(`file/${videoAsset.asset_version_id}`, { headers: { range: `bytes=${mid}-` } });
  const expectedMiddle = fs.readFileSync(videoObjectPath).subarray(mid);
  add("open_ended_range_returns_tail",
    middle.status === 206 && middle.headers["content-range"] === `bytes ${mid}-${size - 1}/${size}` && middle.bytes_sent === size - mid && middle.bytes.equals(expectedMiddle),
    `Range bytes=${mid}- -> ${middle.status}, content-range ${middle.headers["content-range"]}, ${middle.bytes_sent} B, bytes match = ${middle.bytes.equals(expectedMiddle)}`,
    { status: middle.status, content_range: middle.headers["content-range"], bytes: middle.bytes_sent, bytes_match_object: middle.bytes.equals(expectedMiddle) });

  const suffix = await request(`file/${videoAsset.asset_version_id}`, { headers: { range: "bytes=-512" } });
  const expectedSuffix = fs.readFileSync(videoObjectPath).subarray(size - 512);
  add("suffix_range_returns_last_bytes",
    suffix.status === 206 && suffix.headers["content-range"] === `bytes ${size - 512}-${size - 1}/${size}` && suffix.bytes.equals(expectedSuffix),
    `Range bytes=-512 -> ${suffix.status}, content-range ${suffix.headers["content-range"]}, ${suffix.bytes_sent} B, bytes match = ${suffix.bytes.equals(expectedSuffix)}`,
    { status: suffix.status, content_range: suffix.headers["content-range"], bytes: suffix.bytes_sent, bytes_match_object: suffix.bytes.equals(expectedSuffix) });

  const outOfRange = await request(`file/${videoAsset.asset_version_id}`, { headers: { range: `bytes=${size}-` } });
  add("range_beyond_end_returns_416",
    outOfRange.status === 416 && outOfRange.headers["content-range"] === `bytes */${size}`,
    `Range bytes=${size}- (one past the end) -> ${outOfRange.status}, content-range ${outOfRange.headers["content-range"] ?? "(none)"}`,
    { status: outOfRange.status, content_range: outOfRange.headers["content-range"] ?? null, body: outOfRange.bytes.toString("utf8").slice(0, 160) });

  const headRange = await request(`file/${videoAsset.asset_version_id}`, { method: "HEAD", headers: { range: "bytes=0-1023" } });
  add("head_with_range_returns_206_without_body",
    headRange.status === 206 && headRange.bytes_sent === 0 && headRange.headers["content-range"] === `bytes 0-1023/${size}`,
    `HEAD Range bytes=0-1023 -> ${headRange.status}, body ${headRange.bytes_sent} B, content-range ${headRange.headers["content-range"]}`,
    { status: headRange.status, body_bytes: headRange.bytes_sent, content_range: headRange.headers["content-range"] });

  // ---- If-Range ------------------------------------------------------------------------------
  const etag = first.headers.etag;
  const ifRangeMatch = await request(`file/${videoAsset.asset_version_id}`, { headers: { range: "bytes=0-1023", "if-range": etag } });
  add("if_range_matching_etag_serves_206", ifRangeMatch.status === 206 && ifRangeMatch.bytes_sent === 1024, `If-Range with the current ETag (${etag}) -> ${ifRangeMatch.status}, ${ifRangeMatch.bytes_sent} B`, { status: ifRangeMatch.status, bytes: ifRangeMatch.bytes_sent, etag });

  const ifRangeStale = await request(`file/${videoAsset.asset_version_id}`, { headers: { range: "bytes=0-1023", "if-range": '"sha256:0000000000000000000000000000000000000000000000000000000000000000"' } });
  add("if_range_stale_etag_falls_back_to_full_200",
    ifRangeStale.status === 200 && ifRangeStale.bytes_sent === size,
    `If-Range with a stale ETag -> ${ifRangeStale.status}, ${ifRangeStale.bytes_sent} B (full representation; a stale validator must not produce a spliced partial read)`,
    { status: ifRangeStale.status, bytes: ifRangeStale.bytes_sent, expected_full: size });

  const ifRangeDate = await request(`file/${videoAsset.asset_version_id}`, { headers: { range: "bytes=0-1023", "if-range": new Date(Date.now() - 86_400_000).toUTCString() } });
  add("if_range_stale_date_falls_back_to_full_200", ifRangeDate.status === 200 && ifRangeDate.bytes_sent === size, `If-Range with an older date -> ${ifRangeDate.status}, ${ifRangeDate.bytes_sent} B`, { status: ifRangeDate.status, bytes: ifRangeDate.bytes_sent });

  // ---- If-Range DATE round-trip, over real HTTP ------------------------------------------------
  // A parent probe found the date validator broken at the HTTP level: Last-Modified is emitted at
  // HTTP-date precision (whole seconds) while the comparison used the file's full millisecond mtime,
  // so echoing the server's OWN header back was judged a mismatch and the range was downgraded to a
  // full 200. A function-level test could not catch that, so these checks pin the object's mtime to a
  // value with a non-zero millisecond part and then do a real request/response round-trip.
  const pinnedMtime = new Date(Date.UTC(2026, 8, 23, 0, 0, 0, 456));
  await fs.promises.utimes(videoObjectPath, pinnedMtime, pinnedMtime);
  const pinnedStat = await fs.promises.stat(videoObjectPath);
  const pinnedFull = await request(`file/${videoAsset.asset_version_id}`);
  const pinnedLastModified = pinnedFull.headers["last-modified"];
  const pinnedEtag = pinnedFull.headers.etag;

  add("object_mtime_kept_its_sub_second_part",
    pinnedStat.mtimeMs % 1000 !== 0,
    `the served object's mtime is pinned to a value with a non-zero millisecond part (mtimeMs=${pinnedStat.mtimeMs}, remainder=${pinnedStat.mtimeMs % 1000}ms), so the date-precision case is actually exercised`,
    { mtime_ms: pinnedStat.mtimeMs, remainder_ms: pinnedStat.mtimeMs % 1000 });

  const dateEcho = await request(`file/${videoAsset.asset_version_id}`, { headers: { range: "bytes=0-1023", "if-range": pinnedLastModified } });
  const expectedPrefix = fs.readFileSync(videoObjectPath).subarray(0, 1024);
  add("if_range_with_the_servers_own_last_modified_returns_206",
    dateEcho.status === 206 && dateEcho.headers["content-range"] === `bytes 0-1023/${size}` && dateEcho.bytes.equals(expectedPrefix),
    `If-Range: ${pinnedLastModified} (the server's own Last-Modified header, echoed verbatim) -> ${dateEcho.status}, content-range ${dateEcho.headers["content-range"] ?? "(none)"}, ${dateEcho.bytes_sent} B, bytes match = ${dateEcho.bytes.equals(expectedPrefix)}. Before the fix this returned 200 because the echoed second-precision date was compared against the full millisecond mtime.`,
    { status: dateEcho.status, content_range: dateEcho.headers["content-range"] ?? null, bytes: dateEcho.bytes_sent, bytes_match: dateEcho.bytes.equals(expectedPrefix), sent: pinnedLastModified });

  const dateStaleAfterPin = await request(`file/${videoAsset.asset_version_id}`, { headers: { range: "bytes=0-1023", "if-range": new Date(pinnedMtime.getTime() - 60_000).toUTCString() } });
  add("if_range_one_minute_older_still_falls_back_to_full_200",
    dateStaleAfterPin.status === 200 && dateStaleAfterPin.bytes_sent === size,
    `If-Range with a date one minute older than Last-Modified -> ${dateStaleAfterPin.status}, ${dateStaleAfterPin.bytes_sent} B (a genuinely stale validator must still downgrade to the full representation)`,
    { status: dateStaleAfterPin.status, bytes: dateStaleAfterPin.bytes_sent });

  // A weak validator must never satisfy If-Range, even when it wraps the current strong ETag.
  const weakEtag = await request(`file/${videoAsset.asset_version_id}`, { headers: { range: "bytes=0-1023", "if-range": `W/${pinnedEtag}` } });
  add("if_range_weak_etag_falls_back_to_full_200",
    weakEtag.status === 200 && weakEtag.bytes_sent === size,
    `If-Range: W/${pinnedEtag} (a weak validator wrapping the current strong ETag) -> ${weakEtag.status}, ${weakEtag.bytes_sent} B: a weak validator can not authorise a partial read, so the full representation is sent`,
    { status: weakEtag.status, bytes: weakEtag.bytes_sent, sent: `W/${pinnedEtag}` });

  const strongEtagAfterPin = await request(`file/${videoAsset.asset_version_id}`, { headers: { range: "bytes=0-1023", "if-range": pinnedEtag } });
  add("if_range_strong_etag_after_mtime_change_returns_206",
    strongEtagAfterPin.status === 206 && strongEtagAfterPin.bytes_sent === 1024,
    `If-Range: ${pinnedEtag} (strong, content-addressed) -> ${strongEtagAfterPin.status}, ${strongEtagAfterPin.bytes_sent} B: a content address is unaffected by the mtime change`,
    { status: strongEtagAfterPin.status, bytes: strongEtagAfterPin.bytes_sent });

  // ---- derived routes ------------------------------------------------------------------------
  const thumb = await request(`thumb/${thumbDerived.derived_file_id}`);
  add("thumbnail_route_serves_real_image", thumb.status === 200 && thumb.headers["content-type"] === "image/jpeg" && thumb.bytes_sent === thumbDerived.size_bytes && thumb.bytes_sent < videoAsset.size_bytes, `GET /thumb/<id> -> ${thumb.status}, ${thumb.headers["content-type"]}, ${thumb.bytes_sent} B (source video ${videoAsset.size_bytes} B)`, { status: thumb.status, content_type: thumb.headers["content-type"], bytes: thumb.bytes_sent, source_bytes: videoAsset.size_bytes, disposition: thumb.headers["content-disposition"] ?? null });

  const proxy = await request(`proxy/${proxyDerived.derived_file_id}`);
  add("proxy_route_serves_playable_video", proxy.status === 200 && proxy.headers["content-type"] === "video/mp4" && proxy.headers["accept-ranges"] === "bytes", `GET /proxy/<id> -> ${proxy.status}, ${proxy.headers["content-type"]}, ${proxy.bytes_sent} B, accept-ranges ${proxy.headers["accept-ranges"]}`, { status: proxy.status, content_type: proxy.headers["content-type"], bytes: proxy.bytes_sent });

  const proxyRange = await request(`proxy/${proxyDerived.derived_file_id}`, { headers: { range: "bytes=0-2047" } });
  add("proxy_route_supports_range", proxyRange.status === 206 && proxyRange.bytes_sent === 2048 && String(proxyRange.headers["content-range"] ?? "").startsWith("bytes 0-2047/"), `Range on /proxy/<id> -> ${proxyRange.status}, content-range ${proxyRange.headers["content-range"]}, ${proxyRange.bytes_sent} B`, { status: proxyRange.status, content_range: proxyRange.headers["content-range"], bytes: proxyRange.bytes_sent });

  // A thumbnail id asked through the proxy route: the type allow-list must refuse it.
  const typeMismatch = await request(`proxy/${thumbDerived.derived_file_id}`);
  add("derived_type_allowlist_refuses_other_types", typeMismatch.status === 404, `GET /proxy/<thumbnail id> -> ${typeMismatch.status} (the proxy route only serves proxy/transcode/audio_proxy)`, { status: typeMismatch.status, body: typeMismatch.bytes.toString("utf8").slice(0, 200) });

  const audioRoute = await request(`proxy/${audioDerived.derived_file_id}`);
  add("audio_proxy_served_on_proxy_route", audioRoute.status === 200 && audioRoute.headers["content-type"] === "audio/mp4", `GET /proxy/<audio_proxy id> -> ${audioRoute.status}, ${audioRoute.headers["content-type"]}, ${audioRoute.bytes_sent} B`, { status: audioRoute.status, content_type: audioRoute.headers["content-type"], bytes: audioRoute.bytes_sent });

  // ---- refusals and hygiene ------------------------------------------------------------------
  const badMethod = await request(`file/${videoAsset.asset_version_id}`, { method: "POST", body: "" });
  add("post_on_media_route_is_405", badMethod.status === 405, `POST /file/<version> -> ${badMethod.status}`, { status: badMethod.status });

  const traversal = await request("file/..%2f..%2fmetadata%2fvideo-assets.sqlite");
  add("traversal_identifier_is_refused", traversal.status === 400 || traversal.status === 404, `GET /file/..%2f..%2fmetadata%2f... -> ${traversal.status}`, { status: traversal.status, body: traversal.bytes.toString("utf8").slice(0, 200) });

  const unknownVersion = await request("file/ver_does_not_exist_at_all");
  add("unknown_identifier_is_404", unknownVersion.status === 404, `GET /file/ver_does_not_exist_at_all -> ${unknownVersion.status}`, { status: unknownVersion.status, body: unknownVersion.bytes.toString("utf8").slice(0, 200) });

  // No response - success or refusal - may describe where objects live on disk.
  //
  // The scan is split by surface, because a single scan over everything is not sound:
  //   * headers are text, so every pattern is checked against them, including the bare drive letter;
  //   * a media BODY is arbitrary binary, where a two-character sequence like "c:" occurs by chance
  //     in a 600 KB file (measured: it does). Scanning binaries for short substrings would report a
  //     "leak" on every video ever served, so bodies are scanned only when they are textual
  //     (the JSON error envelopes and the login response), and against the precise path patterns.
  const responsesForLeakScan = [unauth, authed, queryInline, inlineRange, inlineNoSession, head, first, suffix, outOfRange, dateEcho, weakEtag, thumb, proxy, typeMismatch, traversal, unknownVersion, badMethod];
  const pathPatterns = [
    { name: "repository_root", value: seed.repository_root },
    { name: "asset-repo", value: "asset-repo" },
    { name: "objects_dir", value: "objects" + path.sep + "sha256" },
    { name: "blob_suffix", value: ".blob" },
    { name: "metadata_dir", value: "metadata" + path.sep + "video-assets" }
  ];
  const leaks = [];
  let headerSurfaces = 0;
  let textualBodies = 0;
  for (const [index, response] of responsesForLeakScan.entries()) {
    const headerText = JSON.stringify(response.headers).toLowerCase();
    headerSurfaces += 1;
    for (const pattern of [...pathPatterns, { name: "repo_drive_letter", value: seed.repository_root.slice(0, 2) }]) {
      if (pattern.value && headerText.includes(String(pattern.value).toLowerCase())) {
        leaks.push({ surface: "headers", response_index: index, pattern: pattern.name, value: pattern.value, status: response.status });
      }
    }
    const contentType = String(response.headers["content-type"] ?? "");
    const textual = /json|text|html/i.test(contentType);
    if (!textual) continue;
    textualBodies += 1;
    const bodyText = response.bytes.toString("utf8").toLowerCase();
    for (const pattern of pathPatterns) {
      if (pattern.value && bodyText.includes(String(pattern.value).toLowerCase())) {
        leaks.push({ surface: "body", response_index: index, pattern: pattern.name, value: pattern.value, status: response.status, content_type: contentType });
      }
    }
  }
  add("no_response_exposes_object_store_paths", leaks.length === 0,
    leaks.length === 0
      ? `scanned ${headerSurfaces} response header sets for ${pathPatterns.length + 1} path patterns (including the drive letter) and ${textualBodies} textual bodies for ${pathPatterns.length} path patterns: no on-disk path disclosed`
      : `path disclosure found: ${JSON.stringify(leaks)}`, { leaks, header_surfaces: headerSurfaces, textual_bodies: textualBodies, binary_bodies_excluded: responsesForLeakScan.length - textualBodies });

  const cspSafe = !/asset-repo/i.test(JSON.stringify(proxy.headers));
  add("stream_headers_are_private_and_nostore", /no-store/.test(String(authed.headers["cache-control"] ?? "")) && cspSafe, `cache-control: ${authed.headers["cache-control"] ?? "(none)"} (access-controlled media must not be shared-cached)`, { cache_control: authed.headers["cache-control"] ?? null });

  const failed = checks.filter((c) => !c.ok);
  const report = {
    report: "REN-05 protected stream HTTP acceptance",
    generated_at: new Date().toISOString(),
    base,
    base_path: basePath,
    seed: seedPath,
    video_version_id: videoAsset.asset_version_id,
    video_size_bytes: size,
    checks,
    failed: failed.map((c) => `${c.id}: ${c.detail}`),
    all_pass: failed.length === 0
  };
  if (outPath) {
    await fs.promises.mkdir(path.dirname(outPath), { recursive: true });
    await fs.promises.writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  for (const c of checks) console.log(`[${c.ok ? "PASS" : "FAIL"}] ${c.id}: ${c.detail}`);
  console.log(`http checks: ${checks.length - failed.length}/${checks.length} pass${outPath ? ` -> ${outPath}` : ""}`);
  process.exitCode = failed.length === 0 ? 0 : 1;
} catch (error) {
  console.error(`http checks aborted: ${error?.stack ?? error}`);
  process.exit(4);
}
