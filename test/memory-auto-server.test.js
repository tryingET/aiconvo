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
  const preload = path.join(home, 'clock.cjs');
  fs.writeFileSync(preload, `const fs = require('fs'); const real = Date.now;
Date.now = () => real() + Number(fs.readFileSync(${JSON.stringify(clock)}, 'utf8'));
const interval = global.setInterval; global.setInterval = (fn, ms, ...args) => interval(fn, [120000,20000].includes(ms) ? 60 : ms, ...args);\n`);
  const cli = path.join(home, 'fake-pi.cjs');
  fs.writeFileSync(cli, `const fs = require('fs');
const args = process.argv.slice(2), i = args.indexOf('--system-prompt');
const system = i < 0 ? '' : fs.readFileSync(args[i+1], 'utf8'), input = fs.readFileSync(0, 'utf8');
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({system,input}) + '\\n');
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
  let child;
  const diagnostics = require('./helpers/memory-fixture-diagnostics').createFixtureDiagnostics({ fetch,
    secrets: ['memory-fixture-token'], report: message => t.diagnostic(message) });
  const request = diagnostics.request;
  const log = () => JSON.stringify(diagnostics.snapshot(), null, 2);
  const io = (phase, fn) => { try { return fn(); } catch (e) { throw diagnostics.enhance(e, phase); } };
  const setClock = value => io('clock write', () => fs.writeFileSync(clock, String(value)));
  const start = async () => {
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
  return { home, work, state, key, post, settings, log, request, setClock,
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
      diagnostics.expectedExit(child);
      child.kill('SIGTERM'); await new Promise(r => child.once('close', r));
      io('restart cache removal', () => fs.rmSync(env.CHATTERING_CACHE_DIR, { recursive: true, force: true })); await start();
    },
  };
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
  await until(async () => !(await f.settings()).automaticMemory.pending.length, 'completed durable records');
  await f.restartWithoutCache(); await sleep(300); assert.equal(f.count(), 2, 'cache deletion cannot acquire consent');
  await f.post('/api/settings/background-ai', { automaticMemory: 'off' });
  f.change('import'); await sleep(500); assert.equal(f.count(), 2);
  const sessions = await (await f.request('http://127.0.0.1:' + (await f.settings()).port + '/api/sessions')).json();
  const project = sessions.find(s => s.key === f.key('old')).project;
  const r = await f.request('http://127.0.0.1:' + (await f.settings()).port + '/api/memory/backfill', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project }) });
  assert.equal(r.status, 202, JSON.stringify(await r.json()) + f.log());
  await until(async () => (await f.leaf('import'))?.abstract === 'Preserve user control.', 'manual backfill while automatic off');
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
