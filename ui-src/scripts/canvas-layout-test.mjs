import assert from "node:assert/strict";
import { canvasRectsOverlap, layoutCanvasShapes } from "../src/lib/canvas-layout.ts";

const shape = (id, role, x, y, width = 320, height = 150) => ({
  shape_id: id,
  canvas_id: "canvas_test",
  shape_type: role === "plain" ? "asset_card" : "note",
  subject_type: role === "plain" ? "asset" : "note",
  x,
  y,
  width,
  height,
  props: role === "plain" ? {} : { role },
});

const shapes = [
  shape("fixed", "plain", 0, 0),
  shape("slot", "generation_slot", 20, 20),
  shape("output_a", "generated_output", 20, 40),
  shape("output_b", "revision_output", 20, 60),
  shape("review", "revision_card", 20, 80, 340, 190),
];

const first = layoutCanvasShapes(shapes);
const second = layoutCanvasShapes(shapes);
assert.deepEqual([...first.entries()], [...second.entries()], "显示避让必须确定性稳定");
assert.deepEqual(first.get("fixed"), { x: 0, y: 0, adjusted: false }, "普通卡片不得被显示层改写");

const rects = shapes
  .filter((item) => item.props.role)
  .map((item) => {
    const position = first.get(item.shape_id);
    assert.ok(position, `缺少 ${item.shape_id} 显示位置`);
    assert.equal(position.adjusted, true, `${item.shape_id} 应触发避让`);
    return { id: item.shape_id, x: position.x, y: position.y, width: item.width, height: item.height };
  });

for (let i = 0; i < rects.length; i += 1) {
  for (let j = i + 1; j < rects.length; j += 1) {
    assert.equal(canvasRectsOverlap(rects[i], rects[j], 23), false, `${rects[i].id} 与 ${rects[j].id} 不得重叠`);
  }
}

console.log("canvas-layout-test: PASS");
