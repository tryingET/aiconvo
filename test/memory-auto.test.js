'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMemoryAuto } = require('../memory-auto');
const { sourceSnapshot } = require('../memory-source');
function fixture(t, run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'text-memory-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'session.jsonl'), file = path.join(dir, 'consent.json');
  fs.writeFileSync(source, '{"type":"session","timestamp":"2020-01-01T00:00:00Z"}\n');
  let settings = { automaticMemory: 'legacy', backgroundAi: { decidedAt: 'yes', memory: true } }, allowed = true, calls = 0, published = 0;
  const hooks = { file, settings: () => settings, source: () => source, identity: () => 'fake/model', project: () => 'fixture',
    async *sources() { yield { key: 'session', file: source }; }, canRun: () => true,
    authorize() { if (!allowed) throw new Error('ACL revoked'); },
    async run(key, rev, guard) { calls++; guard(); await run?.({ guard }); guard(); published++; },
  };
  let api = createMemoryAuto(hooks);
  return { source, file, api: () => api, calls: () => calls, published: () => published, deny: () => { allowed = false; },
    restart: () => { api = createMemoryAuto(hooks); },
    change: () => { fs.appendFileSync(source, '{}\n'); api.observe('session', sourceSnapshot(source)); },
    async configure(mode, force = false) { const next = { ...settings, automaticMemory: mode }; await api.configure(next, force); settings = next; },
    async memory(on) { const next = { ...settings, backgroundAi: { decidedAt: 'yes', memory: on } }; await api.configure(next, true); settings = next; },
  };
}

test('text coordinator baselines without calls; exact bytes qualify despite unchanged parsed content; no replay', async t => {
  const f = fixture(t);
  await f.configure('changes-after-enable');
  await f.api().sweep(0); assert.equal(f.calls(), 0);
  f.change(); await f.api().sweep(0); assert.equal(f.published(), 1);
  f.restart(); await f.api().sweep(0); assert.equal(f.calls(), 1);
});

test('off and legacy never adopt future revisions; a re-enable baselines changed history', async t => {
  const f = fixture(t); await f.configure('changes-after-enable'); f.change();
  await f.configure('off'); await f.api().sweep(0); assert.equal(f.calls(), 0);
  await f.configure('changes-after-enable'); await f.api().sweep(0); assert.equal(f.calls(), 0);
  f.change(); await f.api().sweep(0); assert.equal(f.calls(), 1);
  await f.configure('legacy'); assert.equal(f.api().legacy(), true);
});

test('revoked/re-enabled in-flight work cannot publish or consume a newer epoch', async t => {
  let entered, release;
  const started = new Promise(r => entered = r), blocked = new Promise(r => release = r);
  const f = fixture(t, async () => { entered(); await blocked; });
  await f.configure('changes-after-enable'); f.change(); const old = f.api().sweep(0); await started;
  await f.memory(false); await f.memory(true); f.change(); release(); await old;
  assert.equal(f.published(), 0); assert.equal(f.api().status().pending[0].status, 'pending');
  assert.ok(f.api().status().retired.some(p => p.status === 'interrupted'));
});

test('ACL and raw revision are checked after provider work; failures do not retry', async t => {
  for (const revoke of ['acl', 'source']) {
    let f;
    f = fixture(t, () => { if (revoke === 'acl') f.deny(); else fs.appendFileSync(f.source, '{}\n'); });
    await f.configure('changes-after-enable'); f.change(); await f.api().sweep(0);
    assert.equal(f.published(), 0); assert.equal(f.api().status().pending[0].status, 'error');
    await f.api().sweep(0); assert.equal(f.calls(), 1);
  }
});

test('missing consent state is not repaired by a repeated settings save, restart or observation', async t => {
  const f = fixture(t); await f.configure('changes-after-enable'); fs.unlinkSync(f.file);
  f.restart(); await f.configure('changes-after-enable'); f.change(); await f.api().sweep(0);
  assert.equal(f.calls(), 0); assert.equal(fs.existsSync(f.file), false);
  assert.match(f.api().status().error, /missing/);
  await f.configure('off'); await f.configure('changes-after-enable'); assert.equal(f.api().status().active, true);
});

test('source reader rejects directories, oversized bytes, invalid UTF-8 and admits raw revisions', t => {
  const f = fixture(t);
  assert.throws(() => sourceSnapshot(path.dirname(f.source)), /regular/);
  assert.throws(() => sourceSnapshot(f.source, 1), /regular/);
  fs.writeFileSync(f.source, Buffer.from([255])); assert.throws(() => sourceSnapshot(f.source));
  fs.writeFileSync(f.source, '{}\n'); const a = sourceSnapshot(f.source);
  fs.writeFileSync(f.source, '{} \n'); assert.notEqual(sourceSnapshot(f.source).revision, a.revision);
});
