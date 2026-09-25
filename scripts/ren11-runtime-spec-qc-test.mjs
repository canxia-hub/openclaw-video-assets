/**
 * REN-11 fix round regression fixture: QC must judge a run against the RUN'S OWN spec (D1) and the
 * burn-in probe must pick a cue it can actually measure (D2).
 *
 * Both defects were found on the real machine, where they blocked the delivery of a paid, verified
 * render. This fixture reproduces them locally at zero cost:
 *
 *   D1  a 4s single-shot programme judged against `REN11_FIXTURE_SPEC` (15s) fails DURATION, and the
 *       same bytes judged against `outputSpecFromBrief(brief)` pass. The first half is the negative
 *       control: it proves the check still has teeth and is not a rubber stamp.
 *   D2  a single-cue burn-in variant: the probe used to read `cues[1]` (undefined -> "Cannot read
 *       properties of undefined" reported as BURNED_SUBTITLE_PRESENT: fail). It now selects the first
 *       cue with a measurable gap, and when no ink-free stretch exists inside the programme it says so
 *       (applied: false) instead of answering the question with a sample that cannot mean it.
 *   D2' a burn-in variant WITHOUT burned subtitles must still fail BURNED_SUBTITLE_PRESENT - the fix
 *       must not have turned the check into one that always passes.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  REN11_FIXTURE_SPEC,
  ffprobeJson,
  outputSpecFromBrief,
  runFfmpeg
} from "../src/sop-v2-media.js";
import { pickBurnInProbe, qcLocalRender } from "../src/sop-v2-qc.js";

const FFPROBE = process.env.REN11_FFPROBE ?? "ffprobe";
const FFMPEG = process.env.REN11_FFMPEG ?? "ffmpeg";
const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ren11-runtime-spec-"));
const brief = {
  duration_seconds: 4,
  resolution: "1280x720",
  fps: 30,
  shots: [{ key: "shot-1", seconds: 4, cue_text: "镜头一：回归夹具（单镜头 4 秒）。" }]
};
const cues = [{ index: 1, start: 0.5, end: 3.5, text: brief.shots[0].cue_text }];

async function ffmpeg(args, { cwd = tmp, timeoutMs = 180000 } = {}) {
  const result = await runFfmpeg(args, { cwd, ffmpegPath: FFMPEG, timeoutMs });
  assert.equal(result.code, 0, `ffmpeg failed: ${result.stderr.slice(-600)}\ncommand: ${result.command}`);
  return result;
}

async function probe(file) {
  return ffprobeJson(file, { ffprobePath: FFPROBE });
}

/** One 4s shot: flat colour + a static label + a sine tone, muxed with the run's SRT. */
async function buildProgramme() {
  const raw = path.join(tmp, "raw.mp4");
  const srt = path.join(tmp, "cues.srt");
  const soft = path.join(tmp, "timeline.mp4");
  const burned = path.join(tmp, "burned.mp4");
  const burnedEmpty = path.join(tmp, "burned-no-ink.mp4");
  fs.writeFileSync(srt, `1\n00:00:00,500 --> 00:00:03,500\n${cues[0].text}\n`, "utf8");
  await ffmpeg([
    "-y",
    "-f", "lavfi", "-i", "color=c=0x10284F:s=1280x720:r=30:d=4",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=4",
    "-vf", "drawbox=x=40:y=40:w=200:h=120:color=0xFFC63A@1:t=fill",
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-r", "30", "-g", "30",
    "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2",
    "-shortest", "-movflags", "+faststart", "raw.mp4"
  ]);
  await ffmpeg([
    "-y", "-i", "raw.mp4", "-i", "cues.srt",
    "-map", "0:v:0", "-map", "0:a:0", "-map", "1:0",
    "-c:v", "copy", "-c:a", "copy", "-c:s", "mov_text", "-movflags", "+faststart", "timeline.mp4"
  ]);
  const font = "C:\\Windows\\Fonts\\msyh.ttc";
  assert.equal(fs.existsSync(font), true, "the fixture needs a CJK font to rasterise the cue like the real chain does");
  const style = "FontName=Microsoft YaHei,FontSize=30,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=3,Outline=2,MarginV=40";
  for (const [target, extra] of [[burned, []], [burnedEmpty, ["-vf", "null"]]]) {
    const args = [
      "-y", "-i", "raw.mp4",
      ...(extra.length ? extra : ["-vf", `subtitles=cues.srt:force_style='${style}':fontsdir=.`]),
      "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-r", "30",
      "-c:a", "copy", "-movflags", "+faststart", path.basename(target)
    ];
    await ffmpeg(args);
  }
  return { soft, burned, burnedEmpty };
}

