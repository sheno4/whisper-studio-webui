import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { useReducedMotionPreference } from '../hooks/useReducedMotionPreference';
import { getOverlayVariants } from '../motion';
import Icon from './Icon';

export interface AnimatedSelectOption<T extends string> {
  value: T;
  label: string;
  description?: string;
  badge?: ReactNode;
}

interface AnimatedSelectProps<T extends string> {
  id: string;
  value: T;
  options: ReadonlyArray<AnimatedSelectOption<T>>;
  onChange: (value: T) => void;
  className?: string;
  buttonClassName?: string;
  menuClassName?: string;
  optionClassName?: string;
  label?: string;
  disabled?: boolean;
  minWidth?: number;
}

interface MenuPosition {
  left: number;
  width: number;
  maxHeight: number;
  top?: number;
  bottom?: number;
  placement: 'top' | 'bottom';
  transformOrigin: string;
}

function joinClassNames(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(' ');
}

function AnimatedSelect<T extends string>({
  id, value, options, onChange, className, buttonClassName, menuClassName,
  optionClassName, label, disabled = false, minWidth
}: AnimatedSelectProps<T>): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [keyboardMotion, setKeyboardMotion] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [position, setPosition] = useState<MenuPosition>();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef({ value: '', timestamp: 0 });
  const reducedMotion = useReducedMotionPreference();
  const menuId = `${id}-menu`;
  const labelId = `${id}-label`;
  const valueId = `${id}-value`;
  const selectedOption = useMemo(() => options.find((option) => option.value === value) ?? options[0], [options, value]);

  function closeMenu(keyboard = false, returnFocus = false): void {
    setKeyboardMotion(keyboard);
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus({ preventScroll: true });
  }

  function openMenu(keyboard = false): void {
    if (disabled || !options.length) return;
    setKeyboardMotion(keyboard);
    setActiveIndex(Math.max(0, options.findIndex((option) => option.value === value)));
    setOpen(true);
  }

  function updatePosition(): void {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const gutter = 10;
    const gap = 6;
    const viewportWidth = document.documentElement.clientWidth;
    const viewportHeight = window.innerHeight;
    const width = Math.min(Math.max(rect.width, minWidth ?? 0, 220), viewportWidth - gutter * 2);
    const left = Math.max(gutter, Math.min(rect.left, viewportWidth - width - gutter));
    const availableBelow = Math.max(0, viewportHeight - rect.bottom - gap - gutter);
    const availableAbove = Math.max(0, rect.top - gap - gutter);
    const desiredHeight = Math.min(menuRef.current?.scrollHeight ?? options.length * 58 + 12, 360);
    const placement = availableBelow < desiredHeight && availableAbove > availableBelow ? 'top' : 'bottom';
    const originX = Math.max(0, Math.min(rect.left + rect.width / 2 - left, width));
    const next: MenuPosition = {
      left, width, placement,
      maxHeight: Math.min(360, placement === 'top' ? availableAbove : availableBelow),
      transformOrigin: `${originX}px ${placement === 'top' ? 'bottom' : 'top'}`,
      ...(placement === 'top' ? { bottom: viewportHeight - rect.top + gap } : { top: rect.bottom + gap })
    };
    setPosition((current) => current && Object.entries(next).every(([key, nextValue]) => current[key as keyof MenuPosition] === nextValue)
      ? current : next);
  }

  useEffect(() => {
    if (!open) return;
    updatePosition();
    const handlePointerDown = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) closeMenu();
    };
    const handleFocusIn = (event: FocusEvent): void => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) closeMenu(true);
    };
    window.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('focusin', handleFocusIn);
    window.addEventListener('scroll', updatePosition, true);
    window.addEventListener('resize', updatePosition);
    window.visualViewport?.addEventListener('resize', updatePosition);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('focusin', handleFocusIn);
      window.removeEventListener('scroll', updatePosition, true);
      window.removeEventListener('resize', updatePosition);
      window.visualViewport?.removeEventListener('resize', updatePosition);
    };
    // Event listeners are scoped to the open menu, not queue snapshot updates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, minWidth, options.length]);

  useEffect(() => {
    if (disabled || !options.length) setOpen(false);
    else setActiveIndex((current) => Math.min(current, options.length - 1));
  }, [disabled, options.length]);

  useEffect(() => {
    if (!open) return;
    document.getElementById(`${id}-option-${activeIndex}`)?.scrollIntoView({ block: 'nearest' });
  }, [open, activeIndex, id]);

  function commitOption(index: number, keyboard = false): void {
    const option = options[index];
    if (!option) return;
    onChange(option.value);
    closeMenu(keyboard, true);
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLButtonElement>): void {
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      event.stopPropagation();
      closeMenu(true, true);
      return;
    }
    if (event.key === 'Tab') { if (open) closeMenu(true); return; }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setKeyboardMotion(true);
      if (!open) { openMenu(true); return; }
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      setActiveIndex((current) => (current + direction + options.length) % options.length);
      return;
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      if (!open) openMenu(true);
      setKeyboardMotion(true);
      setActiveIndex(event.key === 'Home' ? 0 : options.length - 1);
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (open) commitOption(activeIndex, true);
      else openMenu(true);
      return;
    }
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey && options.length) {
      const now = Date.now();
      const search = now - searchRef.current.timestamp < 600 ? searchRef.current.value + event.key : event.key;
      searchRef.current = { value: search, timestamp: now };
      const match = options.findIndex((option) => option.label.toLocaleLowerCase().startsWith(search.toLocaleLowerCase()));
      if (match >= 0) {
        event.preventDefault();
        if (!open) openMenu(true);
        setKeyboardMotion(true);
        setActiveIndex(match);
      }
    }
  }

  const menuStyle: CSSProperties = position ? {
    position: 'fixed', left: position.left, right: 'auto', width: position.width,
    top: position.top ?? 'auto', bottom: position.bottom ?? 'auto',
    maxHeight: position.maxHeight, overflowY: 'auto', transformOrigin: position.transformOrigin,
    zIndex: 140
  } : { position: 'fixed', visibility: 'hidden' };
  const portalRoot = rootRef.current?.closest<HTMLElement>('[role="dialog"],[role="alertdialog"]') ??
    (typeof document !== 'undefined' ? document.body : null);

  return (
    <div className={joinClassNames('animated-select', className, disabled && 'disabled')} ref={rootRef} style={minWidth ? { minWidth } : undefined}>
      {label ? <span className="animated-select-label" id={labelId}>{label}</span> : null}
      <button
        aria-activedescendant={open ? `${id}-option-${activeIndex}` : undefined}
        aria-controls={open ? menuId : undefined}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-labelledby={label ? `${labelId} ${valueId}` : valueId}
        className={joinClassNames('animated-select-trigger', buttonClassName)}
        disabled={disabled || !options.length}
        onClick={(event) => open ? closeMenu(event.detail === 0) : openMenu(event.detail === 0)}
        onKeyDown={handleKeyDown}
        ref={triggerRef}
        role="combobox"
        type="button"
      >
        <span className="animated-select-trigger-copy">
          <span className="animated-select-trigger-title" id={valueId}>{selectedOption?.label ?? value}</span>
          {selectedOption?.description ? <span className="animated-select-trigger-description">{selectedOption.description}</span> : null}
        </span>
        <span aria-hidden="true" className="animated-select-caret">
          <Icon name="chevron-down" size={14} />
        </span>
      </button>
      {portalRoot ? createPortal(
        <AnimatePresence>
          {open ? (
            <motion.div
              animate="visible"
              className={joinClassNames('animated-select-menu-shell glass-popover', menuClassName)}
              data-placement={position?.placement ?? 'bottom'}
              exit="exit"
              initial="hidden"
              ref={menuRef}
              style={menuStyle}
              variants={getOverlayVariants('popover', reducedMotion, keyboardMotion)}
            >
              <div aria-labelledby={label ? labelId : valueId} className="animated-select-menu" id={menuId} role="listbox">
                {options.map((option, index) => {
                  const active = option.value === value;
                  return (
                    <button
                      aria-selected={active}
                      className={joinClassNames('animated-select-option', optionClassName, active && 'active', index === activeIndex && 'focused')}
                      id={`${id}-option-${index}`}
                      key={option.value}
                      onClick={() => commitOption(index)}
                      onPointerDown={(event) => event.preventDefault()}
                      onPointerMove={(event) => { if (event.pointerType === 'mouse') setActiveIndex(index); }}
                      role="option"
                      tabIndex={-1}
                      type="button"
                    >
                      {active ? <span aria-hidden="true" className="animated-select-option-indicator" /> : null}
                      <span className="animated-select-option-copy">
                        <span className="animated-select-option-title">{option.label}</span>
                        {option.description ? <span className="animated-select-option-description">{option.description}</span> : null}
                      </span>
                      {option.badge !== undefined ? <span className="animated-select-option-badge">{option.badge}</span> : null}
                    </button>
                  );
                })}
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>, portalRoot
      ) : null}
    </div>
  );
}

export default AnimatedSelect;
