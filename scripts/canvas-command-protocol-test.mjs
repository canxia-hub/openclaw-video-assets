/**
 * REN-08: canvas command / revision protocol test (isolated, no server, no browser).
 *
 * What this file is for: the editable canvas is only trustworthy if the concurrency basis underneath it is. Every
 * gesture - drag, box-select, connect, copy, undo, redo - is "apply one command against a known revision", so this
 * test drives that one operation directly and checks the properties the acceptance criteria name:
 *
 *   * a command must state the revision it was composed against, and one composed against a stale revision must be
 *     REPORTED as a conflict rather than applied;
 *   * the loser's edit leaves no trace - not in the rows, not in the revision, not in the command log;
 *   * the revision advances by exactly one per applied command;
 *   * the recorded inverse is enough to undo a command with every reference ID unchanged;
 *   * removing a card does not remove an asset - checked against the object store's bytes, not against a flag;
 *   * viewport and selection writes are VIEW state, not document state, and must not move the revision, or two
 *     people who merely panned would report conflicts on each other's edits;
 *   * the log is a complete description of the document: replaying it onto an empty canvas reproduces the shapes.
 *
 * What this file does NOT claim: nothing here is a browser, a network, or a second process. Two calls sharing one
 * expected_revision model two clients arriving at once; the real two-client case over HTTP is driven separately by
 * tools/canvas-conflict-gates.mjs against a live host.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VideoAssetService } from "../src/service.js";
import { CANVAS_COMMAND_TYPES, normalizeCanvasCommand } from "../src/canvas-commands.js";
import { withTrustedContext } from "../src/provider-gateway.js";

const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ova-canvas-cmd-"));
const repo = path.join(tmp, "repo");
const sourceFile = path.join(tmp, "参考素材.txt");
await fs.promises.writeFile(sourceFile, "canvas command protocol asset", "utf8");

const checks = [];
const check = (id, ok, detail) => {
  checks.push({ id, ok: Boolean(ok), detail });
  if (!ok) throw new Error(`canvas command protocol check failed: ${id} - ${detail}`);
};

/** Byte-level fingerprint of the object store: the honest way to say "removing a card did not touch an asset". */
function objectStoreFingerprint(root) {
  const dir = path.join(root, "asset-repo");
  const entries = [];
  const walk = (current) => {
    if (!fs.existsSync(current)) return;
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.isFile()) continue;
      const bytes = fs.readFileSync(full);
      entries.push(`${path.relative(dir, full).replace(/\\/g, "/")}:${bytes.length}:${crypto.createHash("sha256").update(bytes).digest("hex")}`);
    }
  };
  walk(dir);
  return { count: entries.length, digest: crypto.createHash("sha256").update(entries.join("\n")).digest("hex") };
}

