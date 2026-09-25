/**
 * REN-11 SOP-v2 local media pipeline: programmatic fixtures, FFmpeg post-production and QC.
 *
 * Everything here is original and generated from FFmpeg's own synthetic sources (`lavfi`):
 * no third-party footage, music, fonts-as-assets or unknown-licence material is used. The one
 * external input is a *font file copied from the host OS* purely to rasterise text; it is not
 * redistributed and the copy lives only inside the run's scratch directory.
 *
 * Contract with the orchestrator (see sop-v2-orchestrator.js):
 *   - every function returns facts (hashes, probes, measurements) rather than "ok" booleans,
 *   - QC never returns a pass verdict for media it could not actually decode,
 *   - a QC failure is reported as failed checks with codes; the caller decides the label.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const REN11_FIXTURE_SPEC = Object.freeze({
  width: 1280,
  height: 720,
  fps: 30,
  shot_seconds: 5,
  shot_count: 3,
  total_seconds: 15,
  video_codec: "h264",
  pix_fmt: "yuv420p",
  audio_codec: "aac",
  audio_sample_rate: 48000,
  audio_channels: 2,
  audio_bitrate: "128k"
});

/**
 * The three shots are deliberately distinguishable by three independent signals so that a frame
 * pulled at any time inside a shot identifies which shot it is: background colour, moving shape
 * colour/axis, and the audio tone. The subtitle cue text repeats the shot number.
 */
export const REN11_SHOTS = Object.freeze([
  {
    index: 1,
    key: "shot-1",
    background: "0x10284F",
    background_rgb: [16, 40, 79],
    accent: "0xFFC63A",
    tone_hz: 440,
    label: "SHOT-1 5s",
    cue_text: "镜头一：本地程序化夹具（工程测试预览）",
    motion: "horizontal"
  },
  {
    index: 2,
    key: "shot-2",
    background: "0x1E7A3C",
    background_rgb: [30, 122, 60],
    accent: "0x5BE0A0",
    tone_hz: 660,
    label: "SHOT-2 5s",
    cue_text: "镜头二：本地程序化夹具（工程测试预览）",
    motion: "vertical"
  },
  {
    index: 3,
    key: "shot-3",
    background: "0x7A3A10",
    background_rgb: [122, 58, 16],
    accent: "0xFF6B57",
    tone_hz: 880,
    label: "SHOT-3 5s",
    cue_text: "镜头三：本地程序化夹具（工程测试预览）",
    motion: "diagonal"
  }
]);

/**
 * The output spec a *run* must be judged against, derived from its own brief.
 *
 * `REN11_FIXTURE_SPEC` describes one particular package (three 5s shots, 15s total, 1280x720@30). Using
 * it as the yardstick for a run whose brief says something else fails that run for not being the
 * fixture: on the real-machine paid run (one 4s shot) QC reported "container duration must be 15s,
 * measured 4.021333" and blocked the delivery. Geometry comes from the brief's resolution/fps; the
 * codec/audio fields stay the shared base, which is what the render profile actually emits.
 *
 * @param {object} brief  brief with `duration_seconds`, `resolution`, `fps`, `shots[].seconds`
 * @param {object} [base] shared render/encode base (defaults to the fixture spec's codec profile)
 */
