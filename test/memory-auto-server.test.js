'use strict';
// Real upstream6d server and current FunctAI transport; all sources, identities,
// clocks and provider responses are synthetic. The common harness isolates HOME/network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { registerConsole, consoleFetch: fetch } = require('./helpers/console-fetch');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, message, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await fn(); if (value) return value; await sleep(40); }
  throw new Error('Timed out: ' + message);
}
async function fixture(t) {
  // Native realpath expands Windows 8.3 names before recursive fs.watch.
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'memory-auto-server-')));
  const agent = path.join(home, '.pi', 'agent'), sessions = path.join(agent, 'sessions', 'fixture');
  const work = path.join(home, 'work'); fs.mkdirSync(work); fs.mkdirSync(sessions, { recursive: true });
  const session = (id, origin = '2020-01-01T00:00:00Z') => path.join(sessions, id + '.jsonl');
  const write = (id, origin = '2020-01-01T00:00:00Z') => {
    const file = session(id);
    fs.writeFileSync(file, [
      { type: 'session', version: 3, id, cwd: work, timestamp: origin },
      { type: 'message', id: 'u1', parentId: null, timestamp: origin, message: { role: 'user', content: [{ type: 'text', text: 'Keep the protocol transparent and preserve user control.' }] } },
    ].map(JSON.stringify).join('\n') + '\n');
    return file;
  };
  write('old'); require('./helpers/first-run').answerFirstRun(home);
  const clock = path.join(home, 'clock'), calls = path.join(home, 'calls'), block = path.join(home, 'block'), release = path.join(home, 'release'), fail = path.join(home, 'fail'), abstract = path.join(home, 'abstract');
  fs.writeFileSync(clock, '0');
  // Kept outside the disposable fixture HOME for the isolated harness's proof.
  const evidenceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-cache-evidence-'));
  const phase = path.join(home, 'phase'), events = path.join(home, 'cli-events');
  fs.writeFileSync(phase, 'setup');
  const preload = path.join(home, 'clock.cjs');
  fs.writeFileSync(preload, `const fs = require('fs'); const real = Date.now;
Date.now = () => real() + Number(fs.readFileSync(${JSON.stringify(clock)}, 'utf8'));
const interval = global.setInterval; global.setInterval = (fn, ms, ...args) => interval(fn, [120000,20000].includes(ms) ? 60 : ms, ...args);\n`);
  const cli = path.join(home, 'fake-pi.cjs');
  fs.writeFileSync(cli, `const fs = require('fs'), crypto = require('crypto'), path = require('path');
const args = process.argv.slice(2), i = args.indexOf('--system-prompt');
const system = i < 0 ? '' : fs.readFileSync(args[i+1], 'utf8');
const functionName = system.match(/^Function: (\\w+)/)?.[1] || (args.includes('--list-models') ? 'model-discovery' : 'unknown');
const context = () => {
  let state = null; try { state = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(home, '.config', 'chattering', 'memory-automation.json'))}, 'utf8')); } catch {}
  const rawRevisions = Object.fromEntries(fs.readdirSync(${JSON.stringify(sessions)}).filter(n => n.endsWith('.jsonl')).map(n => ['pi:fixture/'+n, crypto.createHash('sha256').update(fs.readFileSync(path.join(${JSON.stringify(sessions)},n))).digest('hex')]));
  return { generation: process.env.MEMORY_FIXTURE_GENERATION, phase: fs.readFileSync(${JSON.stringify(phase)}, 'utf8'), functionName, args, rawRevisions, state };
};
fs.appendFileSync(${JSON.stringify(events)}, JSON.stringify({event:'spawn',...context()}) + '\\n');
// Pi catalog listing is metadata, not a prompt: it never reads stdin or
// emits a model answer. Keep it in the all-command trace, not the inference ledger.
if (args.includes('--list-models')) {
  fs.appendFileSync(${JSON.stringify(events)}, JSON.stringify({event:'catalog-response',sourceKey:null,...context()}) + '\\n');
  process.stdout.write(['provider'.padEnd(12)+'model'.padEnd(12)+'context'.padEnd(10)+'max-out'.padEnd(10)+'thinking'.padEnd(12)+'images', 'fake'.padEnd(12)+'fixture'.padEnd(12)+'100k'.padEnd(10)+'8k'.padEnd(10)+'no'.padEnd(12)+'no'].join('\\n')+'\\n');
  return; // CJS entry point: let stdout flush normally before exit.
}
const input = fs.readFileSync(0, 'utf8');
const invocation = {system,input,sourceKey:input.match(/CONVERSATION ([^\\n]+)/)?.[1] || null,...context()};
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(invocation) + '\\n');
fs.appendFileSync(${JSON.stringify(events)}, JSON.stringify({event:'invoked',...invocation}) + '\\n');
(async () => {
while (fs.existsSync(${JSON.stringify(block)}) && !fs.existsSync(${JSON.stringify(release)})) await new Promise(r => setTimeout(r, 30));
if (fs.existsSync(${JSON.stringify(fail)})) process.exit(1);
const overview = {summary:'Synthetic project.',identity:'experiment',evolution:[],purpose:'Preserve user control.',vision:'Transparent protocol.',desiredOutcomes:[],principles:[],nonGoals:[]};
const environment = {setup:[],commands:[],services:[],locations:[],tooling:[],authentication:[],cautions:[]};
let answer = '<abstract>'+(fs.existsSync(${JSON.stringify(abstract)}) ? fs.readFileSync(${JSON.stringify(abstract)}, 'utf8') : 'Preserve user control.')+'</abstract>\\n<intent>[]</intent>\\n<environment>[]</environment>\\n<problems>[]</problems>';
if (system.startsWith('Function: project_overview')) answer = '<overview>'+JSON.stringify(overview)+'</overview><epicCandidates>[]</epicCandidates>';
if (system.startsWith('Function: project_intent')) answer = '<coreIntent>Preserve control.</coreIntent><vision>Transparent.</vision><currentDirection>Protocol.</currentDirection>'+['whatMatters','desiredOutcomes','principles','constraints','tensions','nonGoals','evolution','openIntentQuestions'].map(k=>'<'+k+'>[]</'+k+'>').join('');
if (system.startsWith('Function: project_environment')) answer = '<summary>Fixture.</summary><project>'+JSON.stringify(environment)+'</project><machines>[]</machines>';
if (system.startsWith('Function: project_status')) answer = ['recentFocus','unfinished','todos','openQuestions'].map(k=>'<'+k+'>[]</'+k+'>').join('');
process.stdout.write(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:answer}],stopReason:'stop',provider:'fake',model:'fixture',timestamp:Date.now(),usage:{input:10,output:5,totalTokens:15}}})+'\\n');
})();\n`);
  const sock = net.createServer(); await new Promise(r => sock.listen(0, '127.0.0.1', r));
  const port = sock.address().port; await new Promise(r => sock.close(r)); registerConsole(port, 'memory-fixture-token');
  const env = { ...process.env, ...require('./helpers/home-env').homeEnv(home),
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local', 'share'), XDG_CACHE_HOME: path.join(home, '.cache'),
    CHATTERING_PI_CLI: cli, NODE_OPTIONS: '--require=' + preload, PI_CODING_AGENT_DIR: agent, PI_AGENT_DIR: agent,
    CHATTERING_HOST: '127.0.0.1', PORT: String(port), CHATTERING_TLS_PORT: '0', CHATTERING_LAN: '', CHATTERING_TOKEN: 'memory-fixture-token', CHATTERING_PUBLIC_URL: '',
    CHATTERING_NO_SYNC: '1', CHATTERING_CACHE_DIR: path.join(home, '.cache', 'chattering'), CHATTERING_CHECKPOINT_DIR: path.join(home, 'checkpoints'), CHATTERING_DELEGATION_ROOT: path.join(home, 'delegations') };
  let child, generation = 0, restartEvidence;
  const diagnostics = require('./helpers/memory-fixture-diagnostics').createFixtureDiagnostics({ fetch,
    secrets: ['memory-fixture-token'], report: message => t.diagnostic(message) });
  const request = diagnostics.request;
  const log = () => JSON.stringify(diagnostics.snapshot(), null, 2);
  const io = (phase, fn) => { try { return fn(); } catch (e) { throw diagnostics.enhance(e, phase); } };
  const setClock = value => io('clock write', () => fs.writeFileSync(clock, String(value)));
  const safetySnapshot = label => ({ label, count: count(), state: JSON.parse(fs.readFileSync(state, 'utf8')),
    rawRevisions: Object.fromEntries(fs.readdirSync(sessions).filter(n => n.endsWith('.jsonl')).map(n => ['pi:fixture/' + n, require('../memory-automation').revision(fs.readFileSync(path.join(sessions, n)))])) });
  const start = async () => {
    env.MEMORY_FIXTURE_GENERATION = String(++generation);
    fs.writeFileSync(phase, 'start:' + generation);
    child = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env, stdio: ['ignore', 'pipe', 'pipe'] });
    diagnostics.watch(child);
    try {
      await until(async () => {
        if (child.exitCode !== null || child.signalCode !== null) throw new Error('fixture server exited during startup');
        try { return (await (await request(base + '/api/sessions')).json()).some(x => x.key === key('old')); } catch { return false; }
      }, 'server start');
    } catch (e) { throw diagnostics.enhance(e, 'startup'); }
  };
  const base = 'http://127.0.0.1:' + port, key = id => 'pi:fixture/' + id + '.jsonl';
  const post = async (route, body) => {
    const r = await request(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const out = await r.json(); assert.equal(r.status, 200, diagnostics.sanitize(JSON.stringify(out)) + log()); return out;
  };
  const settings = async () => (await (await request(base + '/api/settings')).json());
  const count = () => fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').length : 0;
  const state = path.join(home, '.config', 'chattering', 'memory-automation.json');
  t.after(async () => {
    diagnostics.expectedExit(child);
    try { await require('./helpers/cleanup').stopAndRemove(child, home); }
    catch (e) { throw diagnostics.enhance(e, 'cleanup'); }
  });
  await start();
  const cacheEvidence = label => {
    const evidence = { restart: restartEvidence, after: safetySnapshot(label), programs: fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse) : [],
      cliEvents: fs.existsSync(events) ? fs.readFileSync(events, 'utf8').trim().split('\n').map(JSON.parse) : [] };
    fs.writeFileSync(path.join(evidenceDir, label + '.json'), JSON.stringify(evidence, null, 2));
    return evidence;
  };
  return { home, work, state, key, post, settings, log, request, setClock, safetySnapshot, cacheEvidence,
    restartEvidence: () => restartEvidence,
    cliEvents: () => fs.existsSync(events) ? fs.readFileSync(events, 'utf8').trim().split('\n').map(JSON.parse) : [],
    write: (id, origin) => io('source write', () => write(id, origin)),
    count: () => io('provider call-log read', count),
    corruptState: () => io('consent corruption write', () => fs.writeFileSync(state, '{corrupt')),
    async project() { return (await (await request(base + '/api/sessions')).json()).find(s => s.key === key('old')).project; },
    async docs(project) { const r = await request(base + '/api/project/memory?name=' + encodeURIComponent(project)); return r.status === 200 ? r.json() : null; },
    programs: () => fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse) : [],
    advance: () => setClock('700000'),
    abstract: text => io('abstract write', () => fs.writeFileSync(abstract, text)),
    change: id => io('source append', () => fs.appendFileSync(session(id), ' \n')),
    block: () => io('provider block write', () => fs.writeFileSync(block, '')),
    release: () => io('provider release write', () => fs.writeFileSync(release, '')),
    fail: () => io('provider failure write', () => fs.writeFileSync(fail, '')),
    async leaf(id) { return (await (await request(base + '/api/memory/leaf?id=' + encodeURIComponent(key(id)))).json()).leaf; },
    async restartWithoutCache() {
      fs.writeFileSync(phase, 'pre-stop:' + generation);
      restartEvidence = { before: safetySnapshot('before-stop') };
      diagnostics.expectedExit(child);
      child.kill('SIGTERM'); await new Promise(r => child.once('close', r));
      restartEvidence.stopped = safetySnapshot('stopped');
      io('restart cache removal', () => fs.rmSync(env.CHATTERING_CACHE_DIR, { recursive: true, force: true }));
      restartEvidence.deleted = safetySnapshot('cache-deleted');
      await start(); restartEvidence.ready = safetySnapshot('restart-ready');
    },
  };
}

