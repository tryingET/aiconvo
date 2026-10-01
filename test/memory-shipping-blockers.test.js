'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createAutomation, durableWrite, revision } = require('../memory-automation');
const { createMemoryAuto } = require('../memory-auto');
const a = revision('a'), b = revision('b'), c = revision('c'), d = revision('d');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-blockers-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'memory-automation.json');
  return { file, load: () => createAutomation({ file }) };
}
test('durable consent/settings mismatch blocks legacy, including restart; absent never-enabled legacy remains allowed', async t => {
  const f = fixture(t);
  let settings = { automaticMemory: 'legacy', backgroundAi: { decidedAt: 'yes', memory: true } };
  const hooks = { file: f.file, settings: () => settings, async *sources() {} };
  let auto = createMemoryAuto(hooks);
  assert.equal(auto.legacy(), true);
  await auto.configure({ ...settings, automaticMemory: 'changes-after-enable' });
  // Intent is durable, but the caller's second write has not happened.
  assert.equal(auto.legacy(), false);
  assert.match(auto.status().error, /disagree|mismatch/);
  auto = createMemoryAuto(hooks);
  assert.equal(auto.legacy(), false);
  assert.match(auto.status().error, /disagree|mismatch/);
  // Do not roll back durable intent or silently repair it with a repeated save.
  await auto.configure(settings);
  assert.equal(auto.legacy(), false);
  settings = { ...settings, automaticMemory: 'off' }; await auto.configure(settings, true);
  settings = { ...settings, automaticMemory: 'legacy' }; await auto.configure(settings, true);
  assert.equal(auto.legacy(), true);
  fs.writeFileSync(f.file, '{broken');
  assert.equal(auto.legacy(), false);
  assert.match(auto.status().error, /corrupt/);
});
test('first consent write reports failure after replacement: neither old in-memory state nor restart may permit legacy', t => {
  const f = fixture(t);
  const p = createAutomation({ file: f.file, write(file, next) {
    durableWrite(file, next);
    if (next.mode === 'changes-after-enable') throw new Error('synthetic failure after durable replace');
  } });
  p.activate('legacy');
  assert.throws(() => p.activate('changes-after-enable', { session: a }), /after durable replace/);
  assert.equal(JSON.parse(fs.readFileSync(f.file)).mode, 'changes-after-enable');
  assert.equal(p.legacyAllowed(), false);
  assert.match(p.status('legacy').error, /persisted/);
  const restarted = f.load();
  assert.equal(restarted.legacyAllowed(), false);
  assert.match(restarted.status('legacy').error, /disagree|mismatch/);
});
for (const order of ['failure-before-observation', 'observation-before-failure']) {
  test(`${order}: failed work and completed stages latch across new raw revisions and durable restart`, t => {
    const f = fixture(t); let p = f.load();
    p.activate('changes-after-enable', { session: a }); p.observe('session', b);
    const ticket = p.claim('session'); p.stage(ticket, 'leaf');
    if (order === 'failure-before-observation') {
      assert.throws(() => p.check(ticket, c, 'changes-after-enable'), /source revision/);
      p.finish(ticket, new Error('source drift after leaf publication')); p.observe('session', c);
    } else {
      p.observe('session', c); p.finish(ticket, new Error('source drift after leaf publication'));
    }
    for (let i = 0; i < 2; i++) {
      const rec = p.status('changes-after-enable').pending[0];
      assert.equal(rec.status, order === 'failure-before-observation' ? 'error' : 'interrupted');
      assert.deepEqual(rec.completed, ['leaf']);
      assert.equal(rec.attemptRevision, b, 'completed stages remain attributed to the attempted raw revision');
      assert.ok(rec.error); assert.deepEqual(p.ready(), []);
      p.observe('session', d); p = f.load();
    }
    p.discard('session'); assert.deepEqual(p.ready(), []);
    p.observe('session', a); assert.deepEqual(p.ready(), ['session']);
    p.activate('changes-after-enable', { session: a }); assert.deepEqual(p.ready(), []);
  });
}
