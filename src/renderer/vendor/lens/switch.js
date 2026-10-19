// Extracted from components.js at design-systems commit
// 7a424c93b9be13cf835b91ea67495fec2ec0584e (MIT; see ./LICENSE).
// Original switch DOM and lg:set/lg:sync protocol are preserved. Integration
// additions: controlled snap/cancel, inherited disabled state and unmount signal.
// Its single Jelly body additionally consumes the pinned IshiakiZ switch lift,
// asymptotic edge band and directional release calculation (../ishiakiz).
const accessibleLabel = label => {
  if (typeof label !== 'string' || !label.trim()) throw new TypeError('A non-empty accessible label is required');
  return label;
};
const node = (tag, className) => { const element = document.createElement(tag); element.className = className; return element; };
const surface = (element, kind) => { element.classList.add('lg-surface'); element.dataset.glass = kind; return element; };
function checkIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const path = document.createElementNS(svg.namespaceURI, 'path');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true'); svg.classList.add('lg-icon');
  path.setAttribute('d', 'm5 12 4 4L19 6'); svg.append(path); return svg;
}

export function bindSwitch(element, { checked = element.getAttribute('aria-checked') === 'true', onChange = () => {} } = {}) {
  const abort = new AbortController(), signal = abort.signal;
  let destroyed = false;
  element.setAttribute('role', 'switch'); element.dataset.lgSound = 'toggle';
  const disabled = () => element.matches(':disabled') || element.getAttribute('aria-disabled') === 'true';
  const sync = detail => element.dispatchEvent(new CustomEvent('lg:sync', { bubbles: true, detail }));
  const setValue = (value, { emit = false, snap = false, cancel = false, force = false } = {}) => {
    if (destroyed || emit && !force && disabled()) return false;
    const next = Boolean(value), previous = element.getAttribute('aria-checked') === 'true';
    element.setAttribute('aria-checked', String(next));
    if (emit && previous !== next) onChange(next);
    sync({ snap, cancel }); return true;
  };
  setValue(checked, { force: true, snap: true });
  element.addEventListener('lg:set', event => {
    if (event.target === element) setValue(event.detail.value, { emit: Boolean(event.detail.emit) });
  }, { signal });
  element.addEventListener('click', () => {
    if (!disabled()) setValue(element.getAttribute('aria-checked') !== 'true', { emit: true });
  }, { signal });
  // Space and Enter are native button clicks; handling them twice would toggle twice.
  element.addEventListener('keydown', event => {
    if (!disabled() && !event.altKey && !event.ctrlKey && !event.metaKey && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      setValue(event.key === 'ArrowRight' || event.key === 'End', { emit: true, snap: true, cancel: true });
      element.dispatchEvent(new CustomEvent('lg:commit', { bubbles: true, detail: { cue: element.getAttribute('aria-checked') === 'true' ? 'switchOn' : 'switchOff' } }));
    }
  }, { signal });
  return {
    element,
    get value() { return element.getAttribute('aria-checked') === 'true'; },
    setValue,
    update({ label, disabled: nextDisabled = element.disabled } = {}) {
      if (label !== undefined) element.setAttribute('aria-label', accessibleLabel(label));
      const changed = element.disabled !== Boolean(nextDisabled);
      element.disabled = Boolean(nextDisabled);
      if (changed) sync({ cancel: true, snap: true });
    },
    destroy() {
      if (destroyed) return; destroyed = true; abort.abort();
      element.dispatchEvent(new CustomEvent('lg:unmount', { bubbles: true }));
    }
  };
}

export function createSwitch({ label, checked = false, disabled = false, onChange } = {}) {
  const element = node('button', 'lg-switch');
  element.type = 'button'; element.disabled = Boolean(disabled);
  element.setAttribute('aria-label', accessibleLabel(label)); element.dataset.lgComponent = 'switch';
  const track = surface(node('span', 'lg-switch-track'), 'switch-track');
  const thumb = surface(node('span', 'lg-switch-thumb'), 'thumb');
  track.setAttribute('aria-hidden', 'true'); thumb.setAttribute('aria-hidden', 'true');
  thumb.append(checkIcon()); element.append(track, thumb);
  return bindSwitch(element, { checked, onChange });
}
