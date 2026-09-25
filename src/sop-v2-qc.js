/**
 * REN-11 QC: runtime verification of the locally rendered acceptance package.
 *
 * The rule this module enforces (and that the orchestrator relies on) is: **a failed check never
 * yields a deliverable label**. Every check records what was actually measured next to what the
 * brief asked for, so a reader can re-derive the verdict instead of trusting it.
 */
import {
  REN11_FIXTURE_SPEC,
  REN11_SHOTS,
  decodeCheck,
  dominantToneAt,
  extractSubtitleStream,
  ffprobeJson,
  frameRegionStats,
  parseSrt,
  probeSummary,
  ren11CuePlan,
  shotProbeTime
} from "./sop-v2-media.js";

const COLOUR_TOLERANCE = 46; // per-channel mean deviation accepted for a synthetic flat background
const SHOT_SEPARATION = 40;  // Euclidean RGB separation two shots must exceed to count as distinct
const DURATION_TOLERANCE = 0.35;
/** Shortest stretch of programme without subtitle ink that can be sampled as the "no ink" control. */
export const BURN_IN_MIN_GAP_SECONDS = 0.2;

function push(checks, code, ok, detail, extra = {}) {
  checks.push({ code, ok: ok === true, applied: true, detail, ...extra });
  return ok === true;
}

/**
 * A check that does not apply to this media, recorded so the gap is visible instead of looking passed.
 *
 * Fixture-only expectations (a synthetic tone grid, a configured flat background colour) say nothing
 * about supplier footage, so applying them to a paid run would fail it for not being the fixture. The
 * check is kept in the report with `applied: false` and a reason, and it never counts towards the
 * verdict - "not measured" must not be readable as "measured and fine".
 */
function skip(checks, code, detail, extra = {}) {
  checks.push({ code, ok: null, applied: false, detail, ...extra });
}

function channelDistance(a, b) {
  return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
}

/** Euclidean RGB distance: a flat "all channels differ a little" pair is still one colour to a
 * viewer, which a max-channel metric would over-report. */
function rgbDistance(a, b) {
  return Number(Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2).toFixed(2));
}

/**
 * Where to sample the burn-in band, and what to compare the sample against.
 *
 * The defect this replaces: the probe hardcoded `cues[1]`, which assumed (a) a run with at least two
 * cues and (b) that the second cue is followed by a gap inside the programme. On the real-machine paid
 * run (one 4s shot, one cue) `cues[1]` was undefined and the check failed with
 * "Cannot read properties of undefined (reading 'start')" - attributed to a missing burn-in rather
 * than to a broken instrument. Selection is therefore explicit and reported:
 *   * the first cue with a measurable gap after it is used (comparing ink vs no ink stays honest), and
 *   * when no cue has a gap inside the programme the check is declared not applicable instead of being
 *     answered from a sample that cannot mean what it claims.
 *
 * @param {{cues?: Array, duration_seconds?: number|null}} input
 */
export function pickBurnInProbe({ cues = [], duration_seconds = null } = {}) {
  const list = (Array.isArray(cues) ? cues : []).filter((cue) => cue
    && Number.isFinite(Number(cue.start))
    && Number.isFinite(Number(cue.end))
    && Number(cue.end) >= Number(cue.start));
  if (list.length === 0) return null;
  const normalized = list.map((cue, index) => ({ index, start: Number(cue.start), end: Number(cue.end), text: cue.text ?? null }));
  const declared = Number(duration_seconds);
  const duration = Number.isFinite(declared) && declared > 0 ? declared : normalized[normalized.length - 1].end;
  const gaps = normalized.map((cue, index) => {
    const next = normalized[index + 1] ?? null;
    const limit = next ? next.start : duration;
    return { index, gap: Number((limit - cue.end).toFixed(3)), limit, gap_after: next ? "next_cue" : "programme_end" };
  });
  const withGap = gaps.find((item) => item.gap >= BURN_IN_MIN_GAP_SECONDS) ?? null;
  const chosen = withGap ?? gaps[gaps.length - 1];
  const cue = normalized[chosen.index];
  const span = Math.max(0, cue.end - cue.start);
  const hasGap = Boolean(withGap);
  return {
    cue_index: chosen.index,
    cue_count: normalized.length,
    cue_window: { start: cue.start, end: cue.end },
    cue_text: cue.text,
    // Inside the cue, but never past its midpoint, and < 1s in so a short cue is still probed.
    in_cue_time: Number((cue.start + Math.min(1, span / 2)).toFixed(3)),
    gap_time: hasGap ? Number((cue.end + Math.min(0.3, chosen.gap / 2)).toFixed(3)) : null,
    gap_seconds: chosen.gap,
    gap_after: chosen.gap_after,
    selection: hasGap ? "first_cue_with_a_measurable_gap" : "last_cue_no_gap_available",
    gap_measurable: hasGap,
    reason: hasGap
      ? null
      : 'no cue in this programme is followed by an ink-free stretch, so "absence between cues" cannot be measured'
  };
}

