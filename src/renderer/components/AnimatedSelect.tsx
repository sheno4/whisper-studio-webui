import { AnimatePresence, LayoutGroup, motion } from 'framer-motion';
import type { ReactNode } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { quickTransition, smoothTransition, tabIndicatorTransition } from '../motion';
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

function joinClassNames(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(' ');
}

function AnimatedSelect<T extends string>({
  id,
  value,
  options,
  onChange,
  className,
  buttonClassName,
  menuClassName,
  optionClassName,
  label,
  disabled = false,
  minWidth
}: AnimatedSelectProps<T>): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const menuId = `${id}-menu`;
  const labelId = `${id}-label`;

  const selectedOption = useMemo(
    () => options.find((option) => option.value === value) ?? options[0],
    [options, value]
  );

  useEffect(() => {
    if (!open) {
      return;
    }

    const handlePointerDown = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };

    const handleEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };

    window.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('keydown', handleEscape);

    return () => {
      window.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('keydown', handleEscape);
    };
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const selectedIndex = options.findIndex((option) => option.value === value);
    setActiveIndex(Math.max(0, selectedIndex));
  }, [open, options, value]);

  function commitOption(index: number): void {
    const option = options[index];
    if (!option) {
      return;
    }

    onChange(option.value);
    setOpen(false);
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLButtonElement>): void {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }

      const direction = event.key === 'ArrowDown' ? 1 : -1;
      setActiveIndex((current) => (current + direction + options.length) % options.length);
      return;
    }

    if (!open) {
      return;
    }

    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      setActiveIndex(event.key === 'Home' ? 0 : options.length - 1);
      return;
    }

    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      commitOption(activeIndex);
      return;
    }

    if (event.key === 'Tab') {
      setOpen(false);
    }
  }

  return (
    <div
      className={joinClassNames('animated-select', className, disabled && 'disabled')}
      ref={rootRef}
      style={minWidth ? { minWidth } : undefined}
    >
      {label ? <span className="animated-select-label" id={labelId}>{label}</span> : null}

      <button
        aria-activedescendant={open ? `${id}-option-${activeIndex}` : undefined}
        aria-controls={menuId}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-labelledby={label ? labelId : undefined}
        className={joinClassNames('animated-select-trigger', buttonClassName)}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={handleKeyDown}
        type="button"
      >
        <span className="animated-select-trigger-copy">
          <span className="animated-select-trigger-title">{selectedOption?.label ?? value}</span>
          {selectedOption?.description ? (
            <span className="animated-select-trigger-description">{selectedOption.description}</span>
          ) : null}
        </span>
        <motion.span animate={{ rotate: open ? 180 : 0 }} className="animated-select-caret" transition={quickTransition}>
          <Icon name="chevron-down" size={14} />
        </motion.span>
      </button>

      <AnimatePresence>
        {open ? (
          <motion.div
            animate="visible"
            className={joinClassNames('animated-select-menu-shell', menuClassName)}
            exit="exit"
            initial="hidden"
            variants={{
              hidden: { opacity: 0, y: -8, scale: 0.985 },
              visible: { opacity: 1, y: 0, scale: 1, transition: smoothTransition },
              exit: { opacity: 0, y: -6, scale: 0.99, transition: quickTransition }
            }}
          >
            <LayoutGroup id={`animated-select-${id}`}>
              <div className="animated-select-menu" id={menuId} role="listbox">
                {options.map((option, index) => {
                  const active = option.value === value;
                  const focused = index === activeIndex;

                  return (
                    <button
                      aria-selected={active}
                      className={joinClassNames(
                        'animated-select-option',
                        optionClassName,
                        active && 'active',
                        focused && 'focused'
                      )}
                      id={`${id}-option-${index}`}
                      key={option.value}
                      onClick={() => commitOption(index)}
                      onMouseEnter={() => setActiveIndex(index)}
                      role="option"
                      tabIndex={-1}
                      type="button"
                    >
                      {active ? (
                        <motion.span
                          className="animated-select-option-indicator"
                          layoutId={`animated-select-option-${id}`}
                          transition={tabIndicatorTransition}
                        />
                      ) : null}
                      <span className="animated-select-option-copy">
                        <span className="animated-select-option-title">{option.label}</span>
                        {option.description ? (
                          <span className="animated-select-option-description">{option.description}</span>
                        ) : null}
                      </span>
                      {option.badge !== undefined ? (
                        <span className="animated-select-option-badge">{option.badge}</span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </LayoutGroup>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

export default AnimatedSelect;
