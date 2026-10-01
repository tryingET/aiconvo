'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const { createProcessOwner } = require('../memory-process-owner');

function fixture(latency) {
  const queries = [];
  const context = { module: { exports: {} }, process: { platform: 'win32', env: {}, kill() {} }, require(name) {
    if (name === 'child_process') return { execFileSync(_exe, args, options) {
      const script = args.at(-1); queries.push(options.timeout);
      if (options.timeout < latency) throw Object.assign(new Error('synthetic PowerShell timeout'), { code: 'ETIMEDOUT' });
      if (script.includes('$before =')) return '2026-10-01T00:00:00.0000000Z\t1\n2026-09-01T00:00:00.0000000Z';
      if (script.includes('CommandLine FROM')) return '10\t1\tnode synthetic';
      throw new Error('Unexpected extra process query');
    } };
    return require(name);
  } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../processes'), 'utf8'), context);
  return { api: context.module.exports, queries };
}

test('Given a current Windows query taking more than two seconds, When time remains, Then ownership is read without using discovery caches', () => {
  const s = fixture(2100);
  const owner = createProcessOwner(s.api);
  const anchor = owner.anchor(10);
  assert.equal(anchor.pid, 10); assert.equal(anchor.ppid, 1);
  assert.equal(anchor.start, '2026-10-01T00:00:00.0000000Z');
  assert.equal(anchor.boot, '2026-09-01T00:00:00.0000000Z');
  assert.equal(s.queries.length, 1, 'one fresh birth/parent/birth query, no stale cache fallback');
  assert.ok(s.queries[0] >= 2100 && s.queries[0] <= 10000);
});

test('Given a short remaining cleanup deadline, When a Windows query cannot finish in it, Then no signal is authorized', () => {
  const s = fixture(2100), owner = createProcessOwner(s.api, () => assert.fail('uncertain PID signalled'));
  const deadline = Date.now() + 400;
  assert.throws(() => owner.read(10, deadline), { code: 'ETIMEDOUT' });
  assert.ok(s.queries[0] > 0 && s.queries[0] <= 400, 'query must fit the remaining deadline');
  const table = fixture(2100);
  assert.throws(() => table.api.ownershipList({ deadline }), { code: 'ETIMEDOUT' });
  assert.ok(table.queries[0] > 0 && table.queries[0] <= 400);
});
