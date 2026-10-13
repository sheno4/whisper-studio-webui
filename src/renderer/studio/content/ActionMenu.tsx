import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { GlassSurface } from '../../glass';

interface ActionMenuProps {
  label: ReactNode;
  ariaLabel?: string;
  className?: string;
  children: ReactNode;
}

/** An anchored action menu with live glass, independent of the scrolling card. */
export default function ActionMenu({ label, ariaLabel, className = '', children }: ActionMenuProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ left: number; top: number; above: boolean }>();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const initialItem = useRef<'first' | 'last'>('first');
  const didFocus = useRef(false);
  const id = useId();

  const close = (restoreFocus: boolean): void => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus({ preventScroll: true });
  };

  useLayoutEffect(() => {
    if (!open) { setPosition(undefined); didFocus.current = false; return; }
    const panel = panelRef.current;
    const trigger = triggerRef.current;
    if (!panel || !trigger) return;
    panel.querySelectorAll('button').forEach((item) => item.setAttribute('role', 'menuitem'));
    const reposition = (): void => {
      const anchor = trigger.getBoundingClientRect();
      const box = panel.getBoundingClientRect();
      const viewport = window.visualViewport;
      const leftEdge = viewport?.offsetLeft ?? 0;
      const topEdge = viewport?.offsetTop ?? 0;
      const width = viewport?.width ?? document.documentElement.clientWidth;
      const height = viewport?.height ?? window.innerHeight;
      const above = anchor.bottom + 8 + box.height > topEdge + height - 12 && anchor.top - topEdge > box.height + 8;
      setPosition({
        left: Math.max(leftEdge + 12, Math.min(anchor.right - box.width, leftEdge + width - box.width - 12)),
        top: Math.max(topEdge + 12, Math.min(above ? anchor.top - box.height - 8 : anchor.bottom + 8, topEdge + height - box.height - 12)),
        above
      });
    };
    reposition();
    const observer = new ResizeObserver(reposition);
    observer.observe(panel);
    window.addEventListener('resize', reposition, { passive: true });
    window.addEventListener('scroll', reposition, { passive: true, capture: true });
    window.visualViewport?.addEventListener('resize', reposition, { passive: true });
    window.visualViewport?.addEventListener('scroll', reposition, { passive: true });
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
      window.visualViewport?.removeEventListener('resize', reposition);
      window.visualViewport?.removeEventListener('scroll', reposition);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !position || didFocus.current) return;
    const items = Array.from(panelRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
    (initialItem.current === 'last' ? items.at(-1) : items[0])?.focus({ preventScroll: true });
    didFocus.current = true;
  }, [open, position]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (!panelRef.current?.contains(target) && !triggerRef.current?.contains(target)) close(false);
    };
    const leave = (event: FocusEvent): void => {
      const target = event.target as Node;
      if (!panelRef.current?.contains(target) && !triggerRef.current?.contains(target)) close(false);
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('focusin', leave);
    return () => { document.removeEventListener('pointerdown', outside, true); document.removeEventListener('focusin', leave); };
  }, [open]);

  return <>
    <button className={`studio-menu-trigger ${className}`.trim()} ref={triggerRef} type="button" aria-label={ariaLabel} aria-expanded={open} aria-haspopup="menu" aria-controls={open ? id : undefined} onClick={() => { initialItem.current = 'first'; setOpen((value) => !value); }} onKeyDown={(event) => {
      if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); initialItem.current = event.key === 'ArrowUp' ? 'last' : 'first'; setOpen(true); }
      if (event.key === 'Escape' && open) { event.preventDefault(); close(true); }
    }}>{label}</button>
    {open ? createPortal(<GlassSurface className="studio-action-popover" ref={panelRef} id={id} radius={18} tone="strong" role="menu" aria-label={ariaLabel} style={{ position: 'fixed', left: position?.left ?? 0, top: position?.top ?? 0, visibility: position ? 'visible' : 'hidden', transformOrigin: position?.above ? 'right bottom' : 'right top' }} onClick={(event) => {
      const item = (event.target as Element).closest('button');
      if (item && !item.disabled) close(true);
    }} onKeyDown={(event) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); return; }
      if (event.key === 'Tab') {
        event.preventDefault();
        const items = Array.from(document.querySelectorAll<HTMLElement>('a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]'))
          .filter((item) => item.tabIndex >= 0 && item.getClientRects().length > 0 && !item.closest('[inert], [aria-hidden="true"]') && !panelRef.current?.contains(item));
        const index = items.indexOf(triggerRef.current!);
        const next = items[index + (event.shiftKey ? -1 : 1)];
        close(false);
        (next ?? triggerRef.current)?.focus({ preventScroll: true });
        return;
      }
      const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End'];
      if (!keys.includes(event.key)) return;
      event.preventDefault();
      const items = Array.from(panelRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[next]?.focus({ preventScroll: true });
    }}>{children}</GlassSurface>, document.querySelector('.studio-root') ?? document.body) : null}
  </>;
}
