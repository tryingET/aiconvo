'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { boot, until } = require('./worker-server-fixture.cjs');
const { setup } = require('./fixtures/memory-test-setup.cjs');
const { createMultimodalMemory } = require('../multimodal-memory');
const processes = require('../processes');
const CANARY = 'PRIVATE_SOURCE_NOTE', key = 'pi:fixture/source.jsonl';
async function serverFixture(t, held = false) {
  let release; const gate = held ? new Promise(r => release = r) : Promise.resolve(), requests = [], semanticHits = [];
  const provider = http.createServer((req,res) => {
    let body=''; req.on('data',b=>body+=b); req.on('end',async()=>{
      if(req.url==='/search') { res.setHeader('content-type','application/json'); return res.end(JSON.stringify({hits:semanticHits})); }
      if(!req.url.startsWith('/v1/')) { res.setHeader('content-type','application/json'); return res.end('{}'); }
      requests.push(JSON.parse(body)); await gate;
      res.writeHead(200,{'content-type':'text/event-stream'});
      const text='<note>'+CANARY+'</note><abstract>Private source abstract.</abstract><intent>[]</intent><environment>[]</environment><problems>[]</problems>';
      res.end('data: '+JSON.stringify({id:'synthetic',choices:[{index:0,delta:{content:text},finish_reason:null}]})+'\n\n'+
        'data: '+JSON.stringify({id:'synthetic',choices:[{index:0,delta:{},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise(r=>provider.listen(0,'127.0.0.1',r));
  const url='http://127.0.0.1:'+provider.address().port;
  const s=await boot(t,{settings:{usePiDefault:false,provider:'fake',model:'fixture',memoryImages:true,contextTokens:128000,
    anywhere:{off:true},semanticSearch:true,semanticUrl:url},env:held?{NODE_OPTIONS:'--require='+path.resolve(__dirname,'fixtures/distill-listener-probe.cjs')}:{},setup({agent,config,notes}){
    fs.writeFileSync(path.join(agent,'models.json'),JSON.stringify({providers:{fake:{api:'openai-completions',apiKey:'synthetic-only',baseUrl:url+'/v1',
      models:[{id:'fixture',input:['text','image'],contextWindow:128000,maxTokens:8000,compat:{supportsStore:false}}]}}}));
    fs.writeFileSync(path.join(config,'users.json'),JSON.stringify({v:1,groups:[],aliases:{},users:[
      {id:'owner',name:'Owner',role:'owner',groups:[],credentials:[{id:'install',kind:'install'}]},
      ...['reader','outsider'].map(id=>({id,name:id,role:'member',groups:[],credentials:[{id:id+'-device',kind:'device',hash:crypto.createHash('sha256').update(id+'-token').digest('hex')}]})),
    ]}));
    fs.writeFileSync(path.join(notes,'access.json'),JSON.stringify({v:1,rules:{['conversation:'+key]:{mode:'listed',owners:['owner'],listed:{'user:reader':'see'}}}}));
  }});
  const close=async()=>{release?.();await s.stop();await new Promise(r=>provider.close(r));};t.after(close);
  return {...s,release,requests,semanticHits,close};
}
async function start(s) {
  const result=await s.request('/api/distill/start?id='+encodeURIComponent(key)+'&force=1',{});assert.equal(result.status,202,JSON.stringify(result));return result.data.id;
}
const done=(s,id)=>until(async()=>(await s.request('/api/jobs')).data.find(j=>j.id===id&&j.finishedAt));

// Windows composition: server scan 12s + cold-call deadline 120s + owned
// OS cleanup 30s + claim persistence 12s + restart close/scan 6s/12s +
// markdown readiness 12s + API assertions 30s + final close 6s = 240s.
// Native transport alone took 3–27s; 30s for this entire chain is not a bound.
// Other shipping tests and the already-passing POSIX search budget stay put.
const searchTimeout = process.platform === 'win32' ? 12000 + 120000 + 30000 + 12000 + 6000 + 12000 + 12000 + 30000 + 6000 : 30000;
test('shipping search: cold note after restart and old/ambiguous derived markdown require live source admission in lexical and semantic hits',{timeout:searchTimeout},async t=>{
  const s=await serverFixture(t);assert.equal((await done(s,await start(s))).status,'done');
  const note=(await s.request('/api/note?id='+encodeURIComponent(key))).data.notePath;
  fs.writeFileSync(path.join(s.notes,'old-derived.md'),'# '+CANARY+' old derived\n\n'+CANARY);
  const dir=path.join(s.notes,'projects','historical');fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,'overview.md'),'# '+CANARY+' historical\n\n'+CANARY);
  fs.writeFileSync(path.join(dir,'manifest.json'),JSON.stringify({sourceKeys:[key]}));
  fs.symlinkSync(note,path.join(s.notes,'alias.md'));
  await until(()=>{try{return JSON.parse(fs.readFileSync(path.join(s.cache,'index.json'),'utf8'))[key]?.notePath===note;}catch{return false;}},'source note claim persisted before restart');
  await s.restart();
  const query='/api/search?q='+CANARY;
  // The lexical scanner indexes regular markdown, not symlinks; the alias is
  // exercised below as a semantic hit against the same live source admission.
  // walk() -> putMarkdown() -> search() preserves native path.relative(),
  // unlike web/GPU fixture metadata, which also exercises forward slashes.
  const historicalFile = path.join('projects', 'historical', 'overview.md');
  const indexedFiles = [path.basename(note), 'old-derived.md', historicalFile];
  await until(async()=> {
    const groups = (await s.request(query)).data.groups;
    return indexedFiles.every(file => groups.some(g => g.file === file));
  }, 'all fixture markdown indexed after restart');
  assert.equal((await s.request('/api/note?id='+encodeURIComponent(key),undefined,'GET','outsider-token')).status,403);
  const lexical=await s.request(query,undefined,'GET','outsider-token');assert.equal(lexical.status,200);
  assert.doesNotMatch(JSON.stringify(lexical.data.groups),new RegExp(CANARY));
  assert.deepEqual(lexical.data.groups,[]);assert.equal(lexical.data.total,0);
  const allowed=await s.request(query,undefined,'GET','reader-token');
  assert.ok(allowed.data.groups.some(g=>g.file===path.basename(note)));assert.ok(allowed.data.groups.some(g=>g.file===historicalFile));
  assert.equal(allowed.data.groups.some(g=>g.file==='old-derived.md'),false,'ambiguous old source is not public');
  for(const file of new Set([path.basename(note),'old-derived.md',historicalFile,'projects/historical/overview.md','alias.md','../outside.md']))
    s.semanticHits.push({score:1,meta:{kind:'note',file,title:CANARY,snip:CANARY}});
  // A permitted first hit must not lend its admission to a later denied file
  // with the same group key: authorize raw hits before merging snippets.
  const deniedSemantic = 'DENIED_SEMANTIC_METADATA';
  s.semanticHits.unshift({score:1,meta:{key,kind:'message',snip:'Allowed source snippet'}});
  s.semanticHits.push({score:1,meta:{key,file:'old-derived.md',title:deniedSemantic,snip:deniedSemantic}});
  const semantic='/api/search/semantic?q=canary';
  assert.deepEqual((await s.request(semantic,undefined,'GET','outsider-token')).data.groups,[]);
  const visible=(await s.request(semantic,undefined,'GET','reader-token')).data.groups;
  assert.ok(visible.some(g=>g.file===path.basename(note)));assert.equal(visible.some(g=>g.file==='old-derived.md'),false);
  for(const file of new Set([historicalFile,'projects/historical/overview.md'])) assert.ok(visible.some(g=>g.file===file),'admitted semantic historical source: '+file);
  assert.doesNotMatch(JSON.stringify(visible),new RegExp(deniedSemantic),'a permitted group cannot launder a denied semantic hit');
  await s.request('/api/access',{id:key,mode:'listed',owners:['owner'],listed:{}},'PUT');
  assert.deepEqual((await s.request(query,undefined,'GET','reader-token')).data.groups,[]);
  assert.deepEqual((await s.request(semantic,undefined,'GET','reader-token')).data.groups,[]);
  await s.close();
});

test('shipping distill stream: read grant and credential revocation deny every live push and replay while owner job remains valid',{timeout:30000},async t=>{
  for(const withdrawal of ['grant','credential']) {
    const s=await serverFixture(t,true),id=await start(s);await until(()=>s.requests.length===1);
    const abort=new AbortController();const route='/api/distill-stream?id='+encodeURIComponent(key);
    const reading=fetch(s.base+route,{headers:{Authorization:'Bearer reader-token'},signal:abort.signal})
      .then(async res=>{assert.equal(res.status,200);return res.text();})
      .catch(e=>{if(!abort.signal.aborted)s.diagnose('distill stream connect/read failed',e);throw e;});
    reading.catch(()=>{});t.after(()=>abort.abort());
    await until(async()=>await s.probe({operation:'test-distill-listeners',key})===1,'real authorized subscriber installed');
    if(withdrawal==='grant') assert.equal((await s.request('/api/access',{id:key,mode:'listed',owners:['owner'],listed:{}},'PUT')).status,200);
    else assert.equal((await s.request('/api/users/revoke',{id:'reader',credentialId:'reader-device'})).status,200);
    s.release();assert.equal((await done(s,id)).status,'done','owner worker is still authorized');
    const text=await reading;assert.doesNotMatch(text,new RegExp(CANARY));
    assert.equal(await s.probe({operation:'test-distill-listeners',key}),0,'subscriber detached');
    const replay=await s.request(route,undefined,'GET','reader-token');assert.notEqual(replay.status,200);assert.doesNotMatch(JSON.stringify(replay.data),new RegExp(CANARY));
    await s.close();
  }
});

test('shipping cleanup: captured detached provider descendants exit on completion/cancel; unrelated process survives',{timeout:30000},async t=>{
  const outside=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});
  const outsideId=await until(()=>processes.identity(outside.pid));
  t.after(async()=>{const exit=new Promise(r=>outside.once('exit',r));if(outside.exitCode===null){outside.kill('SIGKILL');await exit;}});
  const findings=[];
  for(const cancel of [false,true]) {
    const s=setup(t,{MEMORY_FIXTURE_CHILD:'1',MEMORY_FIXTURE_DETACHED:'1',MEMORY_FIXTURE_WAIT:cancel?'30000':'100'});
    const abort=new AbortController(),builder=createMultimodalMemory({programs:s.programs,settings:()=>s.settings,transport:s.transport,projectOf:()=> 'fixture',check(){}});
    const pending=builder.build(s.data(),s.file,{signal:abort.signal});pending.catch(()=>{});await s.waitForCapture();
    const capture=s.captures()[0],owned=processes.identity(capture.childPid);assert.ok(owned);
    // Windows has no POSIX PGID; its captured identity must still be cleaned.
    if(process.platform !== 'win32') assert.equal(owned.pgrp,owned.pid,'provider descendant really leads a separate group');
    if(cancel){abort.abort();await assert.rejects(pending,e=>e.code==='ABORTED');}else await pending;
    findings.push({cancel,alive:processes.identity(owned.pid),tempExists:fs.existsSync(capture.cwd)});
    // Red teardown owns this exact fixture identity only; never kill a reused pid.
    const current=processes.identity(owned.pid);if(current&&current.start===owned.start&&current.boot===owned.boot) process.kill(owned.pid,'SIGKILL');
    assert.deepEqual(processes.identity(outside.pid),outsideId,'no unrelated process killed');
  }
  assert.ok(findings.every(f=>f.alive===null),JSON.stringify(findings));assert.ok(findings.every(f=>!f.tempExists));
  // This injection depends on Linux identity-read ordering and a /proc cwd
  // absence proof before deleting retained credentials. Windows cannot provide
  // that proof via cwd(); do not interpret its null as absence. Native detached
  // completion/cancel and all assertions above still run on every platform.
  await t.test('unreadable captured identity rejects and retains state with Linux proc exit proof', {
    skip: process.platform !== 'linux' ? 'Fault-read ordering and inactive-cwd proof require Linux /proc; native completion/cancel remain enabled' : false,
  }, async t => {
  const s=setup(t,{MEMORY_FIXTURE_CHILD:'1',MEMORY_FIXTURE_DETACHED:'1',MEMORY_FIXTURE_WAIT:'200'});
  const pending=require('../internal-model').runInternalModel({messages:[{role:'user',content:'synthetic',timestamp:0}]},{...s.transport(),settings:s.settings,check(){}});
  pending.catch(()=>{});await s.waitForCapture();const capture=s.captures()[0],id=processes.identity(capture.childPid),original=processes.identity;
  let reads=0,retained;
  processes.identity=pid=>{if(pid===id.pid&&++reads>1)throw new Error('Synthetic identity unreadable');return original(pid);};
  try {await assert.rejects(pending,e=>{retained=e.temporaryDirectory;return e.retainTemporaryState===true;});assert.equal(fs.existsSync(capture.cwd),true);}
  finally {
    processes.identity=original;const current=original(id.pid);if(current&&current.start===id.start&&current.boot===id.boot)process.kill(id.pid,'SIGKILL');
    await until(()=>{const current=original(id.pid);return !current||current.start!==id.start||current.boot!==id.boot;},'owned captured fixture identity exits');
    await until(()=>!processes.list().some(p=>processes.cwd(p.pid)===capture.cwd),'owned retained fixture processes exit');
    if(retained)fs.rmSync(retained,{recursive:true,force:true});
  }
  });
  assert.deepEqual(processes.identity(outside.pid),outsideId);
});
