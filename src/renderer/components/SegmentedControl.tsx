import { useRef, type KeyboardEvent, type ReactNode } from 'react';

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  badge?: ReactNode;
  disabled?: boolean;
  title?: string;
  buttonClassName?: string;
}

interface SegmentedControlProps<T extends string> {
  id: string;
  value: T;
  items: Array<SegmentedOption<T>>;
  onChange: (value: T) => void;
  className?: string;
  buttonClassName?: string;
  ariaLabel?: string;
  allowWrap?: boolean;
  stretch?: boolean;
}

function joinClassNames(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(' ');
}

function SegmentedControl<T extends string>({
  id,
  value,
  items,
  onChange,
  className,
  buttonClassName,
  ariaLabel,
  allowWrap = false,
  stretch = false
}: SegmentedControlProps<T>): React.JSX.Element {
  const groupRef = useRef<HTMLDivElement | null>(null);
  const selectedIndex = items.findIndex((item) => item.value === value && !item.disabled);
  const tabbableIndex = selectedIndex >= 0 ? selectedIndex : items.findIndex((item) => !item.disabled);

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    const available = items.map((item, itemIndex) => !item.disabled ? itemIndex : -1).filter((itemIndex) => itemIndex >= 0);
    if (!available.length) return;
    let next: number;
    if (event.key === 'Home') next = available[0];
    else if (event.key === 'End') next = available[available.length - 1];
    else if (['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown'].includes(event.key)) {
      const direction = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1;
      next = available[(available.indexOf(index) + direction + available.length) % available.length];
    } else return;
    event.preventDefault();
    onChange(items[next].value);
    groupRef.current?.querySelectorAll<HTMLButtonElement>('button')[next]?.focus({ preventScroll: true });
  };

  return (
      <div
        aria-label={ariaLabel}
        className={joinClassNames(
          'segmented-control',
          allowWrap && 'allow-wrap',
          stretch && 'stretch',
          className
        )}
        id={id}
        ref={groupRef}
        role="group"
      >
        {items.map((item, index) => {
          const active = value === item.value;

          return (
            <button
              aria-pressed={active}
              className={joinClassNames(
                'segment-button',
                active && 'active',
                stretch && 'stretch-button',
                buttonClassName,
                item.buttonClassName
              )}
              disabled={item.disabled}
              key={item.value}
              onClick={() => onChange(item.value)}
              onKeyDown={(event) => handleKeyDown(event, index)}
              tabIndex={index === tabbableIndex ? 0 : -1}
              title={item.title}
              type="button"
            >
              {active ? (
                <span
                  aria-hidden="true"
                  className="segment-active-indicator"
                />
              ) : null}
              <span className="segment-label">{item.label}</span>
              {item.badge !== undefined ? <span className="segment-button-badge">{item.badge}</span> : null}
            </button>
          );
        })}
      </div>
  );
}

export default SegmentedControl;
