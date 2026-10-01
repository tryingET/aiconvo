'use strict';
// Consumer-local adoption: no ambient defaults and no second consent flag.
const { revision } = require('./memory-identity');
// Packing reserves 10,000 tokens after the 80% context admission margin.
// 16,384 leaves 3,107 for evidence; 12,000 left a negative budget even for tiny text.
const MIN_CONTEXT_TOKENS = 16384;
function memoryConfig(value) {
  const s = structuredClone(value || {});
  if (s.usePiDefault || typeof s.provider !== 'string' || !s.provider.trim() ||
      typeof s.model !== 'string' || !s.model.trim()) throw new Error('Memory requires exact configured provider/model IDs');
  if (s.memoryImages !== undefined && typeof s.memoryImages !== 'boolean') throw new Error('Invalid memoryImages');
  if (s.contextTokens !== undefined && (!Number.isSafeInteger(s.contextTokens) || s.contextTokens < MIN_CONTEXT_TOKENS || s.contextTokens > 1000000)) throw new Error('Invalid memory context budget');
  const extensions = s.providerExtensions?.[s.provider] || [];
  if (!Array.isArray(extensions) || extensions.some(p => typeof p !== 'string' || !require('node:path').isAbsolute(p))) throw new Error('Provider extensions must be explicit absolute file paths');
  const thinking = s.thinking || 'off';
  if (!['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(thinking)) throw new Error('Invalid memory thinking level');
  return { provider: s.provider, model: s.model, thinking, memoryImages: s.memoryImages === true,
    contextTokens: s.contextTokens || 128000, providerExtensions: { [s.provider]: [...extensions] } };
}
const modelIdentity = settings => revision(JSON.stringify(memoryConfig(settings)));
module.exports = { memoryConfig, modelIdentity, MIN_CONTEXT_TOKENS };
