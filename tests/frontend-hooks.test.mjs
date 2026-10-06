import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const { buildSync } = createRequire(require.resolve('tsx'))('esbuild');
const code = buildSync({
  stdin: {
    contents: [
      "export { useWhisperWorkspace } from './src/renderer/hooks/useWhisperWorkspace';",
      "export { useDesktopSnapshot } from './src/renderer/hooks/useDesktopSnapshot';",
      "export { useWorkspaceSelection } from './src/renderer/hooks/useWorkspaceSelection';",
      "export { default as ModelPreparationPanel } from './src/renderer/components/ModelPreparationPanel';",
      "export { default as SettingsModal } from './src/renderer/components/SettingsModal';"
    ].join('\n'),
    resolveDir: fileURLToPath(new URL('..', import.meta.url))
  },
  bundle: true, platform: 'node', format: 'cjs', external: ['react', 'framer-motion'], write: false
}).outputFiles[0].text;

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const emptySnapshot = { settings: { translateByDefault: false, translationServices: [] }, tasks: [], history: [] };

// Unit-test the actual hook callbacks without a browser, image renderer, or DOM
// dependency. This scheduler implements state/effect ordering and cleanup only.
function mountHook(name, api, initialArgs = [], runtime = {}) {
  const slots = [];
  let cursor = 0;
  let dirty = true;
  let current;
  let args = initialArgs;
  let effects = [];
  const changed = (left, right) => !left || !right || left.length !== right.length || left.some((value, i) => !Object.is(value, right[i]));
  const react = {
    useState(initial) {
      const index = cursor++;
      slots[index] ??= { value: typeof initial === 'function' ? initial() : initial };
      return [slots[index].value, (next) => {
        const value = typeof next === 'function' ? next(slots[index].value) : next;
        if (!Object.is(value, slots[index].value)) { slots[index].value = value; dirty = true; }
      }];
    },
    useRef(value) { const index = cursor++; return slots[index] ??= { current: value }; },
    useMemo(factory, dependencies) {
      const index = cursor++;
      if (!slots[index] || changed(slots[index].dependencies, dependencies)) {
        slots[index] = { value: factory(), dependencies };
      }
      return slots[index].value;
    },
    useCallback(callback, dependencies) { return react.useMemo(() => callback, dependencies); },
    useEffect(callback, dependencies) {
      const index = cursor++;
      const prior = slots[index];
      if (!prior || changed(prior.dependencies, dependencies)) {
        slots[index] = { dependencies, cleanup: prior?.cleanup };
        effects.push(() => { slots[index].cleanup?.(); slots[index].cleanup = callback(); });
      }
    }
  };
  const module = { exports: {} };
  const window = { whisperWeb: api, setTimeout: () => 1, clearTimeout() {}, addEventListener() {}, removeEventListener() {} };
  vm.runInNewContext(code, { module, exports: module.exports, require: (id) => {
    if (id === 'react/jsx-runtime') {
      const jsx = (type, props) => ({ type, props });
      return { jsx, jsxs: jsx, Fragment: 'fragment' };
    }
    if (id === 'framer-motion') return { motion: new Proxy({}, { get: (_, name) => name }) };
    assert.equal(id, 'react'); return react;
  }, window, crypto, console, URL, Error, navigator: {}, ...runtime });
  const flush = () => {
    let renders = 0;
    while (dirty) {
      assert.ok(++renders < 40, 'hook should settle');
      dirty = false;
      cursor = 0;
      current = module.exports[name](...args);
      const pending = effects;
      effects = [];
      for (const effect of pending) effect();
    }
    return current;
  };
  flush();
  return {
    get current() { return flush(); },
    update(...next) { args = next; dirty = true; return flush(); },
    async settle() { await Promise.resolve(); await Promise.resolve(); return flush(); },
    dispose() { for (const slot of slots) slot?.cleanup?.(); }
  };
}

function workspaceApi(overrides = {}) {
  return {
    getSnapshot: async () => emptySnapshot, onState: () => () => {}, onToast: () => () => {},
    ...overrides
  };
}

function elements(tree) {
  if (Array.isArray(tree)) return tree.flatMap(elements);
  return tree && typeof tree === 'object' && tree.props ? [tree, ...elements(tree.props.children)] : [];
}

const selectedModelSettings = { pythonPath: 'selected-python', transcriptionEngine: 'whisper.cpp', whisperModel: 'turbo' };

