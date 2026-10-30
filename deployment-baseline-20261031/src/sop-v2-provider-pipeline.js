/**
 * REN-11 fix round: provider result → real post-production chain.
 *
 * The defect this module removes: `providerGeneration` recorded only a job list while the downstream
 * stages still read the *local fixture* structure, so a paid run could not actually reach audio /
 * subtitle / edit / QC / export / delivery without being silently swapped for local media (and
 * `importArtifacts` refused `source=provider_job` outright).
 *
 * What this module produces is a normalized programme built from the provider's own output files:
 *   * every provider clip is conformed to the run's output spec (scale + pad + fps) and to its shot's
 *     declared duration,
 *   * the clips are concatenated into the continuous programme (`base_video`),
 *   * the cue plan is derived from the brief, not from the fixture constant,
 *   * and the audio provenance of each shot is *declared* (`provider` vs `synthesized_silence`) rather
 *     than hidden, because “the provider gave us silence” and “we inserted silence” are different
 *     facts and a delivery report must not confuse them.
 *
 * The QC negative control stays local on purpose: it is test instrumentation, not a provider output,
 * and it is labelled as such wherever it appears.
 */
import fs from "node:fs";
import path from "node:path";
import {
  REN11_FIXTURE_SPEC,
  concatShots,
  ensureScratchFont,
  ffprobeJson,
  fileFact,
  generateDefectiveFixture,
  probeSummary,
  runFfmpeg,
  sha256File
} from "./sop-v2-media.js";

/** Cue plan built from the *brief*, so a provider run is not tied to the fixture's 5s constant. */
export function cuePlanFromShots(shots) {
  let cursor = 0;
  return shots.map((shot, index) => {
    const start = cursor;
    const end = cursor + Number(shot.seconds);
    cursor = end;
    return {
      index: index + 1,
      start: Number((start + 0.5).toFixed(3)),
      end: Number((end - 0.5).toFixed(3)),
      text: shot.cue_text ?? `${shot.key}：${shot.intent ?? ""}`.trim()
    };
  });
}

function relFor(cwd, target) {
  const relative = path.relative(cwd, target);
  if (!relative || relative.startsWith("..")) throw new Error(`output ${target} must live inside ${cwd}`);
  return relative.split(path.sep).join("/");
}

/**
 * Conform one provider clip to the programme spec.
 *
 * Aspect handling is pad-only (never crop): cropping a provider frame would silently remove picture
 * the shot was approved for, while padding states plainly that the frame did not match the spec.
 */
export async function conformProviderShot({
  sourcePath,
  outputPath,
  seconds,
  spec = REN11_FIXTURE_SPEC,
  workDir,
  ffmpegPath = null,
  ffprobePath = null
} = {}) {
  if (!sourcePath || !fs.existsSync(sourcePath)) throw new Error(`provider clip is missing on disk: ${sourcePath}`);
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const sourceProbe = probeSummary(await ffprobeJson(sourcePath, { ffprobePath }));
  if (!sourceProbe.video) throw new Error(`provider clip has no video stream: ${sourcePath}`);
  const hasAudio = Boolean(sourceProbe.audio);
  const sourceDuration = Number.isFinite(sourceProbe.duration_seconds) ? sourceProbe.duration_seconds : 0;

  const filters = [
    `scale=${spec.width}:${spec.height}:force_original_aspect_ratio=decrease`,
    `pad=${spec.width}:${spec.height}:(ow-iw)/2:(oh-ih)/2:color=black`,
    "setsar=1",
    `fps=${spec.fps}`
  ];
  // A clip shorter than its shot is extended by cloning its last frame; the fact is recorded so a
  // reviewer can see the programme is not made only of provider-rendered frames.
  const shortfall = Math.max(0, Number(seconds) - sourceDuration);
  if (shortfall > 0.05) filters.push(`tpad=stop_mode=clone:stop_duration=${shortfall.toFixed(3)}`);

  const scratchOut = path.join(workDir, `_conform-${path.basename(outputPath)}`);
  const args = [
    "-y", "-i", path.resolve(sourcePath),
    ...(hasAudio ? [] : ["-f", "lavfi", "-i", `anullsrc=channel_layout=stereo:sample_rate=${spec.audio_sample_rate}`]),
    "-map", "0:v:0", "-map", hasAudio ? "0:a:0" : "1:a:0",
    "-vf", filters.join(","),
    "-t", String(seconds),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", spec.pix_fmt,
    "-r", String(spec.fps), "-g", String(spec.fps * 2),
    "-c:a", spec.audio_codec, "-b:a", spec.audio_bitrate, "-ar", String(spec.audio_sample_rate), "-ac", String(spec.audio_channels),
    "-movflags", "+faststart",
    relFor(workDir, scratchOut)
  ];
  const result = await runFfmpeg(args, { cwd: workDir, ffmpegPath, timeoutMs: 600000 });
  if (result.code !== 0) throw new Error(`provider clip conform failed (${sourcePath}): ${result.stderr.slice(-1200)}`);
  fs.renameSync(scratchOut, outputPath);
  const probe = probeSummary(await ffprobeJson(outputPath, { ffprobePath }));
  return {
    path: outputPath,
    sha256: await sha256File(outputPath),
    ...fileFact(outputPath),
    probe,
    source_path: sourcePath,
    source_sha256: await sha256File(sourcePath),
    source_duration_seconds: sourceDuration,
    audio_source: hasAudio ? "provider" : "synthesized_silence",
    duration_padded_seconds: Number(shortfall.toFixed(3)),
    scale_pad: { target: `${spec.width}x${spec.height}`, source: sourceProbe.video ? `${sourceProbe.video.width}x${sourceProbe.video.height}` : null, mode: "pad_only_no_crop" }
  };
}