async function completedRevisions(f, ids) {
  const snapshot = await until(() => {
    const s = f.safetySnapshot('completed');
    return ids.every(id => { const p = s.state.pending[f.key(id)]; return p?.status === 'done' && p.attemptRevision === s.rawRevisions[f.key(id)] &&
      ['leaf', 'documents', 'leaf-and-documents'].every(stage => p.completed.includes(stage)); }) ? s : null;
  }, 'exact raw revisions and all automatic stages durably completed');
  assert.deepEqual(snapshot.state.baseline, snapshot.rawRevisions, 'every current source revision is durably accounted for');
  assert.ok(Object.values(snapshot.state.pending).every(p => p.status === 'done'));
  assert.equal((await f.settings()).automaticMemory.active, true);
  return snapshot;
}
function unchangedRestart(f, evidence, count) {
  for (const snapshot of [evidence.restart.stopped, evidence.restart.deleted, evidence.restart.ready, evidence.after]) {
    assert.deepEqual(snapshot.rawRevisions, evidence.restart.before.rawRevisions, 'restart must not introduce new raw material');
    assert.deepEqual(snapshot.state, evidence.restart.before.state, 'same consent epoch, baselines, outcomes and stages after cache-only restart');
  }
  assert.equal(f.count(), count, 'cache deletion cannot acquire consent: ' + JSON.stringify(evidence));
}

