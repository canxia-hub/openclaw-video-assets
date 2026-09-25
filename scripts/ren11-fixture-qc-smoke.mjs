import fs from "node:fs";
import { resolveOutputRoot } from "./ren11-paths.mjs";
import path from "node:path";
import { buildLocalFixturePackage } from "../src/sop-v2-fixture.js";
import { qcLocalRender, qcVerdictLine } from "../src/sop-v2-qc.js";

const outputRoot = resolveOutputRoot(process.argv[2] ?? null);
const workDir = path.join(outputRoot, "_work", "fixture-qc-smoke");
const outDir = path.join(outputRoot, "fixture-qc-smoke");
fs.mkdirSync(workDir, { recursive: true });

const built = await buildLocalFixturePackage({ workDir, outputDir: outDir });
const qc = await qcLocalRender({
  file: built.deliverables.soft_subtitle.path,
  burnedFile: built.deliverables.burned_subtitle.path
});
const badQc = built.defective_control
  ? await qcLocalRender({ file: built.defective_control.path })
  : null;

console.log(JSON.stringify({
  master: built.master.probe,
  soft: qcVerdictLine(qc),
  failed: qc.checks.filter((c) => !c.ok),
  shot_facts: qc.shot_facts,
  tone_facts: qc.tone_facts.map((t) => ({ shot: t.shot, dominant_hz: t.dominant_hz })),
  burn_in: qc.burn_in && { in_cue: qc.burn_in.in_cue.luma_stddev, in_gap: qc.burn_in.in_gap.luma_stddev },
  negative_control: badQc && { verdict: badQc.verdict, failed_checks: badQc.failed_checks }
}, null, 2));
process.exitCode = qc.passed && badQc && badQc.verdict === "fail" ? 0 : 1;
