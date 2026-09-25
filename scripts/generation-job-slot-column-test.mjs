/**
 * REN-11 fix round regression fixture (D5): `generation_jobs.slot_shape_id` must exist, be written, and
 * be backfilled for rows created before the column existed.
 *
 * Why it matters operationally: `request_json` and the canvas output card both carried the slot, but the
 * job row did not - so `SELECT * FROM generation_jobs` (the operator's view of a paid run) could not say
 * which canvas slot the output belonged to, and the acceptance check `JOB_BOUND_TO_CANVAS_SLOT` failed
 * even though the output had been written back correctly.
 *
 * No provider call, no ffmpeg: the three write paths are exercised directly.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VideoAssetService } from "../src/service.js";
import { withTrustedContext } from "../src/provider-gateway.js";

const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ren11-slot-column-"));
const quiet = { log: () => {}, debug: () => {}, warn: () => {}, error: () => {} };
const ctx = { trusted: true, actor_id: "agent:tuan", actor_type: "agent", surface: "tool", scopes: ["operator.read", "operator.write"] };
const call = (input) => withTrustedContext(input, ctx);

const svc = await new VideoAssetService({
  pluginConfig: {
    repositoryRoot: path.join(tmp, "repo"),
    generationJobs: { enabled: true, maxCredits: 1000, maxConcurrent: 1, allowedActors: ["agent:tuan"] },
    security: { generation: { allowSurfaces: ["tool"], allowActors: ["*"], ledger: "memory", budget: { totalCredits: 1000, estimates: { "dreamina.video.generate": 100 } } } }
  },
  logger: quiet
}).init();

const results = {};
try {
  const columns = svc.db.prepare("PRAGMA table_info(generation_jobs)").all().map((column) => column.name);
  assert.equal(columns.includes("slot_shape_id"), true, "generation_jobs must carry a slot_shape_id column");
  results.column_present = true;

  const project = svc.createProject({ title: "REN-11 slot column fixture" });
  const canvas = svc.createCanvas({ project_id: project.project_id, title: "slot column canvas" });
  const slot = svc.createGenerationSlot({
    canvas_id: canvas.canvas_id,
    slot: "draft_output",
    generation_type: "image_to_video",
    shape_id: "shape_slot_column_fixture",
    title: "slot column fixture slot",
    status: "ready",
    x: 1140,
    y: 330,
    width: 320,
    height: 150
  });

  // ---- 1. the insert path records the slot on the row ------------------------------------------
  const job = svc.createGenerationJob(call({
    idempotency_key: "ren11:slot-column:1",
    entry: "dreamina.video.generate",
    provider: "dreamina_cli",
    project_id: project.project_id,
    canvas_id: canvas.canvas_id,
    confirm_cost: true,
    estimate_credits: 100,
    request: { generation_type: "image_to_video", prompt: "slot column fixture", duration: 3, slot_shape_id: slot.shape_id }
  }));
  const inserted = svc.db.prepare("SELECT slot_shape_id FROM generation_jobs WHERE job_id = ?").get(job.job_id);
  assert.equal(inserted.slot_shape_id, slot.shape_id, "the job row must record the slot declared in the request");
  assert.equal(job.slot_shape_id, slot.shape_id, "the job object returned to callers must expose the slot");
  results.insert_path = inserted.slot_shape_id;

  // ---- 2. the writeback phase commits the slot the output actually landed in --------------------
  const lateSlot = svc.createGenerationSlot({
    canvas_id: canvas.canvas_id,
    slot: "draft_output",
    generation_type: "image_to_video",
    shape_id: "shape_slot_column_late",
    title: "late slot",
    status: "ready",
    x: 1140,
    y: 520,
    width: 320,
    height: 150
  });
  svc.generationJobs.commitPhaseResult(job.job_id, "writeback", { target: "canvas_generation_slot", canvas_id: canvas.canvas_id, slot_shape_id: lateSlot.shape_id });
  const afterWriteback = svc.db.prepare("SELECT slot_shape_id, result_json FROM generation_jobs WHERE job_id = ?").get(job.job_id);
  assert.equal(afterWriteback.slot_shape_id, lateSlot.shape_id, "the writeback phase must persist the slot it wrote into");
  assert.equal(JSON.parse(afterWriteback.result_json).writeback.slot_shape_id, lateSlot.shape_id);
  results.writeback_path = afterWriteback.slot_shape_id;

  // ---- 3. rows from the previous build are backfilled from their own request_json ----------------
  const legacyId = "job_fixture_legacy_slot";
  const now = new Date().toISOString();
  svc.db.prepare(`INSERT INTO generation_jobs
    (job_id,idempotency_key,request_hash,entry,provider,surface,actor_id,actor_type,project_id,canvas_id,slot_shape_id,state,phase,request_json,plan_json,estimated_credits,reserved_credits,actual_credits,budget_state,provider_request_id,provider_submit_state,result_json,error_code,error_message,failed_phase,local_cancel_requested,remote_cancel_state,submit_attempts,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,NULL,'completed','completed',?,'{}',100,100,48,'committed','submit-legacy','submitted','{}',NULL,NULL,NULL,0,'not_requested',1,?,?)`)
    .run(legacyId, "ren11:slot-column:legacy", "legacy-hash", "dreamina.video.generate", "dreamina_cli", "tool", "agent:tuan", "agent", project.project_id, canvas.canvas_id, JSON.stringify({ generation_type: "image_to_video", slot_shape_id: slot.shape_id }), now, now);
  const beforeBackfill = svc.db.prepare("SELECT slot_shape_id FROM generation_jobs WHERE job_id = ?").get(legacyId);
  assert.equal(beforeBackfill.slot_shape_id, null, "the fixture must start from a row written by the older build");
  const backfilled = svc.generationJobs.ensureSlotColumn();
  const afterBackfill = svc.db.prepare("SELECT slot_shape_id FROM generation_jobs WHERE job_id = ?").get(legacyId);
  assert.equal(backfilled >= 1, true, "the migration must report what it backfilled");
  assert.equal(afterBackfill.slot_shape_id, slot.shape_id, "a legacy row must be backfilled from its own request_json");
  results.backfill = { rows_backfilled: backfilled, slot_shape_id: afterBackfill.slot_shape_id };

  // ---- 4. the operational question the column exists to answer ----------------------------------
  const bound = svc.db.prepare("SELECT job_id, canvas_id, slot_shape_id FROM generation_jobs WHERE canvas_id = ? AND slot_shape_id IS NOT NULL").all(canvas.canvas_id);
  assert.equal(bound.length >= 2, true, "every job bound to a canvas slot must be findable without parsing JSON");
  results.slot_bound_rows = bound.length;

  console.log(JSON.stringify({ fixture: "generation-job-slot-column", ...results }, null, 2));
  console.log("generation job slot column test passed");
} finally {
  svc.close();
  await fs.promises.rm(tmp, { recursive: true, force: true });
}
