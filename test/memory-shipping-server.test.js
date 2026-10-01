'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture, until, sleep } = require('./memory-shipping-fixture');

for (const boundary of ['before-consent', 'after-consent', 'after-settings', 'settings-failure']) {
  test(`activation write boundary ${boundary}: real restart cannot turn durable future consent into legacy inference`, { timeout: 90000 }, async t => {
    const f = await fixture(t, { memory: true });
    assert.equal(f.count(), 0); f.armFault(boundary);
    const result = await f.request('/api/settings/background-ai', { automaticMemory: 'changes-after-enable' }).catch(() => null);
    f.armFault('');
    if (boundary === 'settings-failure') {
      assert.ok(result && result.status >= 400);
      const current = await f.settings();
      assert.equal(current.settings.automaticMemory, 'legacy', 'failed settings save restores old configuration, not old durable intent');
      assert.match(current.automaticMemory.error, /disagree|mismatch/);
      // A general save of restored settings must not silently restore legacy permission.
      await f.post('/api/settings', { ...current.settings, quietMinutes: 0 });
      f.addTurn(); await f.post('/api/rescan', {}); f.advance(); await sleep(600);
      assert.equal(f.count(), 0, 'settings failure must block before scheduling/provider invocation');
    }
    if (boundary === 'before-consent') assert.equal(fs.existsSync(f.state), false);
    else assert.equal(JSON.parse(fs.readFileSync(f.state)).mode, 'changes-after-enable');
    await f.restart();
    const restarted = await f.settings();
    if (boundary === 'after-consent' || boundary === 'settings-failure') {
      assert.equal(restarted.settings.automaticMemory, 'legacy');
      assert.match(restarted.automaticMemory.error, /disagree|mismatch/);
      f.addTurn(); await f.post('/api/rescan', {}); f.advance(); await sleep(700);
      assert.equal(f.count(), 0, 'durable/configured mismatch must not infer via old legacy queues');
    } else if (boundary === 'after-settings') {
      assert.equal(restarted.settings.automaticMemory, 'changes-after-enable');
      f.advance(); await sleep(300); assert.equal(f.count(), 0, 'committed activation remains baseline-only on restart: ' + JSON.stringify(f.programs()));
      f.addTurn(); await f.post('/api/rescan', {}); f.advance();
      await until(() => f.count() === 1, 'new committed future revision inferred');
    } else {
      assert.equal(restarted.settings.automaticMemory, 'legacy');
      assert.equal(restarted.automaticMemory.error, null);
      f.addTurn(); await f.post('/api/rescan', {}); f.advance();
      await until(() => f.count() === 1, 'never-enabled legacy remains operational');
    }
  });
}

for (const order of ['failure-before-observation', 'observation-before-failure']) {
  test(`${order}: real source drift after leaf publication latches stages across observations/restart`, { timeout: 90000 }, async t => {
    const f = await fixture(t, { manualObservation: true }), project = await f.project();
    const built = await f.request('/api/memory/backfill', { project }); assert.equal(built.status, 202);
    await until(() => f.docs(project), 'manual memory documents');
    await f.post('/api/settings/background-ai', { memory: true, automaticMemory: 'changes-after-enable' });
    f.abstract('Changed public abstract.'); f.block('project_overview');
    f.change('old'); await f.post('/api/rescan', {}); f.advance();
    await until(async () => (await f.settings()).automaticMemory.pending.some(p => p.completed.includes('leaf')) && f.programs().some(c => c.system.startsWith('Function: project_overview') && c.input.includes('Changed public abstract.')), 'provider work after published leaf');
    const attemptedRevision = (await f.settings()).automaticMemory.pending[0].revision;
    f.change('old');
    if (order === 'observation-before-failure') await f.post('/api/rescan', {});
    f.release();
    await until(async () => (await f.settings()).automaticMemory.pending.some(p => p.status === (order === 'failure-before-observation' ? 'error' : 'interrupted')), 'indeterminate outcome latched');
    await f.post('/api/rescan', {});
    const calls = f.count();
    for (let i = 0; i < 2; i++) {
      f.change('old'); await f.post('/api/rescan', {}); f.advance();
      const rec = (await f.settings()).automaticMemory.pending[0];
      assert.equal(rec.status, order === 'failure-before-observation' ? 'error' : 'interrupted');
      assert.deepEqual(rec.completed, ['leaf']);
      assert.equal(rec.attemptRevision, attemptedRevision);
      assert.ok(rec.error); await sleep(300); assert.equal(f.count(), calls);
      await f.restart();
    }
    const final = (await f.settings()).automaticMemory.pending[0];
    assert.deepEqual(final.completed, ['leaf']); assert.equal(f.count(), calls);
  });
}

