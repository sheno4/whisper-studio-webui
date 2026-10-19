/** Add native Lens semantics to business-owned DOM without replacing inputs,
 * event handlers, selection, refs, form values or accessible names. */
const selector = 'button,input,textarea';
// Hidden business actions may become visible later without being reinserted.
// Their native visibility/accessibility attributes are deliberately preserved.
const skip = '[data-lens-native-ignore],[role=menu],[role=menuitem],[role=option],[role=tab],[role=switch],[data-lg-component],[data-lg-segments],.lg-search,.lg-stepper,.lg-notification-close';
type Enhancement = {classes: string[]; glass: string; drag: string | undefined; sound: string | undefined};

export function createNativeDOMEnhancer(stage: HTMLElement) {
  const enhanced = new Map<HTMLElement, Enhancement>();
  const release = (root: HTMLElement) => {
    for (const [element, state] of enhanced) {
      if (element !== root && !root.contains(element)) continue;
      state.classes.forEach(name => element.classList.remove(name));
      if (element.dataset.glass === state.glass) delete element.dataset.glass;
      if (state.drag && element.dataset.lgDrag === state.drag) delete element.dataset.lgDrag;
      if (state.sound && element.dataset.lgSound === state.sound) delete element.dataset.lgSound;
      delete element.dataset.lensNativeEnhanced;
      enhanced.delete(element);
    }
  };
  return {release, repair(element: HTMLElement) {
    const state = enhanced.get(element);
    // React may replace a business className when its state changes. Restore
    // only the added Lens classes, without mounting/recreating any body.
    if (state) for (const name of state.classes) if (!element.classList.contains(name)) element.classList.add(name);
  }, mount(root: HTMLElement = stage) {
    for (const element of [ ...(root.matches(selector) ? [root] : []), ...root.querySelectorAll<HTMLElement>(selector)]) {
      if (element.dataset.glass || enhanced.has(element) || element.closest(skip)) continue;
      const button = element instanceof HTMLButtonElement;
      if (!button && (!(element instanceof HTMLInputElement) && !(element instanceof HTMLTextAreaElement))) continue;
      if (element instanceof HTMLInputElement && ['range', 'checkbox', 'radio', 'hidden', 'file', 'color', 'button', 'submit', 'reset'].includes(element.type)) continue;
      const names = ['lg-surface', button ? 'lg-button' : 'lg-search'];
      const classes = names.filter(name => !element.classList.contains(name));
      element.classList.add(...classes);
      const state: Enhancement = {classes, glass: button ? 'button' : 'search', drag: undefined, sound: undefined};
      element.dataset.glass = state.glass;
      element.dataset.lensNativeEnhanced = 'true';
      if (button && !element.dataset.lgDrag) element.dataset.lgDrag = state.drag = 'press';
      if (!element.dataset.lgSound) element.dataset.lgSound = state.sound = button ? 'select' : 'type';
      enhanced.set(element, state);
    }
  }, prune() {
    for (const element of enhanced.keys()) if (!stage.contains(element)) release(element);
  }, destroy() {release(stage); enhanced.clear();}};
}