const svc = new VideoAssetService({ pluginConfig: { repositoryRoot: repo } }).init();
try {
  const project = svc.createProject({ title: "命令协议项目" });
  const asset = await svc.ingestAsset({ file_path: sourceFile, title: "命令协议参考素材", kind: "working" });
  const assetVersionId = asset.default_version_id;
  const canvas = svc.createCanvas({ project_id: project.project_id, title: "命令协议画布" });
  const canvasId = canvas.canvas_id;

  // ------------------------------------------------------------------------------------------------
  // 1. The revision exists, starts at zero, and travels with the canvas.
  // ------------------------------------------------------------------------------------------------
  check("a_new_canvas_starts_at_revision_zero", canvas.revision === 0, `createCanvas reported revision ${canvas.revision}`);
  const rev0 = svc.getCanvasRevision({ canvas_id: canvasId });
  check("revision_is_readable_without_the_document", rev0.revision === 0 && rev0.command_count === 0, `getCanvasRevision: ${JSON.stringify(rev0)}`);
  check("canvas_get_reports_the_revision", svc.getCanvas({ canvas_id: canvasId }).revision === 0, "getCanvas carries the revision so a client never needs a second round trip to learn it");

  // ------------------------------------------------------------------------------------------------
  // 2. A command is REQUIRED to state its base revision.
  // ------------------------------------------------------------------------------------------------
  let missingExpected = null;
  try {
    svc.applyCanvasCommand({ canvas_id: canvasId, command: { type: "create_shapes", shapes: [{ shape_id: "shape_guard", shape_type: "note", x: 0, y: 0 }] } });
  } catch (error) {
    missingExpected = error;
  }
  check(
    "a_command_without_expected_revision_is_refused",
    missingExpected?.code === "CANVAS_COMMAND_INVALID" && /expected_revision/.test(String(missingExpected.message)),
    `error: ${missingExpected?.code} ${missingExpected?.message}`
  );
  check("the_refusal_did_not_move_the_revision", svc.getCanvasRevision({ canvas_id: canvasId }).revision === 0, "an invalid command must not claim a revision");

  // ------------------------------------------------------------------------------------------------
  // 3. An unknown command type is REFUSED, never ignored. A silently ignored command would leave the client's
  //    optimistic state showing an edit the document never received.
  // ------------------------------------------------------------------------------------------------
  let unknownType = null;
  try {
    svc.applyCanvasCommand({ canvas_id: canvasId, expected_revision: 0, command: { type: "teleport_shapes", shape_ids: ["x"] } });
  } catch (error) {
    unknownType = error;
  }
  check("an_unknown_command_type_is_refused", unknownType?.code === "CANVAS_COMMAND_INVALID" && /unknown canvas command type/.test(String(unknownType.message)), `error: ${unknownType?.code}`);
  check("the_command_type_set_is_closed", CANVAS_COMMAND_TYPES.length === 6 && CANVAS_COMMAND_TYPES.includes("delete_shapes"), `types: ${CANVAS_COMMAND_TYPES.join(", ")}`);

  // ------------------------------------------------------------------------------------------------
  // 4. Apply a real command: revision +1, recorded in the log, ids chosen by the caller.
  // ------------------------------------------------------------------------------------------------
  const shapeA = "shape_proto_a";
  const shapeB = "shape_proto_b";
  const createCommand = {
    type: "create_shapes",
    shapes: [
      { shape_id: shapeA, shape_type: "asset_card", subject_type: "asset", subject_id: asset.asset_id, title: "卡片 A", x: 100, y: 100, width: 240, height: 120, z_index: 1, props: { beta: 2, alpha: 1 } },
      { shape_id: shapeB, shape_type: "note", title: "卡片 B", x: 500, y: 140, width: 240, height: 120, z_index: 2 }
    ]
  };
  const created = svc.applyCanvasCommand(withTrustedContext({
    canvas_id: canvasId,
    expected_revision: 0,
    command_id: "cmd_proto_create_1",
    client_id: "client-A",
    command: createCommand
  }, { trusted: true, actor_id: "human:protocol-A", actor_type: "human", source: "protocol-test" }));
  check("applying_a_command_advances_the_revision_by_one", created.revision === 1, `revision after one command: ${created.revision}`);
  check("the_result_reports_the_revision_it_claimed_from", created.base_revision === 0, `base_revision: ${created.base_revision}`);
  check("the_created_ids_are_the_ones_the_caller_chose", created.created_shape_ids.join(",") === `${shapeA},${shapeB}`, `created: ${created.created_shape_ids.join(",")}`);
  check("the_revision_is_persisted", svc.getCanvas({ canvas_id: canvasId }).revision === 1, "getCanvas must report the new revision");

  const logAfterCreate = svc.listCanvasCommands({ canvas_id: canvasId, order: "asc" });
  check("the_command_was_recorded", logAfterCreate.command_count === 1 && logAfterCreate.commands[0].command_id === "cmd_proto_create_1", `log: ${JSON.stringify(logAfterCreate.commands.map((c) => c.command_id))}`);
  check("the_log_records_the_base_revision", logAfterCreate.commands[0].base_revision === 0 && logAfterCreate.commands[0].revision === 1, `entry: base=${logAfterCreate.commands[0].base_revision} revision=${logAfterCreate.commands[0].revision}`);
  check("the_log_records_an_inverse", Array.isArray(created.undo_commands) && created.undo_commands.length === 1 && created.undo_commands[0].type === "delete_shapes", `inverse: ${JSON.stringify(created.undo_commands)}`);
  check("the_log_records_the_client", logAfterCreate.commands[0].client_id === "client-A", `client_id: ${logAfterCreate.commands[0].client_id}`);

  // ------------------------------------------------------------------------------------------------
  // 5. THE CORE REQUIREMENT: two clients composed against the same revision. The second must be TOLD it conflicts.
  // ------------------------------------------------------------------------------------------------
  const beforeConflict = svc.getCanvas({ canvas_id: canvasId });
  let conflict = null;
  try {
    svc.applyCanvasCommand({
      canvas_id: canvasId,
      expected_revision: 0, // stale: the document is at 1
      client_id: "client-B",
      command: { type: "move_shapes", positions: [{ shape_id: shapeA, x: 999, y: 999 }] }
    });
  } catch (error) {
    conflict = error;
  }
  check("a_stale_command_is_reported_as_a_conflict", conflict?.code === "CANVAS_REVISION_CONFLICT", `error: ${conflict?.code} ${conflict?.message}`);
  check("the_conflict_carries_status_409", conflict?.status === 409, `status: ${conflict?.status}`);
  check("the_conflict_names_both_revisions", conflict?.details?.expected_revision === 0 && conflict?.details?.actual_revision === 1, `details: ${JSON.stringify(conflict?.details)}`);

  const afterConflict = svc.getCanvas({ canvas_id: canvasId });
  const conflictedShape = afterConflict.shapes.find((shape) => shape.shape_id === shapeA);
  check(
    "the_loser_edit_did_not_land",
    conflictedShape.x === 100 && conflictedShape.y === 100,
    `shape A is at ${conflictedShape.x},${conflictedShape.y}; the conflicting command asked for 999,999`
  );
  check("the_conflict_did_not_move_the_revision", afterConflict.revision === beforeConflict.revision, `revision ${beforeConflict.revision} -> ${afterConflict.revision}`);
  const logAfterConflict = svc.listCanvasCommands({ canvas_id: canvasId });
  check("the_conflict_left_no_log_entry", logAfterConflict.command_count === 1, `log length: ${logAfterConflict.command_count}`);

  // ------------------------------------------------------------------------------------------------
  // 6. A command_id is an idempotency key for ONE normalized command by ONE trusted actor.
  // ------------------------------------------------------------------------------------------------
  const semanticallySameCommandWithDifferentKeyOrder = {
    shapes: [
      { props: { alpha: 1, beta: 2 }, z_index: 1, height: 120, width: 240, y: 100, x: 100, title: "卡片 A", subject_id: asset.asset_id, subject_type: "asset", shape_type: "asset_card", shape_id: shapeA },
      { z_index: 2, height: 120, width: 240, y: 140, x: 500, title: "卡片 B", shape_type: "note", shape_id: shapeB }
    ],
    type: "create_shapes"
  };
  const replayed = svc.applyCanvasCommand(withTrustedContext({
    canvas_id: canvasId,
    expected_revision: 0, // deliberately stale: the recorded command already consumed revision 1
    command_id: "cmd_proto_create_1",
    client_id: "client-A",
    command: semanticallySameCommandWithDifferentKeyOrder
  }, { trusted: true, actor_id: "human:protocol-A", actor_type: "human", source: "protocol-test" }));
  check("the_same_normalized_command_id_replays_for_the_same_trusted_actor", replayed.replayed === true && replayed.revision === 1, `replay: ${JSON.stringify({ replayed: replayed.replayed, revision: replayed.revision })}`);
  check("object_key_order_does_not_break_a_legitimate_retry", replayed.command_id === "cmd_proto_create_1", "canonical comparison ignores object-key order while preserving array order");
  check("the_retry_did_not_move_the_revision", svc.getCanvas({ canvas_id: canvasId }).revision === 1, "an idempotent replay must not consume a revision");

  const stateBeforeIdConflicts = svc.getCanvas({ canvas_id: canvasId });
  const logBeforeIdConflicts = svc.listCanvasCommands({ canvas_id: canvasId }).command_count;
  let payloadConflict = null;
  try {
    svc.applyCanvasCommand(withTrustedContext({
      canvas_id: canvasId,
      expected_revision: 0,
      command_id: "cmd_proto_create_1",
      command: { type: "create_shapes", shapes: [{ shape_id: "shape_should_not_exist", shape_type: "note", x: 0, y: 0 }] }
    }, { trusted: true, actor_id: "human:protocol-A", actor_type: "human", source: "protocol-test" }));
  } catch (error) {
    payloadConflict = error;
  }
  check("the_same_command_id_with_a_different_payload_is_a_409_conflict", payloadConflict?.code === "CANVAS_COMMAND_ID_CONFLICT" && payloadConflict?.status === 409 && payloadConflict?.details?.reason === "different_payload", `error: ${payloadConflict?.code} status ${payloadConflict?.status} reason ${payloadConflict?.details?.reason}`);
  check("the_payload_conflict_created_nothing", !svc.getCanvas({ canvas_id: canvasId }).shapes.some((shape) => shape.shape_id === "shape_should_not_exist"), "the conflicting payload must not create a row");

  let actorConflict = null;
  try {
    svc.applyCanvasCommand(withTrustedContext({ canvas_id: canvasId, expected_revision: 0, command_id: "cmd_proto_create_1", command: createCommand }, { trusted: true, actor_id: "human:protocol-B", actor_type: "human", source: "protocol-test" }));
  } catch (error) {
    actorConflict = error;
  }
  check("another_trusted_actor_cannot_replay_the_command_id", actorConflict?.code === "CANVAS_COMMAND_ID_CONFLICT" && actorConflict?.status === 409 && actorConflict?.details?.reason === "different_actor", `error: ${actorConflict?.code} status ${actorConflict?.status} reason ${actorConflict?.details?.reason}`);

  let spoofedActorConflict = null;
  try {
    svc.applyCanvasCommand({ canvas_id: canvasId, expected_revision: 0, command_id: "cmd_proto_create_1", actor_id: "human:protocol-A", command: createCommand });
  } catch (error) {
    spoofedActorConflict = error;
  }
  check("a_request_body_actor_id_cannot_impersonate_the_trusted_actor", spoofedActorConflict?.code === "CANVAS_COMMAND_ID_CONFLICT" && spoofedActorConflict?.details?.reason === "different_actor", `error: ${spoofedActorConflict?.code} reason ${spoofedActorConflict?.details?.reason}`);
  const stateAfterIdConflicts = svc.getCanvas({ canvas_id: canvasId });
  check("command_id_conflicts_leave_revision_and_document_unchanged", stateAfterIdConflicts.revision === stateBeforeIdConflicts.revision && stateAfterIdConflicts.shapes.length === stateBeforeIdConflicts.shapes.length, `revision ${stateBeforeIdConflicts.revision} -> ${stateAfterIdConflicts.revision}; shapes ${stateBeforeIdConflicts.shapes.length} -> ${stateAfterIdConflicts.shapes.length}`);
  check("command_id_conflicts_leave_no_log_entries", svc.listCanvasCommands({ canvas_id: canvasId }).command_count === logBeforeIdConflicts, `log ${logBeforeIdConflicts} -> ${svc.listCanvasCommands({ canvas_id: canvasId }).command_count}`);

  // ------------------------------------------------------------------------------------------------
  // 7. Connecting two cards, and the removal of a card that also removes its edges - with a faithful inverse.
  // ------------------------------------------------------------------------------------------------
  const edgeId = "edge_proto_1";
  const linked = svc.applyCanvasCommand({
    canvas_id: canvasId,
    expected_revision: 1,
    client_id: "client-A",
    command: { type: "create_edges", edges: [{ edge_id: edgeId, source_shape_id: shapeA, target_shape_id: shapeB, relation_type: "references", label: "参考" }] }
  });
  check("connecting_advances_the_revision", linked.revision === 2, `revision: ${linked.revision}`);
  check("the_edge_exists_with_the_chosen_id", svc.getCanvas({ canvas_id: canvasId }).edges.some((edge) => edge.edge_id === edgeId), "the edge must carry the id the client chose");

  const objectStoreBeforeDelete = objectStoreFingerprint(repo);
  const versionBeforeDelete = svc.getAsset({ asset_id: asset.asset_id }).versions.length;

  const removed = svc.applyCanvasCommand({
    canvas_id: canvasId,
    expected_revision: 2,
    client_id: "client-A",
    command: { type: "delete_shapes", shape_ids: [shapeB] }
  });
  check("removing_a_card_advances_the_revision", removed.revision === 3, `revision: ${removed.revision}`);
  check("removing_a_card_also_removes_its_edges", removed.applied.removed_edge_count === 1, `removed_edge_count: ${removed.applied.removed_edge_count}`);
  check("removing_a_card_removes_the_card", !svc.getCanvas({ canvas_id: canvasId }).shapes.some((shape) => shape.shape_id === shapeB), "the card is gone");
  check(
    "removing_a_card_restores_both_card_and_edge_on_undo",
    removed.undo_commands.length === 2 && removed.undo_commands.some((command) => command.type === "create_shapes") && removed.undo_commands.some((command) => command.type === "create_edges"),
    `inverse: ${JSON.stringify(removed.undo_commands)}`
  );

  // DELETING A CARD MUST NOT DELETE AN ASSET - checked on the bytes, and on the asset library.
  const objectStoreAfterDelete = objectStoreFingerprint(repo);
  check("removing_a_card_left_the_object_store_byte_identical", objectStoreAfterDelete.digest === objectStoreBeforeDelete.digest && objectStoreAfterDelete.count === objectStoreBeforeDelete.count, `objects ${objectStoreBeforeDelete.count} -> ${objectStoreAfterDelete.count}`);
  check("removing_a_card_left_the_asset_readable", svc.getAsset({ asset_id: asset.asset_id }).asset_id === asset.asset_id, "the asset row must still be readable");
  check("removing_a_card_left_the_version_count_unchanged", svc.getAsset({ asset_id: asset.asset_id }).versions.length === versionBeforeDelete, `versions: ${versionBeforeDelete} -> ${svc.getAsset({ asset_id: asset.asset_id }).versions.length}`);
  check(
    "the_delete_command_has_no_asset_vocabulary",
    !/\basset/.test(JSON.stringify(normalizeCanvasCommand({ type: "delete_shapes", shape_ids: [shapeB] }))),
    "a delete_shapes command names canvas rows only, so it cannot reach an asset by construction"
  );
  const deleteAudit = svc.listCommits({ limit: 50 }).find((entry) => entry.action === "canvas.shapes.delete");
  check("the_delete_audit_says_no_assets_were_touched", deleteAudit?.changes?.assets_touched === 0, `audit changes: ${JSON.stringify(deleteAudit?.changes)}`);

  // ------------------------------------------------------------------------------------------------
  // 8. UNDO by applying the recorded inverse - and the IDs come back unchanged.
  // ------------------------------------------------------------------------------------------------
  const undoOne = svc.applyCanvasCommand({
    canvas_id: canvasId,
    expected_revision: 3,
    client_id: "client-A",
    command: removed.undo_commands[0]
  });
  const undoTwo = svc.applyCanvasCommand({
    canvas_id: canvasId,
    expected_revision: undoOne.revision,
    client_id: "client-A",
    command: removed.undo_commands[1]
  });
  check("undo_applies_as_ordinary_commands", undoTwo.revision === 5, `revision after two undo commands: ${undoTwo.revision}`);
  const afterUndo = svc.getCanvas({ canvas_id: canvasId });
  const restoredShape = afterUndo.shapes.find((shape) => shape.shape_id === shapeB);
  check("undo_restored_the_card_with_its_own_id", Boolean(restoredShape), "the card id must be the one that was removed, not a new one");
  check("undo_restored_the_card_position", restoredShape?.x === 500 && restoredShape?.y === 140, `restored at ${restoredShape?.x},${restoredShape?.y}`);
  check("undo_restored_the_edge_with_its_own_id", afterUndo.edges.some((edge) => edge.edge_id === edgeId), "the edge id must be the one that was removed");
  check("undo_restored_the_subject_reference", restoredShape?.title === "卡片 B", `title: ${restoredShape?.title}`);

  // The asset card kept its subject reference through every step.
  const assetCard = afterUndo.shapes.find((shape) => shape.shape_id === shapeA);
  check("reference_ids_survived_the_whole_sequence", assetCard?.subject_id === asset.asset_id && assetCard?.subject_type === "asset", `subject: ${assetCard?.subject_type}/${assetCard?.subject_id}`);

  // ------------------------------------------------------------------------------------------------
  // 9. Viewport and selection are VIEW state: they must not move the document revision.
  // ------------------------------------------------------------------------------------------------
  const revisionBeforeViewWrites = svc.getCanvasRevision({ canvas_id: canvasId }).revision;
  svc.saveCanvasViewState({ canvas_id: canvasId, viewport: { x: 10, y: 20, zoom: 0.75, width: 1280, height: 720 }, source: "workbench_canvas" });
  svc.saveCanvasSelection({ canvas_id: canvasId, selected_shape_ids: [shapeA], primary_shape_id: shapeA, source: "workbench_canvas" });
  const revisionAfterViewWrites = svc.getCanvasRevision({ canvas_id: canvasId }).revision;
  check(
    "viewport_and_selection_do_not_move_the_document_revision",
    revisionAfterViewWrites === revisionBeforeViewWrites,
    `revision ${revisionBeforeViewWrites} -> ${revisionAfterViewWrites}: panning is not an edit`
  );
  check("the_viewport_was_still_saved", svc.getCanvasViewState({ canvas_id: canvasId }).view_state.viewport.zoom === 0.75, "view state must still persist");
  check("the_selection_was_still_saved", svc.getCanvasSelection({ canvas_id: canvasId }).selected_shape_ids.join(",") === shapeA, "selection must still persist");

  // ------------------------------------------------------------------------------------------------
  // 10. A create with an id that already exists is REFUSED, not an upsert: otherwise a redo would destroy the card
  //     it was meant to restore, and the id would silently refer to a different card.
  // ------------------------------------------------------------------------------------------------
  let duplicateCreate = null;
  try {
    svc.applyCanvasCommand({
      canvas_id: canvasId,
      expected_revision: revisionAfterViewWrites,
      command: { type: "create_shapes", shapes: [{ shape_id: shapeA, shape_type: "note", x: 0, y: 0 }] }
    });
  } catch (error) {
    duplicateCreate = error;
  }
  check("creating_an_existing_shape_id_is_refused", duplicateCreate?.code === "CANVAS_COMMAND_INVALID" && duplicateCreate?.status === 409, `error: ${duplicateCreate?.code} status ${duplicateCreate?.status}`);
  check("the_refused_create_left_the_card_alone", svc.getCanvas({ canvas_id: canvasId }).shapes.find((shape) => shape.shape_id === shapeA).x === 100, "the existing card must be untouched");

  // ------------------------------------------------------------------------------------------------
  // 11. A command that cannot be applied must leave the revision alone (the claim is rolled back with the work).
  // ------------------------------------------------------------------------------------------------
  const revisionBeforeFailed = svc.getCanvasRevision({ canvas_id: canvasId }).revision;
  let failedMove = null;
  try {
    // shapeB exists, but this batch also names a shape that does not: the whole command must fail atomically.
    svc.applyCanvasCommand({
      canvas_id: canvasId,
      expected_revision: revisionBeforeFailed,
      command: { type: "move_shapes", positions: [{ shape_id: shapeB, x: 700, y: 700 }, { shape_id: "shape_does_not_exist", x: 1, y: 1 }] }
    });
  } catch (error) {
    failedMove = error;
  }
  check("a_partially_invalid_command_is_refused", failedMove?.code === "CANVAS_COMMAND_INVALID", `error: ${failedMove?.code}`);
  check("the_rejected_command_left_the_revision_alone", svc.getCanvasRevision({ canvas_id: canvasId }).revision === revisionBeforeFailed, `revision ${revisionBeforeFailed} -> ${svc.getCanvasRevision({ canvas_id: canvasId }).revision}`);
  check(
    "the_rejected_command_rolled_back_its_first_change",
    svc.getCanvas({ canvas_id: canvasId }).shapes.find((shape) => shape.shape_id === shapeB).x === 500,
    "the first position in a rejected batch must not have been written"
  );

  // ------------------------------------------------------------------------------------------------
  // 12. THE LOG IS A COMPLETE DESCRIPTION OF THE DOCUMENT: clear the canvas, replay the log, compare.
  //     This is the evidence behind the rollback claim "can replay to the revision before the change".
  //
  //     Note WHY the replay runs on the same canvas rather than on a fresh one: shape_id is the primary key of
  //     canvas_shapes, so an id belongs to exactly one canvas. Replaying onto a second canvas would have to rename
  //     every row, which would prove nothing about the ids the acceptance criteria require to be unchanged.
  //     Clearing this canvas and replaying its own log recreates the rows WITH THEIR OWN IDS.
  // ------------------------------------------------------------------------------------------------
  const live = svc.getCanvas({ canvas_id: canvasId });
  const signatureOf = (canvasDoc) => ({
    shapes: canvasDoc.shapes.map((shape) => `${shape.shape_id}@${shape.x},${shape.y}:${shape.title ?? ""}:${shape.subject_type ?? ""}/${shape.subject_id ?? ""}`).sort().join("|"),
    edges: canvasDoc.edges.map((edge) => `${edge.edge_id}:${edge.source_shape_id}->${edge.target_shape_id}:${edge.relation_type}`).sort().join("|")
  });
  const liveSignature = signatureOf(live);
  const log = svc.listCanvasCommands({ canvas_id: canvasId, order: "asc", limit: 500 });
  check("the_log_covers_every_applied_command", log.command_count === live.revision, `log entries ${log.command_count} vs revision ${live.revision}`);

  const liveShapeIds = live.shapes.map((shape) => shape.shape_id);
  const cleared = svc.applyCanvasCommand({
    canvas_id: canvasId,
    expected_revision: live.revision,
    client_id: "replay-harness",
    command: { type: "delete_shapes", shape_ids: liveShapeIds }
  });
  check("the_replay_can_start_from_an_empty_canvas", svc.getCanvas({ canvas_id: canvasId }).shapes.length === 0, "the canvas must be empty before the replay");

  let replayRevision = cleared.revision;
  for (const entry of log.commands) {
    replayRevision = svc.applyCanvasCommand({ canvas_id: canvasId, expected_revision: replayRevision, client_id: "replay-harness", command: entry.command }).revision;
  }
  const replayedCanvas = svc.getCanvas({ canvas_id: canvasId });
  const replayedSignature = signatureOf(replayedCanvas);
  check("replaying_the_log_reproduces_the_shapes", liveSignature.shapes === replayedSignature.shapes, `live: ${liveSignature.shapes.slice(0, 240)} | replayed: ${replayedSignature.shapes.slice(0, 240)}`);
  check("replaying_the_log_reproduces_the_edges", liveSignature.edges === replayedSignature.edges, `live: ${liveSignature.edges} | replayed: ${replayedSignature.edges}`);
  check("every_replayed_id_is_the_original_id", replayedCanvas.shapes.every((shape) => liveShapeIds.includes(shape.shape_id)), `replayed ids: ${replayedCanvas.shapes.map((shape) => shape.shape_id).join(",")}`);
  check("the_replay_consumed_exactly_one_revision_per_command", replayedCanvas.revision === cleared.revision + log.command_count, `${cleared.revision} + ${log.command_count} commands = ${cleared.revision + log.command_count}, actual ${replayedCanvas.revision}`);

  // ------------------------------------------------------------------------------------------------
  // 14. A MULTI-CARD DELETE MUST BE RECOVERABLE, INCLUDING THE EDGES BETWEEN THE CARDS IT REMOVED.
  //
  //     This is a regression test for a defect the browser gates found: an edge between two selected cards was
  //     collected from BOTH endpoints, so the recorded inverse named it twice. Applying the inverse then hit the
  //     create path's own duplicate refusal, and undoing a multi-card delete restored the cards while silently
  //     losing the edges between them. The assertion below is not "the undo returned ok" - it is that every edge
  //     that existed before the delete exists after the undo, with the same id and the same endpoints.
  // ------------------------------------------------------------------------------------------------
  {
    const chainA = "shape_chain_a";
    const chainB = "shape_chain_b";
    const chainC = "shape_chain_c";
    const chainEdges = [
      { edge_id: "edge_chain_ab", source_shape_id: chainA, target_shape_id: chainB, relation_type: "related_to" },
      { edge_id: "edge_chain_bc", source_shape_id: chainB, target_shape_id: chainC, relation_type: "related_to" }
    ];
    let chainRevision = svc.getCanvasRevision({ canvas_id: canvasId }).revision;
    chainRevision = svc.applyCanvasCommand({
      canvas_id: canvasId,
      expected_revision: chainRevision,
      client_id: "chain-test",
      command: {
        type: "create_shapes",
        shapes: [chainA, chainB, chainC].map((shape_id, index) => ({ shape_id, shape_type: "note", subject_type: "note", title: shape_id, x: 3000 + index * 260, y: 3000, width: 220, height: 90 }))
      }
    }).revision;
    chainRevision = svc.applyCanvasCommand({ canvas_id: canvasId, expected_revision: chainRevision, client_id: "chain-test", command: { type: "create_edges", edges: chainEdges } }).revision;

    const beforeChainDelete = svc.getCanvas({ canvas_id: canvasId });
    const chainEdgesBefore = beforeChainDelete.edges.filter((edge) => edge.edge_id.startsWith("edge_chain_")).map((edge) => `${edge.edge_id}:${edge.source_shape_id}->${edge.target_shape_id}`).sort();
    check("the_chain_fixture_has_both_edges", chainEdgesBefore.length === 2, `edges before the delete: ${chainEdgesBefore.join(", ")}`);

    // Delete the MIDDLE card of the chain: both edges touch it, and each is found from a different endpoint.
    const chainDelete = svc.applyCanvasCommand({
      canvas_id: canvasId,
      expected_revision: chainRevision,
      client_id: "chain-test",
      command: { type: "delete_shapes", shape_ids: [chainB] }
    });
    check("deleting_a_connected_card_removes_both_of_its_edges", chainDelete.applied.removed_edge_count === 2, `removed_edge_count: ${chainDelete.applied.removed_edge_count}`);
    const inverseEdges = chainDelete.undo_commands.filter((command) => command.type === "create_edges").flatMap((command) => command.edges ?? []);
    const inverseEdgeIds = inverseEdges.map((edge) => edge.edge_id);
    check(
      "the_recorded_inverse_names_each_removed_edge_exactly_once",
      inverseEdgeIds.length === new Set(inverseEdgeIds).size && inverseEdgeIds.length === 2,
      `the inverse carries ${inverseEdgeIds.length} edge(s) with ${new Set(inverseEdgeIds).size} distinct id(s): ${inverseEdgeIds.join(", ")}`
    );

    // Now undo it the way the client does: apply the recorded inverse as new commands.
    let undoRevision = chainDelete.revision;
    for (const command of chainDelete.undo_commands) {
      undoRevision = svc.applyCanvasCommand({ canvas_id: canvasId, expected_revision: undoRevision, client_id: "chain-test", command }).revision;
    }
    const afterChainUndo = svc.getCanvas({ canvas_id: canvasId });
    const chainEdgesAfter = afterChainUndo.edges.filter((edge) => edge.edge_id.startsWith("edge_chain_")).map((edge) => `${edge.edge_id}:${edge.source_shape_id}->${edge.target_shape_id}`).sort();
    check(
      "undoing_a_multi_card_delete_restores_every_edge_exactly_once",
      JSON.stringify(chainEdgesAfter) === JSON.stringify(chainEdgesBefore),
      `edges before ${JSON.stringify(chainEdgesBefore)}, after undo ${JSON.stringify(chainEdgesAfter)}`
    );
    check("the_restored_chain_card_keeps_its_id", afterChainUndo.shapes.some((shape) => shape.shape_id === chainB), "the middle card is back under its own id");

    // And a payload that names the same edge twice is refused with the id, rather than half-applied.
    let duplicatePayload = null;
    try {
      svc.applyCanvasCommand({
        canvas_id: canvasId,
        expected_revision: svc.getCanvasRevision({ canvas_id: canvasId }).revision,
        command: { type: "create_edges", edges: [chainEdges[0], chainEdges[0]] }
      });
    } catch (error) {
      duplicatePayload = error;
    }
    check(
      "a_create_edges_payload_with_a_repeated_edge_id_is_refused_by_id",
      duplicatePayload?.code === "CANVAS_COMMAND_INVALID" && /named the same edge more than once|names the same edge more than once/.test(String(duplicatePayload.message)) && String(duplicatePayload.message).includes("edge_chain_ab"),
      `error: ${duplicatePayload?.code} ${String(duplicatePayload?.message).slice(0, 160)}`
    );
    check(
      "the_refused_duplicate_payload_applied_nothing",
      svc.getCanvas({ canvas_id: canvasId }).edges.filter((edge) => edge.edge_id.startsWith("edge_chain_")).length === 2,
      "the refusal must leave the two chain edges as they were"
    );
  }

  // ------------------------------------------------------------------------------------------------
  // 13. The revision survives a reopen (a new service over the same repository), which is what "refresh" means
  //     server-side: nothing about the version lives only in memory.
  // ------------------------------------------------------------------------------------------------
  const finalCanvas = svc.getCanvas({ canvas_id: canvasId });
  const revisionBeforeReopen = finalCanvas.revision;
  const shapesBeforeReopen = finalCanvas.shapes.length;
  svc.close();
  const reopened = new VideoAssetService({ pluginConfig: { repositoryRoot: repo } }).init();
  try {
    const reopenedCanvas = reopened.getCanvas({ canvas_id: canvasId });
    check("the_revision_survives_a_reopen", reopenedCanvas.revision === revisionBeforeReopen, `reopened at ${reopenedCanvas.revision}, was ${revisionBeforeReopen}`);
    check("the_command_log_survives_a_reopen", reopened.listCanvasCommands({ canvas_id: canvasId }).command_count === revisionBeforeReopen, "the log is in the database, not in memory");
    check("the_shapes_survive_a_reopen", reopenedCanvas.shapes.length === shapesBeforeReopen, `shapes ${reopenedCanvas.shapes.length} vs ${shapesBeforeReopen}`);
    const replayAfterReopen = reopened.applyCanvasCommand(withTrustedContext({
      canvas_id: canvasId,
      expected_revision: 0,
      command_id: "cmd_proto_create_1",
      command: semanticallySameCommandWithDifferentKeyOrder
    }, { trusted: true, actor_id: "human:protocol-A", actor_type: "human", source: "protocol-test-reopen" }));
    check("the_same_command_and_trusted_actor_replay_after_a_database_reopen", replayAfterReopen.replayed === true && replayAfterReopen.revision === 1, `replayed=${replayAfterReopen.replayed} revision=${replayAfterReopen.revision}`);
    check("the_reopen_retry_has_no_side_effect", reopened.getCanvas({ canvas_id: canvasId }).revision === revisionBeforeReopen && reopened.listCanvasCommands({ canvas_id: canvasId }).command_count === revisionBeforeReopen, `revision/log remain ${revisionBeforeReopen}`);
    // A stale writer arriving after the reopen is still refused against the persisted revision.
    let staleAfterReopen = null;
    try {
      reopened.applyCanvasCommand({ canvas_id: canvasId, expected_revision: 0, command: { type: "move_shapes", positions: [{ shape_id: shapeA, x: -1, y: -1 }] } });
    } catch (error) {
      staleAfterReopen = error;
    }
    check("a_stale_writer_is_refused_after_a_reopen", staleAfterReopen?.code === "CANVAS_REVISION_CONFLICT", `error: ${staleAfterReopen?.code}`);
  } finally {
    reopened.close();
  }

  const failed = checks.filter((entry) => !entry.ok);
  assert.equal(failed.length, 0, `unexpected failures: ${JSON.stringify(failed)}`);
  console.log(JSON.stringify({ ok: true, checks: checks.length, final_revision: revisionBeforeReopen, command_types: [...CANVAS_COMMAND_TYPES] }, null, 2));
  console.log("canvas command protocol test passed");
} finally {
  try { svc.close(); } catch { /* already closed by the reopen section */ }
  await fs.promises.rm(tmp, { recursive: true, force: true });
}
