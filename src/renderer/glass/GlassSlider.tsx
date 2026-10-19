import { useId, useLayoutEffect, useRef, type CSSProperties } from 'react';
import { createComponent, type ValueHandle } from '../vendor/lens-native/index.js';
import { releaseLensRoot, scheduleLensMount } from '../lens/Runtime';

export interface GlassSliderProps {
  label: string; min?: number; max?: number; step?: number; defaultValue?: number; value?: number;
  disabled?: boolean; name?: string; form?: string; id?: string; hint?: string; className?: string; style?: CSSProperties;
  formatValue?: (value: number) => string; onValueChange?: (value: number) => void; onValueCommit?: (value: number) => void;
}

/** The original factory's native range retains keyboard and form semantics;
 * the shared Lens runtime alone owns its original circular thumb. */
export function GlassSlider({ label, min = 0, max = 100, step = 1, defaultValue = 80, value, disabled = false, name, form, id, hint, className = '', style, formatValue, onValueChange, onValueCommit }: GlassSliderProps): React.JSX.Element {
  const generated = useId(), inputId = id ?? `glass-slider-${generated}`;
  const host = useRef<HTMLDivElement>(null), control = useRef<ValueHandle<number> | null>(null);
  const latest = useRef({ label, min, max, step, defaultValue, value, disabled, name, form, hint, formatValue, onValueChange, onValueCommit });
  latest.current = { label, min, max, step, defaultValue, value, disabled, name, form, hint, formatValue, onValueChange, onValueCommit };
  const sync = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    const root = host.current; if (!root) return;
    const props = latest.current;
    let userChanged = false;
    const instance = createComponent('slider', {
      label: props.label, min: props.min, max: props.max, step: props.step, value: props.value ?? props.defaultValue,
      onChange: current => {
        if (range.matches(':disabled')) return;
        userChanged = true;
        latest.current.onValueChange?.(current);
        if (latest.current.value !== undefined) queueMicrotask(() => {
          if (control.current === instance && latest.current.value !== undefined && instance.value !== latest.current.value) instance.setValue(latest.current.value);
        });
      }
    });
    const range = instance.element.querySelector<HTMLInputElement>('input')!, output = instance.element.querySelector<HTMLOutputElement>('output')!;
    range.id = inputId; output.htmlFor.value = inputId;
    range.defaultValue = String(props.defaultValue); range.disabled = props.disabled;
    control.current = instance; root.prepend(instance.element); scheduleLensMount(instance.element);
    const abort = new AbortController(), signal = abort.signal;
    let lastCommitted = instance.value, resetForm: HTMLFormElement | null = null;
    const reset = (): void => { queueMicrotask(() => { if (control.current !== instance) return; instance.setValue(latest.current.value ?? Number(range.value)); lastCommitted = instance.value; userChanged = false; syncOutput(); }); };
    const syncOutput = (): void => {
      const text = latest.current.formatValue?.(instance.value) ?? String(instance.value);
      output.value = text; range.setAttribute('aria-valuetext', text);
    };
    const update = (): void => {
      const p = latest.current;
      instance.element.querySelector('.lg-slider-heading > span')!.textContent = p.label;
      range.setAttribute('aria-label', p.label); range.min = String(p.min); range.max = String(p.max); range.step = String(p.step); range.disabled = p.disabled;
      if (p.name) range.name = p.name; else range.removeAttribute('name');
      if (p.form) range.setAttribute('form', p.form); else range.removeAttribute('form');
      if (resetForm !== range.form) { resetForm?.removeEventListener('reset', reset); resetForm = range.form; resetForm?.addEventListener('reset', reset, { signal }); }
      if (p.hint) range.setAttribute('aria-describedby', `${inputId}-hint`); else range.removeAttribute('aria-describedby');
      instance.setValue(p.value ?? instance.value);
      if (!userChanged) lastCommitted = instance.value;
      syncOutput();
    };
    const commit = (): void => { if (userChanged && !range.matches(':disabled')) { userChanged = false; if (instance.value !== lastCommitted) { lastCommitted = instance.value; latest.current.onValueCommit?.(instance.value); } } };
    range.addEventListener('lg:sync', syncOutput, { signal });
    range.addEventListener('change', commit, { signal });
    range.addEventListener('blur', commit, { signal });
    range.addEventListener('lg:gesture', event => { const phase = (event as CustomEvent<{ phase: string }>).detail.phase; if (phase === 'end' || phase === 'cancel') commit(); }, { signal });
    sync.current = update; update();
    return () => { commit(); abort.abort(); sync.current = null; control.current = null; releaseLensRoot(instance.element); instance.destroy(); instance.element.remove(); };
  }, [inputId]);
  useLayoutEffect(() => { sync.current?.(); }, [label, min, max, step, disabled, name, form, hint, value, formatValue]);
  return <div ref={host} className={`glass-slider-host ${className}`.trim()} style={style} data-glass-source="lens-native">{hint ? <p className="glass-slider-hint" id={`${inputId}-hint`}>{hint}</p> : null}</div>;
}