test('model panel preserves other downloads, matches the Python environment, and shows only reported progress', () => {
  const states = [
    { id: 'download', pythonPath: 'other-python', engine: 'faster-whisper', model: 'small', status: 'preparing', message: '正在下载', percent: 25, downloadedBytes: 52428800, totalBytes: 209715200 },
    { id: 'current', pythonPath: 'selected-python', engine: 'whisper.cpp', model: 'large-v3-turbo', status: 'ready', message: '就绪' },
    { id: 'other-environment', pythonPath: 'other-python', engine: 'whisper.cpp', model: 'large-v3-turbo', status: 'failed', error: 'wrong environment', message: '失败' }
  ];
  const hook = mountHook('ModelPreparationPanel', {}, [{ settings: selectedModelSettings, preparations: states }]);
  const nodes = elements(hook.current);
  const rows = nodes.filter((node) => node.type === 'article');
  assert.equal(rows.length, 2);
  assert.equal(nodes.find((node) => node.type === 'progress').props.value, 25);
  assert.ok(nodes.some((node) => node.type === 'small' && node.props.children === '25% · 50.0 MB / 200.0 MB'));
  assert.ok(nodes.some((node) => node.props.className?.includes('row--ready')));
  assert.ok(!JSON.stringify(hook.current).includes('wrong environment'));
  hook.update({ settings: selectedModelSettings, preparations: [{ ...states[0], percent: undefined, downloadedBytes: undefined, totalBytes: undefined }, states[1]] });
  assert.equal(elements(hook.current).find((node) => node.type === 'progress').props.value, undefined);
  hook.dispose();
});

test('model panel retry failures stay visible and a late request response cannot replace streamed progress', async () => {
  const pending = deferred();
  let requests = 0;
  const failed = { id: 'failed', pythonPath: 'selected-python', engine: 'whisper.cpp', model: 'large-v3-turbo', status: 'failed', message: '断网' };
  const hook = mountHook('ModelPreparationPanel', {
    prepareModel: () => ++requests === 1 ? Promise.reject(new Error('download unavailable')) : pending.promise
  }, [{ settings: selectedModelSettings, preparations: [failed] }]);
  elements(hook.current).find((node) => node.type === 'button').props.onClick();
  await hook.settle();
  assert.equal(elements(hook.current).find((node) => node.props.role === 'alert').props.children, 'download unavailable');
  elements(hook.current).find((node) => node.type === 'button').props.onClick();
  const preparing = { ...failed, id: 'retry', status: 'preparing', percent: 72 };
  hook.update({ settings: selectedModelSettings, preparations: [preparing] });
  pending.resolve({ ...preparing, status: 'queued', percent: undefined });
  await hook.settle();
  assert.equal(elements(hook.current).find((node) => node.type === 'progress').props.value, 72);
  hook.update({ settings: selectedModelSettings, preparations: [{ ...failed, id: 'retry-elsewhere' }] });
  assert.equal(elements(hook.current).filter((node) => node.type === 'article').length, 1);
  assert.ok(!elements(hook.current).some((node) => node.type === 'progress'));
  hook.dispose();
});

test('model panel cancellation reports errors instead of claiming a completed cancellation', async () => {
  let cancelledId;
  const hook = mountHook('ModelPreparationPanel', {
    cancelModelPreparation: async (id) => { cancelledId = id; return false; }
  }, [{ settings: selectedModelSettings, preparations: [{
    id: 'active-model', pythonPath: 'selected-python', engine: 'whisper.cpp', model: 'large-v3-turbo', status: 'preparing', message: '下载中'
  }] }]);
  elements(hook.current).find((node) => node.type === 'button').props.onClick();
  await hook.settle();
  assert.equal(cancelledId, 'active-model');
  assert.match(elements(hook.current).find((node) => node.props.role === 'alert').props.children, /状态已更新/);
  assert.ok(elements(hook.current).some((node) => node.type === 'progress'));
  hook.dispose();
});

test('settings drafts survive background snapshots and saving keeps model progress open', async () => {
  const settings = { ...emptySnapshot.settings, pythonPath: 'python', outputDir: 'outputs', transcriptionEngine: 'faster-whisper', whisperModel: 'tiny', keepAudio: true, logLevel: 'info', debugMode: false };
  let closed = 0;
  let saved;
  const props = { settings, onClose: () => closed++, onSave: async (payload) => { saved = payload; }, onPickDirectory: async () => null, onPickWallpaper: async () => null };
  const hook = mountHook('SettingsModal', {}, [props]);
  elements(hook.current).find((node) => node.type === 'select' && node.props.value === 'tiny').props.onChange({ target: { value: 'small' } });
  hook.update({ ...props, settings: { ...settings, whisperModel: 'base' }, modelPreparations: [{ status: 'preparing' }] });
  assert.ok(elements(hook.current).some((node) => node.type === 'select' && node.props.value === 'small'));
  elements(hook.current).find((node) => node.type === 'button' && node.props.children === '保存设置').props.onClick();
  await hook.settle();
  assert.equal(saved.whisperModel, 'small');
  assert.equal(closed, 0);
  hook.dispose();
});

