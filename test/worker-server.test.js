'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), crypto = require('node:crypto');
const { boot, until } = require('./worker-server-fixture.cjs');
const fixture = require('./fixtures/memory-fixture.cjs');
const sessionCachePath = (dir, key) => path.join(dir, key.replace(/[:\/\\]/g, '__') + '.json');
const key = 'pi:fixture/source.jsonl';
async function setup(t, hold = false, consent = false) {
  const requests = []; let release;
  const gate = hold ? new Promise(r => release = r) : Promise.resolve();
  t.after(() => release?.());
  const provider = http.createServer((req, res) => {
    let body = ''; req.on('data', b => body += b); req.on('end', async () => {
      const request = JSON.parse(body); requests.push(request);
      const system = request.messages.find(m => m.role === 'system')?.content || '';
      if (hold !== 'rollup' || /Function: project_/.test(system)) await gate;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      let text = '<note>PRIVATE_SOURCE_NOTE</note><abstract>Source image memory.</abstract><intent>[]</intent><environment>[]</environment><problems>[]</problems>';
      if (/Function: project_overview/.test(system)) text = '<overview>'+JSON.stringify({ summary:'Grounded project.',identity:'fixture',evolution:[],purpose:'fixture',vision:'fixture',desiredOutcomes:[],principles:[],nonGoals:[] })+'</overview><epicCandidates>[]</epicCandidates>';
      if (/Function: project_status/.test(system)) text = '<recentFocus>[]</recentFocus><unfinished>[]</unfinished><todos>[]</todos><openQuestions>[]</openQuestions>';
      if (/Function: project_environment/.test(system)) text = '<summary>Fixture environment.</summary><project>'+JSON.stringify(Object.fromEntries(['setup','commands','services','locations','tooling','authentication','cautions'].map(k=>[k,[]])))+'</project><machines>[]</machines>';
      if (/Function: project_intent/.test(system)) text = '<coreIntent>Fixture.</coreIntent><vision>Fixture.</vision><currentDirection>Fixture.</currentDirection>'+['whatMatters','desiredOutcomes','principles','constraints','tensions','nonGoals','evolution','openIntentQuestions'].map(k=>'<'+k+'>[]</'+k+'>').join('');
      res.end('data: ' + JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta: { content: text }, finish_reason: null }] }) + '\n\n' +
        'data: ' + JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 2 } }) + '\n\n' + 'data: [DONE]\n\n');
    });
  });
  await new Promise(r => provider.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => provider.close(r)));
  const s = await boot(t, {
    settings: { usePiDefault: false, provider: 'fake', model: 'fixture', contextTokens: 128000, memoryImages: true,
      anywhere: { off: true }, backgroundAi: { decidedAt: 'fixture', names: false, memory: consent } },
    setup({ agent, source, work, notes, config }) {
      const rows = fixture.transcript(); rows[0].cwd = work; fs.writeFileSync(source, fixture.jsonl(rows));
      fs.writeFileSync(path.join(agent, 'models.json'), JSON.stringify({ providers: { fake: {
        api: 'openai-completions', apiKey: 'synthetic-only', baseUrl: 'http://127.0.0.1:' + provider.address().port + '/v1',
        models: [{ id: 'fixture', input: ['text','image'], contextWindow: 128000, maxTokens: 8000, compat: { supportsStore: false } }] } } }));
      fs.writeFileSync(path.join(config, 'users.json'), JSON.stringify({ v: 1, users: [
        { id: 'owner', name: 'Owner', role: 'owner', credentials: [{ id: 'install', kind: 'install' }], groups: [] },
        ...['actor','outsider'].map(id => ({ id, name: id, role: 'member', groups: [], credentials: [{ id: id+'-device', kind: 'device', hash: crypto.createHash('sha256').update(id+'-token').digest('hex') }] })),
      ], groups: [], aliases: {} }));
      fs.writeFileSync(path.join(notes, 'access.json'), JSON.stringify({ v: 1, rules: {
        ['conversation:'+key]: { mode: 'listed', owners: ['owner'], listed: { 'user:actor': 'act' } },
      } }));
    },
  });
  return { ...s, requests, release };
}
async function start(s, token) {
  const out = await s.request('/api/distill/start?id=' + encodeURIComponent(key) + '&force=1', {}, 'POST', token || s.token);
  assert.equal(out.status, 202, JSON.stringify(out)+s.log()); return out.data.id;
}
const finished = (s, id) => until(async () => (await s.request('/api/jobs')).data.find(j => j.id === id && j.status !== 'running'));

