import fs from "node:fs";
import { resolveOutputRoot } from "./ren11-paths.mjs";
import path from "node:path";
import { buildLocalFixturePackage } from "../src/sop-v2-fixture.js";

const outputRoot = resolveOutputRoot(process.argv[2] ?? null);
const workDir = path.join(outputRoot, "_work", "fixture-smoke");
const outDir = path.join(outputRoot, "fixture-smoke");
fs.mkdirSync(workDir, { recursive: true });

const built = await buildLocalFixturePackage({
  workDir,
  outputDir: outDir,
  onStage: (event) => console.log(`[stage] ${event.stage} ${event.status}${event.count ? ` count=${event.count}` : ""}`)
});
console.log(JSON.stringify({
  manifest_path: built.manifest_path,
  master: built.master.probe,
  soft: built.deliverables.soft_subtitle.probe,
  burned: built.deliverables.burned_subtitle.probe,
  defective: built.defective_control?.probe ?? null
}, null, 2));
