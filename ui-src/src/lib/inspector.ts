import { create } from "zustand";
import type { CanvasEdge, CanvasShape } from "./rpc";

/** 检查器当前选中对象。页面只负责 select，检查器面板自行拉取详情（shape 直接携带数据）。 */
export type InspectorSelection =
  | { kind: "asset" | "project"; id: string }
  | { kind: "shape"; id: string; shape: CanvasShape }
  | { kind: "edge"; id: string; edge: CanvasEdge; source?: CanvasShape; target?: CanvasShape }
  | null;

interface InspectorState {
  selection: InspectorSelection;
  select: (sel: NonNullable<InspectorSelection>) => void;
  clear: () => void;
}

export const useInspector = create<InspectorState>((set) => ({
  selection: null,
  select: (sel) => set({ selection: sel }),
  clear: () => set({ selection: null }),
}));