test('future-only real server: baseline, genuine creation vs import, raw changes, cache deletion and manual off', { timeout: 90000 }, async t => {
  const f = await fixture(t);
  const enabled = await f.post('/api/settings/background-ai', { memory: true, automaticMemory: 'changes-after-enable' });
  assert.equal(enabled.automaticMemory.baselineCount, 1); assert.equal(f.count(), 0);
  // POSIX mode bits do not establish Windows ACL confidentiality. Only this
  // mode assertion is platform-conditional; state/durability checks still run.
  if (process.platform !== 'win32') assert.equal(fs.statSync(f.state).mode & 0o777, 0o600);
  const general = await f.post('/api/settings', { ...enabled.settings, automaticMemory: 'off' });
  assert.equal(general.settings.automaticMemory, 'changes-after-enable');
  await sleep(100); f.write('import'); f.write('created', new Date().toISOString());
  await until(async () => (await f.settings()).automaticMemory.pending.some(p => p.key === f.key('created')), 'live creation admitted');
  const before = (await f.settings()).automaticMemory;
  assert.equal(before.observations[f.key('import')].kind, 'baseline-discovery');
  assert.equal(before.pending.some(p => p.key === f.key('import')), false);
  f.change('old');
  await until(async () => (await f.settings()).automaticMemory.pending.some(p => p.key === f.key('old')), 'raw-only changed historical session');
  f.advance();
  await until(async () => (await f.leaf('old'))?.abstract === 'Preserve user control.' && (await f.leaf('created'))?.abstract === 'Preserve user control.', 'automatic text leaves ' + f.log());
  assert.equal(f.count(), 2); assert.equal(await f.leaf('import'), null);
  const logs = fs.readdirSync(path.join(f.home, 'functai', 'calls')).flatMap(d => fs.readdirSync(path.join(f.home, 'functai', 'calls', d)).flatMap(file => fs.readFileSync(path.join(f.home, 'functai', 'calls', d, file), 'utf8').trim().split('\n').map(JSON.parse)));
  assert.equal(logs.filter(r => r.functai_call && r.program.name === 'memory_dialogue' && r.caller.automatic).length, 2);
  await completedRevisions(f, ['old', 'created']);
  await f.restartWithoutCache(); await sleep(300);
  const evidence = f.cacheEvidence('after-300ms');
  unchangedRestart(f, evidence, 2);
  await f.post('/api/settings/background-ai', { automaticMemory: 'off' });
  f.change('import'); await sleep(500); assert.equal(f.count(), 2);
  const sessions = await (await f.request('http://127.0.0.1:' + (await f.settings()).port + '/api/sessions')).json();
  const project = sessions.find(s => s.key === f.key('old')).project;
  const r = await f.request('http://127.0.0.1:' + (await f.settings()).port + '/api/memory/backfill', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project }) });
  assert.equal(r.status, 202, JSON.stringify(await r.json()) + f.log());
  await until(async () => (await f.leaf('import'))?.abstract === 'Preserve user control.', 'manual backfill while automatic off');
});

