'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');

// Run the actual dispatch functions against real HTTP responses. The only
// doubles are identity/source lookup: this boundary must refuse revoked
// credentials before even evaluating an event or writing a response.
function dispatchers() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const events = source.slice(source.indexOf('const sseByConn ='), source.indexOf('// ---- reading:'));
  const programs = source.slice(source.indexOf('function programLiveSend('), source.indexOf('function publishProgramLive('));
  let checked = 0;
  const policy = require('../policy.js');
  const owner = { tier: 'owner', user: { id: 'owner', role: 'owner', scope: 'household' } };
  const context = { LAN_TOKEN: 'test-only', roster: {}, index: {}, console,
    usersLib: { identify: proof => proof.valid ? owner : null, isWalled: () => false },
    wallsFor: identity => identity, ownerIdentity: () => owner,
    liveMemoryIdentity: identity => identity,
    policy: { ...policy, eventView(event, receiver) { checked++; return policy.eventView(event, receiver); } },
    keyVisible: () => true, projectVisible: () => true, assertPathAccess() {}, expandHomePath: p => p, path,
  };
  vm.runInNewContext(events + '\nconst programLiveFollowers = new Set();\n' + programs +
    '\nObject.assign(this, {sseByConn, programLiveFollowers, broadcast, programLiveSend});', context);
  return { ...context, checked: () => checked };
}

for (const kind of ['broadcast', 'programLiveSend']) {
  test(`Given a revoked event-stream credential, When ${kind} publishes, Then the stream ends without a write or policy evaluation`, async t => {
    const dispatch = dispatchers(), errors = [];
    let resolveCheck, rejectCheck, writes = 0;
    const checked = new Promise((resolve, reject) => { resolveCheck = resolve; rejectCheck = reject; });
    const server = http.createServer((req, res) => {
      res.on('error', error => errors.push(error.code));
      const write = res.write.bind(res);
      res.write = (...args) => { writes++; return write(...args); };
      dispatch.sseByConn.set('revoked', { proof: { valid: false }, res });
      dispatch.programLiveFollowers.add('revoked');
      dispatch[kind](kind === 'broadcast' ? { type: 'index' } : { type: 'program-live', ops: [{ op: 'end', id: 'call', scope: {}, state: 'done' }] });
      setImmediate(() => {
        try {
          assert.equal(res.writableEnded, true, 'revocation closes the response');
          assert.deepEqual(errors, [], 'no asynchronous write-after-end error');
          assert.equal(writes, 0, 'no attempted write after revocation');
          assert.equal(dispatch.checked(), 0, 'revoked streams never enter event policy');
          resolveCheck();
        } catch (error) { rejectCheck(error); }
      });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const response = fetch('http://127.0.0.1:' + server.address().port).then(r => r.text());
    await Promise.all([checked, response]);
  });
}

test('Given a valid owner event stream, When an index event publishes, Then it still receives the event', () => {
  const dispatch = dispatchers(), lines = [];
  const res = { writableEnded: false, destroyed: false, write: line => lines.push(line), end: () => assert.fail('valid stream ended') };
  dispatch.sseByConn.set('valid', { proof: { valid: true }, res });
  dispatch.broadcast({ type: 'index' });
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0].slice(6)), { type: 'index' });
});

for (const state of ['writableEnded', 'destroyed']) for (const kind of ['broadcast', 'programLiveSend']) {
  test(`Given a ${state} owner stream, When ${kind} publishes, Then neither write nor policy runs`, () => {
    const dispatch = dispatchers();
    let writes = 0, ends = 0;
    const res = { writableEnded: false, destroyed: false, [state]: true, write: () => writes++, end: () => ends++ };
    dispatch.sseByConn.set('closed', { proof: { valid: true }, res });
    dispatch.programLiveFollowers.add('closed');
    dispatch[kind](kind === 'broadcast' ? { type: 'index' } : { type: 'program-live', ops: [{ op: 'log', seq: 1 }] });
    assert.equal(writes, 0);
    assert.equal(ends, 0);
    assert.equal(dispatch.checked(), 0);
  });
}

test('Given a valid owner program stream, When a nonempty program event publishes, Then delivery remains unchanged', () => {
  const dispatch = dispatchers(), lines = [];
  const event = { type: 'program-live', ops: [{ op: 'log', seq: 1 }] };
  dispatch.sseByConn.set('valid', { proof: { valid: true }, res: { writableEnded: false, destroyed: false, write: line => lines.push(line), end: () => assert.fail('valid stream ended') } });
  dispatch.programLiveFollowers.add('valid');
  dispatch.programLiveSend(event);
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0].slice(6)), event);
});
