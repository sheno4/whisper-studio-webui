import { Children, isValidElement, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { createComponent, type MenuHandle } from '../vendor/lens-native/index.js';
import { releaseLensRoot, scheduleLensMount } from '../lens/Runtime';
import { bindLensMenuPopover, observeFieldsetDisabled } from './lens-menu-adapter';

export interface GlassSelectOption { value: string; label: ReactNode; disabled?: boolean }
export interface GlassSelectProps {
  value: string; onChange: (value: string) => void; options: readonly GlassSelectOption[]; label: string;
  disabled?: boolean; id?: string; name?: string; required?: boolean; form?: string; className?: string; placeholder?: string;
  'aria-describedby'?: string;
}
function labelText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (isValidElement<{ children?: ReactNode }>(node)) return labelText(node.props.children);
  return Children.toArray(node).map(item => isValidElement<{ children?: ReactNode }>(item) ? labelText(item.props.children) : typeof item === 'string' || typeof item === 'number' ? String(item) : '').join('');
}
type SelectNodes = { instance: MenuHandle; trigger: HTMLButtonElement; panel: HTMLElement; value: HTMLElement; items: HTMLButtonElement[] };

/** A normal dropdown is an application semantic adapter over Lens's actual
 * menu factory. Opening and keyboard highlighting never commit selection. */
