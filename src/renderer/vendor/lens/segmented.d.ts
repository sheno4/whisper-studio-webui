export interface SegmentOption { value: string; label: string; disabled?: boolean; badge?: string | number; }
export interface SegmentedProps { label: string; options: SegmentOption[]; value?: string; disabled?: boolean; panelIds?: Record<string, string>; onChange?: (value: string) => void; }
export interface SegmentedHandle {
  element: HTMLElement;
  readonly value: string;
  setValue(value: string, options?: { emit?: boolean; snap?: boolean; cancel?: boolean; force?: boolean }): boolean;
  update(props: Omit<SegmentedProps, 'value' | 'onChange'>): void;
  destroy(): void;
}
export function createSegmentedControl(props: SegmentedProps): SegmentedHandle;
