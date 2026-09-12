'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');
const { createMultimodalMemory } = require('../multimodal-memory');
const { createMemoryFeature } = require('../memory-feature');
const { normalizeSettings } = require('../settings');
const fixture = require('./fixtures/memory-fixture.cjs');

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-build-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'sample.jsonl'); fs.writeFileSync(file, fixture.jsonl(fixture.transcript()));
  return { root, file };
}

test('a source edited during the call is never published', async t => {
  const { file } = setup(t);
  const builder = createMultimodalMemory({ parseFile: fixture.parser(),
    settings: () => normalizeSettings({ memoryImages: true, provider: 'fixture', model: 'vision' }),
    projectOf: () => 'fixture', run: async () => { fs.appendFileSync(file, '\n'); return '{}'; } });
  await assert.rejects(builder.build({ key: 'pi:sample', title: 'Keep title' }, file), /Source revision/);
});

test('JSON correction retries preserve attachment/message mapping; summary and leaf share the same grounded result', async t => {
  const { file } = setup(t); const calls = [];
  const settings = normalizeSettings({ memoryImages: true, aiTitles: false, provider: 'fixture', model: 'vision', contextTokens: 50000 });
  const builder = createMultimodalMemory({ parseFile: fixture.parser(), settings: () => settings, projectOf: () => 'fixture',
    run: async (input, prompt) => {
      calls.push(structuredClone(input)); assert.match(prompt, /Do not generate a document/);
      if (calls.length === 1) return '{bad';
      return JSON.stringify({ note: 'Grounded note.', abstract: 'Useful abstract.', intent: input.ids.map(id => ({ id })), environment: [], problems: [] });
    } });
  const built = await builder.build({ key: 'pi:sample', title: 'Existing title' }, file);
  assert.deepEqual(calls[0], calls[1]);
  assert.match(built.note, /^# Existing title/); assert.match(built.note, /Useful abstract/);
  assert.equal(built.leaf.intent.find(i => i.entry === 'u1').assistantBeforeEntry, 'a0');
  assert.equal(built.leaf.intent.find(i => i.entry === 'u1').images.length, 1);
  const firstHash = built.memoryHash;
  const entries = fixture.transcript(); entries[5].message.content[0] = fixture.image({ pixel: 81 }); fs.writeFileSync(file, fixture.jsonl(entries));
  const second = await builder.build({ key: 'pi:sample', title: 'Existing title' }, file);
  assert.notEqual(second.memoryHash, firstHash);
  settings.memoryImages = false;
  const third = await builder.build({ key: 'pi:sample', title: 'Existing title' }, file);
  assert.notEqual(third.memoryHash, second.memoryHash); assert.equal(third.leaf.imageCount, 0);
  assert.match(calls.at(-1).text, /intentionally not inspected/);
  assert.equal(third.leaf.intent.some(i => i.user.includes('intentionally not inspected')), false, 'coverage markers never become verbatim user quotes');
  let malformedCalls = 0;
  const malformed = createMultimodalMemory({ parseFile: fixture.parser(), settings: () => settings, projectOf: () => 'fixture',
    run: async () => { malformedCalls++; return JSON.stringify({ note: 'Note.', abstract: 'Abstract.', intent: [], environment: [{ fact: 'missing type' }], problems: [] }); } });
  await assert.rejects(malformed.build({ key: 'pi:sample', title: 'Existing title' }, file), /extraction schema/);
  assert.equal(malformedCalls, 2, 'malformed fields fail explicitly after one schema correction');
});

test('image opt-in reroutes memory work only, and never unrelated text helpers', async t => {
  const { file } = setup(t);
  const settings = normalizeSettings({ memoryImages: true, provider: 'fixture', model: 'vision' });
  const context = new AsyncLocalStorage();
  const feature = createMemoryFeature({ settings: () => settings, context, parseFile: fixture.parser(),
    stateFile: path.join(path.dirname(file), 'automation.json'),
    sourceFile: () => file, projectOf: () => 'fixture', runInternalModel: async () => ({ content: [] }) });
  assert.equal(feature.routeCall({ text: 'review or naming', images: [] }, 'text').modelOnly, false);
  await context.run({ memory: true }, async () => {
    assert.equal(feature.routeCall({ text: 'memory document', images: [] }, 'text').modelOnly, true);
  });
  settings.memoryImages = false;
  await context.run({ memory: true }, async () => {
    assert.equal(feature.routeCall({ text: 'memory document', images: [] }, 'text').modelOnly, false);
  });
});
