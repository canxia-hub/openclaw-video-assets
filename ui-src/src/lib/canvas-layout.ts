import type { CanvasShape } from "./rpc";

export interface CanvasDisplayPosition {
  x: number;
  y: number;
  adjusted: boolean;
}

interface CanvasRect {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

const AUTO_LAYOUT_ROLES = new Set([
  "generation_slot",
  "generated_output",
  "revision_output",
  "replacement_output",
  "timeline_output",
  "revision_card",
]);

function shapeProps(shape: CanvasShape) {
  if (shape.props) return shape.props;
  if (!shape.props_json) return {};
  try {
    return JSON.parse(shape.props_json) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function rectFor(shape: CanvasShape, x = shape.x ?? 0, y = shape.y ?? 0): CanvasRect {
  return {
    id: shape.shape_id,
    x,
    y,
    width: shape.width ?? 220,
    height: shape.height ?? 90,
  };
}

export function canvasRectsOverlap(a: CanvasRect, b: CanvasRect, padding = 0) {
  return a.x < b.x + b.width + padding
    && a.x + a.width + padding > b.x
    && a.y < b.y + b.height + padding
    && a.y + a.height + padding > b.y;
}

/**
 * 仅在显示层为关键生产卡片做确定性二维避让。
 *
 * 后端仍保存原始坐标；普通素材卡和分区不移动。这样既不擅自改写用户画布，
 * 又能让历史画布中已重叠的生成槽、输出与返修卡恢复可读。新写回仍由后端
 * findOpenCanvasPosition 保证持久坐标不冲突。
 */
export function layoutCanvasShapes(shapes: CanvasShape[], padding = 24) {
  const result = new Map<string, CanvasDisplayPosition>();
  const movable = shapes
    .filter((shape) => AUTO_LAYOUT_ROLES.has(String(shapeProps(shape).role ?? "")))
    .sort((a, b) => (a.y ?? 0) - (b.y ?? 0) || (a.x ?? 0) - (b.x ?? 0) || a.shape_id.localeCompare(b.shape_id));
  const movableIds = new Set(movable.map((shape) => shape.shape_id));
  const blockers = shapes
    .filter((shape) => shape.shape_type !== "section" && !movableIds.has(shape.shape_id))
    .map((shape) => rectFor(shape));
  const placed: CanvasRect[] = [];

  for (const shape of movable) {
    const original = rectFor(shape);
    let candidate = { ...original };
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const hits = [...blockers, ...placed].filter((item) => canvasRectsOverlap(candidate, item, padding));
      if (!hits.length) break;
      candidate = {
        ...candidate,
        y: Math.max(candidate.y + candidate.height + padding, ...hits.map((item) => item.y + item.height + padding)),
      };
    }
    placed.push(candidate);
    result.set(shape.shape_id, {
      x: candidate.x,
      y: candidate.y,
      adjusted: candidate.x !== original.x || candidate.y !== original.y,
    });
  }

  for (const shape of shapes) {
    if (!result.has(shape.shape_id)) {
      result.set(shape.shape_id, { x: shape.x ?? 0, y: shape.y ?? 0, adjusted: false });
    }
  }
  return result;
}
