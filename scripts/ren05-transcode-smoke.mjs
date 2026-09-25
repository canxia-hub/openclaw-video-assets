// REN-05 / scripts/ren05-transcode-smoke.mjs
//
// Direct exercise of src/media-transcode.js against the synthesized fixture set: real derivations
// for each supported (kind, derivative_type) pair, and explicit coded refusals for the pairs that
// are not supported. Run standalone so a failure localizes to the adapter itself.
//
// Usage: node scripts/ren05-transcode-smoke.mjs --fixtures <dir> --out <json>

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DERIVATION_PROFILES,
  MEDIA_KINDS,
  generateDerivation,
  planDerivation,
  probeImageWithFfprobe,
  probeWithFfprobe,
  resolveMediaTools
} from "../src/media-transcode.js";

function arg(name, dflt = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
}

const fixturesDir = arg("fixtures");
const outPath = arg("out");
if (!fixturesDir) {
  console.error("usage: node scripts/ren05-transcode-smoke.mjs --fixtures <dir> --out <json>");
  process.exit(2);
}

const index = JSON.parse(fs.readFileSync(path.join(fixturesDir, "fixtures-index.json"), "utf8"));
const fixture = (name) => path.join(fixturesDir, name);
const checks = [];
const add = (id, ok, detail, extra = {}) => checks.push({ id, ok, detail, ...extra });

const workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ren05-transcode-"));
const tools = await resolveMediaTools();

