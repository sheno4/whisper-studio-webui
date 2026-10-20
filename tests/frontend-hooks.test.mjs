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

const historySummary = (id, outputDir = `/results/${id}`) => ({ id, displayName: id, sourceType: 'link', createdAt: '2026-10-19T00:00:00Z', finishedAt: '2026-10-19T01:00:00Z', status: 'completed', outputDir });
const finishedResult = (id, changes = {}) => ({ id, sourceType: 'link', input: `https://fixture.invalid/${id}`, displayName: id, status: 'completed', createdAt: '2026-10-19T00:00:00Z', updatedAt: '2026-10-19T01:00:00Z', progressMessage: '完成', attempts: 1, translateToChinese: true, downloadBehavior: 'transcribe', videoQuality: 'best', transcriptionLanguage: 'auto', transcriptText: `Original ${id}`, translationText: `译文 ${id}`, transcriptSegments: [{ id: 0, start: 0, end: 1, text: `Original ${id}` }], translationSegments: [{ id: 0, start: 0, end: 1, text: `译文 ${id}` }], outputDir: `/results/${id}`, outputFiles: { transcriptTxt: `/results/${id}/original.txt` }, logs: [{ timestamp: '2026-10-19T01:00:00Z', level: 'info', message: `Finished ${id}` }], ...changes });

test('history loads full finished results without a live task and rejects late selection responses', async () => {
  const first = deferred(), second = deferred(), refreshed = deferred();
  const requests = [];
  const snapshot = { ...emptySnapshot, history: [historySummary('A'), historySummary('B')] };
  const hook = mountHook('useWorkspaceSelection', { getHistoryResult: id => { requests.push(id); return requests.length === 1 ? first.promise : requests.length === 2 ? second.promise : refreshed.promise; } }, [snapshot]);
  hook.current.setActivityView('history');
  assert.equal(hook.current.historyResultLoading, true);
  hook.current.setSelectedHistoryId('B');
  assert.equal(hook.current.activeTask, undefined);
  first.resolve(finishedResult('A'));await hook.settle();
  assert.equal(hook.current.activeTask, undefined, 'late A cannot appear while B loads');
  second.resolve(finishedResult('B'));await hook.settle();
  assert.equal(hook.current.activeTask.transcriptText, 'Original B');
  assert.equal(hook.current.activeTask.translationText, '译文 B');
  assert.equal(hook.current.activeTask.logs[0].message, 'Finished B');
  hook.update({ ...snapshot, tasks: [finishedResult('B', { status: 'transcribing', updatedAt: '2026-10-19T02:00:00Z', transcriptText: 'New unfinished run' })] });
  assert.equal(hook.current.activeTask.transcriptText, 'Original B', 'retry must not replace the finished history result');
  hook.update({ ...snapshot, history: [historySummary('A'), historySummary('B', undefined)].map(record => record.id === 'B' ? { ...record, outputDir: undefined } : record) });
  assert.equal(hook.current.activeTask, undefined, 'deleted output invalidates the old file cache immediately');
  refreshed.resolve(finishedResult('B', { outputDir: undefined, outputFiles: {} }));await hook.settle();
  assert.equal(hook.current.activeTask.outputDir, undefined);
  assert.equal(Object.keys(hook.current.activeTask.outputFiles).length, 0);
  assert.equal(hook.current.activeTask.transcriptText, 'Original B');
  assert.deepEqual(requests, ['A', 'B', 'B']);
  hook.dispose();
});

test('failed history reads can retry, while removed history cannot be revived by a late response', async () => {
  const first = deferred(), second = deferred();
  let calls = 0;
  const snapshot = { ...emptySnapshot, history: [historySummary('A')] };
  const hook = mountHook('useWorkspaceSelection', { getHistoryResult: () => ++calls === 1 ? first.promise : second.promise }, [snapshot]);
  hook.current.setActivityView('history');assert.equal(hook.current.historyResultLoading, true);
  first.reject(new Error('Fixture read failure'));await hook.settle();
  assert.equal(hook.current.historyResultError, 'Fixture read failure');
  assert.equal(hook.current.historyResultLoading, false);
  hook.current.reloadHistoryResult();assert.equal(hook.current.historyResultLoading, true);
  hook.update({ ...snapshot, history: [] });
  second.resolve(finishedResult('A'));await hook.settle();
  assert.equal(hook.current.activeTask, undefined);
  assert.equal(hook.current.activeHistoryRecord, undefined);
  assert.equal(hook.current.historyResultLoading, false);
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
