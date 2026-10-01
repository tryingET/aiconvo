'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const { spawn } = require('node:child_process');
const sessionCachePath = (dir, key) => path.join(dir, key.replace(/[:\/\\]/g, '__') + '.json');
const sleep = ms => new Promise(r => setTimeout(r, ms));
function sanitizeFixtureLog(value, secrets = []) {
  let text = String(value);
  for (const secret of secrets.filter(s => typeof s === 'string' && s.length)) text = text.split(secret).join('[redacted]');
  return text.replace(/(?:[a-z][a-z0-9+.-]*:\/\/)[^\s"'<>]+/gi, '[redacted-link]')
    .replace(/Bearer\s+[^\s"'<>]+/gi, 'Bearer [redacted]')
    .replace(/(["']?(?:apiKey|token|password|secret|authorization)["']?\s*[:=]\s*)(["'][^"']*["']|[^\s,;}]+)/gi, '$1[redacted]')
    .replace(/\b[\w-]*synthetic[\w-]*\b|\b[\w-]+-token\b/gi, '[redacted]');
}
async function until(fn, label = 'fixture condition', timeout = 12000) {
  for (let n = 0; n < Math.ceil(timeout / 40); n++) { const value = await fn(); if (value) return value; await sleep(40); }
  throw new Error('Timed out: ' + label);
}
async function port() { const s = net.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise(r => s.close(r)); return p; }
async function boot(t, options = {}) {
  // Expand Windows short temp names before the real server installs watchers.
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'local-integration-')));
  const home = path.join(root, 'home'), tmp = path.join(root, 'tmp'), work = path.join(root, 'project');
  const config = path.join(root, 'config'), cache = path.join(root, 'cache'), data = path.join(root, 'data'), notes = path.join(root, 'notes');
  const agent = path.join(home, '.pi/agent');
  for (const p of [home, tmp, work, config, cache, data, notes, path.join(agent, 'sessions/fixture')]) fs.mkdirSync(p, { recursive: true });
  const rel = options.rel || 'fixture/source.jsonl', key = 'pi:' + rel, source = path.join(agent, 'sessions', rel);
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, [
    { type: 'session', version: 3, id: 'fixture-session', cwd: work, timestamp: new Date().toISOString() },
    { type: 'message', id: 'u1', parentId: null, timestamp: new Date().toISOString(), message: { role: 'user', content: options.content || 'Keep fixture paths exact.' } },
  ].map(JSON.stringify).join('\n') + '\n');
  const settingsFile = path.join(config, 'settings.json');
  fs.writeFileSync(settingsFile, JSON.stringify({ settingsVersion: 3, welcome: { doneAt: 'fixture' }, backgroundAi: { decidedAt: 'fixture', names: false, memory: false }, ...options.settings }));
  const callsFile = path.join(root, 'cli-calls.jsonl'), answerFile = path.join(root, 'answer'), delayFile = path.join(root, 'delay');
  fs.writeFileSync(answerFile, '<label>Fixture</label><title>Fixture generated title</title>'); fs.writeFileSync(delayFile, '0');
  const cli = path.join(root, 'fake-pi.cjs');
  fs.writeFileSync(cli, `const fs=require('node:fs');const args=process.argv.slice(2);const at=args.indexOf('--system-prompt');const system=at<0?'':fs.readFileSync(args[at+1],'utf8');
fs.appendFileSync(${JSON.stringify(callsFile)},JSON.stringify({args,system})+'\\n');
if(args.includes('--list-models')) { process.stdout.write('provider        model           context   max-out   thinking   images\\nfake            fixture         128K      8K        no         yes\\n'); }
else if(args.includes('--version')) process.stdout.write('0.87.1\\n');
else if(at>=0) { fs.readFileSync(0,'utf8');setTimeout(()=>process.stdout.write(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:fs.readFileSync(${JSON.stringify(answerFile)},'utf8')}],stopReason:'stop',provider:'fake',model:'fixture',timestamp:Date.now(),usage:{input:2,output:2,totalTokens:4}}})+'\\n'),Number(fs.readFileSync(${JSON.stringify(delayFile)},'utf8'))); }
`);
  const p = await port(), previewPort = await port(), token = 'local-integration-synthetic-token';
  const env = {
    ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot, windir: process.env.windir } : {}),
    PATH: process.platform === 'win32' ? path.join(process.env.SystemRoot || process.env.windir, 'System32') : '/usr/bin:/bin',
    HOME: home, USERPROFILE: home, TMPDIR: tmp, TMP: tmp, TEMP: tmp,
    XDG_CONFIG_HOME: config, XDG_CACHE_HOME: cache, XDG_DATA_HOME: data, XDG_STATE_HOME: path.join(root, 'state'),
    PI_CODING_AGENT_DIR: agent, PI_AGENT_DIR: agent, PI_OFFLINE: '1',
    CHATTERING_CONFIG_DIR: config, CHATTERING_CACHE_DIR: cache, CHATTERING_DATA_DIR: data, CHATTERING_NOTES_DIR: notes,
    CHATTERING_DELEGATION_ROOT: path.join(data, 'delegations'), CHATTERING_CHECKPOINT_DIR: path.join(data, 'checkpoints'),
    CHATTERING_NO_CHECKPOINTS: '1', CHATTERING_NO_FILE_HISTORY: '1', CHATTERING_NO_LEDGER: '1',
    CHATTERING_CHECKPOINT_MAINTENANCE: '0', CHATTERING_NO_SYNC: '1', CHATTERING_DISABLE_NETWORK_RECOVERY: '1', CHATTERING_DISABLE_DELEGATION_CALLBACKS: '1',
    CHATTERING_HOST: '127.0.0.1', CHATTERING_TOKEN: token, PORT: String(p), CHATTERING_PREVIEW_PORT: String(previewPort),
    CHATTERING_PI_CLI: cli, CHATTERING_PI_PACKAGE_DIR: path.resolve(__dirname, '../runtime/node_modules/@earendil-works/pi-coding-agent'),
    FUNCTAI_LOG_CALLS: path.join(data, 'functai/calls'), ...(options.env || {}),
  };
  let child, log = '', stderr = '', jobs = [], requests = [];
  const secrets = new Set([token, ...Object.entries(env).filter(([key]) => /token|secret|password|api.?key/i.test(key)).map(([, value]) => value)]);
  const safe = value => sanitizeFixtureLog(value, [...secrets]);
  const states = new WeakMap();
  const diagnose = (label, error) => {
    const details = { label, pid: child?.pid, exitCode: child?.exitCode, signal: child?.signalCode,
      requests, jobs, error: error?.code || error?.cause?.code || error?.message,
      stderr: stderr.slice(-8192), log: log.slice(-4096) };
    process.stderr.write('[worker fixture] ' + JSON.stringify(details, (_key, value) => typeof value === 'string' ? safe(value) : value) + '\n');
  };
  const start = () => {
    child = spawn(process.execPath, ['server.js'], { cwd: path.resolve(__dirname, '..'), env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    const current = child, state = { closed: false, stopping: false }; states.set(current, state);
    current.stdout.on('data', b => log = (log + b).slice(-32768));
    current.stderr.on('data', b => { stderr = (stderr + b).slice(-16384); log = (log + b).slice(-32768); });
    current.once('error', e => diagnose('server spawn/IPC error', e));
    current.once('exit', () => { if (!state.stopping) diagnose('unexpected server exit'); });
    current.once('close', () => { state.closed = true; });
  };
  const stop = async () => {
    const current = child, state = current && states.get(current);
    if (!current || state.closed) return;
    state.stopping = true;
    let escalation, deadline;
    try {
      await new Promise((resolve, reject) => {
        const closed = () => { clearTimeout(escalation); clearTimeout(deadline); resolve(); };
        current.once('close', closed);
        const kill = signal => { if (current.exitCode === null && current.signalCode === null) current.kill(signal); };
        kill('SIGTERM'); escalation = setTimeout(() => kill('SIGKILL'), 3000);
        deadline = setTimeout(() => { current.off('close', closed); reject(new Error('Fixture server close deadline; state retained')); }, 6000);
      });
    } catch (e) { diagnose('server cleanup failed', e); throw e; }
    finally { clearTimeout(escalation); clearTimeout(deadline); }
  };
  t.after(async () => {
    await stop();
    try { await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
    catch (e) { diagnose('fixture directory cleanup failed', e); throw e; }
  });
  const base = 'http://127.0.0.1:' + p;
  const request = async (route, body, method = body === undefined ? 'GET' : 'POST', credential = token, quiet = false, timeoutMs = 10000) => {
    secrets.add(credential);
    const pathname = new URL(route, base).pathname;
    requests = [...requests, { method, route: pathname }].slice(-12); // no query/credentials/bodies
    try {
      const response = await fetch(base + route, { method, signal: AbortSignal.timeout(timeoutMs), headers: { Authorization: 'Bearer ' + credential, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const text = await response.text(); let result; try { result = JSON.parse(text); } catch { result = text; }
      if (pathname === '/api/jobs' && Array.isArray(result)) jobs = result.slice(0, 20).map(({ id, type, status, error }) => ({ id, type, status, error }));
      return { status: response.status, data: result };
    } catch (e) { if (!quiet) diagnose(method + ' ' + pathname, e); throw e; }
  };
  const ready = async () => {
    const deadline = Date.now() + 12000;
    try {
      while (Date.now() < deadline) {
        if (child.exitCode !== null || child.signalCode !== null || states.get(child).closed) throw new Error('Server exited before scan');
        try {
          const out = await request('/api/sessions', undefined, 'GET', token, true, Math.max(1, Math.min(1500, deadline - Date.now())));
          if (Array.isArray(out.data) && out.data.some(e => e.key === key)) return;
        } catch {}
        await sleep(40);
      }
      throw new Error('Fixture server scan deadline');
    } catch (e) { diagnose('server readiness failed', e); throw e; }
  };
  const calls = () => { try { return fs.readFileSync(callsFile, 'utf8').trim().split('\n').map(JSON.parse); } catch { return []; } };
  if (options.setup) await options.setup({ root, home, agent, work, notes, cache, config, env, source });
  start(); await ready();
  return { root, home, tmp, work, notes, config, cache, agent, source, key, settingsFile, answerFile, delayFile, env, base, token, previewPort, request, calls,
    cachePath: sessionCachePath(path.join(cache, 'sessions'), key), log: () => safe(log), diagnose, stop,
    listeners: () => {
      const sockets = new Set(fs.readdirSync('/proc/' + child.pid + '/fd').map(fd => { try { return fs.readlinkSync('/proc/' + child.pid + '/fd/' + fd).match(/^socket:\[(\d+)\]$/)?.[1]; } catch { return null; } }));
      return ['tcp', 'tcp6'].flatMap(table => fs.readFileSync('/proc/net/' + table, 'utf8').trim().split('\n').slice(1).flatMap(line => {
        const columns = line.trim().split(/\s+/); if (columns[3] !== '0A' || !sockets.has(columns[9])) return [];
        const [address, port] = columns[1].split(':'); return [{ address, port: parseInt(port, 16) }];
      }));
    },
    probe: packet => new Promise((resolve, reject) => {
      const current = child, id = Math.random();
      const cleanup = () => { clearTimeout(timeout); current.off('message', receive); current.off('close', closed); };
      const fail = error => { cleanup(); diagnose('fixture probe failed', error); reject(error); };
      const timeout = setTimeout(() => fail(new Error('Fixture probe timed out')), 3000);
      const closed = () => fail(new Error('Server closed during fixture probe'));
      const receive = reply => { if (reply.id !== id) return; cleanup(); resolve(reply.value); };
      current.on('message', receive); current.once('close', closed);
      if (!current.connected) fail(new Error('Fixture IPC disconnected'));
      else current.send({ ...packet, id }, error => { if (error) fail(error); });
    }),
    restart: async () => { await stop(); start(); await ready(); } };
}
module.exports = { boot, until, sleep, port, sanitizeFixtureLog };
