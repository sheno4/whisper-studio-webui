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
      "export { useWorkspaceSelection } from './src/renderer/hooks/useWorkspaceSelection';"
    ].join('\n'),
    resolveDir: fileURLToPath(new URL('..', import.meta.url))
  },
  bundle: true, platform: 'node', format: 'cjs', external: ['react'], write: false
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
function mountHook(name, api, initialArgs = []) {
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
  const window = { whisperWeb: api, setTimeout: () => 1, clearTimeout() {} };
  vm.runInNewContext(code, { module, exports: module.exports, require: (id) => {
    assert.equal(id, 'react'); return react;
  }, window, crypto, console, URL, navigator: {} });
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
