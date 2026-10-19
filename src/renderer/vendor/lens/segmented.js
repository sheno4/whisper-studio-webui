// Extracted from component-patterns.js at design-systems commit
// 7a424c93b9be13cf835b91ea67495fec2ec0584e (MIT). The original tab DOM,
// lg:set/lg:sync protocol and shared runtime's segment gesture remain intact.
// Integration additions only: controlled updates, badges, optional real panel
// associations, dynamic disabled state and deterministic keyboard alignment.
let patternId = 0;
const node = (tag, className, text) => {
  const element = document.createElement(tag);
  element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
};
const validate = (label, options) => {
  if (typeof label !== 'string' || !label.trim()) throw new TypeError('A non-empty accessible label is required');
  if (!options.length || new Set(options.map(option => option.value)).size !== options.length || options.some(option => typeof option.value !== 'string' || typeof option.label !== 'string' || !option.label.trim())) throw new TypeError('Use unique string option values and non-empty labels');
};
const attr=(element,name,value)=>{if(value===undefined){if(element.hasAttribute(name))element.removeAttribute(name);}else if(element.getAttribute(name)!==String(value))element.setAttribute(name,String(value));};

export function createSegmentedControl({label, options = [], value, disabled = false, panelIds = {}, onChange = () => {}} = {}) {
  validate(label, options);
  let current = value ?? options.find(option => !option.disabled)?.value ?? options[0].value;
  if (!options.some(option => option.value === current)) throw new TypeError('Invalid selection');
  let groupDisabled = disabled, destroyed = false;
  const abort = new AbortController(), signal = abort.signal, id = ++patternId;
  const element = node('div', 'lg-tabs'), bar = node('div', 'lg-segment-bar');
  const indicator = node('span', 'lg-segment-indicator lg-surface'), entries = [];
  element.dataset.lgSegments = 'true';
  bar.setAttribute('aria-label', label); bar.setAttribute('role', 'tablist');
  indicator.dataset.glass = 'tab'; indicator.setAttribute('aria-hidden', 'true');
  bar.append(indicator); element.append(bar);
  const available = () => entries.filter(({button}) => !button.matches(':disabled') && button.getAttribute('aria-disabled') !== 'true');
  const sync = (detail = {}) => element.dispatchEvent(new CustomEvent('lg:sync', {bubbles: true, detail}));
  let alignedX=-1,alignedWidth=-1;
  const align = (detail = {}) => {
    const button = entries.find(entry => entry.option.value === current)?.button;
    if (!button || destroyed) return;
    // Jelly owns the presentation width after mounting. A label/count update
    // must never replace the held lens's current fit behind the pointer.
    const x=button.offsetLeft,width=button.offsetWidth,changed=x!==alignedX||width!==alignedWidth;
    if(!indicator.hasAttribute('data-jelly')&&indicator.style.width!==`${width}px`)indicator.style.width = `${width}px`;
    if(indicator.style.getPropertyValue('--lg-segment-x')!==`${x}px`)indicator.style.setProperty('--lg-segment-x', `${x}px`);
    alignedX=x;alignedWidth=width;if(changed||detail.snap||detail.cancel)sync(detail);
  };
  const setValue = (next, {emit = false, snap = false, cancel = false, force = false} = {}) => {
    const entry = entries.find(entry => entry.option.value === next);
    if (!entry || (!force && (groupDisabled || entry.button.matches(':disabled')))) return false;
    const changed = current !== next;
    current = next;if(element.dataset.value!==current)element.dataset.value = current;
    for (const {option, button} of entries) {
      const selected = option.value === current;
      const tabIndex=selected&&!button.disabled?0:-1;if(button.tabIndex!==tabIndex)button.tabIndex=tabIndex;
      attr(button,'aria-selected',String(selected));
    }
    // If a selected tab is unavailable, an enabled tab remains keyboard reachable.
    if (!entries.some(({button}) => button.tabIndex === 0)){const first=available()[0]?.button;if(first)attr(first,'tabindex','0');}
    align({snap, cancel});
    if (changed && emit) onChange(current);
    return true;
  };
  const paintEntry = (entry, option, nextPanelIds) => {
    entry.option = {...option};
    if(entry.copy.textContent!==option.label)entry.copy.textContent = option.label;
    const disabled=groupDisabled||Boolean(option.disabled);if(entry.button.disabled!==disabled)entry.button.disabled=disabled;
    const hidden=option.badge===undefined||option.badge===null;if(entry.badge.hidden!==hidden)entry.badge.hidden=hidden;
    const text=hidden?'':typeof option.badge==='number'&&option.badge>99?'99+':String(option.badge);
    if(entry.badge.textContent!==text)entry.badge.textContent=text;
    attr(entry.badge,'title',hidden?undefined:String(option.badge));
    const panel = nextPanelIds?.[option.value];
    attr(entry.button,'aria-controls',panel||undefined);
  };
  for (const option of options) {
    const button = node('button', 'lg-segment-option'), copy = node('span', 'lg-segment-label'), badge = node('span', 'lg-segment-badge');
    button.type = 'button'; button.dataset.value = option.value; button.dataset.lgSound = 'select';
    button.setAttribute('role', 'tab'); button.id = `lg-tab-${id}-${entries.length}`;
    button.append(copy, badge);
    const entry = {option, button, copy, badge}; entries.push(entry); paintEntry(entry, option, panelIds);
    button.addEventListener('click', () => setValue(entry.option.value, {emit: true}), {signal});
    bar.append(button);
  }
  bar.setAttribute('aria-disabled', String(groupDisabled));
  bar.dataset.hasBadges=String(options.some(option=>option.badge!==undefined&&option.badge!==null));
  bar.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || event.altKey || event.ctrlKey || event.metaKey || groupDisabled) return;
    const enabled = available(); if (!enabled.length) return;
    event.preventDefault();
    const index = enabled.findIndex(entry => entry.option.value === current);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? enabled.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + enabled.length) % enabled.length;
    setValue(enabled[next].option.value, {emit: true, snap: true, cancel: true});
    enabled[next].button.focus();
  }, {signal});
  element.addEventListener('lg:set', event => {
    if (event.target === element) setValue(event.detail.value, {emit: Boolean(event.detail.emit)});
  }, {signal});
  // Container/label geometry must not animate like a selection change. The
  // motion runtime ignores this snap while held, preserving the live gesture.
  const observer = new ResizeObserver(() => align({snap: true})); observer.observe(bar);
  // Content-sized slots can resize while the overall rail remains unchanged.
  for(const {button} of entries)observer.observe(button);
  setValue(current, {force: true, snap: true});
  return {
    element,
    get value() { return current; },
    setValue,
    update({label: nextLabel = label, options: nextOptions = options, disabled: nextDisabled = groupDisabled, panelIds: nextPanelIds = panelIds} = {}) {
      validate(nextLabel, nextOptions);
      if (nextOptions.length !== entries.length || nextOptions.some((option, index) => option.value !== entries[index].option.value)) throw new TypeError('Recreate the control when option identities change');
      const availabilityChanged = groupDisabled !== nextDisabled || nextOptions.some((option, index) => Boolean(option.disabled) !== Boolean(entries[index].option.disabled));
      label = nextLabel; options = nextOptions; panelIds = nextPanelIds; groupDisabled = nextDisabled;
      attr(bar,'aria-label',label);attr(bar,'aria-disabled',String(groupDisabled));attr(bar,'data-has-badges',String(options.some(option=>option.badge!==undefined&&option.badge!==null)));
      entries.forEach((entry, index) => paintEntry(entry, options[index], panelIds));
      setValue(current, {force: true, cancel: availabilityChanged});
    },
    destroy() {
      destroyed = true; abort.abort(); observer.disconnect();
      element.dispatchEvent(new CustomEvent('lg:unmount', {bubbles: true}));
    }
  };
}
