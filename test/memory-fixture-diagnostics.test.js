'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createFixtureDiagnostics } = require('./helpers/memory-fixture-diagnostics');
const token = 'synthetic-fixture-credential';
function child() {
  const c = new EventEmitter();
  Object.assign(c, { pid: 123, exitCode: null, signalCode: null, killed: false,
    stdout: new EventEmitter(), stderr: new EventEmitter() });
  return c;
}

test('request reset captures method/URL/body/cause, child exit and stderr without exposing fixture credentials or retrying', async () => {
  let calls = 0; const reports = [];
  const diag = createFixtureDiagnostics({ secrets: [token], report: message => reports.push(message), async fetch(url, options) {
    calls++;
    assert.equal(options.headers.Authorization, 'Bearer ' + token, 'diagnostics must not change the actual request');
    const cause = new Error('read ECONNRESET'); cause.code = 'ECONNRESET'; cause.syscall = 'read';
    throw new TypeError('fetch failed ' + token, { cause });
  } });
  const c = child(); diag.watch(c);
  c.stderr.emit('data', Buffer.from('synthetic EPERM on clock; token=' + token));
  c.exitCode = 71; c.emit('exit', 71, null);
  assert.equal(reports.length, 1);
  await assert.rejects(() => diag.request('http://127.0.0.1:1234/api/settings?token=url-secret', {
    method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: JSON.stringify({ automaticMemory: 'off', clientSecret: 'body-secret', token }),
  }), error => {
    const text = error.stack + JSON.stringify(error.cause);
    for (const value of ['POST', '/api/settings', 'automaticMemory', 'ECONNRESET', 'EPERM', '71']) assert.ok(text.includes(value), value);
    for (const secret of [token, 'url-secret', 'body-secret', 'Authorization']) assert.equal(text.includes(secret), false, secret);
    assert.equal(error.cause.cause.code, 'ECONNRESET');
    return true;
  });
  assert.equal(calls, 1, 'a failed request is never retried');
  diag.expectedExit(c); // cleanup after failure must not hide the earlier crash.
  c.stderr.emit('data', Buffer.from('\nlate stderr ' + token)); c.emit('close', 71, null);
  assert.equal(reports.length, 2);
  assert.ok(reports.at(-1).includes('late stderr'));
  assert.ok(reports.at(-1).includes('/api/settings'));
  assert.ok(reports.every(text => !text.includes(token)));
});

test('expected teardown is recorded without reporting it as an unexpected server exit', () => {
  const reports = [], c = child();
  const diag = createFixtureDiagnostics({ fetch: () => { throw new Error('unused'); }, report: message => reports.push(message) });
  diag.watch(c); diag.expectedExit(c); c.signalCode = 'SIGTERM'; c.emit('exit', null, 'SIGTERM'); c.emit('close', null, 'SIGTERM');
  assert.deepEqual(reports, []);
  assert.equal(diag.snapshot().events.at(-1).unexpected, false);
  assert.equal(diag.snapshot().child.signalCode, 'SIGTERM');
});

test('response-body errors retain request identity and HTTP status as sanitized diagnostics', async () => {
  let calls = 0;
  const diag = createFixtureDiagnostics({ secrets: [token], async fetch() {
    calls++; return { status: 200, async json() { throw new SyntaxError('invalid fixture body ' + token); } };
  } });
  const response = await diag.request('http://127.0.0.1:1234/api/memory/leaf?id=pi:fixture/old.jsonl');
  assert.equal(response.status, 200);
  await assert.rejects(() => response.json(), error => {
    assert.ok(error.message.includes('response body'));
    assert.ok(error.message.includes('/api/memory/leaf'));
    assert.equal(error.message.includes(token), false);
    return true;
  });
  assert.equal(diag.snapshot().requests.at(-1).status, 200);
  assert.equal(calls, 1);
});