try {
  add("toolchain_available", tools.available, `ffmpeg=${tools.ffmpeg} (${tools.ffmpeg_version}); ffprobe=${tools.ffprobe} (${tools.ffprobe_version})`, { tools });

  // ---- real probing -------------------------------------------------------------------------
  const mp4 = await probeWithFfprobe(fixture("clip_720p_2s.mp4"));
  add("probe_mp4_real_metadata",
    mp4 && mp4.probed_by === "ffprobe" && mp4.width === 1280 && mp4.height === 720 && mp4.duration_ms >= 1800 && mp4.duration_ms <= 2200 && /h264/.test(String(mp4.codec)),
    `mp4 probe: ${JSON.stringify({ w: mp4?.width, h: mp4?.height, ms: mp4?.duration_ms, codec: mp4?.codec, rate: mp4?.frame_rate })}`,
    { probe: mp4 });

  const mov = await probeWithFfprobe(fixture("clip_480p_3s.mov"));
  add("probe_mov_real_metadata",
    mov && mov.width === 854 && mov.height === 480 && mov.duration_ms >= 2800 && mov.duration_ms <= 3200,
    `mov probe: ${JSON.stringify({ w: mov?.width, h: mov?.height, ms: mov?.duration_ms, container: mov?.container })}`,
    { probe: mov });

  // The baseline handwritten parser returned {} for mp3; ffprobe must return real numbers.
  const mp3 = await probeWithFfprobe(fixture("audio_220hz_2s.mp3"));
  add("probe_mp3_real_metadata_where_baseline_was_null",
    mp3 && mp3.media_type === "audio" && mp3.sample_rate === 44100 && mp3.channels === 1 && mp3.duration_ms >= 1800 && mp3.duration_ms <= 2200 && mp3.codec === "mp3",
    `mp3 probe (baseline returned NULL metadata for every mp3): ${JSON.stringify({ sr: mp3?.sample_rate, ch: mp3?.channels, ms: mp3?.duration_ms, codec: mp3?.codec })}`,
    { probe: mp3 });

  const wav = await probeWithFfprobe(fixture("audio_440hz_3s.wav"));
  add("probe_wav_real_metadata", wav && wav.media_type === "audio" && wav.sample_rate === 44100 && wav.duration_ms >= 2800 && wav.duration_ms <= 3200, `wav probe: ${JSON.stringify({ sr: wav?.sample_rate, ch: wav?.channels, ms: wav?.duration_ms })}`, { probe: wav });

  const png = await probeImageWithFfprobe(fixture("still_1024x768.png"));
  add("probe_png_real_dimensions", png && png.media_type === "image" && png.width === 1024 && png.height === 768, `png probe: ${JSON.stringify({ w: png?.width, h: png?.height })}`, { probe: png });

  // ---- real derivations ---------------------------------------------------------------------
  const derivations = [
    { id: "derive_thumbnail_from_image", source: "still_1024x768.png", derivative_type: "thumbnail", parameters: { width: 256 }, expect: (d) => d.width === 256 && d.output_extension === ".jpg" },
    { id: "derive_thumbnail_from_video_mp4", source: "clip_720p_2s.mp4", derivative_type: "thumbnail", parameters: { width: 320, offset_ms: 500 }, expect: (d) => d.width === 320 && d.output_extension === ".jpg" },
    { id: "derive_thumbnail_from_video_mov", source: "clip_480p_3s.mov", derivative_type: "thumbnail", parameters: { width: 240 }, expect: (d) => d.width === 240 },
    { id: "derive_proxy_from_video", source: "clip_720p_2s.mp4", derivative_type: "proxy", parameters: { width: 640 }, expect: (d) => d.output_extension === ".mp4" && d.output_probe.media_type === "video" && d.duration_ms >= 1800 },
    { id: "derive_transcode_from_video", source: "clip_480p_3s.mov", derivative_type: "transcode", parameters: { width: 480 }, expect: (d) => d.output_extension === ".mp4" && d.output_probe.media_type === "video" },
    { id: "derive_audio_proxy_from_wav", source: "audio_440hz_3s.wav", derivative_type: "audio_proxy", parameters: {}, expect: (d) => d.output_extension === ".m4a" && d.output_probe.media_type === "audio" && /aac/.test(String(d.output_probe.codec)) },
    { id: "derive_audio_proxy_from_mp3", source: "audio_220hz_2s.mp3", derivative_type: "audio_proxy", parameters: { bitrate_kbps: 96 }, expect: (d) => d.output_extension === ".m4a" && d.duration_ms >= 1800 },
    { id: "derive_waveform_from_audio", source: "audio_440hz_3s.wav", derivative_type: "waveform", parameters: { width: 512, height: 128 }, expect: (d) => d.output_extension === ".png" && d.width === 512 && d.height === 128 }
  ];

  const derivationResults = [];
  for (const item of derivations) {
    const sourceFile = fixture(item.source);
    const stat = await fs.promises.stat(sourceFile);
    try {
      const result = await generateDerivation({
        source: { file_path: sourceFile, file_name: item.source, asset_version_id: `fix_${item.source}`, sha256: null },
        derivativeType: item.derivative_type,
        parameters: item.parameters,
        outputDir: path.join(workDir, item.id)
      });
      const ok = item.expect(result);
      // The artifact must be a different image/video, not a copy of the source: size and hash differ.
      const copied = result.sha256 === (await sha256File(sourceFile));
      add(item.id, ok && !copied, `${item.source} -> ${item.derivative_type}: profile=${result.profile} bytes=${result.size_bytes} (source ${stat.size}) verified=${result.verification.map((c) => `${c.name}=${c.ok}`).join(",")}`, {
        profile: result.profile,
        size_bytes: result.size_bytes,
        source_size_bytes: stat.size,
        sha256: result.sha256,
        distinct_from_source: !copied,
        output_probe: result.output_probe,
        elapsed_ms: result.elapsed_ms
      });
      derivationResults.push({ id: item.id, profile: result.profile, bytes: result.size_bytes, elapsed_ms: result.elapsed_ms, checks: result.verification, output_probe: result.output_probe });
    } catch (error) {
      add(item.id, false, `${item.source} -> ${item.derivative_type} failed: ${error.code ?? ""} ${error.message}`, { error: { code: error.code, message: error.message, details: error.details } });
    }
  }

  // ---- explicit refusals --------------------------------------------------------------------
  const refusals = [
    { id: "refuse_thumbnail_from_audio", source: "audio_440hz_3s.wav", derivative_type: "thumbnail", code: "DERIVATION_UNSUPPORTED" },
    { id: "refuse_proxy_from_image", source: "still_1024x768.png", derivative_type: "proxy", code: "DERIVATION_UNSUPPORTED" },
    { id: "refuse_waveform_from_video", source: "clip_720p_2s.mp4", derivative_type: "waveform", code: "DERIVATION_UNSUPPORTED" },
    { id: "refuse_thumbnail_from_non_media", source: "unsupported_archive.zip", derivative_type: "thumbnail", code: "DERIVATION_KIND_UNKNOWN" },
    { id: "refuse_audio_proxy_from_video", source: "clip_720p_2s.mp4", derivative_type: "audio_proxy", code: "DERIVATION_UNSUPPORTED" }
  ];
  for (const item of refusals) {
    const sourceFile = fixture(item.source);
    let outcome = null;
    const outDir = path.join(workDir, item.id);
    try {
      const result = await generateDerivation({
        source: { file_path: sourceFile, file_name: item.source, asset_version_id: `fix_${item.source}`, sha256: null },
        derivativeType: item.derivative_type,
        parameters: {},
        outputDir: outDir
      });
      outcome = { threw: false, result };
    } catch (error) {
      outcome = { threw: true, code: error.code, message: error.message };
    }
    // No output may be left behind, and nothing may have been copied into the output directory.
    const leftBehind = fs.existsSync(outDir) ? fs.readdirSync(outDir) : [];
    add(item.id, outcome.threw === true && outcome.code === item.code && leftBehind.length === 0,
      `${item.source} -> ${item.derivative_type}: refused with ${outcome.code ?? "(no error)"} (expected ${item.code}); artifacts left behind = ${leftBehind.length}`,
      { expected: item.code, actual: outcome.code ?? null, message: outcome.message ?? null, artifacts_left_behind: leftBehind });
  }

  // ---- plan-level parameter validation ------------------------------------------------------
  {
    let code = null;
    try {
      planDerivation({ source: { file_name: "x.png" }, derivativeType: "thumbnail", parameters: { width: 5 }, outputDir: workDir });
    } catch (error) {
      code = error.code;
    }
    add("reject_out_of_range_width", code === "DERIVATION_BAD_PARAMETER", `width=5 (below the 16px floor) rejected with ${code}`, { code });
  }
  {
    const plan = planDerivation({ source: { file_name: "x.mp4" }, derivativeType: "proxy", parameters: { width: 641 }, outputDir: workDir });
    add("proxy_width_forced_even", plan.parameters.width === 640, `odd width 641 normalised to ${plan.parameters.width} (H.264 requires even dimensions)`, { parameters: plan.parameters });
  }
  {
    add("profiles_are_declared_and_distinct",
      Object.keys(DERIVATION_PROFILES).length >= 6,
      `${Object.keys(DERIVATION_PROFILES).length} derivation profiles declared: ${Object.keys(DERIVATION_PROFILES).join(", ")}`,
      { profiles: Object.values(DERIVATION_PROFILES).map((p) => ({ id: p.id, type: p.derivative_type, accepts: p.accepts, verify: p.verify })) });
  }
  {
    add("media_kinds_exported", MEDIA_KINDS.IMAGE === "image" && MEDIA_KINDS.VIDEO === "video" && MEDIA_KINDS.AUDIO === "audio", "media kinds exported for callers", { kinds: MEDIA_KINDS });
  }

  const failed = checks.filter((c) => !c.ok);
  const report = {
    report: "REN-05 media-transcode adapter smoke",
    generated_at: new Date().toISOString(),
    toolchain: { ffmpeg: tools.ffmpeg, ffmpeg_version: tools.ffmpeg_version, ffprobe: tools.ffprobe, ffprobe_version: tools.ffprobe_version, available: tools.available },
    fixtures_index: path.join(fixturesDir, "fixtures-index.json"),
    derivations: derivationResults,
    checks,
    failed: failed.map((c) => `${c.id}: ${c.detail}`),
    all_pass: failed.length === 0
  };
  if (outPath) {
    await fs.promises.mkdir(path.dirname(outPath), { recursive: true });
    await fs.promises.writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  for (const c of checks) console.log(`[${c.ok ? "PASS" : "FAIL"}] ${c.id}: ${c.detail}`);
  console.log(`media-transcode smoke: ${checks.length - failed.length}/${checks.length} pass${outPath ? ` -> ${outPath}` : ""}`);
  process.exitCode = failed.length === 0 ? 0 : 1;
} finally {
  await fs.promises.rm(workDir, { recursive: true, force: true });
}

async function sha256File(file) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
