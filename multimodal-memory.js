'use strict';
const { sourceSnapshot, hydrate, packRows } = require('./memory-images');
const { revision } = require('./memory-identity');
const { memoryConfig, modelIdentity } = require('./memory-config');
const { parseSnapshot } = require('./memory-source');

function createMultimodalMemory({ programs, settings, transport, projectOf, check, parseFile = parseSnapshot }) {
  if (!programs?.run || typeof check !== 'function') throw new Error('Logged programs and live permission guard required');
  async function build(data, file, { guard: external = () => {}, caller = {}, signal } = {}) {
    const selected = memoryConfig(settings()), identity = modelIdentity(selected);
    const snapshot = sourceSnapshot(file), project = projectOf(data);
    const guard = () => {
      for (const fn of [check, external]) { const result = fn(); if (result === false || result?.then) throw new Error('Bound memory permission denied or asynchronous guard unsupported'); }
      if (modelIdentity(settings()) !== identity || sourceSnapshot(file).revision !== snapshot.revision || projectOf(data) !== project) {
        throw Object.assign(new Error('Source, model configuration or project changed; no publication'), { code: 'STALE_MEMORY_INPUT' });
      }
    };
    guard();
    const parsed = await parseFile(file, snapshot.text);
    // Indexing attaches trusted delegation provenance AFTER parsing. Preserve it
    // by source entry identity on every reparse; never let kickoff become intent.
    const origins = new Map((data.messages || []).filter(m => m.role === 'user' && m.origin).map(m => [m.eid, m.origin]));
    for (const m of parsed.messages) if (m.role === 'user' && origins.has(m.eid)) m.origin = origins.get(m.eid);
    if (data.delegationId) {
      const kickoff = parsed.messages.find(m => m.role === 'user');
      if (kickoff) kickoff.origin = 'delegation';
    }
    const bundle = hydrate(snapshot, parsed, undefined, { inspectImages: selected.memoryImages });
    if (!bundle.rows.length) throw new Error('No attributed memory source messages');
    const groups = packRows(bundle.rows, Math.floor(selected.contextTokens * 0.8) - 10000);
    const results = [], intent = [], seen = new Set();
    for (const group of groups) {
      guard();
      const name = 'memory_extract' + (group.images.length ? '_' + group.images.length : '');
      const inputs = { evidence: group.text, ...Object.fromEntries(group.images.map((image, i) =>
        ['image_' + (i + 1), { data: image.data, media_type: image.mimeType }])) };
      const call = await programs.run(name, inputs, { caller: { ...caller, conversation: data.key, project }, signal,
        memory: { ...transport(), settings: selected, check: guard } });
      guard();
      const result = call.outputs;
      if (!result.note?.trim() || !result.abstract?.trim()) throw new Error('Empty memory extraction');
      results.push({ result, callId: call.callId });
      for (const candidate of result.intent) {
        const row = bundle.rows.find(r => r.id === candidate.id);
        if (!row || !group.ids.includes(row.id) || row.role !== 'user' || row.origin === 'delegation' || seen.has(row.id)) continue;
        if (!Number.isFinite(candidate.confidence) || candidate.confidence < 0 || candidate.confidence > 1) throw new Error('Invalid intent confidence');
        seen.add(row.id);
        intent.push({ messageIndex: row.id, entry: row.eid, offBranch: !!row.off, ts: row.ts || null,
          ...Object.fromEntries(['kind', 'force', 'situation', 'confidence', 'reason'].map(k => [k, candidate[k]])),
          user: row.text || '', assistantBefore: row.assistantBefore?.text || '', assistantBeforeEntry: row.assistantBefore?.entry || null,
          images: row.images.map(i => ({ entry: i.entry, path: i.path, identity: i.identity, mimeType: i.mimeType })) });
      }
    }
    const facts = kind => [...new Map(results.flatMap(r => r.result[kind]).map(r => [JSON.stringify(r), r])).values()];
    const abstract = results.map(r => r.result.abstract).join('\n\n');
    const memoryHash = revision('attributed-functai-memory-v1\0' + snapshot.revision + '\0' + identity);
    const supplied = selected.memoryImages ? bundle.imageCount : 0;
    const leaf = { v: 3, key: data.key, title: data.title || 'Session', memoryHash, sourceRevision: snapshot.revision,
      memoryImages: selected.memoryImages, imageCount: supplied, sourceImageCount: bundle.imageCount, builtAt: Date.now(),
      callIds: results.map(r => r.callId), span: { firstTs: parsed.meta.firstTs, lastTs: parsed.meta.lastTs },
      abstract, intent, environment: facts('environment'), problems: facts('problems') };
    const note = [`# ${leaf.title.replace(/[\r\n]/g, ' ')}`, '', `- **Session:** ${data.key}`,
      `- **Project:** ${project}`, `- **Source revision:** ${snapshot.revision}`,
      `- **Images supplied:** ${supplied} (${selected.memoryImages ? 'inspection requested, not proof of understanding' : 'intentionally not inspected'})`,
      '', '**Abstract.** ' + abstract, '', ...results.flatMap(({ result }, i) => [`## Section ${i + 1}`, '', result.note, ''])].join('\n');
    guard();
    return { note, leaf, guard, sourceRevision: snapshot.revision, memoryHash };
  }
  return { build };
}
module.exports = { createMultimodalMemory, modelIdentity };
