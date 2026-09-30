'use strict';
// Pure snapshot projection for memory, not a replacement for server's UI parser.
// Full source text is evidence; system/config entries are never user intent.
const { createClaudeChain } = require('./claude-chain');
// Validate transport aliases before any choice or projection. message.id is
// a provider reply ID (shared across Claude tool lines), NOT an entry alias.
function validateSourceEntry(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) throw new Error('Invalid source entry');
  for (const [a, b] of [['id', 'uuid'], ['parentId', 'parentUuid']]) {
    if (Object.hasOwn(d, a) && Object.hasOwn(d, b) && d[a] !== d[b]) throw new Error('Ambiguous source ' + a + '/' + b);
    for (const key of [a, b]) if (Object.hasOwn(d, key) &&
      !(key.startsWith('parent') && d[key] === null) && (typeof d[key] !== 'string' || !d[key])) throw new Error('Invalid source ' + key);
  }
  if (['user', 'assistant'].includes(d.type) && d.message && Object.hasOwn(d.message, 'role') && d.message.role !== d.type) {
    throw new Error('Ambiguous source message role');
  }
  return d;
}
function parseSnapshot(_file, text) {
  const messages = [], parents = new Map(), chain = createClaudeChain();
  const meta = { firstTs: null, lastTs: null };
  let leaf = null;
  const row = (d, role, content, pathPrefix = []) => {
    const eid = d.id || d.uuid, images = [], words = [];
    if (typeof content === 'string') words.push(content);
    else if (Array.isArray(content)) content.forEach((b, i) => {
      if (b?.type === 'text' && typeof b.text === 'string') words.push(b.text);
      if (b?.type === 'thinking' && typeof b.thinking === 'string') words.push(b.thinking);
      if (b?.type === 'image') images.push({ entry: eid, path: [...pathPrefix, i].join('.'),
        mime: b.source ? (b.source.media_type || b.source.mediaType) : b.mimeType });
      if (b?.type === 'toolCall' || b?.type === 'tool_use') words.push(JSON.stringify({ tool: b.name, input: b.arguments || b.input }));
      if (b?.type === 'tool_result') row(d, 'toolresult', b.content, [...pathPrefix, i]);
    });
    if (words.join('\n').trim() || images.length) messages.push({ role, eid, text: words.join('\n'), images,
      ts: d.timestamp || null, origin: role === 'user' ? d.origin || d.message?.origin : undefined });
  };
  const ids = new Set();
  for (const line of text.replace(/^\uFEFF/, '').split('\n')) {
    if (!line.trim()) continue;
    const d = validateSourceEntry(JSON.parse(line));
    if (d.type === 'session') continue;
    const eid = d.id || d.uuid;
    if (eid != null) {
      if (typeof eid !== 'string' || ids.has(eid)) throw new Error('Invalid or duplicate source entry ID');
      ids.add(eid);
      if (!d.isSidechain) { parents.set(eid, d.parentId !== undefined ? d.parentId : d.parentUuid ?? null); leaf = eid; chain.add(d); }
    }
    if (d.isMeta || d.isSidechain) continue;
    const role = d.type === 'message' ? d.message?.role : ['user', 'assistant'].includes(d.type) ? d.type : null;
    if (['user', 'assistant', 'toolResult'].includes(role)) {
      if (!eid) throw new Error('Memory message lacks a source entry ID');
      row(d, role === 'toolResult' ? 'toolresult' : role, d.message?.content);
      if (d.timestamp) { meta.firstTs ||= d.timestamp; meta.lastTs = d.timestamp; }
    } else if (d.type === 'custom_message') row(d, 'event', d.content);
    else if (d.type === 'compaction' || d.type === 'branch_summary') row(d, 'event', d.summary || '');
  }
  chain.linearize(parents);
  const active = new Set();
  for (let p = leaf; p != null && parents.has(p) && !active.has(p); p = parents.get(p)) active.add(p);
  for (const m of messages) if (!active.has(m.eid)) m.off = true;
  return { meta, messages, entryParents: [...parents] };
}
module.exports = { parseSnapshot, validateSourceEntry };
