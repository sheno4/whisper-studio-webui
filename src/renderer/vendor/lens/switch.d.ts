export type SwitchSetOptions = { emit?: boolean; snap?: boolean; cancel?: boolean; force?: boolean };
export type SwitchProps = { label: string; checked?: boolean; disabled?: boolean; onChange?: (checked: boolean) => void };
export interface SwitchHandle {
  element: HTMLButtonElement;
  readonly value: boolean;
  setValue(checked: boolean, options?: SwitchSetOptions): boolean;
  update(options?: { label?: string; disabled?: boolean }): void;
  destroy(): void;
}
export function bindSwitch(element: HTMLButtonElement, options?: { checked?: boolean; onChange?: (checked: boolean) => void }): SwitchHandle;
export function createSwitch(options: SwitchProps): SwitchHandle;
