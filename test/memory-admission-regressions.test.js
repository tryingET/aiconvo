'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { parseSnapshot } = require('../memory-source');
const { sourceSnapshot, hydrate, packRows, LIMITS } = require('../memory-images');
const { revision } = require('../memory-identity');
const { image, jsonl } = require('./fixtures/image-fixture.cjs');
const captured = text => ({ text, revision: revision(text) });
function scratch(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'image-regressions-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}
function branches() {
  return [
    { type: 'assistant', uuid: 'A', parentUuid: null, message: { id: 'provider-A', role: 'assistant', content: 'answer A' } },
    { type: 'assistant', uuid: 'B', parentUuid: null, message: { id: 'provider-B', role: 'assistant', content: 'answer B' } },
    { type: 'user', uuid: 'U', parentUuid: 'B', message: { role: 'user', content: [image()] } },
  ];
}
const conflicts = {
  'top-level transport IDs': d => { d.id = 'different-U'; },
  'top-level parents selecting A instead of native B': d => { d.parentId = 'A'; },
  'explicit null parent instead of native B': d => { d.parentId = null; },
  'Claude outer user versus inner assistant': d => { d.message.role = 'assistant'; },
  'Claude outer assistant versus inner user': d => { d.type = 'assistant'; },
};
for (const [name, mutate] of Object.entries(conflicts)) test('captured source rejects conflicting ' + name, t => {
  const entries = branches(); mutate(entries[2]);
  const bytes = Buffer.from(jsonl(entries)), file = path.join(scratch(t), 'source.jsonl'); fs.writeFileSync(file, bytes);
  const snapshot = sourceSnapshot(file);
  assert.equal(snapshot.revision, revision(bytes));
  assert.throws(() => parseSnapshot(file, snapshot.text), /[Aa]mbiguous|[Cc]onflicting/);
  // A native parser's output must not bypass the raw metadata check in hydrate.
  const native = parseSnapshot('', jsonl(branches()));
  assert.throws(() => hydrate(snapshot, native), /[Aa]mbiguous|[Cc]onflicting/);
});

test('matching aliases preserve native branch B; provider message IDs are not entry aliases', () => {
  const entries = branches();
  for (const d of entries) { d.id = d.uuid; d.parentId = d.parentUuid; }
  const text = jsonl(entries), parsed = parseSnapshot('', text), result = hydrate(captured(text), parsed);
  const row = result.rows.find(r => r.eid === 'U');
  assert.equal(row.assistantBefore.entry, 'B'); assert.equal(row.images[0].entry, 'U');
  assert.equal(result.rows.find(r => r.eid === 'A').off, true);
});

test('aliases and role conflicts reject even on session, meta and sidechain entries before projection', () => {
  for (const d of [
    { type: 'session', id: 'one', uuid: 'two' },
    { type: 'custom', id: 'meta', parentId: 'A', parentUuid: 'B', isMeta: true },
    { type: 'user', uuid: 'side', isSidechain: true, message: { role: 'assistant', content: [] } },
  ]) assert.throws(() => parseSnapshot('', jsonl([d])), /[Aa]mbiguous|[Cc]onflicting/);
});

test('hydrate requires a valid revision, not undefined-derived shared identity', () => {
  const text = jsonl(branches()), parsed = parseSnapshot('', text);
  for (const claimed of [undefined, null, '', 'abc', 'g'.repeat(64), revision(text).toUpperCase()]) {
    assert.throws(() => hydrate({ text, revision: claimed }, parsed), /snapshot.*revision/i);
  }
});

test('hydrate rejects incorrect text or raw-byte revision bindings', () => {
  const text = jsonl(branches()), parsed = parseSnapshot('', text);
  assert.throws(() => hydrate({ text, revision: '0'.repeat(64) }, parsed), /revision/);
  assert.throws(() => hydrate({ ...captured(text), text: text + '\n' }, parsed), /revision/);
  const bytes = Buffer.from(text);
  assert.throws(() => hydrate({ ...captured(text), bytes: Buffer.from(text + '\n') }, parsed), /revision/);
  assert.throws(() => hydrate({ text: text + '\n', bytes, revision: revision(bytes) }, parsed), /text|binding/);
  assert.throws(() => hydrate({ ...captured(text), bytes: 'not bytes' }, parsed), /bytes/);
});

test('distinct exact source bytes produce distinct multimodal identities', () => {
  const text = jsonl(branches()), second = text + '\n';
  const a = hydrate(captured(text), parseSnapshot('', text)), b = hydrate(captured(second), parseSnapshot('', second));
  assert.notEqual(a.revision, b.revision); assert.notEqual(a.identity, b.identity);
});

test('BOM source capture carries raw bytes while decoded text stays compatible', t => {
  const text = jsonl(branches()), plain = Buffer.from(text), bom = Buffer.concat([Buffer.from([239,187,191]), plain]);
  const file = path.join(scratch(t), 'source.jsonl'); fs.writeFileSync(file, bom);
  const snapshot = sourceSnapshot(file), parsed = parseSnapshot('', snapshot.text);
  assert.equal(snapshot.text, text); assert.deepEqual(snapshot.bytes, bom);
  const withBom = hydrate(snapshot, parsed), withoutBom = hydrate(captured(text), parsed);
  assert.equal(withBom.revision, revision(bom)); assert.notEqual(withBom.identity, withoutBom.identity);
  // Structured cloning transports Buffer as Uint8Array; the byte binding survives.
  assert.equal(hydrate(structuredClone(snapshot), parsed).identity, withBom.identity);
  // Removing the byte proof may not pretend the BOM hash belongs to normalized text.
  assert.throws(() => hydrate({ text: snapshot.text, revision: snapshot.revision }, parsed), /revision/);
  snapshot.bytes[0] ^= 1;
  assert.throws(() => hydrate(snapshot, parsed), /revision/);
});

test('raw bytes must decode as strict UTF-8 and bind the supplied text; source bounds also apply to manual snapshots', () => {
  const bytes = Buffer.from([255]);
  assert.throws(() => hydrate({ text: '\ufffd', bytes, revision: revision(bytes) }, { messages: [] }), /UTF-8/);
  const text = jsonl(branches());
  assert.throws(() => hydrate(captured(text), parseSnapshot('', text), { ...LIMITS, sourceBytes: Buffer.byteLength(text) - 1 }), /bounded|budget/);
  assert.throws(() => hydrate(captured('\ud800'), { messages: [] }), /UTF-8|text/);
});

const estimate = (section, limits = LIMITS) => Math.ceil(Buffer.byteLength(section.text) / 2) + section.images.length * limits.imageTokens;
const plainRow = text => ({ id: 0, eid: 'u', parent: null, role: 'user', text, assistantBefore: null, images: [] });
test('packing accounts for the actual returned section header even for one text-only row', () => {
  const row = plainRow('x'), full = packRows([row], 1000)[0];
  const rowOnly = Math.ceil(Buffer.byteLength(full.text.split('\n').slice(2).join('\n')) / 2), total = estimate(full);
  assert.ok(total > rowOnly);
  assert.throws(() => packRows([row], rowOnly), /budget/);
  assert.throws(() => packRows([row], total - 1), /budget/);
  assert.equal(estimate(packRows([row], total)[0]), total);
});

test('attachment manifests and image estimates fit returned bodies at exact boundaries', () => {
  const text = jsonl(branches()), input = hydrate(captured(text), parseSnapshot('', text));
  const row = input.rows.find(r => r.eid === 'U'), full = packRows([row], 100000)[0], total = estimate(full);
  const rowOnly = Math.ceil(Buffer.byteLength(full.text.split('\n').slice(2).join('\n')) / 2) + LIMITS.imageTokens;
  assert.ok(total > rowOnly); assert.throws(() => packRows([row], rowOnly), /budget/);
  assert.throws(() => packRows([row], total - 1), /budget/);
  assert.equal(estimate(packRows([row], total)[0]), total);
});

test('multi-section estimates include Unicode, joins, manifests and section-number digit growth', () => {
  const rows = Array.from({ length: 24 }, (_, id) => ({ ...plainRow('é🙂 ' + 'x'.repeat(140)), id, eid: 'u' + id }));
  const one = packRows([rows[0]], 10000)[0];
  const budget = Math.ceil(Buffer.byteLength(one.text.split('\n').slice(2).join('\n')) / 2) * 2;
  const sections = packRows(rows, budget);
  assert.ok(sections.length >= 10);
  assert.deepEqual(sections.flatMap(s => s.ids), rows.map(r => r.id));
  for (const s of sections) assert.ok(estimate(s) <= budget, `estimate ${estimate(s)} exceeds ${budget}`);
  const text = jsonl(branches()), images = hydrate(captured(text), parseSnapshot('', text)).rows.filter(r => r.images.length);
  const repeated = Array.from({ length: 12 }, (_, id) => ({ ...images[0], id }));
  const limits = { ...LIMITS, imageTokens: 7, callImages: 2 };
  const withImages = packRows(repeated, 650, limits);
  for (const s of withImages) { assert.ok(estimate(s, limits) <= 650); assert.ok(s.images.length <= 2); }
  const off = repeated.map(r => ({ ...r, images: r.images.map(i => ({ ...i, inspected: false })) }));
  for (const s of packRows(off, 650, limits)) { assert.equal(s.images.length, 0); assert.ok(estimate(s, limits) <= 650); }
});

test('packing rejects nonfinite or negative estimates rather than bypassing its bound', () => {
  for (const budget of [NaN, Infinity, -1]) assert.throws(() => packRows([plainRow('x')], budget), /budget/);
  for (const imageTokens of [NaN, Infinity, -1]) assert.throws(() => packRows([plainRow('x')], 1000, { ...LIMITS, imageTokens }), /budget/);
});