test('saving settings from LAN HTTP succeeds without a secure-context randomUUID', async () => {
  let saved = 0;
  const hook = mountHook('useWhisperWorkspace', workspaceApi({
    saveSettings: async () => { saved++; return { translateByDefault: true }; }
  }), [], { crypto: { getRandomValues: crypto.getRandomValues.bind(crypto) } });
  await hook.settle();
  await hook.current.saveSettings({});
  assert.equal(saved, 1);
  assert.equal(hook.current.composer.translateNext, true);
  assert.equal(hook.current.toasts.at(-1).title, '设置已保存');
  assert.equal(hook.current.toasts.at(-1).tone, 'success');
  hook.dispose();
});

test('busy drag/drop is rejected before uploading and gives an explicit retry message', async () => {
  const pending = deferred();
  let uploaded = 0;
  let imported = 0;
  const hook = mountHook('useWhisperWorkspace', workspaceApi({
    addLinkTasks: () => pending.promise,
    uploadFiles: async () => { uploaded++; return ['uploaded-path']; },
    addFileTasks: async () => { imported++; return []; }
  }));
  await hook.settle();
  hook.current.setLinkInput('https://youtu.be/one');
  const adding = hook.current.addLinks();
  await hook.current.addDroppedFiles([{}]);
  assert.equal(uploaded, 0);
  assert.equal(imported, 0);
  assert.match(hook.current.toasts.at(-1).message, /等待本次导入完成/);
  pending.resolve([]);
  await adding;
  await hook.current.addDroppedFiles([{}]);
  assert.equal(uploaded, 1);
  assert.equal(imported, 1);
  hook.dispose();
});

test('file picking and uploading remain busy until the task has been created', async () => {
  const pick = deferred();
  const create = deferred();
  let imports = 0;
  const hook = mountHook('useWhisperWorkspace', workspaceApi({
    pickFiles: () => pick.promise,
    addFileTasks: () => { imports++; return create.promise; }
  }));
  await hook.settle();
  const picking = hook.current.pickFiles();
  assert.equal(hook.current.composer.busy, true);
  pick.resolve(['uploaded-path']);
  await hook.settle();
  assert.equal(imports, 1);
  assert.equal(hook.current.composer.busy, true);
  create.resolve([]);
  await picking;
  assert.equal(hook.current.composer.busy, false);
  hook.dispose();
});

test('completing a submission preserves text typed for the next task', async () => {
  const pending = deferred();
  const hook = mountHook('useWhisperWorkspace', workspaceApi({ addLinkTasks: () => pending.promise }));
  await hook.settle();
  hook.current.setLinkInput('https://youtu.be/one');
  const adding = hook.current.addLinks();
  hook.current.setLinkInput('https://youtu.be/two');
  pending.resolve([]);
  await adding;
  assert.equal(hook.current.composer.linkInput, 'https://youtu.be/two');
  hook.dispose();
});

test('newer streamed state survives a late initial snapshot or error', async () => {
  for (const reject of [false, true]) {
    const pending = deferred();
    let listener;
    let hydrated;
    const hook = mountHook('useDesktopSnapshot', {
      getSnapshot: () => pending.promise,
      onState: (callback) => { listener = callback; return () => {}; }
    }, [(snapshot) => { hydrated = snapshot.version; }]);
    listener({ ...emptySnapshot, version: 'new' });
    if (reject) pending.reject(new Error('old error'));
    else pending.resolve({ ...emptySnapshot, version: 'old' });
    await hook.settle();
    assert.equal(hook.current.snapshot.version, 'new');
    assert.equal(hook.current.loadError, undefined);
    assert.equal(hydrated, 'new');
    hook.dispose();
  }
});

test('created link and file tasks appear immediately without a stream update', async () => {
  for (const source of ['link', 'file', 'drop']) {
    const nextTask = { id: `new-${source}`, status: 'queued' };
    const hook = mountHook('useWhisperWorkspace', workspaceApi({
      addLinkTasks: async () => [nextTask],
      pickFiles: async () => ['uploaded-path'],
      uploadFiles: async () => ['uploaded-path'],
      addFileTasks: async () => [nextTask]
    }));
    await hook.settle();
    if (source === 'link') {
      hook.current.setLinkInput('https://youtu.be/one');
      await hook.current.addLinks();
    } else if (source === 'file') {
      await hook.current.pickFiles();
    } else {
      await hook.current.addDroppedFiles([{}]);
    }
    assert.equal(hook.current.snapshot.tasks.length, 1);
    assert.equal(hook.current.snapshot.tasks[0].id, nextTask.id);
    assert.equal(hook.current.activity.selectedTaskId, nextTask.id);
    assert.equal(hook.current.composer.busy, false);
    hook.dispose();
  }
});