test('cache-only restart: two completed raw revisions cannot infer again when the catalog stdin closes', { timeout: 90000 }, async t => {
  const f = await fixture(t);
  await until(() => f.cliEvents().some(e => e.generation === '1' && e.functionName === 'model-discovery' && e.event === 'spawn'), 'first startup catalog is actually launched');
  await f.post('/api/settings/background-ai', { memory: true, automaticMemory: 'changes-after-enable' });
  await sleep(100); f.write('created', new Date().toISOString());
  await until(async () => (await f.settings()).automaticMemory.pending.some(p => p.key === f.key('created')), 'live creation admitted before advancing the clock');
  f.change('old');
  await until(async () => (await f.settings()).automaticMemory.pending.some(p => p.key === f.key('old')), 'old revision admitted before advancing the clock');
  f.advance(); await completedRevisions(f, ['old', 'created']);
  assert.equal(f.count(), 2);
  assert.deepEqual(f.programs().map(c => c.sourceKey).sort(), [f.key('created'), f.key('old')].sort());
  assert.ok(f.programs().every(c => c.functionName === 'memory_dialogue' && c.state.pending[c.sourceKey].status === 'running' && c.state.pending[c.sourceKey].attemptRevision === c.rawRevisions[c.sourceKey]));
  await f.restartWithoutCache();
  await until(() => f.cliEvents().some(e => e.functionName === 'model-discovery' && (e.generation === '1' && e.event === 'invoked' || e.generation === '2' && e.event === 'catalog-response')), 'old catalog sees shutdown EOF or restarted catalog responds');
  await sleep(300); unchangedRestart(f, f.cacheEvidence('completed-restart'), 2);
});

