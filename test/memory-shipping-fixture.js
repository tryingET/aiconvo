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
async function fixture(t, options = {}) {
  // Run only in the common harness's synthetic HOME; /tmp is deliberately loose.
  const root = path.join(os.homedir(), '.cache', 'chattering-shipping-test-homes');
  fs.mkdirSync(root, { recursive: true });
  const home = fs.realpathSync(fs.mkdtempSync(path.join(root, 'memory-auto-server-')));
  const agent = path.join(home, '.pi', 'agent'), sessions = path.join(agent, 'sessions', 'fixture');
  const work = path.join(home, 'Projects', 'fixture'); fs.mkdirSync(work, { recursive: true }); fs.mkdirSync(sessions, { recursive: true });
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
  const fault = path.join(home, 'write-fault'), settingsFile = path.join(home, '.config', 'chattering', 'settings.json');
  if (options.memory) {
    const saved = JSON.parse(fs.readFileSync(settingsFile));
    saved.backgroundAi.memory = true; fs.writeFileSync(settingsFile, JSON.stringify(saved));
  }
  const preload = path.join(home, 'clock.cjs');
  fs.writeFileSync(preload, `const fs = require('fs'); const real = Date.now;
Date.now = () => real() + Number(fs.readFileSync(${JSON.stringify(clock)}, 'utf8'));
const interval = global.setInterval; global.setInterval = (fn, ms, ...args) => interval(${options.manualObservation ? "ms === 20000 ? () => {} : fn" : 'fn'}, [120000,20000].includes(ms) ? 60 : ms, ...args);
const readFault = () => fs.existsSync(${JSON.stringify(fault)}) ? fs.readFileSync(${JSON.stringify(fault)}, 'utf8') : '';
const consent = ${JSON.stringify(path.join(home, '.config', 'chattering', 'memory-automation.json'))}, settings = ${JSON.stringify(settingsFile)};
const open = fs.openSync; fs.openSync = (file, ...args) => { if (String(file).startsWith(consent + '.') && readFault() === 'before-consent') process.exit(71); return open(file, ...args); };
const rename = fs.renameSync; fs.renameSync = (from, to) => { const result = rename(from, to); if (to === consent && readFault() === 'after-consent') process.exit(72); return result; };
const write = fs.writeFileSync; fs.writeFileSync = (file, ...args) => {
  if (file === settings && readFault() === 'settings-failure') throw new Error('synthetic settings write failure');
  const result = write(file, ...args);
  if (file === settings && readFault() === 'after-settings') process.exit(73);
  return result;
};
${options.manualObservation ? `const watch = fs.watch; fs.watch = (dir, ...args) => { if (String(dir).startsWith(${JSON.stringify(sessions)}) || String(dir).startsWith(${JSON.stringify(path.join(home, 'mirrors', 'sessions'))})) { const e = new (require('events').EventEmitter)(); e.close = () => {}; return e; } return watch(dir, ...args); };` : ''}
`);
  const cli = path.join(home, 'fake-pi.cjs');
  fs.writeFileSync(cli, `const fs = require('fs');
const args = process.argv.slice(2), i = args.indexOf('--system-prompt');
const system = i < 0 ? '' : fs.readFileSync(args[i+1], 'utf8'), input = fs.readFileSync(0, 'utf8');
if (!system.startsWith('Function: ')) process.exit(0); // model discovery is not inference
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({system,input}) + '\\n');
(async () => {
while (fs.existsSync(${JSON.stringify(block)}) && (!fs.readFileSync(${JSON.stringify(block)}, 'utf8') || system.startsWith('Function: '+fs.readFileSync(${JSON.stringify(block)}, 'utf8'))) && !fs.existsSync(${JSON.stringify(release)})) await new Promise(r => setTimeout(r, 30));
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
    CHATTERING_MIRROR_DIR: path.join(home, 'mirrors', 'sessions'), CHATTERING_NO_SYNC: '1', CHATTERING_CACHE_DIR: path.join(home, '.cache', 'chattering'), CHATTERING_CHECKPOINT_DIR: path.join(home, 'checkpoints'), CHATTERING_DELEGATION_ROOT: path.join(home, 'delegations') };
  let child, log = '';
  const start = async () => {
    child = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', b => log += b); child.stderr.on('data', b => log += b);
    await until(async () => { try { return (await (await fetch(base + '/api/sessions')).json()).some(x => x.key === key('old')); } catch { return false; } }, 'server start ' + log);
  };
  const base = 'http://127.0.0.1:' + port, key = id => 'pi:fixture/' + id + '.jsonl';
  const post = async (route, body) => {
    const r = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const out = await r.json(); assert.equal(r.status, 200, JSON.stringify(out) + log); return out;
  };
  const settings = async () => (await (await fetch(base + '/api/settings')).json());
  const count = () => fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').length : 0;
  const state = path.join(home, '.config', 'chattering', 'memory-automation.json');
  t.after(() => require('./helpers/cleanup').stopAndRemove(child, home));
  await options.prepare?.({ home, work, cache: env.CHATTERING_CACHE_DIR, notes: path.join(home, 'notes', 'chattering'), mirror: env.CHATTERING_MIRROR_DIR, key });
  await start();
  return { home, work, state, write, key, post, settings, count, log: () => log,
    async request(route, body) { const r = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, out: await r.json() }; },
    armFault: kind => fs.writeFileSync(fault, kind),
    async restart() { await require('./helpers/cleanup').stopAndRemove(child, null); await start(); },
    async project() { return (await (await fetch(base + '/api/sessions')).json()).find(s => s.key === key('old')).project; },
    async docs(project) { const r = await fetch(base + '/api/project/memory?name=' + encodeURIComponent(project)); return r.status === 200 ? r.json() : null; },
    programs: () => fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse) : [],
    advance: () => fs.writeFileSync(clock, String(Number(fs.readFileSync(clock, 'utf8')) + 700000)),
    abstract: text => fs.writeFileSync(abstract, text),
    change: id => fs.appendFileSync(session(id), ' \n'),
    addTurn: () => fs.appendFileSync(session('old'), JSON.stringify({ type: 'message', id: 'u-' + Date.now(), parentId: 'u1', timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'text', text: 'New revision ' + Date.now() }] } }) + '\n'),
    block: (program = '') => { fs.rmSync(release, { force: true }); fs.writeFileSync(block, program); }, release: () => fs.writeFileSync(release, ''), fail: () => fs.writeFileSync(fail, ''),
    async leaf(id) { return (await (await fetch(base + '/api/memory/leaf?id=' + encodeURIComponent(key(id)))).json()).leaf; },
    async restartWithoutCache() {
      child.kill('SIGTERM'); await new Promise(r => child.once('close', r));
      fs.rmSync(env.CHATTERING_CACHE_DIR, { recursive: true, force: true }); await start();
    },
  };
}

module.exports = { fixture, until, sleep };
