import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { buildSync } = createRequire(require.resolve('tsx'))('esbuild');
const code = buildSync({
  entryPoints: [fileURLToPath(new URL('../src/renderer/utils.ts', import.meta.url))],
  bundle: true, platform: 'browser', format: 'cjs', write: false
}).outputFiles[0].text;

function loadUtils(globals = {}) {
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, URL, ...globals });
  return module.exports;
}

test('UI ids keep UUID shape when either or both Web Crypto APIs are unavailable', () => {
  const implementations = [
    undefined,
    { getRandomValues: crypto.getRandomValues.bind(crypto) },
    { randomUUID() { throw new Error('blocked'); }, getRandomValues() { throw new Error('blocked'); } }
  ];
  for (const implementation of implementations) {
    const utils = loadUtils({ crypto: implementation });
    const ids = new Set(Array.from({ length: 16 }, () => utils.createRandomId()));
    assert.equal(ids.size, 16);
    for (const id of ids) {
      assert.match(id, /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/);
    }
  }
});

function clipboardDom(copySucceeds) {
  const calls = [];
  class HTMLElement {
    isConnected = true;
    focus() { calls.push(this === previousFocus ? 'restore-focus' : 'focus-copy'); }
  }
  class HTMLInputElement extends HTMLElement {}
  class HTMLTextAreaElement extends HTMLElement {
    style = {};
    selectionStart = 2;
    selectionEnd = 5;
    selectionDirection = 'backward';
    setAttribute() {}
    select() { calls.push('select-copy'); }
    setSelectionRange(start, end, direction) { calls.push(['selection', start, end, direction]); }
    remove() { calls.push('remove-copy'); }
  }
  const previousFocus = new HTMLTextAreaElement();
  const originalRange = { cloneRange: () => ({ saved: true }) };
  const selection = {
    rangeCount: 1,
    getRangeAt: () => originalRange,
    removeAllRanges: () => calls.push('clear-selection'),
    addRange: () => calls.push('restore-range')
  };
  const document = {
    activeElement: previousFocus,
    getSelection: () => selection,
    createElement: () => new HTMLTextAreaElement(),
    body: { append: (element) => calls.push(['copy-text', element.value]) },
    execCommand: () => { calls.push('copy'); return copySucceeds; }
  };
  return { globals: { document, HTMLElement, HTMLInputElement, HTMLTextAreaElement }, calls };
}

test('LAN HTTP copy uses the DOM fallback and restores the user selection', async () => {
  const dom = clipboardDom(true);
  const utils = loadUtils({ ...dom.globals, navigator: {} });
  await utils.copyTextToClipboard('本地字幕');
  assert.ok(dom.calls.some((call) => Array.isArray(call) && call[0] === 'copy-text' && call[1] === '本地字幕'));
  assert.ok(dom.calls.includes('copy'));
  assert.ok(dom.calls.includes('remove-copy'));
  assert.ok(dom.calls.includes('restore-focus'));
  assert.ok(dom.calls.includes('restore-range'));
  assert.deepEqual(dom.calls.find((call) => Array.isArray(call) && call[1] === 2), ['selection', 2, 5, 'backward']);
});

test('clipboard permission failure retries the DOM path and exposes an actionable error on rejection', async () => {
  const dom = clipboardDom(false);
  let attempts = 0;
  const utils = loadUtils({ ...dom.globals, navigator: {
    clipboard: { async writeText() { attempts++; throw new Error('denied'); } }
  } });
  await assert.rejects(utils.copyTextToClipboard('字幕'), /请手动选中文本复制/);
  assert.equal(attempts, 1);
  assert.ok(dom.calls.includes('copy'));
  assert.ok(dom.calls.includes('remove-copy'));
  assert.ok(dom.calls.includes('restore-focus'));
});