test('cache-only restart: an unchanged activation baseline cannot acquire its first inference', { timeout: 90000 }, async t => {
  const f = await fixture(t);
  await until(() => f.cliEvents().some(e => e.generation === '1' && e.functionName === 'model-discovery' && e.event === 'spawn'), 'first startup catalog is actually launched');
  await f.post('/api/settings/background-ai', { memory: true, automaticMemory: 'changes-after-enable' });
  const before = f.safetySnapshot('baseline');
  assert.deepEqual(before.state.baseline, before.rawRevisions); assert.deepEqual(before.state.pending, {}); assert.equal(f.count(), 0);
  await f.restartWithoutCache();
  await until(() => f.cliEvents().some(e => e.functionName === 'model-discovery' && (e.generation === '1' && e.event === 'invoked' || e.generation === '2' && e.event === 'catalog-response')), 'old catalog sees shutdown EOF or restarted catalog responds');
  await sleep(300); unchangedRestart(f, f.cacheEvidence('baseline-restart'), 0);
});

test('future-only real server: revoked/re-enabled provider result, error no retry, corrupt state failclosed', { timeout: 90000 }, async t => {
  const f = await fixture(t);
  await f.post('/api/settings/background-ai', { memory: true, automaticMemory: 'changes-after-enable' });
  f.block(); f.change('old');
  await until(async () => (await f.settings()).automaticMemory.pending.length, 'changed pending'); f.advance();
  await until(() => f.count() === 1, 'provider entered');
  await f.post('/api/settings/background-ai', { automaticMemory: 'off' });
  await f.post('/api/settings/background-ai', { automaticMemory: 'changes-after-enable' });
  f.release(); await sleep(700);
  assert.equal(await f.leaf('old'), null, 'old epoch must not publish'); assert.equal(f.count(), 1);
  assert.ok((await f.settings()).automaticMemory.retired.some(p => p.status === 'interrupted'));
  f.fail(); f.change('old');
  await until(async () => (await f.settings()).automaticMemory.pending.some(p => p.status === 'pending'), 'fresh changed revision');
  // Re-enable was at the advanced time, so advance the clock again for its settle.
  f.setClock('1400000');
  await until(async () => (await f.settings()).automaticMemory.pending.some(p => p.status === 'error'), 'failed revision recorded');
  const calls = f.count(); await sleep(500); assert.equal(f.count(), calls, 'no automatic error replay');
  await f.post('/api/settings/memory-discard', { id: f.key('old') });
  f.corruptState(); f.change('old');
  await until(async () => !!(await f.settings()).automaticMemory.error, 'corrupt consent fails closed');
  await f.post('/api/settings/background-ai', { memory: true });
  await sleep(300); assert.equal(f.count(), calls); assert.equal(fs.readFileSync(f.state, 'utf8'), '{corrupt');
});