/**
 * Build the normalized programme facts for a paid run from the queue's completed jobs.
 *
 * @param {object} input
 * @param {Array} input.jobs                 one entry per shot: { shot_key, seconds, job_id, state,
 *                                           provider_request_id, download_files, ingested }
 * @param {object} input.spec                output spec
 * @param {string} input.workDir             scratch dir
 * @param {string} input.outputDir           where the normalized programme lands
 */
export async function buildProviderProgramme({
  jobs,
  brief,
  spec = REN11_FIXTURE_SPEC,
  workDir,
  outputDir,
  ffmpegPath = null,
  ffprobePath = null
} = {}) {
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });
  // One scratch dir for the whole build: the media primitives require every input and output of one
  // build to live inside that build's working directory, so conforming, concatenating and the QC control
  // all happen here, and only the finished files are placed into the final media directory.
  const stagingDir = path.join(workDir, "programme");
  fs.rmSync(stagingDir, { recursive: true, force: true });
  fs.mkdirSync(stagingDir, { recursive: true });
  const shotsDir = path.join(stagingDir, "provider-shots");
  fs.mkdirSync(shotsDir, { recursive: true });

  const shotPlans = brief.shots.map((shot) => ({ ...shot }));
  const shots = [];
  for (const [index, plan] of shotPlans.entries()) {
    const job = jobs.find((item) => item.shot_key === plan.key);
    if (!job) throw new Error(`no provider job for shot ${plan.key}`);
    if (!job.download_files || job.download_files.length === 0) {
      throw new Error(`provider job ${job.job_id} for shot ${plan.key} produced no downloadable output`);
    }
    const conformed = await conformProviderShot({
      sourcePath: job.download_files[0].path,
      outputPath: path.join(shotsDir, `${plan.key}.mp4`),
      seconds: plan.seconds,
      spec,
      workDir: stagingDir,
      ffmpegPath,
      ffprobePath
    });
    shots.push({
      index: index + 1,
      key: plan.key,
      label: `${plan.key} (provider)`,
      seconds: plan.seconds,
      intent: plan.intent,
      motion: null,
      tone_hz: null,
      provider_job_id: job.job_id,
      provider_request_id: job.provider_request_id ?? null,
      provider_asset_id: job.ingested?.[0]?.asset_id ?? null,
      provider_asset_version_id: job.ingested?.[0]?.asset_version_id ?? null,
      file: conformed
    });
  }

  const stagedBase = await concatShots({ shotPaths: shots.map((shot) => shot.file.path), outputPath: path.join(stagingDir, "provider-programme.mp4"), workDir: stagingDir, ffmpegPath });
  const baseVideoPath = path.join(outputDir, "provider-programme.mp4");
  fs.rmSync(baseVideoPath, { force: true });
  fs.renameSync(stagedBase.path, baseVideoPath);
  const base = { ...stagedBase, path: baseVideoPath, sha256: await sha256File(baseVideoPath), ...fileFact(baseVideoPath) };

  // Local QC instrumentation. Not provider media, and named so that no report can mistake it.
  const stagedDefective = await generateDefectiveFixture({ outputPath: path.join(stagingDir, "local-qc-negative-control.mp4"), workDir: stagingDir, ffmpegPath });
  const defectivePath = path.join(outputDir, "local-qc-negative-control.mp4");
  fs.rmSync(defectivePath, { force: true });
  fs.renameSync(stagedDefective.path, defectivePath);
  const defective = { ...stagedDefective, path: defectivePath, sha256: await sha256File(defectivePath), ...fileFact(defectivePath) };

  return {
    base_video: { ...base, probe: probeSummary(await ffprobeJson(base.path, { ffprobePath })) },
    shots,
    cues: cuePlanFromShots(shotPlans),
    defective_control: { ...defective, probe: probeSummary(await ffprobeJson(defective.path, { ffprobePath })), instrument: "local_qc_negative_control" },
    font: await ensureScratchFont(workDir)
  };
}
