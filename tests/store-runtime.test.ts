import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('saving settings keeps explicit runtime overrides active immediately', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-store-paths-'));
  const overrides = {
    WHISPER_DATA_DIR: dataDir,
    WHISPER_PYTHON_PATH: 'configured-python',
    WHISPER_OUTPUT_DIR: path.join(dataDir, 'outputs')
  };
  for (const [key, value] of Object.entries(overrides)) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }
  t.after(() => {
    for (const filename of ['settings.json', 'settings.json.tmp']) {
      const file = path.join(dataDir, filename);
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
    fs.rmdirSync(dataDir);
  });

  const { getSettingsView, saveSettingsView } = await import('../src/main/store');
  const saved = saveSettingsView({
    ...getSettingsView(),
    pythonPath: 'stale-python',
    outputDir: path.join(dataDir, 'stale-outputs'),
    maxConcurrentDownloads: 5,
    maxConcurrentTranscriptions: 2,
    maxConcurrentTranslations: 3,
    downloadConnections: 12,
    youtubeCookieSource: 'firefox',
    youtubeBrowserProfile: 'Profiles/member'
  });
  assert.equal(saved.pythonPath, overrides.WHISPER_PYTHON_PATH);
  assert.equal(saved.outputDir, overrides.WHISPER_OUTPUT_DIR);
  assert.equal(getSettingsView().pythonPath, saved.pythonPath);
  assert.equal(getSettingsView().youtubeCookieSource, 'firefox');
  assert.equal(getSettingsView().youtubeBrowserProfile, 'Profiles/member');
  const persisted = getSettingsView();
  assert.equal(persisted.maxConcurrentDownloads, 5);
  assert.equal(persisted.maxConcurrentTranscriptions, 2);
  assert.equal(persisted.maxConcurrentTranslations, 3);
  assert.equal(persisted.downloadConnections, 12);
  const { parseSaveSettings } = await import('../src/server/validation');
  assert.equal(parseSaveSettings(saved).youtubeCookieSource, 'firefox');
  assert.equal(parseSaveSettings({ ...saved, youtubeCookieSource: undefined }).youtubeCookieSource, 'auto');
  assert.throws(() => parseSaveSettings({ ...saved, youtubeCookieSource: 'unsupported' }), /youtubeCookieSource/);

  const storePath = path.join(dataDir, 'settings.json');
  const rawStore = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  rawStore.settings.maxConcurrentDownloads = 2.5;
  rawStore.settings.maxConcurrentTranscriptions = 0;
  rawStore.settings.maxConcurrentTranslations = 9;
  rawStore.settings.downloadConnections = '16';
  fs.writeFileSync(storePath, JSON.stringify(rawStore), 'utf8');
  const recovered = getSettingsView();
  assert.equal(recovered.maxConcurrentDownloads, 3);
  assert.equal(recovered.maxConcurrentTranscriptions, 1);
  assert.equal(recovered.maxConcurrentTranslations, 2);
  assert.equal(recovered.downloadConnections, 8);
});

test('performance settings accept safe integer limits and retain old-client defaults', async () => {
  const { parseSaveSettings } = await import('../src/server/validation');
  const legacySettings = {
    pythonPath: 'python', outputDir: 'outputs', whisperModel: 'turbo',
    transcriptionEngine: 'faster-whisper', translateByDefault: false,
    translationServices: [], keepAudio: true, logLevel: 'info', debugMode: false
  };
  const defaults = parseSaveSettings(legacySettings);
  assert.equal(defaults.maxConcurrentDownloads, 3);
  assert.equal(defaults.maxConcurrentTranscriptions, 1);
  assert.equal(defaults.maxConcurrentTranslations, 2);
  assert.equal(defaults.downloadConnections, 8);

  const fields = {
    maxConcurrentDownloads: 6,
    maxConcurrentTranscriptions: 2,
    maxConcurrentTranslations: 4,
    downloadConnections: 16
  };
  for (const [field, maximum] of Object.entries(fields)) {
    assert.equal(parseSaveSettings({ ...legacySettings, [field]: 1 })[field as keyof typeof fields], 1);
    assert.equal(parseSaveSettings({ ...legacySettings, [field]: maximum })[field as keyof typeof fields], maximum);
    for (const invalid of [0, maximum + 1, 1.5, '2', null, Number.NaN]) {
      assert.throws(
        () => parseSaveSettings({ ...legacySettings, [field]: invalid }),
        new RegExp(field)
      );
    }
  }
});