test('future-only real server refreshes existing documents; private source is never admitted into shared rollups', { timeout: 90000 }, async t => {
  const f = await fixture(t), project = await f.project();
  // Explicit manual work creates the bundle; enabling itself must not create one.
  const r = await f.request('http://127.0.0.1:' + (await f.settings()).port + '/api/memory/backfill', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project }) });
  assert.equal(r.status, 202, f.log());
  const built = await until(() => f.docs(project), 'manual project document bundle');
  const calls = f.count();
  await f.post('/api/settings/background-ai', { memory: true, automaticMemory: 'changes-after-enable' });
  await sleep(200); assert.equal(f.count(), calls, 'baseline makes no model calls even for built projects');
  // A second session remains private even though this install owner can read it.
  f.write('private');
  await until(async () => (await f.settings()).automaticMemory.observations[f.key('private')], 'private source indexed');
  const owner = (await f.settings()).me.id;
  await f.post('/api/access', { id: f.key('private'), mode: 'listed', listed: {}, owners: [owner] });
  f.abstract('Preserve user control and accountability.');
  f.change('private'); f.change('old');
  await until(async () => (await f.settings()).automaticMemory.pending.length === 2, 'changed shared and private sources');
  f.advance();
  await until(async () => !(await f.settings()).automaticMemory.pending.length, 'automatic leaf and document completion ' + f.log());
  const after = await f.docs(project);
  assert.ok(after.builtAt > built.builtAt);
  const automaticCalls = f.programs().slice(calls);
  assert.ok(automaticCalls.some(c => c.system.startsWith('Function: project_')), 'current FunctAI document programs executed');
  for (const c of automaticCalls.filter(c => c.system.startsWith('Function: project_'))) assert.equal(c.input.includes(f.key('private')), false, 'private transcript excluded from shared document evidence');
  assert.ok(await f.leaf('private'), 'owner may extract private memory, but it never flows into shared rollups');
});
