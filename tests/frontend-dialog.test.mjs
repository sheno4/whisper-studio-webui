import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const { buildSync } = createRequire(require.resolve('tsx'))('esbuild');
const code = buildSync({
  stdin: {
    contents: "export { registerDialog } from './src/renderer/hooks/dialog-interactions';",
    resolveDir: fileURLToPath(new URL('..', import.meta.url))
  }, bundle: true, platform: 'node', format: 'cjs', write: false
}).outputFiles[0].text;

function fixture() {
  const listeners = new Map();
  const document = {
    activeElement: null,
    documentElement: { clientWidth: 1000 },
    addEventListener(name, handler) { listeners.set(name, handler); },
    removeEventListener(name, handler) { if (listeners.get(name) === handler) listeners.delete(name); }
  };
  class Element {
    constructor(tagName = 'DIV', tabIndex = -1) {
      Object.assign(this, { tagName, tabIndex, children: [], parentElement: null, ownerDocument: document, inert: false, hidden: false, disabled: false, visibility: 'visible', isConnected: true, style: {} });
    }
    append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child); } }
    contains(target) { return this === target || this.children.some((child) => child.contains(target)); }
    matches(selector) { return selector === ':disabled' && this.disabled; }
    closest() { return this.inert || this.hidden ? this : this.parentElement?.closest() ?? null; }
    getClientRects() { return this.hidden ? [] : [{}]; }
    querySelectorAll() {
      return this.children.flatMap((child) => [
        ...(child.tabIndex >= 0 || child.tagName === 'BUTTON' ? [child] : []),
        ...child.querySelectorAll()
      ]);
    }
    focus() {
      if (this.closest()) return;
      document.activeElement = this;
      listeners.get('focusin')?.({ target: this });
    }
  }
  document.defaultView = { HTMLElement: Element, innerWidth: 1016, getComputedStyle: (element) => ({ paddingRight: '4px', visibility: element.visibility }) };
  document.body = new Element('BODY');
  document.body.style = { overflow: 'auto', paddingRight: '4px' };
  const page = new Element();
  const opener = new Element('BUTTON', 0);
  page.append(opener);
  const backdrop = new Element();
  const panel = new Element();
  const first = new Element('BUTTON', 0);
  const disabled = new Element('BUTTON', 0);
  disabled.disabled = true;
  const invisible = new Element('BUTTON', 0);
  invisible.visibility = 'hidden';
  const last = new Element('BUTTON', 0);
  panel.append(first, disabled, invisible, last);
  backdrop.append(panel);
  document.body.append(page, backdrop);
  opener.focus();
  const key = (name, shiftKey = false) => {
    const event = { key: name, shiftKey, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {} };
    listeners.get('keydown')?.(event);
    return event;
  };
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports });
  return { ...module.exports, document, Element, page, opener, backdrop, panel, first, last, key, listeners };
}

test('dialog traps focus, excludes hidden or disabled controls, respects busy Escape and restores the opener', () => {
  const f = fixture();
  let dismissals = 0;
  let busy = false;
  const release = f.registerDialog(f.panel, { initialFocus: () => f.first, onEscape: () => dismissals++, canDismiss: () => !busy });
  assert.equal(f.document.activeElement, f.first);
  assert.equal(f.page.inert, true);
  assert.equal(f.document.body.style.overflow, 'hidden');
  assert.equal(f.document.body.style.paddingRight, '20px');
  assert.equal(f.key('Tab', true).defaultPrevented, true);
  assert.equal(f.document.activeElement, f.last);
  f.key('Tab');
  assert.equal(f.document.activeElement, f.first);
  busy = true;
  f.key('Escape');
  assert.equal(dismissals, 0);
  busy = false;
  f.key('Escape');
  assert.equal(dismissals, 1);
  release();
  release();
  assert.equal(f.page.inert, false);
  assert.equal(f.document.activeElement, f.opener);
  assert.equal(f.document.body.style.overflow, 'auto');
  assert.equal(f.document.body.style.paddingRight, '4px');
  assert.equal(f.listeners.size, 0);
});

test('a sibling confirmation promotes out of the settings inert tree and only the top dialog handles Escape', () => {
  const f = fixture();
  const confirmBackdrop = new f.Element();
  const confirmPanel = new f.Element();
  const cancel = new f.Element('BUTTON', 0);
  confirmPanel.append(cancel);
  confirmBackdrop.append(confirmPanel);
  f.document.body.append(confirmBackdrop);
  let settingsDismissals = 0;
  let confirmDismissals = 0;
  const releaseSettings = f.registerDialog(f.panel, { onEscape: () => settingsDismissals++, canDismiss: () => true });
  assert.equal(confirmBackdrop.inert, true);
  const releaseConfirm = f.registerDialog(confirmPanel, { onEscape: () => confirmDismissals++, canDismiss: () => true, initialFocus: () => cancel });
  assert.equal(confirmBackdrop.inert, false);
  assert.equal(f.backdrop.inert, true);
  assert.equal(f.document.activeElement, cancel);
  f.key('Escape');
  assert.equal(confirmDismissals, 1);
  assert.equal(settingsDismissals, 0);
  releaseConfirm();
  assert.equal(f.backdrop.inert, false);
  assert.equal(f.document.activeElement, f.first);
  assert.equal(f.document.body.style.overflow, 'hidden');
  releaseSettings();
  assert.equal(f.document.activeElement, f.opener);
  assert.equal(f.document.body.style.overflow, 'auto');
});
