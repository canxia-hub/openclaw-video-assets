import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VideoAssetService } from "../src/service.js";

const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ova-canvas-widget-"));
const repo = path.join(tmp, "repo");

const svc = new VideoAssetService({ pluginConfig: { repositoryRoot: repo } }).init();
try {
  const project = svc.createProject({ title: "Widget Canvas Project" });
  const canvas = svc.createCanvas({
    project_id: project.project_id,
    title: "Native Widget Contract Canvas",
    viewport: { x: 0, y: 0, zoom: 1, width: 1200, height: 800 }
  });
  const shape = svc.upsertCanvasShape({
    canvas_id: canvas.canvas_id,
    shape_type: "note",
    subject_type: "note",
    title: "Selection Target",
    x: 120,
    y: 90,
    width: 260,
    height: 140
  });

  const initialContext = svc.canvasWidgetContext({ canvas_id: canvas.canvas_id });
  assert.equal(initialContext.source, "video_assets_canvas_widget_context");
  assert.equal(initialContext.widget.status, "contract_ready");
  assert.deepEqual(initialContext.selection.selected_shape_ids, []);
  assert.ok(initialContext.capabilities.includes("selection_state"));
  assert.ok(initialContext.action_policy.allowed_actions.some((action) => action.tool === "video_canvas_save_selection"));

  const savedSelection = svc.saveCanvasSelection({
    canvas_id: canvas.canvas_id,
    selected_shape_ids: [shape.shape_id, shape.shape_id],
    primary_shape_id: shape.shape_id,
    source: "phase_f_widget_test"
  });
  assert.deepEqual(savedSelection.selected_shape_ids, [shape.shape_id]);
  assert.equal(savedSelection.primary_shape_id, shape.shape_id);
  assert.equal(savedSelection.selected_shapes[0].title, "Selection Target");

  const savedViewState = svc.saveCanvasViewState({
    canvas_id: canvas.canvas_id,
    viewport: { x: -240, y: -160, zoom: 0.75, width: 1440, height: 900 },
    source: "phase_f_widget_test"
  });
  assert.equal(savedViewState.view_state.viewport.zoom, 0.75);
  assert.equal(savedViewState.view_state.viewport.width, 1440);

  const restoredContext = svc.canvasWidgetContext({ canvas_id: canvas.canvas_id });
  assert.equal(restoredContext.viewport.zoom, 0.75);
  assert.deepEqual(restoredContext.selection.selected_shape_ids, [shape.shape_id]);
  assert.equal(restoredContext.agent_context.visible_shapes.length, 1);

  const commits = svc.listCommits({ target_id: project.project_id, limit: 100 });
  assert.equal(commits.some((commit) => commit.action.includes("selection")), false);
  assert.equal(commits.some((commit) => commit.action.includes("view")), false);

  console.log("canvas widget state test passed");
} finally {
  svc.close();
  await fs.promises.rm(tmp, { recursive: true, force: true });
}