test('created task responses preserve newer streamed progress and avoid duplicate ids', async () => {
  let listener;
  const hook = mountHook('useDesktopSnapshot', {
    getSnapshot: async () => emptySnapshot,
    onState: (callback) => { listener = callback; return () => {}; }
  });
  await hook.settle();
  const advancedTask = { id: 'new', status: 'downloading', progressPercent: 35 };
  listener({ ...emptySnapshot, tasks: [advancedTask] });
  const createdTask = { id: 'new', status: 'queued' };
  hook.current.includeCreatedTasks([createdTask, createdTask]);
  assert.equal(hook.current.snapshot.tasks.length, 1);
  assert.equal(hook.current.snapshot.tasks[0].status, 'downloading');
  assert.equal(hook.current.snapshot.tasks[0].progressPercent, 35);
  hook.dispose();
});

test('created tasks survive delayed older streams until acknowledged and stay removed afterward', async () => {
  let listener;
  const hook = mountHook('useDesktopSnapshot', {
    getSnapshot: async () => emptySnapshot,
    onState: (callback) => { listener = callback; return () => {}; }
  });
  await hook.settle();
  const createdTask = { id: 'new', status: 'queued' };
  hook.current.includeCreatedTasks([createdTask]);
  assert.equal(hook.current.snapshot.tasks[0].id, 'new');
  listener(emptySnapshot);
  assert.equal(hook.current.snapshot.tasks.length, 1);
  assert.equal(hook.current.snapshot.tasks[0].id, 'new');
  const advancedTask = { ...createdTask, status: 'downloading', progressPercent: 35 };
  listener({ ...emptySnapshot, tasks: [advancedTask] });
  assert.equal(hook.current.snapshot.tasks[0].status, 'downloading');
  assert.equal(hook.current.snapshot.tasks[0].progressPercent, 35);
  listener(emptySnapshot);
  assert.equal(hook.current.snapshot.tasks.length, 0);
  hook.dispose();
});

test('created tasks survive a snapshot GET started before the creation response', async () => {
  const pending = deferred();
  let requests = 0;
  const hook = mountHook('useDesktopSnapshot', {
    getSnapshot: () => ++requests === 1 ? Promise.resolve(emptySnapshot) : pending.promise,
    onState: () => () => {}
  });
  await hook.settle();
  const reloading = hook.current.reload();
  hook.current.includeCreatedTasks([{ id: 'new', status: 'queued' }]);
  assert.equal(hook.current.snapshot.tasks[0].id, 'new');
  pending.resolve(emptySnapshot);
  await reloading;
  assert.equal(hook.current.snapshot.tasks.length, 1);
  assert.equal(hook.current.snapshot.tasks[0].id, 'new');
  hook.dispose();
});

test('created tasks before the initial snapshot trigger a fresh load and remain visible', async () => {
  const initial = deferred();
  let requests = 0;
  const hook = mountHook('useDesktopSnapshot', {
    getSnapshot: () => ++requests === 1 ? initial.promise : Promise.resolve(emptySnapshot),
    onState: () => () => {}
  });
  const createdTask = { id: 'new', status: 'queued' };
  hook.current.includeCreatedTasks([createdTask, createdTask]);
  await hook.settle();
  assert.equal(requests, 2);
  assert.equal(hook.current.snapshot.tasks.length, 1);
  assert.equal(hook.current.snapshot.tasks[0].id, 'new');
  initial.resolve(emptySnapshot);
  await hook.settle();
  assert.equal(hook.current.snapshot.tasks[0].id, 'new');
  hook.dispose();
});

test('new task focus survives the delayed stream update and later removal', () => {
  const oldTask = { id: 'old', status: 'completed' };
  const nextTask = { id: 'new', status: 'queued' };
  const hook = mountHook('useWorkspaceSelection', {}, [{ ...emptySnapshot, tasks: [oldTask] }]);
  assert.equal(hook.current.selectedTaskId, 'old');
  hook.current.focusCreatedTasks([nextTask]);
  assert.equal(hook.current.selectedTaskId, 'new');
  hook.update({ ...emptySnapshot, tasks: [oldTask, nextTask] });
  assert.equal(hook.current.selectedTaskId, 'new');
  hook.update({ ...emptySnapshot, tasks: [oldTask] });
  assert.equal(hook.current.selectedTaskId, 'old');
  hook.dispose();
});
