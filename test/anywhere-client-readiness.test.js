'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { connect } = require('../anywhere/client');

const offerSDP = 'v=0\r\na=ice-ufrag:synthetic\r\na=fingerprint:sha-256 synthetic\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=mid:0\r\na=candidate:local 1 UDP 1 192.0.2.1 12345 typ host\r\na=end-of-candidates\r\n';
const withoutCandidates = offerSDP.replace(/^a=(?:candidate:[^\r\n]*|end-of-candidates)(?:\r?\n|$)/gm, '');
const inlineCandidate = offerSDP.match(/^a=(candidate:[^\r\n]+)/m)[1];
const defer = () => { let resolve, reject; const promise = new Promise((r, j) => { resolve = r; reject = j; }); return { promise, resolve, reject }; };

async function fixture(t, { abortDuringFlush = false, reentrant = false, sdp = offerSDP } = {}) {
  let peer, socket;
  const abort = new AbortController(), setterStarted = defer(), setterRelease = defer(), setterFinished = defer(), flushed = defer();
  class Peer {
    constructor() { peer = this; this.localDescription = null; this.remoteDescription = {}; this.applied = []; this.closed = false; }
    createDataChannel() { return { close() {} }; }
    candidate(label) { this.onicecandidate({ candidate: { candidate: 'candidate:' + label, sdpMid: '0', sdpMLineIndex: 0 } }); }
    async createOffer() { this.candidate('before-offer'); return { type: 'offer', sdp }; }
    async setLocalDescription(d) { this.localDescription = { ...d }; }
    async setRemoteDescription(d) { setterStarted.resolve(); await setterRelease.promise; this.remoteDescription = d; setterFinished.resolve(); }
    async addIceCandidate(c) { assert.ok(this.remoteDescription.sdp, 'candidate application requires applied SDP'); this.applied.push(c); }
    close() { this.closed = true; }
  }
  class Socket {
    constructor() { socket = this; this.sent = []; }
    send(text) {
      const m = JSON.parse(text); this.sent.push(m);
      if (m.data?.candidate) {
        if (reentrant && !this.injected && m.data.candidate.candidate) {
          this.injected = true; peer.candidate('reentrant');
        }
        if (abortDuringFlush) abort.abort();
        if (this.candidates().length >= 2) flushed.resolve();
      }
    }
    candidates() { return this.sent.filter(m => m.data?.candidate); }
    receive(data) { return this.onmessage({ data: JSON.stringify(data) }); }
    close() { this.closed = true; }
  }
  const outcome = connect({ relay: 'https://synthetic.invalid', homeId: 'synthetic', device: {},
    RTCPeerConnection: Peer, WebSocket: Socket, signal: abort.signal }).then(value => ({ value }), error => ({ error }));
  t.after(async () => { abort.abort(); setterRelease.resolve(); await outcome; });
  socket.onopen();
  await socket.receive({ t: 'ice', servers: [] });
  return { peer, socket, abort, outcome, setterStarted, setterRelease, setterFinished, flushed };
}

// Drain the finite promise chain; no clock wait or network fixture is involved.
async function drain() { for (let i = 0; i < 8; i++) await Promise.resolve(); }

test('Given gathered offer candidates and deferred answer application, When the phone signals, Then neither direction applies or publishes ICE before remote SDP readiness', async t => {
  const f = await fixture(t);
  const wire = f.socket.sent.find(m => m.data?.sdp).data.sdp;
  assert.equal(wire.sdp, withoutCandidates, 'only wire candidates/end marker are withheld');
  assert.equal(f.peer.localDescription.sdp, offerSDP, 'native local description is unchanged');
  assert.equal(f.socket.candidates().length, 0, 'local candidate must wait for the answer, not merely the offer');
  await f.socket.receive({ t: 'signal', data: { candidate: { candidate: 'candidate:home', sdpMid: '0' } } });
  await f.socket.receive({ t: 'signal', data: { sdp: { type: 'answer', sdp: 'synthetic answer' } } });
  await f.setterStarted.promise;
  f.peer.candidate('during-answer');
  assert.equal(f.socket.candidates().length, 0);
  assert.equal(f.peer.applied.length, 0);
  f.setterRelease.resolve();
  await f.flushed.promise;
  await drain();
  assert.deepEqual(f.socket.candidates().map(m => m.data.candidate.candidate), ['candidate:before-offer', inlineCandidate, 'candidate:during-answer', '']);
  assert.deepEqual(f.peer.applied.map(c => c.candidate), ['candidate:home']);
  f.peer.candidate('after-answer');
  assert.equal(f.socket.candidates().at(-1).data.candidate.candidate, 'candidate:after-answer');
});

