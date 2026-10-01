'use strict';
// The side list's context line: what the indexer records about how full a
// conversation's window is, and how the browser turns it into a share.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const vm = require('node:vm');
const settingsLib = require('../settings');
const usageLib = require('../usageanalytics');

const serverSource = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
const appSource = fs.readFileSync(path.join(__dirname, '../app.html'), 'utf8');
function extract(source, start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a, start);
  return source.slice(a, b);
}
const streamRequire = specifier => { assert.equal(specifier, 'node:stream'); return require(specifier); };
const textOf = content => typeof content === 'string' ? content : (content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');

async function parseAll(t, lines) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'context-fill-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, lines.map(l => JSON.stringify(l)).join('\n'));
  const box = vm.createContext({ fs, readline, require: streamRequire, usageLib, settingsLib, textOf, conversationFlow: require('../conversation-flow'), createClaudeChain: require('../claude-chain').createClaudeChain,
    toolEventsOf: () => [], directImagesOf: () => [], pathCandidates: () => [], isNoise: () => false });
  vm.runInContext(extract(serverSource, 'async function parseFile(', '\nasync function transcriptImage('), box);
  const parsed = JSON.parse(JSON.stringify(await box.parseFile(file)));
  const captured = JSON.parse(JSON.stringify(await box.parseFile(file + '.not-on-disk', fs.readFileSync(file, 'utf8'))));
  assert.deepEqual(captured, parsed, 'captured text preserves the entire branch/context record');
  return parsed;
}
async function parse(t, lines) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'context-fill-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, lines.map(l => JSON.stringify(l)).join('\n'));
  const box = vm.createContext({ fs, readline, require: streamRequire, usageLib, settingsLib, textOf, conversationFlow: require('../conversation-flow'), createClaudeChain: require('../claude-chain').createClaudeChain,
    toolEventsOf: () => [], directImagesOf: () => [], pathCandidates: () => [], isNoise: () => false });
  vm.runInContext(extract(serverSource, 'async function parseFile(', '\nasync function transcriptImage('), box);
  const parsed = JSON.parse(JSON.stringify(await box.parseFile(file)));
  const captured = JSON.parse(JSON.stringify(await box.parseFile(file + '.not-on-disk', fs.readFileSync(file, 'utf8'))));
  assert.deepEqual(captured, parsed, 'captured text preserves the entire branch/context record');
  return parsed.meta.ctx;
}
const usage = (input, output = 0, cacheRead = 0) => ({ input, output, cacheRead, cacheWrite: 0 });
const reply = (id, parentId, model, u) => ({ type: 'message', id, parentId, message: { role: 'assistant', provider: 'p', model, content: 'ok', usage: u } });
const ask = (id, parentId) => ({ type: 'message', id, parentId, message: { role: 'user', content: 'go' } });

test('the newest reply on the active path counts, cache reads included; other branches do not', async t => {
  const ctx = await parse(t, [
    { type: 'session', id: 's', cwd: '/tmp' },
    ask('q1', null), reply('a1', 'q1', 'm1', usage(1000, 100)),
    ask('q2', 'a1'), reply('a2', 'q2', 'm1', usage(5000, 200, 40000)), // a branch left behind
    ask('q3', 'a1'), reply('a3', 'q3', 'm1', usage(2000, 300, 10000)), // the active path
  ]);
  assert.deepEqual(ctx, { used: 12300, provider: 'p', model: 'm1' });
});

test('a model switch after the last reply names the window the next turn fills', async t => {
  const ctx = await parse(t, [
    { type: 'session', id: 's', cwd: '/tmp' },
    ask('q1', null), reply('a1', 'q1', 'small', usage(9000)),
    { type: 'model_change', id: 'mc', parentId: 'a1', provider: 'big-co', modelId: 'big' },
  ]);
  assert.deepEqual(ctx, { used: 9000, provider: 'big-co', model: 'big' });
});

test('after a compaction nothing is counted until the next reply', async t => {
  const lines = [
    { type: 'session', id: 's', cwd: '/tmp' },
    ask('q1', null), reply('a1', 'q1', 'm1', usage(150000)),
    { type: 'compaction', id: 'c', parentId: 'a1', summary: 'short', tokensBefore: 150000 },
  ];
  assert.equal(await parse(t, lines), null);
  const after = await parse(t, [...lines, ask('q2', 'c'), reply('a2', 'q2', 'm1', usage(8000))]);
  assert.equal(after.used, 8000);
});

