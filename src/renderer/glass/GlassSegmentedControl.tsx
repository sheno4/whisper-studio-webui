import { useId, useLayoutEffect, useRef, type CSSProperties } from 'react';
import { createComponent, type ValueHandle } from '../vendor/lens-native/index.js';
import { releaseLensRoot, scheduleLensMount } from '../lens/Runtime';

export type GlassSegmentOption<Value extends string = string> = { value: Value; label: string; disabled?: boolean; badge?: string | number };
export type GlassSegmentedControlProps<Value extends string = string> = {
  label: string; options: GlassSegmentOption<Value>[]; value: Value; onChange: (value: Value) => void;
  disabled?: boolean; panelIds?: Partial<Record<Value, string>>; className?: string; style?: CSSProperties;
};

export function GlassSegmentedControl<Value extends string>({ className = '', style, ...props }: GlassSegmentedControlProps<Value>): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null), control = useRef<ValueHandle<string> | null>(null);
  const restoreFocus = useRef<string | null>(null);
  const latest = useRef(props); latest.current = props;
  const id = useId();
  // Only option identities/order belong to the factory's closed-over list.
  // Labels, badges and availability update in place, retaining the native body
  // and its spring velocity across ordinary React renders.
  const optionKey = JSON.stringify(props.options.map(option => option.value));
  const optionState = JSON.stringify(props.options.map(({label, disabled, badge}) => [label, Boolean(disabled), badge]));
  useLayoutEffect(() => {
    const root = host.current, current = latest.current;
    if (!root || !current.options.length) return;
    // Pass all identities to the factory's fixed enabled list, then adapt live
    // native disabled state. This also supports all-disabled controlled states.
    const initial = current.options.find(option => option.value === current.value) ?? current.options.find(option => !option.disabled) ?? current.options[0];
    const instance = createComponent('tabs', {
      label: current.label, options: current.options.map(option => ({ value: option.value, label: option.label })), value: initial.value,
      onChange: value => {
        const button = instance.element.querySelector<HTMLButtonElement>(`button[data-value="${CSS.escape(value)}"]`);
        if (!latest.current.disabled && !button?.matches(':disabled') && latest.current.options.some(option => option.value === value && !option.disabled)) latest.current.onChange(value as Value);
        queueMicrotask(() => { if (control.current === instance && instance.value !== latest.current.value) instance.setValue(latest.current.value); });
      }
    });
    // Application tabpanels live in React; remove the factory's empty examples.
    instance.element.querySelectorAll('.lg-tab-panel').forEach(panel => panel.remove());
    const buttons = [...instance.element.querySelectorAll<HTMLButtonElement>('.lg-segment-option')];
    buttons.forEach((button, index) => {
      button.id = `lens-tab-${id}-${index}`;
      button.disabled = Boolean(current.disabled || current.options[index].disabled);
    });
    const syncTabStops = () => {
      const available = buttons.filter(button => !button.matches(':disabled'));
      const entry = available.find(button => button.dataset.value === instance.value) ?? available[0];
      buttons.forEach(button => {const tabIndex = button === entry ? 0 : -1; if (button.tabIndex !== tabIndex) button.tabIndex = tabIndex;});
    };
    const abort = new AbortController();
    instance.element.addEventListener('lg:sync', syncTabStops, {signal: abort.signal});
    syncTabStops();
    instance.element.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || event.altKey || event.ctrlKey || event.metaKey) return;
      event.preventDefault(); event.stopImmediatePropagation();
      const available = buttons.filter(button => !button.matches(':disabled'));
      if (!available.length) return;
      const focused = available.indexOf(document.activeElement as HTMLButtonElement);
      const index = focused >= 0 ? focused : available.findIndex(button => button.dataset.value === instance.value);
      const direction = event.key === 'ArrowRight' ? 1 : -1;
      let next = index < 0 ? (direction > 0 ? 0 : available.length - 1) : (index + direction + available.length) % available.length;
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = available.length - 1;
      instance.setValue(available[next].dataset.value!, {emit: true}); available[next].focus();
    }, { capture: true, signal: abort.signal });
    control.current = instance; root.append(instance.element); scheduleLensMount(instance.element);
    if (restoreFocus.current) {
      const previous = buttons.find(button => button.dataset.value === restoreFocus.current && !button.matches(':disabled'));
      (previous ?? buttons.find(button => button.dataset.value === instance.value && !button.matches(':disabled')))?.focus({preventScroll: true});
    }
    restoreFocus.current = null;
    return () => {
      restoreFocus.current = instance.element.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.value ?? null : null;
      control.current = null; abort.abort(); releaseLensRoot(instance.element); instance.destroy(); instance.element.remove();
    };
  }, [optionKey, id]);
  useLayoutEffect(() => {
    const instance = control.current;
    if (!instance) return;
    const bar = instance.element.querySelector<HTMLElement>('.lg-segment-bar');
    if (bar?.getAttribute('aria-label') !== props.label) bar?.setAttribute('aria-label', props.label);
    let motionChanged = false;
    if (bar && (bar.getAttribute('aria-disabled') === 'true') !== Boolean(props.disabled)) {
      if (props.disabled) bar.setAttribute('aria-disabled', 'true'); else bar.removeAttribute('aria-disabled');
      motionChanged = true;
    }
    instance.element.querySelectorAll<HTMLButtonElement>('.lg-segment-option').forEach((button, index) => {
      const option = props.options[index]; if (!option) return;
      const disabled = Boolean(props.disabled || option.disabled);
      if (button.disabled !== disabled) {button.disabled = disabled; motionChanged = true;}
      const label = button.firstElementChild;
      if (label && label.textContent !== option.label) {label.textContent = option.label; motionChanged = true;}
      const panel = props.panelIds?.[option.value];
      if (panel) {if (button.getAttribute('aria-controls') !== panel) button.setAttribute('aria-controls', panel);}
      else if (button.hasAttribute('aria-controls')) button.removeAttribute('aria-controls');
      let badge = button.querySelector<HTMLElement>('.glass-segment-badge');
      if (option.badge !== undefined) {
        if (!badge) {badge = document.createElement('span'); badge.className = 'glass-segment-badge'; button.append(badge); motionChanged = true;}
        if (badge.textContent !== String(option.badge)) {badge.textContent = String(option.badge); motionChanged = true;}
      } else if (badge) {badge.remove(); motionChanged = true;}
    });
    if (instance.value !== props.value) instance.setValue(props.value);
    else if (motionChanged) instance.element.dispatchEvent(new CustomEvent('lg:sync', {bubbles: true}));
  }, [optionKey, optionState, props.label, props.disabled, props.panelIds, props.value]);
  return <div ref={host} className={`glass-segmented-control ${className}`.trim()} style={style} data-glass-segment-host data-glass-source="lens-native" />;
}

export default GlassSegmentedControl;
