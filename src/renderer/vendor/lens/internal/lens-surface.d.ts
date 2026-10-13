export type LensMotion = 'none' | 'tether' | 'press' | 'free';
export function createLensSurface(options?: {
  element?: HTMLElement;
  tag?: string;
  className?: string;
  kind?: string;
  motion?: LensMotion;
  dragHandle?: string;
}): { element: HTMLElement; destroy(): void };