/**
 * @param {object} input
 * @param {string} input.file           master file with soft subtitles (the acceptance render)
 * @param {string} [input.burnedFile]   burn-in variant, checked for cue presence/absence
 * @param {object} [input.spec]         output spec (geometry, duration, codecs). Defaults to the local
 *   fixture spec; a real run must pass its own (see `outputSpecFromBrief`), because judging a run
 *   against the fixture's 15s/3-shot shape fails it for not being the fixture.
 * @param {number} [input.subtitle_band_height] reserved band height measured at the frame bottom
 */
/**
 * @param {object} input
 * @param {string} input.file           master file with soft subtitles (the acceptance render)
 * @param {string} [input.burnedFile]   burn-in variant, checked for cue presence/absence
 * @param {object} [input.spec]         output spec (geometry, duration, codecs)
 * @param {object|null} [input.expectation] what this media is expected to contain. `null` (the default)
 *   means "the local fixture", i.e. every check applies. A run that produced media from another source
 *   passes `{ cues, tones: null, shots: null }`: `cues` still apply (they are the run's own plan) while
 *   the fixture-only palette and tone checks are recorded as not applicable.
 */
export async function qcLocalRender({ file, burnedFile = null, spec = REN11_FIXTURE_SPEC, expectation = null, ffmpegPath = null, ffprobePath = null } = {}) {
  const checks = [];
  const fixtureExpectations = expectation === null;
  const cues = expectation?.cues ?? ren11CuePlan(spec);
  const paletteApplies = fixtureExpectations || Array.isArray(expectation.shots);
  const tonesApply = fixtureExpectations || Array.isArray(expectation.tones);
  const expectedShots = paletteApplies && !fixtureExpectations ? expectation.shots : REN11_SHOTS;
  const expectedTones = tonesApply && !fixtureExpectations ? expectation.tones : REN11_SHOTS;
  const probe = await ffprobeJson(file, { ffprobePath });
  const summary = probeSummary(probe);
  // Record the yardstick next to the measurements: a duration/geometry verdict is only re-derivable if
  // the reader knows which spec (fixture shape vs this run's brief) it was compared against.
  const specBasis = { basis: spec.basis ?? "fixture", duration_basis: spec.duration_basis ?? "spec.total_seconds", shot_windows: spec.shot_windows ?? null };

  push(checks, "VIDEO_STREAM_PRESENT", Boolean(summary.video), "master must carry a video stream", { measured: summary.video });
  if (summary.video) {
    push(checks, "VIDEO_CODEC", summary.video.codec === spec.video_codec, `video codec must be ${spec.video_codec}`, {
      measured: summary.video.codec,
      expected: spec.video_codec
    });
    push(checks, "RESOLUTION", summary.video.width === spec.width && summary.video.height === spec.height,
      `resolution must be ${spec.width}x${spec.height}`, {
        measured: `${summary.video.width}x${summary.video.height}`,
        expected: `${spec.width}x${spec.height}`
      });
    push(checks, "FRAME_RATE", summary.video.fps !== null && Math.abs(summary.video.fps - spec.fps) < 0.01,
      `frame rate must be ${spec.fps} fps`, { measured: summary.video.fps, expected: spec.fps });
    push(checks, "PIX_FMT", summary.video.pix_fmt === spec.pix_fmt, `pixel format must be ${spec.pix_fmt}`, {
      measured: summary.video.pix_fmt,
      expected: spec.pix_fmt
    });
  }

  push(checks, "DURATION", Number.isFinite(summary.duration_seconds)
    && Math.abs(summary.duration_seconds - spec.total_seconds) <= DURATION_TOLERANCE,
  `container duration must be ${spec.total_seconds}s +/- ${DURATION_TOLERANCE}s (${spec.duration_basis ?? "spec.total_seconds"})`, {
    measured: summary.duration_seconds,
    expected: spec.total_seconds,
    basis: spec.duration_basis ?? "spec.total_seconds"
  });

  push(checks, "AUDIO_STREAM_PRESENT", Boolean(summary.audio), "master must carry an audio stream", { measured: summary.audio });
  if (summary.audio) {
    push(checks, "AUDIO_CODEC", summary.audio.codec === spec.audio_codec, `audio codec must be ${spec.audio_codec}`, {
      measured: summary.audio.codec,
      expected: spec.audio_codec
    });
    push(checks, "AUDIO_SAMPLE_RATE", summary.audio.sample_rate === spec.audio_sample_rate,
      `audio sample rate must be ${spec.audio_sample_rate}`, {
        measured: summary.audio.sample_rate,
        expected: spec.audio_sample_rate
      });
    push(checks, "AUDIO_CHANNELS", summary.audio.channels === spec.audio_channels,
      `audio channel count must be ${spec.audio_channels}`, {
        measured: summary.audio.channels,
        expected: spec.audio_channels
      });
  }

  // ---- subtitles actually inside the container ------------------------------------------------
  push(checks, "SUBTITLE_STREAM_PRESENT", Boolean(summary.subtitle), "master must carry a subtitle stream", { measured: summary.subtitle });
  let extractedCues = null;
  if (summary.subtitle) {
    try {
      extractedCues = parseSrt(await extractSubtitleStream({ file, ffmpegPath }));
    } catch (error) {
      push(checks, "SUBTITLE_EXTRACT", false, `subtitle stream could not be extracted: ${error.message}`);
    }
  }
  if (extractedCues) {
    const sameCount = extractedCues.length === cues.length;
    push(checks, "SUBTITLE_CUE_COUNT", sameCount, `container must hold ${cues.length} cues`, {
      measured: extractedCues.length,
      expected: cues.length
    });
    const textsMatch = sameCount && cues.every((cue, i) => extractedCues[i].text.replace(/\s+/g, "") === cue.text.replace(/\s+/g, ""));
    // libass re-renders the cue into the stream, so spacing may differ; the visible characters must not.
    push(checks, "SUBTITLE_TEXT_MATCH", textsMatch, "cue text read back from the container must match the brief", {
      measured: extractedCues.map((c) => c.text),
      expected: cues.map((c) => c.text)
    });
    const timingOk = sameCount && cues.every((cue, i) => Math.abs(extractedCues[i].start - cue.start) < 0.05
      && Math.abs(extractedCues[i].end - cue.end) < 0.05);
    push(checks, "SUBTITLE_TIMING", timingOk, "cue windows read back from the container must match the brief", {
      measured: extractedCues.map((c) => [Number(c.start.toFixed(3)), Number(c.end.toFixed(3))]),
      expected: cues.map((c) => [c.start, c.end])
    });
  }

  // ---- playability --------------------------------------------------------------------------
  const decode = await decodeCheck({ file, ffmpegPath });
  push(checks, "DECODE_CLEAN", decode.ok, "a full decode pass must complete without errors", { measured: decode });

  // ---- shot identification from pixels -------------------------------------------------------
  const shotFacts = [];
  for (const shot of expectedShots) {
    const probeTime = shotProbeTime(spec, shot.index, Number(spec.shot_seconds) / 2);
    if (!paletteApplies) {
      skip(checks, `SHOT_COLOR_${shot.index}`, "no fixture colour expectation applies to this source", { measured: null, expected: null, reason: "fixture_palette_not_applicable" });
      continue;
    }
    // sample away from the moving accent box: bottom-right quadrant, inset from the border frame
    let stats = null;
    try {
      stats = await frameRegionStats({
        file,
        time: probeTime,
        region: { x: Math.round(spec.width * 0.62), y: Math.round(spec.height * 0.62), w: 320, h: 180 },
        ffmpegPath
      });
    } catch (error) {
      // A file that is too short to hold this probe time is itself a defect; report it as a failed
      // check instead of aborting the whole QC run, so every other defect is still measured.
      push(checks, `SHOT_COLOR_${shot.index}`, false, `could not read a frame at t=${probeTime}s: ${error.message}`, {
        measured: null,
        expected: shot.background_rgb
      });
      shotFacts.push({ shot: shot.key, time: probeTime, stats: null, error: error.message });
      continue;
    }
    shotFacts.push({ shot: shot.key, time: probeTime, stats });
    push(checks, `SHOT_COLOR_${shot.index}`,
      channelDistance(stats.avg_rgb, shot.background_rgb) <= COLOUR_TOLERANCE,
      `${shot.key} background must be within ${COLOUR_TOLERANCE}/255 of its configured colour`, {
        measured: stats.avg_rgb,
        expected: shot.background_rgb
      });
  }
  for (let i = 0; i < shotFacts.length; i += 1) {
    for (let j = i + 1; j < shotFacts.length; j += 1) {
      if (!shotFacts[i].stats || !shotFacts[j].stats) continue;
      const distance = rgbDistance(shotFacts[i].stats.avg_rgb, shotFacts[j].stats.avg_rgb);
      // Distinctness is a real delivery property (two shots that look identical are a defect), so it is
      // measured for every source - it just compares the run's own shots against each other.
      push(checks, `SHOT_DISTINCT_${i + 1}_${j + 1}`, distance > SHOT_SEPARATION,
        `${shotFacts[i].shot} and ${shotFacts[j].shot} must be visually distinguishable`, {
          measured: distance,
          expected: `> ${SHOT_SEPARATION}`
        });
    }
  }

  // ---- audio rhythm from the decoded track ---------------------------------------------------
  const toneFacts = [];
  for (const shot of expectedTones) {
    const probeTime = shotProbeTime(spec, shot.index, 1);
    if (!tonesApply) {
      skip(checks, `AUDIO_TONE_${shot.index}`, "no synthetic tone expectation applies to this source", { measured: null, expected: null, reason: "fixture_tone_not_applicable" });
      continue;
    }
    let tone = null;
    try {
      tone = await dominantToneAt({
        file,
        time: probeTime,
        candidates: REN11_SHOTS.map((s) => s.tone_hz),
        sampleRate: spec.audio_sample_rate,
        ffmpegPath
      });
    } catch (error) {
      push(checks, `AUDIO_TONE_${shot.index}`, false, `could not read audio at t=${probeTime}s: ${error.message}`, {
        measured: null,
        expected: shot.tone_hz
      });
      toneFacts.push({ shot: shot.key, time: probeTime, dominant_hz: null, error: error.message });
      continue;
    }
    toneFacts.push({ shot: shot.key, time: probeTime, ...tone });
    push(checks, `AUDIO_TONE_${shot.index}`, tone.dominant_hz === shot.tone_hz,
      `${shot.key} must carry its own tone (${shot.tone_hz} Hz)`, {
        measured: tone.dominant_hz,
        expected: shot.tone_hz
      });
  }

  // ---- burned-in variant: cue ink present inside the cue window, absent in the gap ------------
  let burnIn = null;
  if (burnedFile) {
    const band = { x: 0, y: Math.round(spec.height * 0.82), w: spec.width, h: 100 };
    const probe = pickBurnInProbe({ cues, duration_seconds: spec.total_seconds });
    if (!probe) {
      push(checks, "BURNED_SUBTITLE_PRESENT", false, "no usable cue window was supplied, so the burn-in band cannot be probed");
    } else {
      try {
        const inCue = await frameRegionStats({ file: burnedFile, time: probe.in_cue_time, region: band, ffmpegPath });
        const inGap = probe.gap_time === null
          ? null
          : await frameRegionStats({ file: burnedFile, time: probe.gap_time, region: band, ffmpegPath });
        burnIn = { band, probe, in_cue: inCue, in_gap: inGap };
        push(checks, "BURNED_SUBTITLE_PRESENT", inCue.luma_stddev > 8,
          `burned-in cue ${probe.cue_index + 1} must put ink in the reserved band while the cue is active`,
          { measured: inCue.luma_stddev, expected: "> 8", probe_time: probe.in_cue_time });
        if (inGap) {
          push(checks, "BURNED_SUBTITLE_ABSENT_IN_GAP", inGap.luma_stddev < inCue.luma_stddev,
            "the reserved band must be visibly cleaner between cues than during a cue", {
              measured: { during_cue: inCue.luma_stddev, between_cues: inGap.luma_stddev },
              probe_time: probe.gap_time
            });
        } else {
          // No ink-free stretch exists in this programme (a single cue that covers it), so the
          // "absent" half is not measurable. Recorded as a gap, never as a pass.
          skip(checks, "BURNED_SUBTITLE_ABSENT_IN_GAP", probe.reason, { measured: { during_cue: inCue.luma_stddev }, reason: "no_ink_free_gap_in_programme" });
        }
      } catch (error) {
        push(checks, "BURNED_SUBTITLE_PRESENT", false, `burn-in band could not be measured: ${error.message}`,
          { measured: null, probe });
      }
    }
    const burnProbe = probeSummary(await ffprobeJson(burnedFile, { ffprobePath }));
    push(checks, "BURNED_VARIANT_SPEC", burnProbe.video?.width === spec.width && burnProbe.video?.height === spec.height
      && Math.abs((burnProbe.duration_seconds ?? 0) - spec.total_seconds) <= DURATION_TOLERANCE
      && Boolean(burnProbe.audio),
    `burn-in variant must keep the master geometry (${spec.width}x${spec.height}), duration (${spec.total_seconds}s) and audio track`,
    { measured: burnProbe });
  }

  // Only APPLIED checks decide the verdict: a not-applicable expectation is an explicit gap.
  const applied = checks.filter((c) => c.applied !== false);
  const failed = applied.filter((c) => !c.ok);
  const notApplied = checks.filter((c) => c.applied === false);
  return {
    source: "ren11_local_qc",
    file,
    burned_file: burnedFile,
    spec,
    spec_basis: specBasis,
    expectation: fixtureExpectations ? "local_fixture" : "supplied",
    probe: summary,
    shot_facts: shotFacts,
    tone_facts: toneFacts,
    burn_in: burnIn,
    checks,
    applied_checks: applied.length,
    not_applied_checks: notApplied.map((c) => ({ code: c.code, reason: c.reason ?? null })),
    passed: failed.length === 0,
    failed_checks: failed.map((c) => c.code),
    verdict: failed.length === 0 ? "pass" : "fail"
  };
}

/** Compact QC projection safe to embed in an index/manifest. */
export function qcVerdictLine(qc) {
  return {
    verdict: qc.verdict,
    passed: qc.passed,
    total_checks: qc.checks.length,
    failed_checks: qc.failed_checks,
    spec_basis: qc.spec_basis ?? null,
    duration_seconds: qc.probe?.duration_seconds ?? null,
    resolution: qc.probe?.video ? `${qc.probe.video.width}x${qc.probe.video.height}` : null,
    fps: qc.probe?.video?.fps ?? null,
    video_codec: qc.probe?.video?.codec ?? null,
    audio_codec: qc.probe?.audio?.codec ?? null,
    subtitle_codec: qc.probe?.subtitle?.codec ?? null
  };
}
