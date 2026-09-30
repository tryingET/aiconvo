'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { LIMITS, decodeImage, sourceSnapshot, hydrate, packRows } = require('../memory-images');
const { createHash } = require('node:crypto');
const { spawnSync, execFileSync } = require('node:child_process');
const { parseSnapshot } = require('../memory-source');
const { revision } = require('../memory-identity');
const captured = text => ({ text, revision: revision(text) });
const fixture = require('./fixtures/image-fixture.cjs');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function scratch(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'image-admission-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
test('PNG variants admitted without transcoding; CRC, animation, size, filters and framing fail closed', () => {
  for (const options of [{}, { color: 0, raw: [0,42] }, { color: 4, raw: [0,42,255] },
    { color: 0, depth: 1, raw: [0,128] }, { depth: 16, raw: [0,0,42,0,100,0,150,255,255] },
    { interlace: 1 }, { color: 3, raw: [0,0], extra: [fixture.chunk('PLTE', Buffer.from([42,100,150]))] }]) {
    const image = fixture.image(options); assert.equal(decodeImage(image).data, image.data);
  }
  for (const options of [{ width: 2049 }, { height: 2049 }, { width: 0 }, { filter: 5 }, { width: 2 },
    { color: 3 }, { color: 0, raw: [0,42], extra: [fixture.chunk('PLTE', Buffer.from([1,2,3]))] },
    { extra: [fixture.chunk('acTL', Buffer.alloc(8))] }, { extra: [fixture.chunk('abcd', Buffer.alloc(0))] }]) assert.throws(() => decodeImage(fixture.image(options)));
  const broken = fixture.png(); broken[broken.length - 1] ^= 1;
  assert.throws(() => decodeImage({ ...fixture.image(), data: broken.toString('base64') }), /CRC/);
  assert.throws(() => decodeImage(fixture.image(), { ...LIMITS, imageBytes: 1 }), /budget/);
});
test('invalid base64, MIME ambiguity, remote sources and unsupported formats are rejected without fetching', () => {
  const image = fixture.image();
  for (const data of ['', '%%%%', image.data + '\n', image.data.slice(0,-1)]) assert.throws(() => decodeImage({ ...image, data }));
  for (const mimeType of ['image/webp', 'image/gif', 'image/jpeg']) assert.throws(() => decodeImage({ ...image, mimeType }));
  assert.throws(() => decodeImage({ ...image, url: 'https://invalid.example' }));
  assert.throws(() => decodeImage({ ...image, source: { type: 'base64', media_type: 'image/png', data: image.data } }));
  assert.throws(() => decodeImage({ type: 'image', source: { type: 'base64', media_type: 'image/png', mediaType: 'image/jpeg', data: image.data } }));
});
test('direct/nested/image-only and branch attribution; byte identities do not depend on inspection', () => {
  const text = fixture.jsonl(fixture.transcript()), snapshot = captured(text), parsed = parseSnapshot('', text);
  const on = hydrate(snapshot, parsed), off = hydrate(snapshot, parsed, LIMITS, { inspectImages: false });
  assert.equal(on.imageCount, 4);
  assert.equal(on.rows.find(r => r.eid === 'u1').assistantBefore.entry, 'a0');
  assert.equal(on.rows.find(r => r.eid === 'off-u').assistantBefore.entry, 'off-a');
  assert.equal(on.rows.find(r => r.eid === 'off-u').off, true);
  assert.equal(on.rows.find(r => r.eid === 'tool-u').images[0].path, '0.0');
  const attachments = data => data.rows.flatMap(r => r.images).map(i => ({ entry: i.entry, path: i.path, identity: i.identity }));
  assert.deepEqual(attachments(on), attachments(off));
  for (const i of on.rows.flatMap(r => r.images)) assert.equal(i.identity, digest(Buffer.from(i.data, 'base64')));
  const groups = packRows(on.rows, 25000); assert.equal(groups.flatMap(g => g.images).length, 4);
  assert.equal(packRows(off.rows, 25000).flatMap(g => g.images).length, 0);
  assert.match(packRows(off.rows, 25000)[0].text, /intentionally not inspected/);
  assert.throws(() => packRows(on.rows, 100));
});
test('cycles, omitted attachments, references, budgets and malformed source fail closed', () => {
  const text = fixture.jsonl(fixture.transcript()), parsed = parseSnapshot('', text);
  const cyclic = structuredClone(parsed); cyclic.entryParents[0][1] = cyclic.entryParents[0][0];
  assert.throws(() => hydrate(captured(text), cyclic), /cyclic/);
  const missing = structuredClone(parsed); missing.messages[0].images = [];
  assert.throws(() => hydrate(captured(text), missing), /no attributed/);
  const changed = structuredClone(parsed); changed.messages[0].images[0].path = '999';
  assert.throws(() => hydrate(captured(text), changed), /image block missing/);
  assert.throws(() => hydrate(captured(text), parsed, { ...LIMITS, count: 1 }));
  assert.throws(() => hydrate(captured(text), parsed, { ...LIMITS, totalBytes: 1 }));
  assert.throws(() => hydrate(captured(text + '{bad'), parsed));
  assert.throws(() => parseSnapshot('', text + text.split('\n')[1]));
});
test('bounded snapshots reject source drift and invalid UTF-8', t => {
  const root = scratch(t);
  const file = path.join(root, 'source'); fs.writeFileSync(file, 'hi');
  const original = fs.readSync;
  try { fs.readSync = (...args) => { const n = original(...args); fs.appendFileSync(file, '\n'); return n; };
    assert.throws(() => sourceSnapshot(file), /changed/); } finally { fs.readSync = original; }
  fs.writeFileSync(file, Buffer.from([255])); assert.throws(() => sourceSnapshot(file), /UTF-8/);
});
test('snapshots hash exact bytes, bound reads, and reject growth and same-size replacement', t => {
  const file = path.join(scratch(t), 'source');
  const bytes = Buffer.from('\ufeff{"text":"é"}\r\n'); fs.writeFileSync(file, bytes);
  const snapshot = sourceSnapshot(file, { ...LIMITS, sourceBytes: bytes.length });
  assert.equal(snapshot.revision, digest(bytes)); assert.equal(snapshot.stat.size, bytes.length);
  assert.equal(snapshot.text, '{"text":"é"}\r\n'); // UTF-8 BOM is not conversation text, but is hashed.
  assert.throws(() => sourceSnapshot(file, { ...LIMITS, sourceBytes: bytes.length - 1 }), /bounded/);
  fs.writeFileSync(file, 'old');
  const read = fs.readSync; let consumed = 0;
  try {
    fs.readSync = (...args) => {
      assert.equal(args[1].length, 4); // admitted size + one byte, regardless of growth
      const n = read(...args); consumed += n; fs.appendFileSync(file, 'growing'); return n;
    };
    assert.throws(() => sourceSnapshot(file), /changed/); assert.ok(consumed <= 4);
  } finally { fs.readSync = read; }
  fs.writeFileSync(file, 'old');
  const replacement = file + '.replacement'; fs.writeFileSync(replacement, 'new');
  try {
    fs.readSync = (...args) => { const n = read(...args); if (fs.existsSync(replacement)) fs.renameSync(replacement, file); return n; };
    assert.throws(() => sourceSnapshot(file), /changed/);
  } finally { fs.readSync = read; }
});
test('opened FIFO/device and regular-to-FIFO replacement reject promptly and close descriptors',
  { skip: process.platform === 'win32' && 'POSIX FIFO/device fixture' }, t => {
    const root = scratch(t), probe = path.join(__dirname, 'fixtures/image-snapshot-admission.cjs');
    const fifo = path.join(root, 'fifo'), target = path.join(root, 'target'), replacement = path.join(root, 'replacement');
    execFileSync('mkfifo', [fifo]); execFileSync('mkfifo', [replacement]); fs.writeFileSync(target, 'regular');
    for (const args of [[fifo], ['/dev/null'], [target, replacement]]) {
      const result = spawnSync(process.execPath, [probe, ...args], { encoding: 'utf8', timeout: 2000 });
      assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr);
      const rejected = JSON.parse(result.stdout);
      assert.equal(rejected.code, 'MEMORY_IMAGE_INPUT'); assert.match(rejected.message, /bounded regular file/);
      assert.equal(rejected.opened, 1); assert.equal(rejected.closed, 1);
    }
  });
