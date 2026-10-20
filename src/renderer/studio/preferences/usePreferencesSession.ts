import { useEffect, useMemo, useRef, useState } from 'react';

import type { SaveSettingsPayload, SettingsData } from '../../../shared/types';
import { clearSubmittedKeys, createPreferencesDraft, preferencesIssue, type PreferenceCategory } from './draft';

/** Keep an unapplied draft in page memory while the dialog itself is closed.
 * No draft (including typed API keys) is written to browser storage. */
export function usePreferencesSession(settings: SettingsData, saveSettings: (payload: SaveSettingsPayload) => Promise<void>) {
  const receivedDraft = useMemo(() => createPreferencesDraft(settings), [settings]);
  const [draft, setDraft] = useState(() => createPreferencesDraft(settings));
  const [category, setCategory] = useState<PreferenceCategory>('general');
  const [selectedService, setSelectedService] = useState<string | undefined>(settings.activeTranslationServiceId || settings.translationServices[0]?.id);
  const [saving, setSaving] = useState(false);
  const [picker, setPicker] = useState<'directory' | 'wallpaper'>();
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const baseline = useRef(JSON.stringify(draft));
  const currentDraft = useRef(draft);
  const latestSettings = useRef(settings);
  const settingsFingerprint = useMemo(() => JSON.stringify(receivedDraft), [receivedDraft]);
  const latestSettingsFingerprint = useRef(settingsFingerprint);
  const synchronizedSettings = useRef(settingsFingerprint);
  const savingLock = useRef(false);
  const pickerGeneration = useRef(0);
  const pickerLock = useRef(false);
  currentDraft.current = draft;
  latestSettings.current = settings;
  latestSettingsFingerprint.current = settingsFingerprint;
  const dirty = JSON.stringify(draft) !== baseline.current;
  const busy = saving || Boolean(picker);

  useEffect(() => {
    // Live status updates must not overwrite an unapplied draft. A clean
    // session follows configuration changed elsewhere, even while closed.
    if (busy || dirty || synchronizedSettings.current === settingsFingerprint) return;
    const next = createPreferencesDraft(latestSettings.current);
    synchronizedSettings.current = settingsFingerprint;
    baseline.current = JSON.stringify(next);
    currentDraft.current = next;
    setDraft(next);
    setSaved(false);
  }, [settingsFingerprint, busy, dirty]);

  const update = (next: SaveSettingsPayload): void => {
    if (savingLock.current || pickerLock.current) return;
    currentDraft.current = next;
    setDraft(next); setSaved(false); setError('');
  };
  const field = <K extends keyof SaveSettingsPayload>(key: K, value: SaveSettingsPayload[K]): void => update({ ...currentDraft.current, [key]: value });
  const reset = (): void => {
    if (savingLock.current || pickerLock.current) return;
    const next = createPreferencesDraft(latestSettings.current);
    synchronizedSettings.current = latestSettingsFingerprint.current;
    baseline.current = JSON.stringify(next);
    currentDraft.current = next;
    setDraft(next); setSaved(false); setError('');
    setSelectedService((selected) => next.translationServices.some(service => service.id === selected) ? selected : next.activeTranslationServiceId || next.translationServices[0]?.id);
  };
  const save = async (): Promise<boolean> => {
    if (savingLock.current || pickerLock.current) return false;
    const submitted = currentDraft.current;
    const issue = preferencesIssue(submitted);
    if (issue) {
      setCategory(issue.category);
      if (issue.serviceId) setSelectedService(issue.serviceId);
      setError(issue.message);
      return false;
    }
    if (JSON.stringify(submitted) === baseline.current) return true;
    savingLock.current = true; setSaving(true); setError('');
    try {
      await saveSettings(submitted);
      const next = clearSubmittedKeys(submitted);
      // Do not restore the pre-save snapshot if its SSE acknowledgement is
      // still in flight. A subsequent actual settings change syncs normally.
      synchronizedSettings.current = latestSettingsFingerprint.current;
      baseline.current = JSON.stringify(next);
      currentDraft.current = next;
      setDraft(next); setSaved(true);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法保存设置，请重试。');
      return false;
    } finally { savingLock.current = false; setSaving(false); }
  };
  const cancelPicker = (): void => {
    // Native pickers cannot always be aborted. Ignore an abandoned result so
    // closing/reopening never leaves the settings locked or changes a draft.
    pickerGeneration.current += 1;
    pickerLock.current = false;
    setPicker(undefined);
  };
  const pick = async (kind: 'directory' | 'wallpaper'): Promise<void> => {
    if (savingLock.current || pickerLock.current) return;
    const generation = ++pickerGeneration.current;
    pickerLock.current = true; setPicker(kind); setError('');
    try {
      const result = kind === 'directory' ? await window.whisperWeb.pickDirectory() : await window.whisperWeb.pickWallpaperFile();
      if (generation !== pickerGeneration.current || !result) return;
      const next = { ...currentDraft.current, [kind === 'directory' ? 'outputDir' : 'wallpaperPath']: result };
      currentDraft.current = next;
      setDraft(next); setSaved(false);
    } catch (cause) {
      if (generation === pickerGeneration.current) setError(cause instanceof Error ? cause.message : '无法打开选择器。');
    } finally {
      if (generation === pickerGeneration.current) { pickerLock.current = false; setPicker(undefined); }
    }
  };

  return { draft, category, setCategory, selectedService, setSelectedService, saving, picker, error, saved, dirty, busy, update, field, reset, save, pick, cancelPicker, setError };
}

export type PreferencesSession = ReturnType<typeof usePreferencesSession>;
