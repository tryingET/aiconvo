// Network-free trusted fixture. No credentials or real provider calls.
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools } from '@earendil-works/pi-ai';
export default function (pi: any) {
  const child = process.env.MEMORY_FIXTURE_CHILD === '1' ? spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', detached: process.env.MEMORY_FIXTURE_DETACHED === '1' }) : null;
  if (process.env.MEMORY_FIXTURE_HOOK === '1') pi.on('before_agent_start', () => undefined);
  pi.registerTool({ name: 'fixture_forbidden', label: 'Forbidden', description: 'Never execute',
    parameters: { type: 'object', properties: {} }, execute: () => { throw new Error('Tool executed'); } });
  pi.registerProvider('memory-fixture', {
    api: 'openai-completions', apiKey: 'synthetic-not-a-credential', baseUrl: 'http://127.0.0.1:1/never-used',
    models: ['vision', 'text'].map(id => ({ id, name: id, reasoning: false, input: id === 'vision' ? ['text', 'image'] : ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8000 })),
    streamSimple(model: any, context: any, options: any) {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(async () => {
        if (!process.env.MEMORY_FIXTURE_CAPTURE) throw new Error('Private capture required');
        fs.appendFileSync(process.env.MEMORY_FIXTURE_CAPTURE, JSON.stringify({ provider: model.provider, model: model.id,
          messages: context.messages, tools: getCurrentTools(context.messages), system: getCurrentSystemPrompt(context.messages),
          maxRetries: options?.maxRetries, agentDir: process.env.PI_CODING_AGENT_DIR, cwd: process.cwd(),
          ambientKey: process.env.OPENAI_API_KEY || null, childPid: child?.pid || null }) + '\n', { mode: 0o600 });
        if (process.env.MEMORY_FIXTURE_WAIT) await new Promise(r => setTimeout(r, Number(process.env.MEMORY_FIXTURE_WAIT)));
        const ids = new Set<number>();
        const evidence = context.messages.filter((m: any) => m.role === 'user').flatMap((m: any) => m.content)
          .filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n');
        for (const line of evidence.split('\n')) { try { const row = JSON.parse(line); if (typeof row.id === 'number') ids.add(row.id); } catch {} }
        const intent = [...ids].map(id => ({ id, kind: 'constraint', force: 'considered-direction', situation: 'fixture', confidence: 0.8, reason: 'fixture' }));
        let text = '<note>Grounded note.</note>\n<abstract>Full revision abstract.</abstract>\n<intent>' + JSON.stringify(intent) + '</intent>\n<environment>[]</environment>\n<problems>[]</problems>';
        if (getCurrentSystemPrompt(context.messages).includes('Function: project_status')) text = '<recentFocus>[]</recentFocus><unfinished>[]</unfinished><todos>[]</todos><openQuestions>[]</openQuestions>';
        const captures = fs.readFileSync(process.env.MEMORY_FIXTURE_CAPTURE, 'utf8').trim().split('\n').length;
        if (process.env.MEMORY_FIXTURE_BAD === '1' && captures === 1) text = 'malformed first reply';
        const message: any = { role: 'assistant', api: model.api, provider: model.provider, model: model.id,
          content: [{ type: 'thinking', thinking: 'Synthetic thinking.' }, { type: 'text', text }],
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: 'stop', timestamp: Date.now() };
        if (process.env.MEMORY_FIXTURE_FAIL === '1') { message.stopReason = 'error'; message.errorMessage = 'synthetic provider failure'; }
        if (process.env.MEMORY_FIXTURE_TOOL === '1') { message.stopReason = 'toolUse'; message.content = [{ type: 'toolCall', id: 'tool', name: 'fixture_forbidden', arguments: {} }]; }
        stream.push({ type: 'start', partial: message });
        if (message.stopReason === 'stop') {
          stream.push({ type: 'thinking_delta', contentIndex: 0, delta: 'Synthetic thinking.', partial: message });
          for (const delta of text.match(/[\s\S]{1,30}/g) || []) stream.push({ type: 'text_delta', contentIndex: 1, delta, partial: message });
          stream.push({ type: 'done', reason: 'stop', message });
        } else stream.push({ type: 'error', reason: 'error', error: message });
        stream.end();
      });
      return stream;
    },
  });
}