test('Given an answer setter still pending, When the phone aborts, Then late setter completion neither publishes buffered ICE nor applies queued home candidates', async t => {
  const f = await fixture(t);
  await f.socket.receive({ t: 'signal', data: { candidate: { candidate: 'candidate:home' } } });
  await f.socket.receive({ t: 'signal', data: { sdp: { type: 'answer', sdp: 'synthetic answer' } } });
  await f.setterStarted.promise;
  f.peer.candidate('during-answer');
  f.abort.abort();
  f.setterRelease.resolve();
  await f.setterFinished.promise; await drain();
  assert.equal((await f.outcome).error.code, 'aborted');
  assert.equal(f.peer.closed, true);
  assert.equal(f.socket.candidates().length, 0);
  assert.equal(f.peer.applied.length, 0);
});

test('Given buffered phone ICE, When abort occurs during the first released candidate, Then no later candidate is published', async t => {
  const f = await fixture(t, { abortDuringFlush: true });
  assert.equal(f.socket.candidates().length, 0, 'no candidate may be released at offer publication');
  f.peer.candidate('second');
  await f.socket.receive({ t: 'signal', data: { sdp: { type: 'answer', sdp: 'synthetic answer' } } });
  await f.setterStarted.promise;
  f.setterRelease.resolve();
  await f.setterFinished.promise; await drain();
  assert.equal((await f.outcome).error.code, 'aborted');
  assert.deepEqual(f.socket.candidates().map(m => m.data.candidate.candidate), ['candidate:before-offer']);
});

test('Given reentrant local gathering during candidate one, When buffered candidates drain, Then new candidates cannot overtake buffered ones or completion', async t => {
  const f = await fixture(t, { reentrant: true });
  f.peer.candidate('second');
  await f.socket.receive({ t: 'signal', data: { sdp: { type: 'answer', sdp: 'synthetic answer' } } });
  await f.setterStarted.promise; f.setterRelease.resolve();
  await f.setterFinished.promise; await drain();
  assert.deepEqual(f.socket.candidates().map(m => m.data.candidate.candidate),
    ['candidate:before-offer', inlineCandidate, 'candidate:second', 'candidate:reentrant', '']);
});

test('Given the same candidate is in SDP and an event, When answer application completes, Then it is conserved once and native null completion is also withheld until readiness', async t => {
  const f = await fixture(t);
  f.peer.onicecandidate({ candidate: { candidate: inlineCandidate, sdpMid: '0', sdpMLineIndex: 0 } });
  f.peer.onicecandidate({ candidate: null });
  assert.equal(f.socket.candidates().length, 0);
  await f.socket.receive({ t: 'signal', data: { sdp: { type: 'answer', sdp: 'synthetic answer' } } });
  await f.setterStarted.promise; f.setterRelease.resolve();
  await f.setterFinished.promise; await drain();
  const candidates = f.socket.candidates().map(m => m.data.candidate);
  assert.equal(candidates.filter(c => c.candidate === inlineCandidate).length, 1);
  assert.ok(candidates.some(c => c.candidate === '' && c.sdpMid === '0' && c.sdpMLineIndex === 0));
  assert.ok(candidates.some(c => c.candidate === '' && c.sdpMid === null && c.sdpMLineIndex === null));
});

test('Given candidates across media sections and a later mid, When offer candidates move to trickle, Then all other SDP bytes and media identities are preserved', async t => {
  const sdp = 'v=0\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\na=candidate:one\na=mid:data\nm=audio 9 UDP/TLS/RTP/SAVPF 0\na=mid:a\na=candidate:two\na=end-of-candidates';
  const f = await fixture(t, { sdp });
  assert.equal(f.socket.sent.find(m => m.data?.sdp).data.sdp.sdp,
    'v=0\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\na=mid:data\nm=audio 9 UDP/TLS/RTP/SAVPF 0\na=mid:a\n');
  assert.equal(f.peer.localDescription.sdp, sdp);
  await f.socket.receive({ t: 'signal', data: { sdp: { type: 'answer', sdp: 'synthetic answer' } } });
  await f.setterStarted.promise; f.setterRelease.resolve();
  await f.setterFinished.promise; await drain();
  assert.deepEqual(f.socket.candidates().map(m => m.data.candidate).filter(c => c.candidate === 'candidate:one' || c.candidate === 'candidate:two'),
    [{ candidate: 'candidate:one', sdpMid: 'data', sdpMLineIndex: 0 }, { candidate: 'candidate:two', sdpMid: 'a', sdpMLineIndex: 1 }]);
});

test('Given a rejected native answer setter, When negotiation fails, Then no buffered candidate or late callback can publish', async t => {
  const f = await fixture(t);
  await f.socket.receive({ t: 'signal', data: { sdp: { type: 'answer', sdp: 'synthetic answer' } } });
  await f.setterStarted.promise;
  f.setterRelease.reject(new Error('controlled answer denial'));
  const result = await f.outcome;
  assert.equal(result.error.code, 'failed');
  assert.match(result.error.message, /controlled answer denial/);
  f.peer.candidate('late');
  assert.equal(f.peer.closed, true);
  assert.equal(f.socket.candidates().length, 0);
});