const linkedKey = 'mirror:fixture-peer/pi/linked-private.jsonl';
function seedMetadata({ home, work, cache, notes, mirror, key }) {
  const sub = path.join(work, 'sub'), other = path.join(home, 'Projects', 'other');
  fs.mkdirSync(sub); fs.mkdirSync(other, { recursive: true });
  const session = (file, cwd, text) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, [
      { type: 'session', version: 3, id: path.basename(file), cwd, timestamp: '2020-01-01T00:00:00Z' },
      { type: 'message', id: 'u1', parentId: null, timestamp: '2020-01-01T00:00:01Z', message: { role: 'user', content: [{ type: 'text', text }] } },
    ].map(JSON.stringify).join('\n') + '\n');
  };
  const sessions = path.join(home, '.pi', 'agent', 'sessions', 'fixture');
  session(path.join(sessions, 'old.jsonl'), sub, 'Public protocol direction.');
  session(path.join(sessions, 'private.jsonl'), sub, 'LOCAL_TRANSCRIPT_SECRET');
  session(path.join(sessions, 'other.jsonl'), other, 'OTHER_PROJECT_SECRET');
  session(path.join(mirror, 'fixture-peer', 'pi', 'linked-private.jsonl'), sub, 'LINKED_TRANSCRIPT_SECRET');
  fs.mkdirSync(cache, { recursive: true }); fs.mkdirSync(path.join(notes, 'projects'), { recursive: true });
  fs.writeFileSync(path.join(notes, 'projects', 'areas.json'), JSON.stringify({ fixture: { sub: { createdAt: 1 } } }));
  fs.writeFileSync(path.join(notes, 'projects', 'conversation-projects.json'), JSON.stringify({ [linkedKey]: 'fixture' }));
  const epic = (id, title, sessionIds) => ({ id, title, sessionIds, updatedAt: 1 });
  fs.writeFileSync(path.join(cache, 'epics.json'), JSON.stringify({
    public: epic('public', 'VISIBLE_EPIC', [key('old')]),
    private: epic('private', 'SECRET_EPIC_ONLY', [key('private')]),
    mixed: epic('mixed', 'SECRET_EPIC_MIXED', [key('old'), key('private')]),
    cross: epic('cross', 'SECRET_EPIC_CROSS', [key('old'), key('other')]),
    linked: epic('linked', 'SECRET_EPIC_LINKED', [key('old'), linkedKey]),
    unknown: epic('unknown', 'SECRET_EPIC_UNKNOWN', [key('old'), key('missing')]),
  }));
}
for (const scope of ['project', 'area', 'mixed-epic', 'linked-epic']) {
  test(`${scope}: private/mixed/unprovable epic titles and local/linked source IDs never enter rollup provider prompts`, { timeout: 90000 }, async t => {
    const f = await fixture(t, { prepare: seedMetadata }), project = await f.project();
    assert.equal(project, 'fixture'); await f.post('/api/rescan', {});
    const owner = (await f.settings()).me.id;
    for (const id of [f.key('private'), f.key('other'), linkedKey]) await f.post('/api/access', { id, mode: 'listed', listed: {}, owners: [owner] });
    const built = await f.request('/api/memory/backfill', { project }); assert.equal(built.status, 202);
    await until(() => f.docs(project), 'project bundle');
    const start = scope === 'project' ? 0 : f.count();
    if (scope !== 'project') {
      const r = await f.request(scope === 'area' ? '/api/project/memory/regenerate' : '/api/epic/memory/regenerate', scope === 'area' ? { project, area: 'sub' } : { id: scope === 'mixed-epic' ? 'mixed' : 'linked' });
      assert.equal(r.status, 202);
      await until(() => f.programs().slice(start).some(c => c.system.startsWith('Function: project_status')), 'scoped document programs');
    }
    const calls = f.programs().slice(start).filter(c => c.system.startsWith('Function: project_'));
    assert.ok(calls.length);
    for (const c of calls) for (const secret of ['SECRET_EPIC_', 'LOCAL_TRANSCRIPT_SECRET', 'OTHER_PROJECT_SECRET', 'LINKED_TRANSCRIPT_SECRET', f.key('private'), f.key('other'), linkedKey, f.key('missing')]) {
      assert.equal(c.input.includes(secret), false, `${scope} leaked ${secret} in ${c.system.split('\n')[0]}`);
    }
    if (scope === 'project') assert.ok(calls.find(c => c.system.startsWith('Function: project_overview')).input.includes('VISIBLE_EPIC'), 'provably admissible public metadata is retained');
  });
}
