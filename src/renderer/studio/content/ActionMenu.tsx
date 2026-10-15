import { Menu } from '@base-ui/react/menu';
import { Children, cloneElement, isValidElement, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';

import { useGlassCapability } from '../../glass/capabilities';
import { LiquidMenuHighlight } from '../../glass/LiquidMenuHighlight';
import { RdevMaterial } from '../../glass/RdevMaterial';

interface ActionMenuProps {
  label: ReactNode;
  ariaLabel?: string;
  className?: string;
  children: ReactNode;
}

/** Keep each existing native button and callback. Base UI composes its one
 * activation handler with that button instead of duplicating the action. */
function primitiveItems(nodes: ReactNode): ReactNode {
  return Children.map(nodes, (node) => {
    if (!isValidElement(node)) return node;
    const element = node as ReactElement<{ children?: ReactNode; disabled?: boolean }>;
    if (element.type === 'button') {
      return <Menu.Item nativeButton disabled={element.props.disabled} className="glass-menu-item" render={element}>{element.props.children}</Menu.Item>;
    }
    return element.props.children === undefined ? element : cloneElement(element, {}, primitiveItems(element.props.children));
  });
}

/** The popup escapes the card's backdrop root, while a dialog's existing
 * focus/inert boundary remains intact. The primitive owns all menu navigation. */
export default function ActionMenu({ label, ariaLabel, className = '', children }: ActionMenuProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const glass = useGlassCapability();
  useLayoutEffect(() => {
    setContainer(triggerRef.current?.closest<HTMLElement>('[role="dialog"]') ?? document.querySelector<HTMLElement>('.studio-root') ?? document.body);
  }, []);
  const escape = (event: React.KeyboardEvent): void => {
    if (open && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); }
  };
  return <Menu.Root open={open} modal={false} onOpenChange={(next, details) => {
    if (details.reason === 'escape-key') details.event.stopPropagation();
    setOpen(next);
  }}>
    <Menu.Trigger ref={triggerRef} className={`studio-menu-trigger glass-menu-trigger ${className}`.trim()} aria-label={ariaLabel} data-glass-mode={glass.mode} data-liquid-glass-source onKeyDownCapture={escape}>
      {glass.mode === 'optical' ? <RdevMaterial owner="select" radius={12} interactionRef={triggerRef} /> : null}
      <span className="glass-menu-trigger__content">{label}</span>
    </Menu.Trigger>
    <Menu.Portal container={container}>
      <Menu.Positioner className="glass-menu-positioner" sideOffset={8} align="end" positionMethod="fixed" collisionPadding={12} collisionAvoidance={{ side: 'flip', align: 'shift', fallbackAxisSide: 'none' }}>
        <Menu.Popup ref={popupRef} className="glass-action-menu" aria-label={ariaLabel} data-glass-mode={glass.mode} data-liquid-glass-source onKeyDownCapture={escape}>
          {glass.mode === 'optical' ? <RdevMaterial owner="menu" radius={18} interactionRef={popupRef} /> : null}
          <div ref={contentRef} className="glass-action-menu-content">
            <LiquidMenuHighlight hostRef={contentRef} active={open} itemSelector=".glass-menu-item" />
            {primitiveItems(children)}
          </div>
        </Menu.Popup>
      </Menu.Positioner>
    </Menu.Portal>
  </Menu.Root>;
}