export default function GlassSelect(props: GlassSelectProps): React.JSX.Element {
  const { value, options, label, disabled = false, id, name, required, form, className = '', placeholder = '请选择', 'aria-describedby': describedBy } = props;
  const generated = useId(), triggerId = id ?? `lens-select-${generated}`;
  const host = useRef<HTMLSpanElement>(null), native = useRef<HTMLSelectElement>(null), control = useRef<SelectNodes | null>(null);
  const restoreTriggerFocus = useRef(false);
  const latest = useRef(props); latest.current = props;
  const [nodes, setNodes] = useState<SelectNodes | null>(null), [invalid, setInvalid] = useState(false);
  const selected = options.find(option => option.value === value);
  const optionKey = JSON.stringify(options.map(option => ({ value: option.value, disabled: Boolean(option.disabled) })));
  useLayoutEffect(() => {
    const root = host.current; if (!root) return;
    const p = latest.current;
    let current: SelectNodes;
    const instance = createComponent('menu', {
      label: p.label,
      options: p.options.length ? p.options.map((option, index) => ({ value: option.value, label: labelText(option.label).trim() || `${p.label} ${index + 1}`, disabled: option.disabled })) : [{ value: '__lens_empty__', label: '暂无可用选项', disabled: true }],
      onAction: next => {
        if (!current || current.trigger.matches(':disabled') || latest.current.disabled || next === latest.current.value || !latest.current.options.some(option => option.value === next && !option.disabled)) return;
        setInvalid(false); latest.current.onChange(next);
      }
    });
    const trigger = instance.element.querySelector<HTMLButtonElement>(':scope > button')!, panel = instance.element.querySelector<HTMLElement>('.lg-menu-popover')!;
    const valueNode = document.createElement('span'), chevron = document.createElement('span');
    valueNode.className = 'glass-select-value'; chevron.className = 'glass-select-icon'; chevron.setAttribute('aria-hidden', 'true'); chevron.textContent = '⌄';
    trigger.replaceChildren(valueNode, chevron); trigger.classList.add('glass-select-trigger');
    trigger.id = triggerId; trigger.setAttribute('role', 'combobox'); trigger.setAttribute('aria-haspopup', 'listbox'); trigger.setAttribute('aria-autocomplete', 'none');
    panel.classList.add('glass-select-popup'); panel.setAttribute('role', 'listbox');
    const items = [...panel.querySelectorAll<HTMLButtonElement>('.lg-menu-item')];
    items.forEach((button, index) => { button.setAttribute('role', 'option'); button.id = `${triggerId}-option-${index}`; button.classList.add('glass-select-option'); button.replaceChildren(); });
    current = { instance, trigger, panel, value: valueNode, items }; control.current = current;
    root.append(instance.element);
    const abort = new AbortController(), signal = abort.signal;
    const syncDisabled = (): void => {
      trigger.disabled = Boolean(latest.current.disabled || !latest.current.options.some(option => !option.disabled));
      if (trigger.matches(':disabled')) instance.close();
    };
    const stopDisabled = observeFieldsetDisabled(trigger, syncDisabled);
    const stopPopover = bindLensMenuPopover(instance, { matchWidth: true, onOpen: () => {
      const index = latest.current.options.findIndex(option => option.value === latest.current.value && !option.disabled);
      (items[index] ?? items.find(button => !button.disabled))?.focus({ preventScroll: true });
    } });
    let search = '', searchedAt = 0;
    const typeahead = (event: KeyboardEvent): void => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.isComposing || event.key.length !== 1 || event.key === ' ') return;
      const now = performance.now(); search = now - searchedAt > 650 ? event.key : search + event.key; searchedAt = now;
      const index = items.findIndex((button, index) => !button.disabled && labelText(latest.current.options[index]?.label).trim().toLocaleLowerCase().startsWith(search.toLocaleLowerCase()));
      if (index >= 0) { event.preventDefault(); if (trigger.getAttribute('aria-expanded') !== 'true') instance.open(); queueMicrotask(() => items[index]?.focus({ preventScroll: true })); }
    };
    trigger.addEventListener('keydown', event => {
      if (trigger.matches(':disabled')) { event.preventDefault(); event.stopImmediatePropagation(); return; }
      typeahead(event);
    }, { signal, capture: true });
    panel.addEventListener('keydown', typeahead, { signal });
    scheduleLensMount(instance.element); setNodes(current); syncDisabled();
    // Replacing a focused option list removes the old active element. Restore
    // its focus intent only while focus is still unclaimed after that removal.
    if (restoreTriggerFocus.current && (document.activeElement === document.body || document.activeElement === document.documentElement || !document.activeElement) && !trigger.matches(':disabled')) trigger.focus({ preventScroll: true });
    restoreTriggerFocus.current = false;
    return () => {
      restoreTriggerFocus.current = instance.element.contains(document.activeElement);
      control.current = null; abort.abort(); stopDisabled(); stopPopover(); releaseLensRoot(instance.element); instance.destroy(); instance.element.remove();
    };
  }, [optionKey, triggerId]);
  useLayoutEffect(() => {
    const select = native.current, owner = select?.form;
    if (!select || !owner) return;
    const reset = (event: Event): void => {
      // The browser applies native reset defaults after dispatch. The business
      // value remains controlled, so restore it after that default action.
      queueMicrotask(() => {
        if (event.defaultPrevented || native.current !== select || !select.isConnected) return;
        const p = latest.current;
        select.value = p.options.some(option => option.value === p.value) ? p.value : '';
        setInvalid(false);
      });
    };
    owner.addEventListener('reset', reset);
    return () => owner.removeEventListener('reset', reset);
  }, [form]);
  useLayoutEffect(() => {
    const current = control.current; if (!current) return;
    current.trigger.className = `lg-surface lg-button glass-select-trigger ${className}`.trim();
    current.trigger.setAttribute('aria-label', label); current.panel.setAttribute('aria-label', label);
    current.trigger.disabled = Boolean(disabled || !options.some(option => !option.disabled));
    if (current.trigger.matches(':disabled')) current.instance.close();
    const hint = current.trigger.closest('label')?.querySelector('small');
    if (hint && !hint.id) hint.id = `${triggerId}-hint`;
    const description = describedBy ?? hint?.id;
    if (description) current.trigger.setAttribute('aria-describedby', description); else current.trigger.removeAttribute('aria-describedby');
    current.trigger.setAttribute('aria-required', String(Boolean(required))); current.trigger.setAttribute('aria-invalid', String(invalid));
    current.items.forEach((button, index) => {
      const option = options[index]; if (!option) return;
      button.disabled = Boolean(option.disabled); button.setAttribute('aria-selected', String(option.value === value));
      button.setAttribute('aria-label', labelText(option.label)); button.dataset.value = option.value;
    });
  }, [nodes, className, label, value, options, disabled, describedBy, triggerId, required, invalid]);
  return <span ref={host} className="glass-select-host" data-glass-source="lens-native">
    <select ref={native} className="studio-visually-hidden glass-select-native" style={{ position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden', clipPath: 'inset(50%)', whiteSpace: 'nowrap', border: 0 }} aria-hidden="true" tabIndex={-1} name={name} form={form} required={required} disabled={disabled || !options.some(option => !option.disabled)} value={selected ? value : ''} onFocus={() => control.current?.trigger.focus()} onInvalid={event => { event.preventDefault(); setInvalid(true); control.current?.trigger.focus(); }} onChange={event => { const next = event.currentTarget.value; if (options.some(option => option.value === next && !option.disabled) && !event.currentTarget.matches(':disabled') && next !== value) { setInvalid(false); props.onChange(next); } }}>
      {!options.some(option => option.value === '') ? <option value="" disabled>{placeholder}</option> : null}
      {options.map(option => <option key={option.value} value={option.value} disabled={option.disabled}>{labelText(option.label)}</option>)}
    </select>
    {nodes ? createPortal(selected?.label ?? (options.length ? placeholder : '暂无可用选项'), nodes.value) : null}
    {nodes ? options.map((option, index) => nodes.items[index] ? createPortal(<><span className="glass-select-option-text">{option.label}</span>{option.value === value ? <span className="glass-select-check" aria-hidden="true">✓</span> : null}</>, nodes.items[index], option.value) : null) : null}
  </span>;
}
