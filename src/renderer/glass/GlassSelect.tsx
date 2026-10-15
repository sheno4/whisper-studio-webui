import { Select } from '@base-ui/react/select';
import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

import { useGlassCapability } from './capabilities';
import { LiquidMenuHighlight } from './LiquidMenuHighlight';
import { RdevMaterial } from './RdevMaterial';

export interface GlassSelectOption { value: string; label: ReactNode; disabled?: boolean }
export interface GlassSelectProps {
  value: string;
  onChange: (value: string) => void;
  options: readonly GlassSelectOption[];
  label: string;
  disabled?: boolean;
  id?: string;
  name?: string;
  required?: boolean;
  form?: string;
  className?: string;
  placeholder?: string;
  'aria-describedby'?: string;
}

/** Controlled business value; Base UI owns selection, focus, typeahead and
 * dismissal. Opening or highlighting an option never commits a value. */
export default function GlassSelect({ value, onChange, options, label, disabled = false, id, name, required, form, className = '', placeholder = '请选择', 'aria-describedby': describedBy }: GlassSelectProps): React.JSX.Element {
  const generatedId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  const [inheritedDisabled, setInheritedDisabled] = useState(false);
  const [hintId, setHintId] = useState<string>();
  const glass = useGlassCapability();
  const unavailable = disabled || inheritedDisabled || !options.some((option) => !option.disabled);
  const selected = options.find((option) => option.value === value);

  useLayoutEffect(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const hint = trigger.closest('label')?.querySelector('small');
    const createdHintId = hint && !hint.id ? `${generatedId}-hint` : undefined;
    if (hint) {
      if (createdHintId) hint.id = createdHintId;
      setHintId(hint.id);
    }
    setContainer(trigger.closest<HTMLElement>('[role="dialog"]') ?? document.querySelector<HTMLElement>('.studio-root') ?? document.body);
    const fieldsets: HTMLFieldSetElement[] = [];
    let ancestor = trigger.parentElement;
    while (ancestor) { if (ancestor instanceof HTMLFieldSetElement) fieldsets.push(ancestor); ancestor = ancestor.parentElement; }
    const syncDisabled = (): void => setInheritedDisabled(fieldsets.some((fieldset) => fieldset.disabled && !fieldset.querySelector(':scope > legend')?.contains(trigger)));
    const observer = new MutationObserver(syncDisabled);
    fieldsets.forEach((fieldset) => observer.observe(fieldset, { attributes: true, attributeFilter: ['disabled'] }));
    syncDisabled();
    return () => {
      observer.disconnect();
      if (hint && createdHintId && hint.id === createdHintId) hint.removeAttribute('id');
    };
  }, [generatedId]);
  useLayoutEffect(() => { if (unavailable && open) setOpen(false); }, [unavailable, open]);

  const escape = (event: React.KeyboardEvent): void => {
    if (open && event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    }
  };
  return <Select.Root<string>
    id={id ?? generatedId} value={selected ? value : null} items={options} disabled={unavailable} name={name} required={required} form={form}
    open={open} modal={false} onOpenChange={(next, details) => {
      if (next && (unavailable || triggerRef.current?.matches(':disabled'))) { details.cancel(); return; }
      if (details.reason === 'escape-key') details.event.stopPropagation();
      setOpen(next);
    }} onValueChange={(next) => {
      if (next === null || unavailable || triggerRef.current?.matches(':disabled') || next === value) return;
      if (options.some((option) => option.value === next && !option.disabled)) onChange(next);
    }}>
    <Select.Trigger ref={triggerRef} className={`glass-select-trigger ${className}`.trim()} aria-label={label} aria-describedby={describedBy ?? hintId}
      data-glass-mode={glass.mode} data-liquid-glass-source data-glass-select={id ?? generatedId} onKeyDownCapture={escape}>
      {glass.mode === 'optical' ? <RdevMaterial owner="select" radius={13} interactionRef={triggerRef} /> : null}
      <Select.Value className="glass-select-value" placeholder={options.length ? placeholder : '暂无可用选项'} />
      <Select.Icon className="glass-select-icon"><svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg></Select.Icon>
    </Select.Trigger>
    <Select.Portal container={container}>
      <Select.Positioner className="glass-select-positioner" sideOffset={7} align="start" positionMethod="fixed" alignItemWithTrigger={false} collisionPadding={12} collisionAvoidance={{ side: 'flip', align: 'shift', fallbackAxisSide: 'none' }}>
        <Select.Popup ref={popupRef} className="glass-select-popup" data-glass-mode={glass.mode} data-liquid-glass-source aria-label={label} onKeyDownCapture={escape}>
          {glass.mode === 'optical' ? <RdevMaterial owner="menu" radius={18} interactionRef={popupRef} /> : null}
          <Select.List ref={listRef} className="glass-select-list" aria-label={label}>
            <LiquidMenuHighlight hostRef={listRef} active={open} itemSelector=".glass-select-option" selectedFallback />
            {options.map((option) => <Select.Item key={option.value} value={option.value} disabled={option.disabled} label={typeof option.label === 'string' ? option.label : undefined} className="glass-select-option" data-value={option.value}>
              <Select.ItemText className="glass-select-option-text">{option.label}</Select.ItemText>
              <Select.ItemIndicator className="glass-select-check"><svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><path d="m3 8 3 3 7-7" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg></Select.ItemIndicator>
            </Select.Item>)}
          </Select.List>
        </Select.Popup>
      </Select.Positioner>
    </Select.Portal>
  </Select.Root>;
}
