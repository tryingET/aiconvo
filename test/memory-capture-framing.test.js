'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs');
const { setup } = require('./fixtures/memory-test-setup.cjs');

// Exercise the exact shared capture reader/wait used by real model tests.
// A split append models Windows visibility; no provider or sleep-based race.
test('capture wait publishes only newline-completed records across split appends', async t => {
  const s = setup(t);
  assert.deepEqual(s.captures(), []);
  fs.writeFileSync(s.capture, '{"childPid":');
  assert.deepEqual(s.captures(), []);
  let settled = false;
  const waiting = s.waitForCapture().then(() => { settled = true; });
  fs.appendFileSync(s.capture, '1}');
  assert.deepEqual(s.captures(), [], 'even valid JSON is uncommitted without its newline');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  fs.appendFileSync(s.capture, '\n{"childPid":');
  await waiting;
  assert.deepEqual(s.captures(), [{ childPid: 1 }], 'partial next record is not parsed');
  fs.appendFileSync(s.capture, '2}\n');
  assert.deepEqual(s.captures(), [{ childPid: 1 }, { childPid: 2 }]);
});

test('completed malformed capture records propagate through the reader and wait, never corruption retries', async t => {
  const s = setup(t);
  for (const corrupt of ['not-json\n', '{"childPid":\n', '{"childPid":1}\ninvalid\n', '\n']) {
    fs.writeFileSync(s.capture, corrupt);
    assert.throws(s.captures, SyntaxError);
    await assert.rejects(s.waitForCapture(), SyntaxError);
  }
});
