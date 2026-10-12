import { useEffect } from 'react';

type InteractionModality = 'pointer' | 'keyboard';
let currentModality: InteractionModality = 'pointer';
let registrations = 0;
let removeListeners: (() => void) | undefined;

export function isKeyboardInteraction(): boolean {
  return currentModality === 'keyboard';
}

/** Install at the app root so a dialog can read its opening interaction. */
export function useInteractionModality(): void {
  useEffect(() => {
    if (typeof document === 'undefined') return;
    registrations += 1;
    if (registrations === 1) {
      const pointer = (): void => {
        currentModality = 'pointer';
        document.documentElement.dataset.inputModality = currentModality;
      };
      const keyboard = (event: KeyboardEvent): void => {
        if (!['Meta', 'Control', 'Alt', 'Shift'].includes(event.key)) {
          currentModality = 'keyboard';
          document.documentElement.dataset.inputModality = currentModality;
        }
      };
      document.documentElement.dataset.inputModality = currentModality;
      document.addEventListener('pointerdown', pointer, true);
      document.addEventListener('keydown', keyboard, true);
      removeListeners = () => {
        document.removeEventListener('pointerdown', pointer, true);
        document.removeEventListener('keydown', keyboard, true);
      };
    }
    return () => {
      registrations -= 1;
      if (registrations === 0) { removeListeners?.(); removeListeners = undefined; }
    };
  }, []);
}
