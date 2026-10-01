'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), { Module } = require('node:module');

// Exercise the actual fixture's wire boundary, not a replacement browser scenario.
test('Given the REAL local-machine Chrome fixture, When teardown runs, Then its attached owned target is detached and closed before Browser.close while the startup blank is untouched', { timeout: 120000 }, async () => {
  let scenario; const hooks = [], calls = [], replies = new Map();
  class ObservedSocket extends WebSocket {
    constructor(...args) {
      super(...args);
      this.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id) replies.set(m.id, m); });
    }
    send(data) { calls.push(JSON.parse(data)); return super.send(data); }
  }
  const fixture = new Module(path.join(__dirname, 'localmachines-server.test.js'), module);
  fixture.require = name => {
    if (name === 'target-socket') return ObservedSocket;
    if (name === 'node:test') return { test: (_name, run) => { scenario = run; } };
    return name.startsWith('.') ? require(path.resolve(__dirname, name)) : require(name);
  };
  fixture._compile("const WebSocket = require('target-socket');\n" + fs.readFileSync(fixture.id, 'utf8'), fixture.id);
  try {
    await scenario({ after: hook => hooks.push(hook), skip: reason => assert.fail(reason) });
  } finally {
    // Preserve the real fixture's joined cleanup even when the scenario fails.
    for (const hook of hooks) await hook();
  }
  const create = calls.find(c => c.method === 'Target.createTarget');
  const attach = calls.find(c => c.method === 'Target.attachToTarget');
  assert.ok(create && attach, 'REAL fixture created and attached its tab');
  const targetId = replies.get(create.id).result.targetId;
  const sessionId = replies.get(attach.id).result.sessionId;
  assert.equal(attach.params.targetId, targetId);
  const shutdown = calls.filter(c => ['Target.detachFromTarget', 'Target.closeTarget', 'Browser.close'].includes(c.method));
  assert.deepEqual(shutdown.map(({ method, params, sessionId }) => ({ method, params, sessionId })), [
    { method: 'Target.detachFromTarget', params: { sessionId }, sessionId: undefined },
    { method: 'Target.closeTarget', params: { targetId }, sessionId: undefined },
    { method: 'Browser.close', params: {}, sessionId: undefined },
  ]);
  assert.equal(replies.get(shutdown[0].id).error, undefined);
  assert.equal(replies.get(shutdown[1].id).result.success, true);
});
