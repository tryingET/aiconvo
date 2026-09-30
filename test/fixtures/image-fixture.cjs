'use strict';
const zlib = require('node:zlib');
// Independent fixture CRC, so malformed fixtures cannot share an admission bug.
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const b of bytes) {
    crc ^= b;
    for (let n = 0; n < 8; n++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(data.length + 12); out.writeUInt32BE(data.length);
  out.write(type, 4); data.copy(out, 8); out.writeUInt32BE(crc32(out.subarray(4, out.length - 4)), out.length - 4); return out;
}
function png({ width = 1, height = 1, color = 6, depth = 8, filter = 0, pixel = 42, extra = [], raw, interlace = 0 } = {}) {
  const head = Buffer.alloc(13); head.writeUInt32BE(width); head.writeUInt32BE(height, 4); head[8] = depth; head[9] = color; head[12] = interlace;
  // Test large header rejection without allocating attacker-sized pixels.
  const data = Buffer.from(raw || [filter, pixel, 100, 150, 255]);
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', head), ...extra, chunk('IDAT', zlib.deflateSync(data)), chunk('IEND', Buffer.alloc(0))]);
}
const image = (options = {}) => ({ type: 'image', mimeType: 'image/png', data: png(options).toString('base64') });
function transcript() {
  const entry = (id, parentId, role, content) => ({ type: 'message', id, parentId, timestamp: '2026-01-01T00:00:00Z', message: { role, content } });
  return [
    { type: 'session', id: 'session', cwd: '/fixture/project' },
    entry('u0', null, 'user', [{ type: 'text', text: 'Keep the diagram labels readable.' }, image()]),
    entry('a0', 'u0', 'assistant', [{ type: 'text', text: 'Ancestor answer.' }]),
    entry('off-a', 'a0', 'assistant', [{ type: 'text', text: 'Other branch answer; not the preceding answer to u1.' }]),
    entry('off-u', 'off-a', 'user', [{ type: 'text', text: 'Alternative branch.' }, image({ pixel: 10 })]),
    entry('u1', 'a0', 'user', [image({ pixel: 80 })]),
    { type: 'user', uuid: 'tool-u', parentUuid: 'u1', timestamp: '2026-01-01T00:01:00Z', message: {
      content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png().toString('base64') } }] }],
    } },
  ];
}
const jsonl = entries => entries.map(e => JSON.stringify(e)).join('\n') + '\n';
module.exports = { chunk, png, image, transcript, jsonl };
