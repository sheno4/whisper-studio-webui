import { useEffect, useState } from 'react';
import {initializeGlassIntensity} from '../glass/material-intensity';

export type Appearance = 'system' | 'light' | 'dark';
export type Material = 'glass' | 'solid';
const storageKey = 'whisper-studio.appearance';

function readPreferences(): { appearance: Appearance; material: Material } {
  try {
    const stored = JSON.parse(window.localStorage.getItem(storageKey) || '{}') as Record<string, unknown>;
    return {
      appearance: stored.appearance === 'light' || stored.appearance === 'dark' ? stored.appearance : 'system',
      // Glass is rendered by this application. Migrate the retired automatic
      // material choice to glass while preserving an explicit solid choice.
      material: stored.material === 'solid' ? 'solid' : 'glass'
    };
  } catch { return { appearance: 'system', material: 'glass' }; }
}

export function initializeAppearance(): void {
  initializeGlassIntensity();
  const preferences = readPreferences();
  document.documentElement.dataset.appearance = preferences.appearance;
  document.documentElement.dataset.material = preferences.material;
}

export function useAppearance(): {
  appearance: Appearance;
  material: Material;
  setAppearance: (value: Appearance) => void;
  setMaterial: (value: Material) => void;
  cycleAppearance: () => void;
  toggleMaterial: () => void;
} {
  const [preferences, setPreferences] = useState(readPreferences);
  useEffect(() => {
    document.documentElement.dataset.appearance = preferences.appearance;
    document.documentElement.dataset.material = preferences.material;
    try { window.localStorage.setItem(storageKey, JSON.stringify({ ...preferences, materialVersion: 4 })); }
    catch { /* Private browsing still supports an in-memory preference. */ }
  }, [preferences]);
  return {
    ...preferences,
    setAppearance: (appearance) => setPreferences((current) => ({ ...current, appearance })),
    setMaterial: (material) => setPreferences((current) => ({ ...current, material })),
    cycleAppearance: () => setPreferences((current) => ({ ...current, appearance: ({ system: 'light', light: 'dark', dark: 'system' } as const)[current.appearance] })),
    toggleMaterial: () => setPreferences((current) => ({ ...current, material: current.material === 'glass' ? 'solid' : 'glass' }))
  };
}