try {
  const media = await buildProgramme();
  const softProbe = await probe(media.soft);
  const duration = Number(softProbe.format.duration);

  // ---- D1a: negative control - the fixture yardstick must still fail a 4s programme --------------
  const strict = await qcLocalRender({ file: media.soft, spec: REN11_FIXTURE_SPEC, expectation: { cues, tones: null, shots: null }, ffprobePath: FFPROBE, ffmpegPath: FFMPEG });
  const strictDuration = strict.checks.find((check) => check.code === "DURATION");
  assert.equal(strictDuration.ok, false, "a 4s programme judged against the fixture's 15s spec must fail DURATION");
  assert.equal(strictDuration.expected, 15);
  assert.equal(strict.verdict, "fail");

  // ---- D1b: the run's own spec passes the same bytes --------------------------------------------
  const runSpec = outputSpecFromBrief(brief);
  assert.equal(runSpec.total_seconds, 4);
  assert.equal(runSpec.width, 1280);
  assert.equal(runSpec.height, 720);
  assert.equal(runSpec.fps, 30);
  assert.deepEqual(runSpec.shot_windows, [{ index: 1, key: "shot-1", start: 0, end: 4 }]);
  const own = await qcLocalRender({ file: media.soft, burnedFile: media.burned, spec: runSpec, expectation: { cues, tones: null, shots: null }, ffprobePath: FFPROBE, ffmpegPath: FFMPEG });
  const ownDuration = own.checks.find((check) => check.code === "DURATION");
  assert.equal(ownDuration.ok, true, `run-spec DURATION must pass: measured=${ownDuration.measured} expected=${ownDuration.expected}`);
  assert.equal(ownDuration.basis, "brief.duration_seconds");
  assert.equal(own.verdict, "pass", `expected a pass, failed: ${own.failed_checks.join(", ")}`);
  assert.equal(own.not_applied_checks.length > 0, true, "fixture-only expectations must stay declared as not applicable");

  // ---- D2a: probe selection on a single cue -----------------------------------------------------
  const singleCue = pickBurnInProbe({ cues, duration_seconds: 4 });
  assert.equal(singleCue.cue_index, 0);
  assert.equal(singleCue.gap_measurable, true);
  assert.equal(singleCue.selection, "first_cue_with_a_measurable_gap");
  assert.equal(singleCue.in_cue_time > 0.5 && singleCue.in_cue_time < 3.5, true, `in-cue sample must sit inside the cue: ${singleCue.in_cue_time}`);
  assert.equal(singleCue.gap_time > 3.5 && singleCue.gap_time < 4, true, `gap sample must sit in the gap after the cue: ${singleCue.gap_time}`);
  assert.equal(pickBurnInProbe({ cues: [], duration_seconds: 4 }), null);

  // ---- D2b: a cue that covers the programme has no measurable gap -> not-applicable, not "pass" --
  const covering = pickBurnInProbe({ cues: [{ index: 1, start: 0, end: 4, text: "全覆盖" }], duration_seconds: 4 });
  assert.equal(covering.gap_measurable, false);
  assert.equal(covering.gap_time, null);
  const covered = await qcLocalRender({
    file: media.soft,
    burnedFile: media.burned,
    spec: runSpec,
    expectation: { cues: [{ index: 1, start: 0, end: 4, text: cues[0].text }], tones: null, shots: null },
    ffprobePath: FFPROBE,
    ffmpegPath: FFMPEG
  });
  const absent = covered.checks.find((check) => check.code === "BURNED_SUBTITLE_ABSENT_IN_GAP");
  assert.equal(absent.applied, false, "without an ink-free stretch the absence check must be declared not applicable");
  assert.equal(covered.failed_checks.includes("BURNED_SUBTITLE_ABSENT_IN_GAP"), false);

  // ---- D2': the instrument still detects a burn-in that is really missing -----------------------
  const noInk = await qcLocalRender({ file: media.soft, burnedFile: media.burnedEmpty, spec: runSpec, expectation: { cues, tones: null, shots: null }, ffprobePath: FFPROBE, ffmpegPath: FFMPEG });
  const noInkCheck = noInk.checks.find((check) => check.code === "BURNED_SUBTITLE_PRESENT");
  assert.equal(noInkCheck.ok, false, "a burn-in variant without burned ink must fail BURNED_SUBTITLE_PRESENT");
  assert.equal(noInk.verdict, "fail");
  assert.equal(noInkCheck.detail.includes("could not be measured"), false, "the probe must measure the band, not fail to find a cue");

  // ---- D2'': a short single-cue timing anomaly is still detected --------------------------------
  const timingOff = await qcLocalRender({
    file: media.soft,
    spec: runSpec,
    expectation: { cues: [{ index: 1, start: 0.5, end: 2.5, text: cues[0].text }], tones: null, shots: null },
    ffprobePath: FFPROBE,
    ffmpegPath: FFMPEG
  });
  assert.equal(timingOff.failed_checks.includes("SUBTITLE_TIMING"), true, "cue timing must still be checked against the run's own plan");

  console.log(JSON.stringify({
    fixture: "ren11-runtime-spec-qc",
    media_duration_seconds: Number(duration.toFixed(3)),
    fixture_spec_duration: 15,
    run_spec: { total_seconds: runSpec.total_seconds, geometry: `${runSpec.width}x${runSpec.height}`, fps: runSpec.fps },
    checks: {
      fixture_yardstick_fails_4s: strict.failed_checks,
      run_spec_passes: own.verdict,
      burn_probe: singleCue,
      covering_cue_not_applicable: absent.code,
      missing_ink_detected: noInkCheck.detail,
      timing_anomaly_detected: true
    }
  }, null, 2));
  console.log("ren11 runtime spec qc test passed");
} finally {
  await fs.promises.rm(tmp, { recursive: true, force: true });
}
