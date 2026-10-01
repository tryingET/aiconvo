'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { Module, createRequire } = require('node:module');
const defer = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'home-signal-order-'));
  const started = defer(), release = defer(), constructed = defer();
  let peer, socket, home;
  const events = [];
  class Peer {
    constructor() { peer = this; this.remoteDescription = {}; this.localDescription = null; }
    async setRemoteDescription(d) { events.push('remote-start'); started.resolve(); await release.promise; this.remoteDescription = d; events.push('remote-ready'); }
    async addIceCandidate() { assert.ok(this.remoteDescription.sdp, 'truthy empty SDP is not readiness'); events.push('candidate'); }
    async createAnswer() { events.push('answer'); return { type: 'answer', sdp: 'synthetic answer' }; }
    async setLocalDescription(d) { this.localDescription = d; events.push('local-ready'); }
    close() { events.push('closed'); }
  }
  class Socket {
    constructor() { socket = this; this.sent = []; constructed.resolve(); }
    send(data) { this.sent.push(JSON.parse(data)); }
    close() {}
    receive(data) { return this.onmessage({ data: JSON.stringify(data) }); }
  }
  // Exercise the unchanged public home handler with controlled platform and
  // relay boundaries, not fabricated native ICE or authentication evidence.
  const file = require.resolve('../anywhere-home'), requireHere = createRequire(file), m = new Module(file, module);
  m.filename = file;
  m.require = spec => spec.includes('node-datachannel')
    ? spec.includes('polyfill') ? { RTCPeerConnection: Peer } : { cleanup() {} }
    : requireHere(spec);
  m._compile(fs.readFileSync(file, 'utf8'), file);
  home = m.exports.createAnywhereHome({ dataDir: dir, appDir: path.dirname(file), WebSocketImpl: Socket,
    relayUrl: () => 'http://synthetic.invalid', localTarget: () => { throw Error('no forwarded request is allowed in this fixture'); },
    issueCredential: () => { throw Error('no authentication is claimed by this fixture'); }, credentialAlive: () => false });
  t.after(() => { home.stop(); release.resolve(); fs.rmSync(dir, { recursive: true, force: true }); });
  await home.pair('synthetic-user');
  await constructed.promise;
  socket.onopen(); await socket.receive({ t: 'welcome', servers: [] });
  return { home, socket, events, started, release, peer: () => peer };
}

for (const leaves of [false, true]) {
  test(`Given a legacy candidate arrives while home SDP is pending, When ${leaves ? 'the peer leaves' : 'the setter completes'}, Then ${leaves ? 'no queued candidate or answer acts after close' : 'the real home handler serializes SDP and candidate application'}`, async t => {
    const f = await fixture(t);
    const applying = f.socket.receive({ t: 'signal', from: 'controlled-phone', data: { sdp: { type: 'offer', sdp: 'synthetic offer' } } });
    await f.started.promise;
    const queued = f.socket.receive({ t: 'signal', from: 'controlled-phone', data: { candidate: { candidate: 'candidate:legacy' } } });
    assert.deepEqual(f.events, ['remote-start']);
    if (leaves) await f.socket.receive({ t: 'gone', from: 'controlled-phone' });
    f.release.resolve(); await Promise.all([applying, queued]);
    if (leaves) {
      assert.equal(f.events.includes('candidate'), false);
      assert.equal(f.events.includes('answer'), false);
      assert.equal(f.socket.sent.filter(m => m.t === 'signal').length, 0);
    } else {
      assert.deepEqual(f.events, ['remote-start', 'remote-ready', 'answer', 'local-ready', 'candidate']);
      assert.equal(f.socket.sent.find(m => m.t === 'signal').data.sdp.type, 'answer');
    }
  });
}
