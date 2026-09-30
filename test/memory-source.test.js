'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const path = require('node:path'), { spawnSync } = require('node:child_process');
const { parseSnapshot } = require('../memory-source');
const { hydrate, LIMITS } = require('../memory-images');
const { revision } = require('../memory-identity');
const { image, jsonl } = require('./fixtures/image-fixture.cjs');

test('snapshot parser uses captured text alone for current Pi message, toolResult and custom formats', () => {
  const entries = [
    { type: 'session', id: 's', version: 3, cwd: '/fixture' },
    { type: 'model_change', id: 'model', parentId: null, provider: 'not-called', modelId: 'not-called' },
    { type: 'custom', id: 'author', parentId: 'model', customType: 'chattering-author', data: { user: { id: 'person' } } },
    { type: 'message', id: 'u', parentId: 'author', origin: 'person', message: { role: 'user', content: [image()] } },
    { type: 'message', id: 'a', parentId: 'u', message: { role: 'assistant', content: [
      { type: 'thinking', thinking: 'reasoning' }, { type: 'toolCall', name: 'read', arguments: { path: 'fixture' } },
    ] } },
    { type: 'message', id: 't', parentId: 'a', message: { role: 'toolResult', toolCallId: 'call', content: [image()] } },
    { type: 'custom_message', id: 'custom', parentId: 't', customType: 'orchestrator-event', content: [image()] },
    { type: 'compaction', id: 'compact', parentId: 'custom', summary: 'summary' },
    { type: 'branch_summary', id: 'branch', parentId: 'compact', summary: 'branch summary' },
  ];
  const text = jsonl(entries), parsed = parseSnapshot('/does/not/exist', text);
  assert.deepEqual(parsed.messages.map(m => [m.eid, m.role]), [
    ['u', 'user'], ['a', 'assistant'], ['t', 'toolresult'], ['custom', 'event'], ['compact', 'event'], ['branch', 'event'],
  ]);
  assert.equal(parsed.messages[0].origin, 'person'); assert.match(parsed.messages[1].text, /reasoning.*\n.*read/);
  const hydrated = hydrate({ text, revision: revision(text) }, parsed);
  assert.equal(hydrated.imageCount, 3);
  assert.equal(hydrated.rows.find(r => r.eid === 't').assistantBefore.entry, 'a');
  assert.equal(hydrated.identity, revision('multimodal-v1\0' + revision(text)));
  assert.ok(hydrated.rows.every(r => !r.off));
});

test('Claude parallel tools retain native chain linearization and attachment ancestry', () => {
  const entries = [
    { type: 'user', uuid: 'u', parentUuid: null, message: { content: [image()] } },
    { type: 'assistant', uuid: 'a1', parentUuid: 'u', message: { id: 'reply', content: [{ type: 'tool_use', name: 'Read', input: { path: 'one' } }] } },
    { type: 'assistant', uuid: 'a2', parentUuid: 'a1', message: { id: 'reply', content: [{ type: 'tool_use', name: 'Read', input: { path: 'two' } }] } },
    { type: 'user', uuid: 'r1', parentUuid: 'a1', message: { content: [{ type: 'tool_result', content: [image()] }] } },
    { type: 'user', uuid: 'r2', parentUuid: 'a2', message: { content: [{ type: 'tool_result', content: [image()] }] } },
  ];
  const text = jsonl(entries), parsed = parseSnapshot('', text), parents = new Map(parsed.entryParents);
  assert.equal(parents.get('r1'), 'a2'); assert.equal(parents.get('r2'), 'r1');
  const result = hydrate({ text, revision: revision(text) }, parsed);
  assert.equal(result.imageCount, 3);
  assert.ok(result.rows.every(r => !r.off));
  for (const row of result.rows.filter(r => r.role === 'toolresult')) {
    assert.equal(row.assistantBefore.entry, 'a2'); assert.equal(row.images[0].path, '0.0');
  }
});

test('meta and sidechain attachments are excluded; full snapshot bytes still change identity', () => {
  const entries = [
    { type: 'user', uuid: 'u', parentUuid: null, message: { content: [image()] } },
    { type: 'user', uuid: 'meta', parentUuid: 'u', isMeta: true, message: { content: [image()] } },
    { type: 'user', uuid: 'side', parentUuid: null, isSidechain: true, message: { content: [image()] } },
  ];
  const text = jsonl(entries), result = hydrate({ text, revision: revision(text) }, parseSnapshot('', text));
  assert.equal(result.imageCount, 1); assert.equal(result.rows.length, 1);
  assert.notEqual(revision(text), revision(jsonl(entries.slice(0,1))));
});

for (const entry of [null, [], 1, { type: 'message', message: { role: 'user', content: 'no ID' } },
  { type: 'message', id: 7, message: { role: 'user', content: 'bad ID' } }]) {
  test('malformed source entry rejects: ' + JSON.stringify(entry), () => assert.throws(() => parseSnapshot('', jsonl([entry]))));
}

test('unsupported descriptors are preserved without inspection and never fetched; inspection rejects', () => {
  const remote = { type: 'image', source: { type: 'url', url: 'https://invalid.example/image' } };
  const text = jsonl([{ type: 'user', uuid: 'u', message: { content: [remote] } }]), parsed = parseSnapshot('', text);
  const off = hydrate({ text, revision: revision(text) }, parsed, LIMITS, { inspectImages: false });
  assert.equal(off.imageCount, 1); assert.equal(off.rows[0].images[0].inspected, false);
  assert.equal(off.rows[0].images[0].identity, revision(JSON.stringify(remote)));
  assert.throws(() => hydrate({ text, revision: revision(text) }, parsed), /unsupported image source/);
});

test('neutral SHA-256 identity and library dependency closure exclude workers, settings and titles', () => {
  assert.equal(revision(Buffer.from('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(revision('abc'), revision(Buffer.from('abc')));
  const root = path.resolve(__dirname, '..');
  const script = `
    const Module = require('node:module'), path = require('node:path');
    const root = ${JSON.stringify(root)}, load = Module._load;
    const allowed = new Set(['memory-identity.js', 'memory-images.js', 'memory-jpeg.js', 'memory-source.js', 'claude-chain.js']);
    Module._load = function(id, parent, ...rest) {
      if (!Module.isBuiltin(id)) {
        const file = Module._resolveFilename(id, parent);
        if (path.dirname(file) !== root || !allowed.has(path.basename(file))) throw Error('Nonneutral dependency: ' + file);
      }
      return load.call(this, id, parent, ...rest);
    };
    global.fetch = () => { throw Error('network forbidden'); };
    for (const name of allowed) require(path.join(root, name));
  `;
  const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});
