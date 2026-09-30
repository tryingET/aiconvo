'use strict';
// Stable identity of exact UTF-8 text or bytes. No controller or runtime state.
const { createHash } = require('node:crypto');
const revision = bytes => createHash('sha256').update(bytes).digest('hex');
module.exports = { revision };