export function outputSpecFromBrief(brief = {}, base = REN11_FIXTURE_SPEC) {
  const shots = Array.isArray(brief?.shots) ? brief.shots : [];
  const parsedResolution = /^\s*(\d+)\s*[x×]\s*(\d+)\s*$/.exec(String(brief?.resolution ?? ""));
  const width = parsedResolution ? Number(parsedResolution[1]) : base.width;
  const height = parsedResolution ? Number(parsedResolution[2]) : base.height;
  const declaredFps = Number(brief?.fps);
  const fps = Number.isFinite(declaredFps) && declaredFps > 0 ? declaredFps : base.fps;
  // Per-shot windows are cumulative, so a brief with unequal shots is judged window by window instead
  // of against one averaged grid.
  let cursor = 0;
  const shot_windows = shots.map((shot, index) => {
    const seconds = Number(shot?.seconds);
    const start = cursor;
    const end = Number.isFinite(seconds) && seconds > 0 ? cursor + seconds : cursor;
    cursor = end;
    return {
      index: index + 1,
      key: shot?.key ?? `shot-${index + 1}`,
      start: Number(start.toFixed(3)),
      end: Number(end.toFixed(3))
    };
  });
  const timeline = shot_windows.length ? shot_windows[shot_windows.length - 1].end : 0;
  const declared = Number(brief?.duration_seconds);
  const total = Number.isFinite(declared) && declared > 0 ? declared : (timeline || base.total_seconds);
  const shot_seconds = shot_windows.length && timeline > 0
    ? Number((timeline / shot_windows.length).toFixed(3))
    : base.shot_seconds;
  return Object.freeze({
    ...base,
    width,
    height,
    fps,
    shot_count: shot_windows.length || base.shot_count,
    shot_seconds,
    total_seconds: total,
    duration_basis: Number.isFinite(declared) && declared > 0 ? "brief.duration_seconds" : "sum_of_shot_seconds",
    shot_windows,
    basis: "run_brief"
  });
}

/** The time window of one shot: an explicit window when the spec carries one, else the uniform grid. */
export function shotWindowOf(spec, index) {
  const explicit = Number.isInteger(index) ? spec?.shot_windows?.[index - 1] : null;
  if (explicit) return { start: Number(explicit.start), end: Number(explicit.end) };
  const step = Number(spec?.shot_seconds) || 0;
  return { start: (index - 1) * step, end: index * step };
}

/**
 * A probe time inside shot `index`, `offset` seconds after its window start and never past its
 * midpoint. Keeps the fixture's old sample points (a 5s shot still probes at start+1s / start+2.5s)
 * while staying inside a window of any other length.
 */
export function shotProbeTime(spec, index, offset) {
  const window = shotWindowOf(spec, index);
  const span = Math.max(0, window.end - window.start);
  return Number((window.start + Math.min(offset, span / 2)).toFixed(3));
}

/** Subtitle cues: one per shot, inset by 0.5s on both sides of a 5s shot, plus a 1s gap. */
export function ren11CuePlan(spec = REN11_FIXTURE_SPEC) {
  const shot = spec.shot_seconds;
  return REN11_SHOTS.map((item, i) => ({
    index: i + 1,
    start: i * shot + 0.5,
    end: (i + 1) * shot - 0.5,
    text: item.cue_text
  }));
}

export function formatSrtTime(seconds) {
  const total = Math.max(0, seconds);
  const hh = String(Math.floor(total / 3600)).padStart(2, "0");
  const mm = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  const ss = String(Math.floor(total % 60)).padStart(2, "0");
  const ms = String(Math.round((total - Math.floor(total)) * 1000)).padStart(3, "0");
  return `${hh}:${mm}:${ss},${ms}`;
}

export function renderSrt(cues) {
  return `${cues
    .map((cue, i) => `${i + 1}\n${formatSrtTime(cue.start)} --> ${formatSrtTime(cue.end)}\n${cue.text}\n`)
    .join("\n")}\n`;
}

export function parseSrt(text) {
  const body = String(text).replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const blocks = body.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  const timeRe = /^(\d{2}):(\d{2}):(\d{2}),(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2}),(\d{3})$/;
  const toSeconds = (h, m, s, ms) => Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000;
  return blocks.map((block) => {
    const lines = block.split("\n");
    const match = timeRe.exec(lines[1] ?? "");
    if (!match) throw new Error(`unparsable srt block: ${JSON.stringify(block.slice(0, 60))}`);
    return {
      start: toSeconds(match[1], match[2], match[3], match[4]),
      end: toSeconds(match[5], match[6], match[7], match[8]),
      text: lines.slice(2).join("\n").trim()
    };
  });
}

/** Run a child process with an argv array (no shell) and return its captured output. */
export function runProcess(command, args, { cwd = process.cwd(), timeoutMs = 300000, stdin = null } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true, shell: false });
    const stdout = [];
    const stderr = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      reject(new Error(`process timeout after ${timeoutMs}ms: ${command} ${args.join(" ")}`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    });
    if (stdin !== null) child.stdin.end(stdin);
  });
}