test('canonical padding, exact bytes, source form and aggregate image bounds', () => {
  const image = fixture.image(), bytes = Buffer.from(image.data, 'base64');
  const otherPadding = Buffer.from('ff', 'hex');
  assert.throws(() => decodeImage({ ...image, data: '/x==' }), /noncanonical/);
  assert.equal(otherPadding.toString('base64'), '/w==');
  const source = { type: 'image', source: { type: 'base64', media_type: image.mimeType, data: image.data } };
  assert.equal(decodeImage(source).identity, digest(bytes));
  assert.equal(decodeImage(image, { ...LIMITS, imageBytes: bytes.length }).data, image.data);
  assert.throws(() => decodeImage(image, { ...LIMITS, imageBytes: bytes.length - 1 }));
  const text = fixture.jsonl(fixture.transcript()), parsed = parseSnapshot('', text);
  const admitted = hydrate(captured(text), parsed), total = admitted.rows.flatMap(r => r.images).reduce((s, i) => s + i.bytes, 0);
  assert.equal(hydrate(captured(text), parsed, { ...LIMITS, count: 4, totalBytes: total }).imageCount, 4);
  assert.throws(() => hydrate(captured(text), parsed, { ...LIMITS, count: 3 }), /budget/);
  assert.throws(() => hydrate(captured(text), parsed, { ...LIMITS, totalBytes: total - 1 }), /budget/);
});
test('PNG framing, contiguous data, trailing compressed bytes and pixel bounds reject', () => {
  const zlib = require('node:zlib'), png = fixture.png(), header = png.subarray(8, 33), end = png.subarray(-12);
  const wrap = chunks => ({ type: 'image', mimeType: 'image/png', data: Buffer.concat([png.subarray(0,8), ...chunks]).toString('base64') });
  const stream = zlib.deflateSync(Buffer.from([0,42,100,150,255]));
  for (const chunks of [
    [header, header, fixture.chunk('IDAT', stream), end],
    [header, fixture.chunk('IDAT', stream.subarray(0,2)), fixture.chunk('tEXt', Buffer.from('a\0b')), fixture.chunk('IDAT', stream.subarray(2)), end],
    [header, fixture.chunk('IDAT', Buffer.concat([stream, Buffer.from([0])])), end],
    [header, fixture.chunk('IDAT', zlib.deflateSync(Buffer.from([0,42,100,150,255,0]))), end],
    [header, fixture.chunk('IDAT', stream)],
    [header, fixture.chunk('IDAT', stream), end, Buffer.from([0])],
  ]) assert.throws(() => decodeImage(wrap(chunks)));
  assert.throws(() => decodeImage(fixture.image(), { ...LIMITS, pixels: 0 }), /dimensions/);
});
test('references reject duplicate, foreign-entry, ambiguous path and changed MIME', () => {
  const text = fixture.jsonl(fixture.transcript()), parsed = parseSnapshot('', text);
  for (const mutate of [
    p => p.messages[0].images.push({ ...p.messages[0].images[0] }),
    p => p.messages[0].images[0].entry = 'u1',
    p => p.messages[0].images[0].path = '01',
    p => p.messages[0].images[0].mime = 'image/jpeg',
  ]) { const p = structuredClone(parsed); mutate(p); assert.throws(() => hydrate(captured(text), p)); }
  const groups = packRows(hydrate(captured(text), parsed).rows, 100000, { ...LIMITS, callImages: 1 });
  assert.equal(groups.length, 4);
  assert.deepEqual(groups.flatMap(g => g.images).map(i => i.data), hydrate(captured(text), parsed).rows.flatMap(r => r.images).map(i => i.data));
});