test('a compaction shows in the transcript as a marker that carries the summary', async t => {
  const parsed = await parseAll(t, [
    { type: 'session', id: 's', cwd: '/tmp' },
    ask('q1', null), reply('a1', 'q1', 'm1', usage(150000)),
    { type: 'compaction', id: 'c', parentId: 'a1', timestamp: '2026-09-24T17:00:00Z', summary: '## Goal\nThe deck.', tokensBefore: 150000 },
  ]);
  const mark = parsed.messages.find(m => m.customType === 'compaction');
  assert.deepEqual({ role: mark.role, text: mark.text, tokensBefore: mark.tokensBefore, eid: mark.eid },
    { role: 'event', text: '## Goal\nThe deck.', tokensBefore: 150000, eid: 'c' });
});

test('a Claude transcript counts cache writes and reads too', async t => {
  const ctx = await parse(t, [
    { type: 'user', uuid: 'u1', parentUuid: null, message: { role: 'user', content: 'hi' } },
    { type: 'assistant', uuid: 'a1', parentUuid: 'u1', message: { model: 'claude-x', content: [{ type: 'text', text: 'hey' }],
      usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 3000, cache_creation_input_tokens: 400 } } },
  ]);
  assert.deepEqual(ctx, { used: 3430, provider: null, model: 'claude-x' });
});

test('no reply yet: nothing to draw', async t => {
  assert.equal(await parse(t, [{ type: 'session', id: 's', cwd: '/tmp' }, ask('q1', null)]), null);
});

test('captured UTF-8/CRLF text, including an unterminated final line, is independent of later disk bytes', async t => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'captured-context-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'session.jsonl');
  const captured = [
    JSON.stringify({ type: 'session', id: 'captured', cwd: dir }),
    JSON.stringify({ ...ask('q1', null), message: { role: 'user', content: 'Grüße — 東京 😺\nsecond line' } }),
    '{malformed record', // Same tolerant JSONL behavior on either input path.
    JSON.stringify(reply('a1', 'q1', 'm1', usage(7, 3, 11))),
  ].join('\r\n');
  fs.writeFileSync(file, captured);
  const box = vm.createContext({ fs, readline, require: streamRequire, usageLib, settingsLib, textOf, conversationFlow: require('../conversation-flow'), createClaudeChain: require('../claude-chain').createClaudeChain,
    toolEventsOf: () => [], directImagesOf: () => [], pathCandidates: () => [], isNoise: () => false });
  vm.runInContext(extract(serverSource, 'async function parseFile(', '\nasync function transcriptImage('), box);
  const disk = JSON.parse(JSON.stringify(await box.parseFile(file)));
  assert.equal(disk.messages[0].text, 'Grüße — 東京 😺\nsecond line');
  assert.deepEqual(disk.meta.ctx, { used: 21, provider: 'p', model: 'm1' });
  fs.writeFileSync(file, JSON.stringify({ type: 'session', id: 'later-disk', cwd: dir }));
  assert.equal((await box.parseFile(file)).meta.sessionId, 'later-disk');
  assert.deepEqual(JSON.parse(JSON.stringify(await box.parseFile(file, captured))), disk);
});

function fillHarness(catalog) {
  const box = vm.createContext({ Math, _modelCatalog: catalog });
  vm.runInContext(extract(appSource, 'function contextFill(s) {', '\nasync function modelCatalog('), box);
  return s => JSON.parse(JSON.stringify(box.contextFill(s)));
}

test('the share uses the catalog window, the default for unsized models, and warns under 15% left', () => {
  const fill = fillHarness({ defaultContext: 100000, models: [{ provider: 'p', model: 'm1', context: 200000 }] });
  assert.deepEqual(fill({ ctx: { used: 50000, provider: 'p', model: 'm1' } }), { used: 50000, size: 200000, pct: 25, warn: false, sized: true });
  assert.deepEqual(fill({ ctx: { used: 50000, provider: 'other', model: 'unknown' } }), { used: 50000, size: 100000, pct: 50, warn: false, sized: false });
  // The composer's rule, rounding included: 14% left warns, 15% does not.
  assert.equal(fill({ ctx: { used: 172000, provider: 'p', model: 'm1' } }).warn, true);
  assert.equal(fill({ ctx: { used: 170000, provider: 'p', model: 'm1' } }).warn, false);
  assert.equal(fill({ ctx: { used: 400000, provider: 'p', model: 'm1' } }).pct, 100, 'never past full');
  assert.equal(fill({}), null);
  assert.equal(fillHarness(null)({ ctx: { used: 1, model: 'm1' } }), null, 'no catalog yet: no line rather than a wrong one');
});
