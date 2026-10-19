export interface RasterPlan {
  base: number[];
  scale: number;
  width: number;
  height: number;
  assets: Promise<unknown>[];
}
export interface RasterState { changed: boolean }
export const NaughtyDOM: {
  measure(element: HTMLElement, options: { width?: number; height?: number; scale?: number; backgroundColor?: string; ignoreElements?: (element: Element) => boolean }): RasterPlan | null;
  paint(plan: RasterPlan, canvas: HTMLCanvasElement, region?: { x: number; y: number; w: number; h: number } | null): HTMLCanvasElement;
  paintLayer(plan: RasterPlan, canvas: HTMLCanvasElement, previous: RasterState | null, force?: boolean): RasterState;
  release(): void;
};
