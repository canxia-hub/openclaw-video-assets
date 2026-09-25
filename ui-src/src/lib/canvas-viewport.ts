/**
 * REN-08：画布初始视图的计算。
 *
 * 为什么需要它：画布现在只挂载视口内的卡片（这是 300/1000 卡能用的前提）。于是“打开画布时看哪里”
 * 从一件装饰性的事变成了功能性的事——初始视口如果落在空白处，用户看到的是一块**空画布**，而画布其实
 * 有内容，且没有任何东西暗示“内容在别处”。旧版本把全部卡片都挂进 DOM，所以这个问题不存在；
 * 引入裁剪就必须同时把初始视图做对。
 *
 * 为什么不是简单的“适配全部内容”：把 1000 张卡全部缩进 1280×800，缩放会掉到 0.13 左右，可视区域覆盖
 * 整张画布——于是裁剪失效，1000 个节点全被挂载，正是裁剪要避免的事。所以在缩放过小时**不**适配全图，
 * 而是落在内容的起始区域，让用户从画布开头看起。
 *
 * 三条规则，都可判定：
 *   1. 没有卡片 → 保持 1:1，对准原点；
 *   2. 内容能装下（缩放在 [MIN_INITIAL_ZOOM, 1] 内）→ 居中适配全部内容；
 *   3. 内容太大 → 用下限缩放，对准内容包围盒的起始区域（左上角起第一个视口）。
 */

/** 初始视图的缩放下限。低于它就不做全图适配：适配会让裁剪失去意义（见文件头）。 */
export const MIN_INITIAL_ZOOM = 0.5;
export const MAX_INITIAL_ZOOM = 1;
/** 适配时留出的边距比例，避免卡片贴着视口边缘。 */
const FIT_PADDING_RATIO = 0.08;

export interface ViewportRect {
  x: number;
  y: number;
  zoom: number;
}

interface ShapeLike {
  x: number;
  y: number;
  width?: number;
  height?: number;
}

export interface InitialViewportDecision extends ViewportRect {
  reason: string;
  content_bbox: { x: number; y: number; width: number; height: number } | null;
  fit_zoom: number | null;
}

/**
 * @param shapes    the document's shapes (all of them, not just the mounted ones)
 * @param viewportSize the canvas element's size in CSS pixels
 */
export function initialViewportFor(shapes: ShapeLike[], viewportSize: { width: number; height: number }): InitialViewportDecision {
  const width = Math.max(1, viewportSize.width || 1280);
  const height = Math.max(1, viewportSize.height || 800);
  const zoom = 1;
  if (!shapes || shapes.length === 0) {
    return {
      x: 0,
      y: 0,
      zoom,
      reason: "the canvas has no cards, so the view stays at the origin",
      content_bbox: null,
      fit_zoom: null
    };
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const shape of shapes) {
    const shapeWidth = shape.width ?? 220;
    const shapeHeight = shape.height ?? 90;
    minX = Math.min(minX, shape.x);
    minY = Math.min(minY, shape.y);
    maxX = Math.max(maxX, shape.x + shapeWidth);
    maxY = Math.max(maxY, shape.y + shapeHeight);
  }
  const contentWidth = Math.max(1, maxX - minX);
  const contentHeight = Math.max(1, maxY - minY);
  const paddedWidth = contentWidth * (1 + FIT_PADDING_RATIO * 2);
  const paddedHeight = contentHeight * (1 + FIT_PADDING_RATIO * 2);
  const fitZoom = Math.min(width / paddedWidth, height / paddedHeight);

  if (fitZoom >= MIN_INITIAL_ZOOM) {
    // The content fits at a legible zoom: centre on the whole canvas, which is what "open the canvas" should mean.
    const applied = Math.min(MAX_INITIAL_ZOOM, fitZoom);
    const centreX = (minX + maxX) / 2;
    const centreY = (minY + maxY) / 2;
    return {
      x: width / 2 - centreX * applied,
      y: height / 2 - centreY * applied,
      zoom: applied,
      reason: `the whole canvas fits at zoom ${applied.toFixed(3)} (fit ${fitZoom.toFixed(3)}), so the view is centred on the content`,
      content_bbox: { x: minX, y: minY, width: contentWidth, height: contentHeight },
      fit_zoom: fitZoom
    };
  }

  // Too large to fit legibly. Land on the beginning of the canvas instead of shrinking it into illegibility -
  // and note that this is also what keeps the mounted-node count bounded on a 1000-card document.
  const focusX = minX + width / 2 / MIN_INITIAL_ZOOM;
  const focusY = minY + height / 2 / MIN_INITIAL_ZOOM;
  return {
    x: width / 2 - focusX * MIN_INITIAL_ZOOM,
    y: height / 2 - focusY * MIN_INITIAL_ZOOM,
    zoom: MIN_INITIAL_ZOOM,
    reason: `the canvas is larger than the viewport at a legible zoom (fit would be ${fitZoom.toFixed(3)}, floor ${MIN_INITIAL_ZOOM}), so the view starts at the beginning of the content`,
    content_bbox: { x: minX, y: minY, width: contentWidth, height: contentHeight },
    fit_zoom: fitZoom
  };
}
