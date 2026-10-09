const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

async function check(file) {
  const source = fs.readFileSync(file, 'utf8');
  assert.match(source, /registerPreviewSave\(saveBtn, line, async \(\) => \{\s*const previewRows/, 'Register the actual Filling and Press save handler');
  assert.match(source, /registerPreviewSave\(saveBtn, "apd", async \(\) => \{\s*const rows/, 'Register the actual APD save handler');
  assert.match(source, /registerPreviewSave\(el\("spkSaveButton"\), "spk",/, 'Register the actual SPK save handler');
  const registry = source.slice(source.indexOf('  const previewSaveHandlers'), source.indexOf('  let writeQueue'));
  const autosave = source.slice(source.indexOf('  let autosaveRunning'), source.indexOf('  async function preloadAppViews'));
  let tick;
  const context = vm.createContext({
    state: { currentUser: {}, preview: { spk: [{}], filling: [{}], apd: [{}], press: [{}] } },
    canLevel: () => true, persistPreview() {}, saveFormDraft() {}, qs: () => null,
    navigator: { onLine: true }, console, Date,
    window: { setInterval(callback, interval) { tick = callback; assert.equal(interval, 300000); } },
    document: { addEventListener() {} }, CONFIG: { AUTOSAVE_INTERVAL_MS: 300000 },
    writeQueue: Promise.resolve(),
  });
  vm.runInContext(registry + autosave + '\ninitAutosave();', context);
  const calls = [];
  context.calls = calls;
  vm.runInContext(`
    for (const line of ['spk', 'filling', 'apd', 'press']) {
      registerPreviewSave({ disabled: true, addEventListener() {} }, line, async () => {
        await Promise.resolve();
        calls.push(line);
        state.preview[line] = [];
      });
    }
  `, context);
  await tick();
  assert.deepEqual(calls, ['spk', 'filling', 'apd', 'press'], 'Save disabled buttons and await Filling');
  context.state.preview.filling = [{}];
  context.state.preview.press = [{}];
  vm.runInContext(`previewSaveHandlers.set('filling', async () => calls.push('failed-filling'));`, context);
  calls.length = 0;
  await tick();
  assert.deepEqual(calls, ['failed-filling'], 'Keep Press pending after failed Filling');
  context.navigator.onLine = false;
  calls.length = 0;
  await tick();
  assert.deepEqual(calls, [], 'Never send writes while offline');
  context.navigator.onLine = true;
  vm.runInContext(`
    let finish;
    registerPreviewSave({ addEventListener() {} }, 'filling', () => new Promise(resolve => { finish = resolve; calls.push('once'); }));
    globalThis.pendingSave = previewSaveHandlers.get('filling')();
  `, context);
  await vm.runInContext(`previewSaveHandlers.get('filling')()`, context);
  assert.deepEqual(calls, ['once'], 'Prevent overlapping manual and automatic saves');
  vm.runInContext('finish()', context);
  await context.pendingSave;
  console.log(file + ': autosave checks passed');
}
(async () => { await check('script.js'); await check('public/script.js'); })().catch(error => { console.error(error); process.exitCode = 1; });
