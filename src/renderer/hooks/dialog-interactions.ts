interface DialogOptions {
  onEscape: () => void;
  canDismiss: () => boolean;
  initialFocus?: () => HTMLElement | null;
}

interface DialogEntry {
  element: HTMLElement;
  previousFocus: HTMLElement | null;
  lastFocus: HTMLElement | null;
  background: HTMLElement[];
  options: DialogOptions;
}

interface DialogStack {
  entries: DialogEntry[];
  inert: Map<HTMLElement, { previous: boolean }>;
  overflow: string;
  paddingRight: string;
  removeListeners: () => void;
}

const stacks = new WeakMap<Document, DialogStack>();
const focusableSelector = 'a[href],button,input,select,textarea,[tabindex],[contenteditable="true"]';

function canReceiveFocus(candidate: HTMLElement): boolean {
  return candidate.isConnected && !candidate.matches(':disabled') &&
    !candidate.closest('[hidden],[inert],[aria-hidden="true"]') && candidate.getClientRects().length > 0 &&
    candidate.ownerDocument.defaultView?.getComputedStyle(candidate).visibility !== 'hidden';
}

function focusableElements(element: HTMLElement): HTMLElement[] {
  return [...element.querySelectorAll<HTMLElement>(focusableSelector)].filter((candidate) =>
    candidate.tabIndex >= 0 && canReceiveFocus(candidate)
  );
}

function focusElement(element: HTMLElement | null): void {
  if (element?.isConnected) element.focus({ preventScroll: true });
}

function focusInside(entry: DialogEntry): void {
  const preferred = entry.options.initialFocus?.();
  const target = preferred && canReceiveFocus(preferred) ? preferred
    : entry.lastFocus && canReceiveFocus(entry.lastFocus) ? entry.lastFocus
      : focusableElements(entry.element)[0] ?? entry.element;
  focusElement(target);
}

function backgroundElements(element: HTMLElement, document: Document): HTMLElement[] {
  const background: HTMLElement[] = [];
  let branch: HTMLElement | null = element;
  while (branch && branch !== document.body) {
    const parent: HTMLElement | null = branch.parentElement;
    if (!parent) break;
    for (const sibling of parent.children) {
      if (sibling !== branch && sibling instanceof document.defaultView!.HTMLElement &&
        !['SCRIPT', 'STYLE', 'LINK'].includes(sibling.tagName)) background.push(sibling);
    }
    branch = parent;
  }
  return background;
}

function updateBackground(stack: DialogStack): void {
  // Recompute for the topmost surface. Incremental inert locks can accidentally
  // leave a newly opened sibling dialog inside the previous dialog's inert tree.
  for (const [element, state] of stack.inert) element.inert = state.previous;
  stack.inert.clear();
  for (const sibling of stack.entries.at(-1)?.background ?? []) {
    stack.inert.set(sibling, { previous: sibling.inert });
    sibling.inert = true;
  }
}

/** Own keyboard/focus/scroll for the topmost dialog, including nested dialogs. */
export function registerDialog(element: HTMLElement, options: DialogOptions): () => void {
  const document = element.ownerDocument;
  const view = document.defaultView;
  let stack = stacks.get(document);

  if (!stack) {
    const originalOverflow = document.body.style.overflow;
    const originalPadding = document.body.style.paddingRight;
    const scrollbarWidth = view ? Math.max(0, view.innerWidth - document.documentElement.clientWidth) : 0;
    const reservedGutter = view?.getComputedStyle(document.documentElement).scrollbarGutter.includes('stable');
    if (scrollbarWidth && view && !reservedGutter) {
      const padding = Number.parseFloat(view.getComputedStyle(document.body).paddingRight) || 0;
      document.body.style.paddingRight = `${padding + scrollbarWidth}px`;
    }
    document.body.style.overflow = 'hidden';

    const nextStack: DialogStack = {
      entries: [], inert: new Map(), overflow: originalOverflow, paddingRight: originalPadding,
      removeListeners: () => {
        document.removeEventListener('keydown', handleKeyDown);
        document.removeEventListener('focusin', handleFocusIn);
      }
    };

    function handleKeyDown(event: KeyboardEvent): void {
      const current = nextStack.entries.at(-1);
      if (!current || event.defaultPrevented) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        if (current.options.canDismiss()) current.options.onEscape();
        return;
      }
      if (event.key !== 'Tab') return;
      const targets = focusableElements(current.element);
      const first = targets[0];
      const last = targets.at(-1);
      if (!first) { event.preventDefault(); focusElement(current.element); return; }
      if (event.shiftKey && (document.activeElement === first || !current.element.contains(document.activeElement))) {
        event.preventDefault(); focusElement(last ?? first);
      } else if (!event.shiftKey && (document.activeElement === last || !current.element.contains(document.activeElement))) {
        event.preventDefault(); focusElement(first);
      }
    }

    function handleFocusIn(event: FocusEvent): void {
      const current = nextStack.entries.at(-1);
      if (!current) return;
      const target = event.target as HTMLElement | null;
      if (target && current.element.contains(target)) current.lastFocus = target;
      else focusInside(current);
    }

    stack = nextStack;
    stacks.set(document, stack);
    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('focusin', handleFocusIn);
  }

  const activeElement = document.activeElement;
  const entry: DialogEntry = {
    element, previousFocus: activeElement instanceof view!.HTMLElement ? activeElement : null,
    lastFocus: null, background: backgroundElements(element, document), options
  };
  stack.entries.push(entry);
  updateBackground(stack);
  focusInside(entry);

  let released = false;
  return () => {
    if (released) return;
    released = true;
    const wasTop = stack.entries.at(-1) === entry;
    const index = stack.entries.indexOf(entry);
    if (index !== -1) stack.entries.splice(index, 1);
    updateBackground(stack);
    const current = stack.entries.at(-1);
    if (current && wasTop) {
      if (entry.previousFocus?.isConnected && current.element.contains(entry.previousFocus)) focusElement(entry.previousFocus);
      else focusInside(current);
    } else if (!current) {
      stack.removeListeners();
      document.body.style.overflow = stack.overflow;
      document.body.style.paddingRight = stack.paddingRight;
      stacks.delete(document);
      focusElement(entry.previousFocus);
    }
  };
}
