'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { setup } = require('./fixtures/memory-test-setup.cjs');
const { createMultimodalMemory } = require('../multimodal-memory');
const { runInternalModel } = require('../internal-model');
const { modelMessage } = require('../pirouter');
const builder = (s, check = () => {}) => createMultimodalMemory({ programs: s.programs, settings: () => s.settings,
  transport: s.transport, projectOf: () => 'fixture', check });

test('typed multimodal FunctAI program: exact image bytes, one correction, logging attribution and live thinking', async t => {
  const s = setup(t, { MEMORY_FIXTURE_BAD: '1' });
  const out = await builder(s).build(s.data(), s.file, { caller: { user: 'synthetic', automatic: true } });
  s.live.flush();
  const sent = s.captures(); assert.equal(sent.length, 2); assert.equal(s.agentCalls(), 0);
  const images = m => m.messages.flatMap(m => Array.isArray(m.content) ? m.content.filter(c => c.type === 'image') : []);
  assert.equal(images(sent[0]).length, 4); assert.deepEqual(images(sent[0]), images(sent[1]));
  assert.deepEqual(sent[0].tools, []); assert.equal(sent[0].maxRetries, 0);
  assert.equal(sent[0].ambientKey, null); assert.equal(sent[0].model, 'vision');
  assert.equal(fs.existsSync(sent[0].cwd), false, 'owned temporary credentials removed after tree exit');
  assert.equal(out.leaf.intent.some(i => i.entry === 'u0'), false, 'post-parse delegated kickoff stays excluded');
  assert.equal(out.leaf.intent.find(i => i.entry === 'u1').assistantBeforeEntry, 'a0');
  const [rec] = s.records(); assert.equal(rec.id, out.leaf.callIds[0]); assert.equal(rec.program.name, 'memory_extract_4');
  assert.equal(rec.model, 'memory-fixture/vision'); assert.equal(rec.caller.user, 'synthetic');
  assert.equal(rec.caller.automatic, true); assert.equal(rec.content, false); assert.equal(rec.exchanges.length, 2);
  assert.ok(s.ops.some(o => o.op === 'thinking')); assert.equal(s.ops.find(o => o.op === 'start').id, rec.id);
});
test('memoryImages off keeps evidence hashes/provenance, omits bytes and never promotes coverage markers to quotes', async t => {
  const s = setup(t), b = builder(s);
  const on = await b.build(s.data(), s.file); s.settings.memoryImages = false;
  const off = await b.build(s.data(), s.file);
  assert.equal(off.leaf.imageCount, 0); assert.equal(off.leaf.sourceImageCount, 4);
  assert.notEqual(on.memoryHash, off.memoryHash);
  const one = on.leaf.intent.find(i => i.entry === 'u1'), two = off.leaf.intent.find(i => i.entry === 'u1');
  assert.deepEqual(one.images, two.images);
  assert.equal(one.entry, two.entry);
  assert.equal(two.user, ''); assert.match(off.note, /intentionally not inspected/);
  const last = s.captures().at(-1); assert.equal(last.messages.flatMap(m => Array.isArray(m.content) ? m.content : []).some(c => c.type === 'image'), false);
});
test('source/model/permission drift before and after call blocks publication and later retries', async t => {
  for (const kind of ['source', 'model', 'permission']) {
    const s = setup(t, { MEMORY_FIXTURE_WAIT: '100', MEMORY_FIXTURE_BAD: '1' }); let allowed = true;
    const b = builder(s, () => { if (!allowed) throw new Error('Permission revoked'); });
    const timer = setInterval(() => { if (!s.captures().length) return;
      clearInterval(timer);
      if (kind === 'source') fs.appendFileSync(s.file, '\n');
      else if (kind === 'model') s.settings.model = 'text';
      else allowed = false;
    }, 10);
    try { await assert.rejects(b.build(s.data(), s.file)); } finally { clearInterval(timer); }
    assert.equal(s.captures().length, 1, 'no correction after revoked snapshot');
  }
});
test('provider failure/tool request/unsupported hooks/text-only model fail without user fallback or automatic replay', async t => {
  for (const flag of ['MEMORY_FIXTURE_FAIL', 'MEMORY_FIXTURE_TOOL', 'MEMORY_FIXTURE_HOOK', 'text']) {
    const s = setup(t, flag === 'text' ? {} : { [flag]: '1' }); if (flag === 'text') s.settings.model = 'text';
    await assert.rejects(builder(s).build(s.data(), s.file)); assert.equal(s.agentCalls(), 0);
    assert.equal(s.captures().length, ['text', 'MEMORY_FIXTURE_HOOK'].includes(flag) ? 0 : 1);
  }
});
test('pre-abort and missing bound permission fail before loading extensions; cold transport cannot route naming/made programs', async t => {
  const s = setup(t), ac = new AbortController(); ac.abort();
  await assert.rejects(builder(s).build(s.data(), s.file, { signal: ac.signal })); assert.equal(s.captures().length, 0);
  await assert.rejects(s.programs.run('conversation_title', { opening_user_messages: ['x'] }, { memory: { settings: s.settings, check() {} } }), /restricted/);
  await assert.rejects(s.programs.run('memory_extract', { evidence: 'x' }), /no fallback/);
  await assert.rejects(runInternalModel({ messages: [] }, { settings: s.settings }), /guard/);
  assert.throws(() => modelMessage({ messages: [{ role: 'user', parts: [{ type: 'image', url: 'https://invalid.example' }] }] }));
});
test('cold worker is deadline bounded; auth/config commands and corrupt selected state are rejected before provider call', async t => {
  const s = setup(t, { MEMORY_FIXTURE_WAIT: '30000' });
  const b = createMultimodalMemory({ programs: s.programs, settings: () => s.settings, projectOf: () => 'fixture', check() {},
    transport: () => ({ ...s.transport(), timeoutMs: 1000 }) });
  await assert.rejects(b.build(s.data(), s.file), /deadline|worker/);
  const fresh = setup(t); fs.writeFileSync(path.join(fresh.agentDir, 'auth.json'), '{broken');
  await assert.rejects(builder(fresh).build(fresh.data(), fresh.file)); assert.equal(fresh.captures().length, 0);
  fs.writeFileSync(path.join(fresh.agentDir, 'auth.json'), JSON.stringify({ 'memory-fixture': { type: 'api_key', key: '!echo no' } }));
  await assert.rejects(builder(fresh).build(fresh.data(), fresh.file), /commands/);
});
