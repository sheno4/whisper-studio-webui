import { LayoutGroup, motion } from 'framer-motion';
import type { ReactNode } from 'react';

import { tabIndicatorTransition } from '../motion';

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
  return (
    <LayoutGroup id={id}>
      <div
        aria-label={ariaLabel}
        className={joinClassNames(
          'segmented-control',
          allowWrap && 'allow-wrap',
          stretch && 'stretch',
          className
        )}
        role="group"
      >
        {items.map((item) => {
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
              title={item.title}
              type="button"
            >
              {active ? (
                <motion.span
                  className="segment-active-indicator"
                  layoutId={`${id}-indicator`}
                  transition={tabIndicatorTransition}
                />
              ) : null}
              <span className="segment-label">{item.label}</span>
              {item.badge !== undefined ? <span className="segment-button-badge">{item.badge}</span> : null}
            </button>
          );
        })}
      </div>
    </LayoutGroup>
  );
}

export default SegmentedControl;
