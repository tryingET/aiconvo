'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createMemoryAdmission } = require('../memory-admission');

test('missing derived files under a logical parent alias retain canonical protection and source claims', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-parent-alias-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const real = path.join(root, 'physical'), alias = path.join(root, 'logical');
  for (const dir of ['cache', 'notes', 'private']) fs.mkdirSync(path.join(real, dir), { recursive: true });
  fs.symlinkSync(real, alias, process.platform === 'win32' ? 'junction' : 'dir');
  let authorized = false;
  const claimed = path.join(real, 'cache', 'claimed.json');
  const admission = createMemoryAdmission({ notesDir: path.join(real, 'notes'), cacheDir: path.join(real, 'cache'),
    privateDirs: [path.join(real, 'private')], entries: () => ({ source: {} }), files: () => [claimed],
    authorize: key => { assert.equal(key, 'source'); authorized = true; }, privileged: () => false });
  for (const suffix of ['cache/orphan.json', 'cache/missing/deep/orphan.json', 'private/missing/orphan.json', 'notes/projects/missing/overview.md'])
    assert.throws(() => admission.admit(path.join(alias, suffix)), /claims/, suffix);
  const check = admission.admit(path.join(alias, 'cache', 'claimed.json'));
  assert.equal(authorized, true); authorized = false; check(); assert.equal(authorized, true);
  fs.writeFileSync(claimed, 'changed'); assert.throws(check, /changed/);
});

test('canonicalization errors other than ENOENT fail closed', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-parent-error-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const admission = createMemoryAdmission({ notesDir: root, cacheDir: root, entries: () => ({}), files: () => [], authorize() {}, privileged: () => false });
  const original = fs.realpathSync;
  fs.realpathSync = () => { throw Object.assign(new Error('synthetic denied ancestor'), { code: 'EACCES' }); };
  try { assert.throws(() => admission.admit(path.join(root, 'orphan')), e => e.code === 'EACCES'); }
  finally { fs.realpathSync = original; }
});
