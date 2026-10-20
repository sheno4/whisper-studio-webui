import { Children, cloneElement, isValidElement, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type ReactElement, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { createComponent, type MenuHandle } from '../../vendor/lens-native/index.js';
import { releaseLensRoot, scheduleLensMount } from '../../lens/Runtime';
import { bindLensMenuPopover } from '../../glass/lens-menu-adapter';

interface ActionMenuProps { label: ReactNode; ariaLabel?: string; className?: string; disabled?: boolean; children: ReactNode }
type MenuNodes = { instance: MenuHandle; trigger: HTMLButtonElement; label: HTMLElement; panel: HTMLElement };

/** Preserve every original React native button, callback and export group.
 * Only semantic menu attributes are composed onto those existing elements. */
function menuItems(nodes: ReactNode, close: () => void): ReactNode {
  return Children.map(nodes, node => {
    if (!isValidElement(node)) return node;
    if (node.type === 'button') {
      const button = node as ReactElement<ButtonHTMLAttributes<HTMLButtonElement>>;
      return cloneElement(button, {
        className: `lg-menu-item glass-menu-item ${button.props.className ?? ''}`.trim(),
        type: button.props.type ?? 'button', role: 'menuitem', tabIndex: -1,
        onClick: event => { button.props.onClick?.(event); if (!event.defaultPrevented && !event.currentTarget.matches(':disabled')) close(); }
      });
    }
    const element = node as ReactElement<{ children?: ReactNode }>;
    return element.props.children === undefined ? element : cloneElement(element, {}, menuItems(element.props.children, close));
  });
}

/** The original menu factory supplies its trigger, surface and open/close
 * lifecycle. A thin semantic adapter lets its popup contain grouped JSX. */
export default function ActionMenu({ label, ariaLabel, className = '', disabled = false, children }: ActionMenuProps): React.JSX.Element {
  const host = useRef<HTMLSpanElement>(null), control = useRef<MenuNodes | null>(null);
  const [nodes, setNodes] = useState<MenuNodes | null>(null);
  const latest = useRef({ ariaLabel, className }); latest.current = { ariaLabel, className };
  useLayoutEffect(() => {
    const root = host.current; if (!root) return;
    const instance = createComponent('menu', { label: latest.current.ariaLabel || '操作菜单', options: [{ value: '__react_menu_content__', label: '操作' }] });
    const trigger = instance.element.querySelector<HTMLButtonElement>(':scope > button')!, panel = instance.element.querySelector<HTMLElement>('.lg-menu-popover')!;
    const labelNode = document.createElement('span'); labelNode.className = 'glass-menu-trigger__content';
    trigger.replaceChildren(labelNode); trigger.classList.add('studio-menu-trigger', 'glass-menu-trigger');
    panel.classList.add('glass-action-menu'); panel.replaceChildren();
    const current = { instance, trigger, label: labelNode, panel }; control.current = current;
    root.append(instance.element);
    const abort = new AbortController(), signal = abort.signal;
    const available = (): HTMLButtonElement[] => [...panel.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]')].filter(button => !button.matches(':disabled') && !button.hidden && !button.closest('[hidden]'));
    const focus = (last = false): void => { const items = available(); (last ? items.at(-1) : items[0])?.focus({ preventScroll: true }); };
    const stopPopover = bindLensMenuPopover(instance, { align: 'end', onOpen: focus });
    // The factory's own keyboard list is flat. Use the actual preserved native
    // buttons when a grouped export menu supplies the application content.
    trigger.addEventListener('keydown', event => {
      if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
      event.preventDefault(); event.stopImmediatePropagation();
      if (trigger.matches(':disabled')) return;
      instance.open(); queueMicrotask(() => { if (control.current === current) focus(event.key === 'ArrowUp'); });
    }, { signal, capture: true });
    let search = '', searchedAt = 0;
    panel.addEventListener('keydown', event => {
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault(); event.stopImmediatePropagation();
        const items = available(), index = items.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items[next]?.focus();
      } else if (event.key.length === 1 && event.key !== ' ' && !event.altKey && !event.ctrlKey && !event.metaKey && !event.isComposing) {
        const now = performance.now(); search = now - searchedAt > 650 ? event.key : search + event.key; searchedAt = now;
        const next = available().find(button => (button.textContent ?? '').trim().toLocaleLowerCase().startsWith(search.toLocaleLowerCase()));
        if (next) { event.preventDefault(); next.focus(); }
      }
    }, { signal, capture: true });
    scheduleLensMount(instance.element); setNodes(current);
    return () => { control.current = null; abort.abort(); stopPopover(); releaseLensRoot(instance.element); instance.destroy(); instance.element.remove(); };
  }, []);
  useLayoutEffect(() => {
    const current = control.current; if (!current) return;
    current.trigger.className = `lg-surface lg-button studio-menu-trigger glass-menu-trigger ${className}`.trim();
    current.trigger.setAttribute('aria-label', ariaLabel || '操作菜单'); current.panel.setAttribute('aria-label', ariaLabel || '操作菜单');
    current.trigger.disabled = disabled;
    if (disabled) current.instance.close();
  }, [nodes, ariaLabel, className, disabled]);
  return <span ref={host} className="glass-action-menu-host" data-glass-source="lens-native">
    {nodes ? createPortal(label, nodes.label) : null}
    {nodes ? createPortal(<div className="glass-action-menu-content">{menuItems(children, () => { if (control.current === nodes) nodes.instance.close(); })}</div>, nodes.panel) : null}
  </span>;
}