export async function runFfmpeg(args, options = {}) {
  const result = await runProcess(options.ffmpegPath ?? process.env.REN11_FFMPEG ?? "ffmpeg", ["-hide_banner", "-nostdin", ...args], options);
  return {
    code: result.code,
    stdout: result.stdout.toString("utf8"),
    stderr: result.stderr.toString("utf8"),
    // Raw buffers, for the readback paths (rgb24 frames, s16le PCM). Decoding binary to utf8 first
    // corrupts it, which is how a "short frame readback" appears out of nowhere.
    stdoutBuffer: result.stdout,
    stderrBuffer: result.stderr,
    command: `ffmpeg ${args.join(" ")}`
  };
}

export async function ffprobeJson(file, options = {}) {
  const result = await runProcess(
    options.ffprobePath ?? process.env.REN11_FFPROBE ?? "ffprobe",
    ["-hide_banner", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", file],
    options
  );
  if (result.code !== 0) {
    throw new Error(`ffprobe failed (${result.code}) for ${file}: ${result.stderr.toString("utf8").trim()}`);
  }
  return JSON.parse(result.stdout.toString("utf8"));
}

export async function sha256File(file) {
  const hash = createHash("sha256");
  const stream = fs.createReadStream(file);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

export function fileFact(file) {
  const stat = fs.statSync(file);
  return { path: file, bytes: stat.size, mtime: stat.mtime.toISOString() };
}

/** Parse "30000/1001"-style rationals into a number. */
export function rational(value) {
  if (value === null || value === undefined || value === "") return null;
  const [num, den] = String(value).split("/");
  const n = Number(num);
  const d = den === undefined ? 1 : Number(den);
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return null;
  return n / d;
}

export function probeSummary(probe) {
  const video = (probe.streams ?? []).find((s) => s.codec_type === "video") ?? null;
  const audio = (probe.streams ?? []).find((s) => s.codec_type === "audio") ?? null;
  const subtitle = (probe.streams ?? []).find((s) => s.codec_type === "subtitle") ?? null;
  return {
    format_name: probe.format?.format_name ?? null,
    duration_seconds: Number(probe.format?.duration ?? NaN),
    video: video && {
      codec: video.codec_name,
      profile: video.profile ?? null,
      pix_fmt: video.pix_fmt ?? null,
      width: video.width,
      height: video.height,
      fps: rational(video.avg_frame_rate),
      frames: Number(video.nb_frames ?? NaN),
      duration_seconds: Number(video.duration ?? NaN)
    },
    audio: audio && {
      codec: audio.codec_name,
      sample_rate: Number(audio.sample_rate ?? NaN),
      channels: audio.channels,
      duration_seconds: Number(audio.duration ?? NaN)
    },
    subtitle: subtitle && {
      codec: subtitle.codec_name,
      duration_seconds: Number(subtitle.duration ?? NaN)
    }
  };
}

// ---------------------------------------------------------------------------------------------
// fixture generation
// ---------------------------------------------------------------------------------------------

/** FFmpeg output paths are given relative to the scratch cwd to keep drive letters out of filters. */
function relFor(cwd, target) {
  const relative = path.relative(cwd, target);
  if (!relative || relative.startsWith("..")) throw new Error(`output ${target} must live inside the scratch dir ${cwd}`);
  return relative.split(path.sep).join("/");
}

/**
 * Copy a host font into the scratch dir so text rasterisation needs no absolute path (a drive
 * letter inside a filter graph is a quoting hazard). The copy is scratch-only and never shipped.
 */
export async function ensureScratchFont(workDir) {
  const candidates = [
    "C:\\Windows\\Fonts\\msyh.ttc",
    "C:\\Windows\\Fonts\\msyh.ttf",
    "C:\\Windows\\Fonts\\arial.ttf",
    "C:\\Windows\\Fonts\\segoeui.ttf"
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      const target = path.join(workDir, "fixture-font.ttf");
      if (!fs.existsSync(target)) fs.copyFileSync(candidate, target);
      return { source: candidate, local: "fixture-font.ttf" };
    }
  }
  throw new Error("no host font available for text rasterisation");
}

/**
 * Build one 5s shot: coloured background, a moving accent shape (axis differs per shot) and a
 * static label, plus a distinct sine tone. Rendered with explicit encoder settings so the output
 * is reproducible rather than dependent on FFmpeg defaults.
 */
export async function generateFixtureShot({ shot, outputPath, workDir, spec = REN11_FIXTURE_SPEC, ffmpegPath = null }) {
  const { width, height, fps, shot_seconds } = spec;
  const boxW = 220;
  const boxH = 160;
  const xExpr = shot.motion === "horizontal"
    ? `120+t*200`
    : (shot.motion === "diagonal" ? `120+t*170` : `(iw-${boxW})/2`);
  const yExpr = shot.motion === "vertical"
    ? `120+t*110`
    : (shot.motion === "diagonal" ? `120+t*95` : `(ih-${boxH})/2`);
  const label = shot.label.replace(/[:',]/g, "");
  const draw = [
    `drawbox=x=0:y=0:w=iw:h=ih:color=${shot.background}@1:t=fill`,
    `drawbox=x=6:y=6:w=iw-12:h=ih-12:color=white@0.85:t=4`,
    `drawbox=x='${xExpr}':y='${yExpr}':w=${boxW}:h=${boxH}:color=${shot.accent}@1:t=fill`,
    `drawtext=fontfile=fixture-font.ttf:text='${label}':fontcolor=white:fontsize=54:x=40:y=40`,
    `drawtext=fontfile=fixture-font.ttf:text='REN11 LOCAL FIXTURE':fontcolor=white@0.8:fontsize=26:x=40:y=660`
  ].join(",");
  const args = [
    "-y",
    "-f", "lavfi", "-i", `color=c=black:s=${width}x${height}:r=${fps}:d=${shot_seconds}`,
    "-f", "lavfi", "-i", `sine=frequency=${shot.tone_hz}:sample_rate=${spec.audio_sample_rate}:duration=${shot_seconds}`,
    "-vf", draw,
    "-af", "volume=0.25",
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", spec.pix_fmt, "-r", String(fps), "-g", String(fps),
    "-c:a", spec.audio_codec, "-b:a", spec.audio_bitrate, "-ar", String(spec.audio_sample_rate), "-ac", String(spec.audio_channels),
    "-shortest", "-movflags", "+faststart",
    relFor(workDir, outputPath)
  ];
  const result = await runFfmpeg(args, { cwd: workDir, ffmpegPath });
  if (result.code !== 0) throw new Error(`fixture shot ${shot.key} failed: ${result.stderr.slice(-2000)}`);
  return { path: outputPath, sha256: await sha256File(outputPath), ...fileFact(outputPath) };
}

/** Concatenate shots with the concat demuxer (no re-encode) into the 15s master. */
export async function concatShots({ shotPaths, outputPath, workDir, ffmpegPath = null }) {
  const listPath = path.join(workDir, "concat-list.txt");
  // The concat demuxer resolves entries relative to the list file, so entries must carry the
  // sub-directory. A bare basename silently picked up a stale copy in the scratch root.
  const body = shotPaths.map((p) => `file '${relFor(workDir, p).replace(/'/g, "'\\''")}'`).join("\n") + "\n";
  fs.writeFileSync(listPath, body, "utf8");
  const result = await runFfmpeg(
    ["-y", "-f", "concat", "-safe", "0", "-i", "concat-list.txt", "-c", "copy", "-movflags", "+faststart", relFor(workDir, outputPath)],
    { cwd: workDir, ffmpegPath }
  );
  if (result.code !== 0) throw new Error(`concat failed: ${result.stderr.slice(-2000)}`);
  return { path: outputPath, sha256: await sha256File(outputPath), ...fileFact(outputPath) };
}

export async function muxSoftSubtitles({ videoPath, srtPath, outputPath, workDir, ffmpegPath = null }) {
  // Rendered inside the scratch dir (so every argument stays relative) and then moved to its
  // final home: FFmpeg filter graphs must not carry a drive letter, and the deliverable must not
  // live in scratch.
  const scratchOut = path.join(workDir, `_mux-${path.basename(outputPath)}`);
  const result = await runFfmpeg(
    [
      "-y", "-i", relFor(workDir, videoPath), "-i", relFor(workDir, srtPath),
      "-map", "0:v:0", "-map", "0:a:0", "-map", "1:0",
      "-c:v", "copy", "-c:a", "copy", "-c:s", "mov_text",
      "-metadata:s:s:0", "language=zho", "-movflags", "+faststart",
      relFor(workDir, scratchOut)
    ],
    { cwd: workDir, ffmpegPath }
  );
  if (result.code !== 0) throw new Error(`soft subtitle mux failed: ${result.stderr.slice(-2000)}`);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.renameSync(scratchOut, outputPath);
  return { path: outputPath, sha256: await sha256File(outputPath), ...fileFact(outputPath) };
}

/** Subtitle burn-in font family. The copied host font is a CJK face; the family name is required
 * because libass matches by family, not by file name, and a Latin-only fallback renders tofu
 * boxes for these cues. */
export const REN11_BURN_FONT_FAMILY = "Microsoft YaHei";

export async function burnSubtitles({ videoPath, srtPath, outputPath, workDir, spec = REN11_FIXTURE_SPEC, fontFamily = REN11_BURN_FONT_FAMILY, ffmpegPath = null }) {
  const style = `FontName=${fontFamily},FontSize=30,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=3,Outline=2,MarginV=40`;
  const scratchOut = path.join(workDir, `_burn-${path.basename(outputPath)}`);
  const result = await runFfmpeg(
    [
      "-y", "-i", relFor(workDir, videoPath),
      "-vf", `subtitles=${relFor(workDir, srtPath)}:force_style='${style}':fontsdir=.`,
      "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", spec.pix_fmt, "-r", String(spec.fps),
      "-c:a", "copy", "-movflags", "+faststart",
      relFor(workDir, scratchOut)
    ],
    { cwd: workDir, ffmpegPath }
  );
  if (result.code !== 0) throw new Error(`subtitle burn-in failed: ${result.stderr.slice(-2000)}`);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.renameSync(scratchOut, outputPath);
  return { path: outputPath, sha256: await sha256File(outputPath), ...fileFact(outputPath) };
}

/**
 * Deliberately broken sibling used as the QC negative control. Every defect is a real encoding
 * defect (wrong geometry, wrong frame rate, no audio track, truncated duration) rather than a
 * flag the test flips: if QC cannot tell this file from the good one, it is not testing anything.
 */
export async function generateDefectiveFixture({ outputPath, workDir, ffmpegPath = null }) {
  const scratchOut = path.join(workDir, `_defective-${path.basename(outputPath)}`);
  const args = [
    "-y",
    "-f", "lavfi", "-i", "color=c=blue:s=640x360:r=25:d=9",
    "-vf", "drawbox=x=40:y=40:w=120:h=90:color=red@1:t=fill",
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    relFor(workDir, scratchOut)
  ];
  const result = await runFfmpeg(args, { cwd: workDir, ffmpegPath });
  if (result.code !== 0) throw new Error(`defective fixture failed: ${result.stderr.slice(-2000)}`);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.renameSync(scratchOut, outputPath);
  return { path: outputPath, sha256: await sha256File(outputPath), ...fileFact(outputPath) };
}

// ---------------------------------------------------------------------------------------------
// measurements
// ---------------------------------------------------------------------------------------------

/** Average RGB + luma standard deviation of a cropped frame region, read back as raw rgb24. */
export async function frameRegionStats({ file, time, region, ffmpegPath = null, ffprobePath = null }) {
  let { x, y, w, h } = region;
  if (w <= 0 || h <= 0) throw new Error(`invalid region ${JSON.stringify(region)}`);
  // crop: even offsets only, to avoid chroma-planar rounding complaints from the scaler
  x = x - (x % 2);
  y = y - (y % 2);
  w = w - (w % 2);
  h = h - (h % 2);
  const result = await runFfmpeg(
    [
      "-v", "error", "-ss", String(time), "-i", path.resolve(file),
      "-frames:v", "1", "-vf", `crop=${w}:${h}:${x}:${y}`, "-pix_fmt", "rgb24",
      "-f", "rawvideo", "-"
    ],
    { ffmpegPath, timeoutMs: 120000 }
  );
  if (result.code !== 0) throw new Error(`frame extraction failed at t=${time}: ${result.stderr.slice(-800)}`);
  const raw = result.stdoutBuffer;
  const expected = w * h * 3;
  if (raw.length < expected) throw new Error(`frame readback short: ${raw.length} < ${expected}`);
  let r = 0;
  let g = 0;
  let b = 0;
  const pixels = w * h;
  const lumas = new Float64Array(pixels);
  for (let i = 0; i < pixels; i += 1) {
    const rr = raw[i * 3];
    const gg = raw[i * 3 + 1];
    const bb = raw[i * 3 + 2];
    r += rr; g += gg; b += bb;
    lumas[i] = 0.2126 * rr + 0.7152 * gg + 0.0722 * bb;
  }
  const meanLuma = lumas.reduce((acc, v) => acc + v, 0) / pixels;
  const variance = lumas.reduce((acc, v) => acc + (v - meanLuma) ** 2, 0) / pixels;
  return {
    time,
    region: { x, y, w, h },
    avg_rgb: [r / pixels, g / pixels, b / pixels].map((v) => Number(v.toFixed(2))),
    luma_mean: Number(meanLuma.toFixed(3)),
    luma_stddev: Number(Math.sqrt(variance).toFixed(3))
  };
}

/** Dominant tone among the shots' configured frequencies, from 1s of decoded mono PCM. */
export async function dominantToneAt({ file, time, candidates, ffmpegPath = null, sampleRate = 48000, seconds = 1 }) {
  const result = await runFfmpeg(
    [
      "-v", "error", "-ss", String(time), "-t", String(seconds), "-i", path.resolve(file),
      "-vn", "-ac", "1", "-ar", String(sampleRate), "-f", "s16le", "-"
    ],
    { ffmpegPath, timeoutMs: 120000 }
  );
  if (result.code !== 0) throw new Error(`audio extraction failed at t=${time}: ${result.stderr.slice(-800)}`);
  const samples = new Int16Array(result.stdoutBuffer.buffer, result.stdoutBuffer.byteOffset, Math.floor(result.stdoutBuffer.length / 2));
  if (samples.length < sampleRate / 4) throw new Error(`too few audio samples at t=${time}: ${samples.length}`);
  const n = Math.min(samples.length, sampleRate);
  const magnitudes = candidates.map((freq) => {
    let re = 0;
    let im = 0;
    for (let i = 0; i < n; i += 1) {
      const angle = (2 * Math.PI * freq * i) / sampleRate;
      const value = samples[i] / 32768;
      re += value * Math.cos(angle);
      im -= value * Math.sin(angle);
    }
    return { freq, magnitude: Number(Math.sqrt(re * re + im * im).toFixed(2)) };
  });
  const best = [...magnitudes].sort((a, b) => b.magnitude - a.magnitude)[0];
  return { time, dominant_hz: best.freq, magnitudes, samples: n };
}

/** Full decode pass: any decode error is a real playability defect. */
export async function decodeCheck({ file, ffmpegPath = null }) {
  const result = await runFfmpeg(["-v", "error", "-i", path.resolve(file), "-f", "null", "-"], { ffmpegPath, timeoutMs: 300000 });
  return { ok: result.code === 0 && result.stderr.trim() === "", exit_code: result.code, stderr: result.stderr.trim().slice(0, 4000) };
}

export async function extractSubtitleStream({ file, ffmpegPath = null }) {
  const result = await runFfmpeg(["-v", "error", "-i", path.resolve(file), "-map", "0:s:0", "-f", "srt", "-"], { ffmpegPath });
  if (result.code !== 0) throw new Error(`subtitle extraction failed: ${result.stderr.slice(-800)}`);
  return result.stdout;
}
