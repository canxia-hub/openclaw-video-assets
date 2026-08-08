import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VideoAssetService } from "../src/service.js";

const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ova-canvas-render-"));
const repo = path.join(tmp, "repo");

const svc = new VideoAssetService({ pluginConfig: { repositoryRoot: repo } }).init();
try {
  const project = svc.createProject({ title: "Render Widget Project" });
  const noCanvasRender = svc.renderCanvasWidget({ project_id: project.project_id });
  assert.equal(noCanvasRender.structuredContent.status, "needs_canvas");
  assert.equal(noCanvasRender.structuredContent.resourceUri, "ui://widget/video-assets/canvas.html");
  assert.equal(noCanvasRender._meta["openai/outputTemplate"], "ui://widget/video-assets/canvas.html");
  assert.equal(noCanvasRender._meta["openai/widgetAccessible"], true);
  assert.equal(noCanvasRender.structuredContent.runtimeSupport.nativeResource, false);
  assert.equal(noCanvasRender.structuredContent.runtimeSupport.resourceRegistration, "not_available_in_current_openclaw_plugin_api");
  assert.ok(noCanvasRender.structuredContent.runtimeSupport.diagnostics.length >= 1);
  assert.equal(noCanvasRender.structuredContent.fallbackUrl, "/__openclaw__/video-assets/workbench/");

  const canvas = svc.createCanvas({
    project_id: project.project_id,
    title: "Render Widget Canvas",
    viewport: { x: 10, y: 20, zoom: 1.2, width: 1280, height: 720 }
  });
  const shape = svc.upsertCanvasShape({
    canvas_id: canvas.canvas_id,
    shape_type: "note",
    subject_type: "note",
    title: "Render Target",
    x: 80,
    y: 90,
    width: 240,
    height: 120
  });
  svc.saveCanvasSelection({
    canvas_id: canvas.canvas_id,
    selected_shape_ids: [shape.shape_id],
    primary_shape_id: shape.shape_id,
    source: "render_test"
  });

  const commitsBefore = svc.listCommits({ target_id: project.project_id, limit: 100 }).length;
  const render = svc.renderCanvasWidget({
    canvas_id: canvas.canvas_id,
    title: "Production Canvas",
    display_mode: "inline",
    viewport: { x: 0, y: 0, zoom: 0.8, width: 1440, height: 900 }
  });
  const commitsAfter = svc.listCommits({ target_id: project.project_id, limit: 100 }).length;

  assert.equal(render.structuredContent.status, "ready");
  assert.equal(render.structuredContent.title, "Production Canvas");
  assert.equal(render.structuredContent.preferredDisplayMode, "inline");
  assert.equal(render.structuredContent.canvas.canvas_id, canvas.canvas_id);
  assert.equal(render.structuredContent.viewport.zoom, 0.8);
  assert.deepEqual(render.structuredContent.selection.selected_shape_ids, [shape.shape_id]);
  assert.ok(render.structuredContent.capabilities.includes("selection_state"));
  assert.equal(render._meta.ui.resourceUri, "ui://widget/video-assets/canvas.html");
  assert.deepEqual(render._meta.ui.visibility, ["model", "app"]);
  assert.equal(render._meta.widgetData.canvas.canvas_id, canvas.canvas_id);
  assert.equal(commitsAfter, commitsBefore);

  svc.setCanvasWidgetRuntimeSupport({
    nativeResource: true,
    resourceRegistration: "registerAppResource",
    fallback: "protected_workbench_route",
    resourceUri: "ui://widget/video-assets/canvas.html",
    fallbackUrl: "/__openclaw__/video-assets/workbench/",
    attemptedApis: ["registerAppResource"],
    diagnostics: []
  });
  const nativeRender = svc.renderCanvasWidget({ canvas_id: canvas.canvas_id });
  assert.equal(nativeRender.structuredContent.runtimeSupport.nativeResource, true);
  assert.equal(nativeRender.structuredContent.runtimeSupport.resourceRegistration, "registerAppResource");
  assert.deepEqual(nativeRender.structuredContent.runtimeSupport.attemptedApis, ["registerAppResource"]);

  const byProject = svc.renderCanvasWidget({ project_id: project.project_id, display_mode: "side_panel" });
  assert.equal(byProject.structuredContent.status, "ready");
  assert.equal(byProject.structuredContent.canvas.canvas_id, canvas.canvas_id);
  assert.equal(byProject.structuredContent.preferredDisplayMode, "fullscreen");

  console.log("canvas widget render test passed");
} finally {
  svc.close();
  await fs.promises.rm(tmp, { recursive: true, force: true });
}
