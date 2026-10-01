'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createAiPrograms } = require('../ai-programs');
const settings = { memoryImages: true, provider: 'fake', model: 'fixture', contextTokens: 128000, providerExtensions: {} };
const tick = () => new Promise(resolve => setImmediate(resolve));

for (const uncertain of [false, true]) {
  test('cold program cancellation waits for transport cleanup' + (uncertain ? ' and preserves indeterminate retention' : ''), async t => {
    const ac = new AbortController();
    let entered, release, settled = false;
    const invoked = new Promise(resolve => entered = resolve);
    const cleanup = new Promise(resolve => release = resolve);
    t.after(release);
    const failure = uncertain
      ? Object.assign(new Error('cleanup cannot be verified'), { retainTemporaryState: true, temporaryDirectory: '/synthetic/retained' })
      : Object.assign(new Error('cancelled after verified cleanup'), { code: 'ABORTED' });
    const programs = createAiPrograms({ piExec: () => assert.fail('cold call used the agent'),
      modelExec: async () => { entered(); await cleanup; throw failure; },
      lm: () => 'unused/agent', logFolder: () => null });
    const pending = programs.run('memory_dialogue', { conversation: '1. Synthetic user evidence.' },
      { signal: ac.signal, memory: { settings, check() {} } });
    pending.then(() => settled = true, () => settled = true);
    await invoked; ac.abort(); await tick(); await tick();
    const settledBeforeCleanup = settled;
    release();
    await assert.rejects(pending, error => uncertain
      ? error.retainTemporaryState === true && error.temporaryDirectory === '/synthetic/retained'
      : error.code === 'ABORTED');
    assert.equal(settledBeforeCleanup, false, 'a cancelled facade cannot report completion before its owned transport settles');
  });
}

test('filesystem cleanup failure is retained across facade cancellation, with the actual temporary directory', async () => {
  const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
  const owned = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-removal-proof-'));
  const agentDir = path.join(owned, 'agent'); await fs.mkdir(agentDir);
  let entered, release, retained, settled = false;
  const removing = new Promise(resolve => entered = resolve);
  const gate = new Promise(resolve => release = resolve);
  const original = fs.rm;
  fs.rm = async (target, options) => {
    if (!path.basename(target).startsWith('chattering-model-')) return original(target, options);
    retained = target; entered(); await gate;
    throw Object.assign(new Error('synthetic filesystem removal denied'), { code: 'EPERM' });
  };
  try {
    const ac = new AbortController();
    // Missing trusted extension fails before any worker/provider is launched.
    // Its real cleanup path is then deliberately held and denied.
    const invalid = { ...settings, providerExtensions: { fake: [path.join(owned, 'missing-provider.js')] } };
    const programs = createAiPrograms({ piExec: () => assert.fail('cold call used the agent'), lm: () => 'unused/agent', logFolder: () => null });
    const pending = programs.run('memory_dialogue', { conversation: 'Synthetic evidence.' },
      { signal: ac.signal, memory: { settings: invalid, agentDir, check() {} } });
    pending.then(() => settled = true, () => settled = true);
    await removing; ac.abort(); await tick();
    const settledBeforeCleanup = settled; release();
    await assert.rejects(pending, error => error.retainTemporaryState === true && error.temporaryDirectory === retained && error.cause?.code === 'EPERM');
    assert.equal(settledBeforeCleanup, false);
    assert.equal((await fs.stat(retained)).isDirectory(), true, 'retained state is not reported removed');
  } finally {
    release(); fs.rm = original;
    // No worker can exist: preflight failed at the missing extension above.
    if (retained) await original(retained, { recursive: true, force: true });
    await original(owned, { recursive: true, force: true });
  }
});