async function follow(t, s, token) {
  const abort = new AbortController(), events = []; let buffer = '';
  const res = await fetch(s.base+'/api/events', { headers:{ Authorization:'Bearer '+token }, signal:abort.signal });
  const reader = res.body.getReader(), decode = new TextDecoder();
  const pump = (async () => { try { for (;;) { const {done,value}=await reader.read(); if(done) break;
    buffer += decode.decode(value,{stream:true}); let n;
    while((n=buffer.indexOf('\n\n'))>=0) { const frame=buffer.slice(0,n); buffer=buffer.slice(n+2); const data=frame.split('\n').find(l=>l.startsWith('data: ')); if(data) events.push(JSON.parse(data.slice(6))); }
  } } catch(e) { if(!abort.signal.aborted) throw e; } })();
  const close=async()=>{abort.abort();await pump;}; t.after(close);
  const hello=await until(()=>events.find(e=>e.type==='hello'));
  assert.equal((await s.request('/api/programs/live',{conn:hello.conn},'POST',token)).status,200);
  return {events,close};
}

test('real server opted note+leaf: exact source images, current title, private reads/logs/aliases and no user-agent calls', { timeout: 30000 }, async t => {
  const s = await setup(t), {events,close} = await follow(t,s,'outsider-token');
  const id = await start(s, 'actor-token'), job = await finished(s, id);
  assert.equal(job.status, 'done', JSON.stringify(job)+s.log()); assert.equal(s.requests.length, 1);
  const images = s.requests[0].messages.flatMap(m => Array.isArray(m.content) ? m.content.filter(c => c.type === 'image_url') : []);
  assert.equal(images.length, 4); assert.equal(images[0].image_url.url, 'data:image/png;base64,' + fixture.image().data);
  assert.equal(s.requests[0].tools, undefined);
  assert.equal(s.calls().filter(c => c.system).length, 0, 'no pi -p or title call');
  const leaf = await s.request('/api/memory/leaf?id=' + encodeURIComponent(key));
  assert.equal(leaf.data.leaf.v, 3); assert.equal(leaf.data.state, 'fresh'); assert.equal(leaf.data.leaf.imageCount, 4);
  const note = await s.request('/api/note?id=' + encodeURIComponent(key)); assert.match(note.data.text, /PRIVATE_SOURCE_NOTE/);
  const alias = path.join(s.work, 'alias.md'); fs.symlinkSync(note.data.notePath, alias);
  const leafAlias = path.join(s.work, 'leaf-alias.md'); fs.symlinkSync(sessionCachePath(path.join(s.cache,'memory-leaves'),key),leafAlias);
  for (const route of ['/api/memory/leaf?id='+encodeURIComponent(key), '/api/note?id='+encodeURIComponent(key),
    '/api/notefile?f='+encodeURIComponent(path.basename(note.data.notePath)), '/api/file/read?path='+encodeURIComponent(alias),
    '/api/file/read?path='+encodeURIComponent(leafAlias)]) {
    const denied = await s.request(route, undefined, 'GET', 'outsider-token'); assert.equal(denied.status, 403, route+JSON.stringify(denied));
    assert.doesNotMatch(JSON.stringify(denied), /PRIVATE_SOURCE_NOTE|Source image memory/);
    assert.equal((await s.request(route, undefined, 'GET', 'actor-token')).status, 200, route);
  }
  const runs = await until(async()=>{const out=await s.request('/api/programs/runs?name=memory_extract_4&module=chattering');return out.data.total===1&&out;},'cold call reaches real log index');
  const record = await s.request('/api/programs/run?id='+encodeURIComponent(runs.data.runs[0].id));
  assert.equal(record.data.record.caller.conversation, key); assert.equal(record.data.record.content, false);
  assert.equal((await s.request('/api/programs/run?id='+encodeURIComponent(runs.data.runs[0].id), undefined, 'GET', 'outsider-token')).status, 404);
  assert.equal((await s.request('/api/programs/runs?name=memory_extract_4&module=chattering', undefined, 'GET', 'outsider-token')).data.total, 0);
  const ledger = fs.readFileSync(path.join(s.cache, 'internal-usage.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(ledger.length, 1); assert.deepEqual(ledger[0].message.content, []);
  assert.equal(events.filter(e=>e.type==='program-live').flatMap(e=>e.ops||[]).some(o=>o.scope?.key===key),false);
  assert.doesNotMatch(JSON.stringify(events),/PRIVATE_SOURCE_NOTE/); await close();
});

for (const change of ['source', 'permission', 'model', 'opt-in']) test('real server rejects held cold result after '+change+' change, without correction/publication', { timeout: 30000 }, async t => {
  const s = await setup(t, true), id = await start(s, 'actor-token');
  await until(() => s.requests.length === 1);
  if (change === 'source') fs.appendFileSync(s.source, '\n');
  else if (change === 'permission') assert.equal((await s.request('/api/access', { id: key, mode: 'listed', owners: ['owner'], listed: {} }, 'PUT')).status, 200);
  else {
    const settings = (await s.request('/api/settings')).data.settings;
    const changed = await s.request('/api/settings', { ...settings, ...(change === 'model' ? { thinking: 'low' } : { memoryImages: false }) }, 'PUT');
    assert.equal(changed.status, 200, JSON.stringify(changed));
  }
  s.release(); const job = await finished(s, id); assert.equal(job.status, 'error', JSON.stringify(job)+s.log());
  assert.equal(s.requests.length, 1); assert.equal(fs.existsSync(sessionCachePath(path.join(s.cache,'memory-leaves'),key)), false);
  assert.equal(fs.readdirSync(s.notes).some(f => /^memory-.*\.md$/.test(f)), false);
});

test('real server read-only member denied before inference; invalid opt-in configuration is rejected; default remains false', { timeout: 30000 }, async t => {
  const s = await setup(t);
  assert.equal((await s.request('/api/distill/start?id='+encodeURIComponent(key), {}, 'POST', 'outsider-token')).status, 403);
  const current = (await s.request('/api/settings')).data.settings;
  assert.equal((await s.request('/api/settings', { ...current, usePiDefault: true, memoryImages: true }, 'PUT')).status, 400);
  assert.equal((await s.request('/api/settings', { ...current, memoryImages: 'yes' }, 'PUT')).status, 400);
  assert.equal(require('../settings').DEFAULT_SETTINGS.memoryImages, false);
  assert.deepEqual(s.requests, []);
});

async function publicSource(s) {
  assert.equal((await s.request('/api/access', {id:key,mode:'everyone',owners:['owner'],listed:{}},'PUT')).status,200);
  return (await s.request('/api/sessions')).data.find(e=>e.key===key).project;
}
test('real opted backfill and document lanes use cold transport, canonical source claims and no names', {timeout:30000}, async t=>{
  const s=await setup(t), project=await publicSource(s);
  const start=await s.request('/api/memory/backfill',{project}); assert.equal(start.status,202,JSON.stringify(start));
  const job=await finished(s,start.data.id); assert.equal(job.status,'done',JSON.stringify(job)+s.log());
  const docs=await until(async()=> (await s.request('/api/jobs')).data.find(j=>j.type==='memory-docs'&&j.finishedAt));
  assert.equal(docs.status,'done',JSON.stringify(docs)+s.log()); assert.deepEqual(docs.sessionIds,[key]);
  assert.equal(s.requests.length,5,'one leaf and the four document lanes'); assert.equal(s.calls().filter(c=>c.system).length,0);
  const doc=await s.request('/api/project/memory/file?name='+encodeURIComponent(project)+'&kind=overview',undefined,'GET','outsider-token');
  assert.equal(doc.status,200,JSON.stringify(doc)); assert.match(doc.data.text,/Grounded project/);
  const manifest=JSON.parse(fs.readFileSync(path.join(path.dirname(doc.data.path),'manifest.json'),'utf8'));
  assert.deepEqual(manifest.sourceKeys,[key]);
});
test('real held document lane refuses source eligibility narrowing even when actor retains act', {timeout:30000}, async t=>{
  const s=await setup(t,'rollup'); assert.equal((await finished(s,await start(s))).status,'done');
  const project=await publicSource(s), startDocs=await s.request('/api/project/memory/regenerate',{project});
  assert.equal(startDocs.status,202,JSON.stringify(startDocs)); await until(()=>s.requests.length===2);
  assert.equal((await s.request('/api/access',{id:key,mode:'listed',owners:['owner'],listed:{'user:actor':'act'}},'PUT')).status,200);
  s.release(); const job=await finished(s,startDocs.data.id); assert.equal(job.status,'error',JSON.stringify(job)+s.log());
  assert.equal(s.requests.length,2,'no correction or later lane after narrowing');
  assert.equal(fs.readdirSync(path.join(s.notes,'projects')).some(f=>fs.existsSync(path.join(s.notes,'projects',f,'overview.md'))),false);
});
