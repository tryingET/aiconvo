'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');
const { createMemoryAdmission } = require('../memory-admission');
const { createMemoryFeature } = require('../memory-feature');
const { setup } = require('./fixtures/memory-test-setup.cjs');

test('canonical memory admissions retain original claims and generation, never relabel held bytes after rebuild', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-admission-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const notesDir = path.join(root, 'notes'), cacheDir = path.join(root, 'cache'), dir = path.join(notesDir,'projects','p');
  fs.mkdirSync(dir,{ recursive:true }); fs.mkdirSync(cacheDir);
  const file = path.join(dir,'overview.md'), manifest = path.join(dir,'manifest.json'), alias = path.join(root,'alias.md');
  fs.writeFileSync(file,'private'); fs.writeFileSync(manifest,JSON.stringify({ sourceKeys:['private'] })); fs.symlinkSync(file,alias);
  let allowed = true, seen = [];
  const admission = createMemoryAdmission({ notesDir, cacheDir, entries: () => ({ private:{}, public:{} }), files: () => [], privileged: () => false,
    authorize: key => { seen.push(key); if(key === 'private' && !allowed) throw new Error('revoked'); } });
  const check = admission.admit(alias); assert.deepEqual(seen,['private']);
  allowed = false; assert.throws(check,/revoked/);
  fs.writeFileSync(manifest,JSON.stringify({ sourceKeys:['public'] })); assert.throws(check,/generation/);
  assert.doesNotThrow(admission.admit(alias));
  fs.unlinkSync(alias); fs.symlinkSync(path.join(cacheDir,'orphan.json'),alias); assert.throws(check,/alias/);
  assert.throws(() => admission.admit(path.join(cacheDir,'orphan.json')),/claims/);
  fs.writeFileSync(manifest,JSON.stringify({ sourceKeys:['missing'] })); assert.throws(() => admission.admit(file),/unavailable/);
});

test('feature binds the original principal across publication contexts and rechecks live permission', async t => {
  const s = setup(t), context = new AsyncLocalStorage(); let allowed = true;
  const feature = createMemoryFeature({ programs: s.programs, settings: () => s.settings, transport: s.transport, sourceFile: () => s.file,
    projectOf: () => 'fixture', authorize({key}) { assert.equal(key,'pi:source'); assert.equal(context.getStore(),'original'); if(!allowed) throw new Error('revoked'); } });
  const built = await context.run('original', () => feature.build(s.data()));
  context.run('other', () => built.guard()); allowed=false;
  context.run('other', () => assert.throws(built.guard,/revoked/));
  assert.throws(() => createMemoryFeature({}),/permission guard/);
});

test('missing exact model and invalid extension/config/context inputs are not admitted', () => {
  const { memoryConfig, MIN_CONTEXT_TOKENS } = require('../memory-config');
  const base = { provider:'synthetic', model:'synthetic' };
  assert.throws(() => memoryConfig({...base,usePiDefault:true}),/exact/);
  assert.throws(() => memoryConfig({...base,contextTokens:MIN_CONTEXT_TOKENS-1}),/budget/);
  assert.throws(() => memoryConfig({...base,providerExtensions:{synthetic:['relative.ts']}}),/absolute/);
  assert.throws(() => memoryConfig({...base,memoryImages:'true'}),/memoryImages/);
  assert.equal(memoryConfig(base).memoryImages,false);
});
test('denied and asynchronous parent guards fail before cold provider invocation', async t=>{
  for(const authorize of [()=>false,async()=>true]) {
    const s=setup(t), feature=createMemoryFeature({programs:s.programs,settings:()=>s.settings,transport:s.transport,sourceFile:()=>s.file,projectOf:()=> 'fixture',authorize});
    await assert.rejects(feature.build(s.data()),/permission denied|asynchronous/); assert.deepEqual(s.captures(),[]);
  }
});
test('multi-source live events and opted job metadata require every source',()=>{
  const {scopeOf}=require('../programs-live'),{eventView}=require('../policy');
  const can={member:true,key:k=>k==='public',project:()=>true,path:()=>true};
  const scope=scopeOf({conversations:['public','private']});
  assert.equal(eventView({type:'program-live',ops:[{op:'text',scope,text:'private'}]},can),null);
  assert.equal(eventView({type:'job',job:{memoryScope:true,sessionIds:['public','private']}},can),null);
});
