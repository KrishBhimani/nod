import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import {
  createAgentSession,
  createExtensionRuntime,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ResourceLoader,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import type { Agent } from '../../ports/agent.ts';
import { taskId } from '../../ports/task-identity.ts';

function isFinalAnswer(signature: string | undefined) {
  if (!signature?.startsWith('{')) return false;
  try {
    const value = JSON.parse(signature);
    return value?.v === 1 && value.phase === 'final_answer';
  } catch {
    return false;
  }
}

function resources(systemPrompt: string): ResourceLoader {
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

export function createPiAgent(options: {
  provider: string;
  model?: string;
  apiKey?: string;
  sessionRoot: string;
  createSession?: typeof createAgentSession;
}): Agent {
  const active = new Set<Awaited<ReturnType<typeof createAgentSession>>['session']>();
  let disposed = false;
  return {
    async open(input) {
      if (disposed) throw new Error('The agent service has stopped.');
      if (!options.apiKey)
        throw new Error('Configure the selected model provider to enable the assistant.');
      const directory = resolve(options.sessionRoot, taskId(input.taskId));
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const runtime = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(),
        modelsPath: null,
        refreshOnCreate: false,
        allowModelNetwork: false,
      });
      await runtime.setRuntimeApiKey(options.provider, options.apiKey);
      const modelId =
        options.model ||
        ({ openai: 'gpt-5.4-mini', anthropic: 'claude-sonnet-4-6' } as Record<string, string>)[
          options.provider
        ];
      const model = runtime.getModel(options.provider, modelId);
      if (!model)
        throw new Error('The configured model is not present in the installed Pi catalog.');
      const tools: ToolDefinition[] = input.tools.map((tool) => ({
        name: tool.name,
        label: tool.name.replaceAll('_', ' '),
        description: tool.description,
        parameters: tool.parameters as ToolDefinition['parameters'],
        executionMode: 'sequential',
        execute: async (_id, args) => ({
          ...(await tool.execute(args as Record<string, unknown>)),
          details: {},
        }),
      }));
      const manager = SessionManager.continueRecent(directory, directory);
      const resumed = manager.buildSessionContext().messages.length > 0;
      const { session } = await (options.createSession ?? createAgentSession)({
        cwd: directory,
        agentDir: directory,
        modelRuntime: runtime,
        model,
        thinkingLevel: 'low',
        tools: tools.map((tool) => tool.name),
        customTools: tools,
        noTools: 'builtin',
        resourceLoader: resources(input.systemPrompt),
        sessionManager: manager,
        settingsManager: SettingsManager.inMemory({
          compaction: { enabled: true },
          retry: { enabled: true, maxRetries: 2 },
          transport: 'sse',
        }),
      });
      if (disposed) {
        session.dispose();
        throw new Error('The agent service has stopped.');
      }
      active.add(session);
      const finishTurn = session.agent.finishTurn;
      session.agent.finishTurn = async (...args) => {
        const result = await finishTurn?.(...args);
        return input.shouldStop() ? { action: 'end' as const } : (result ?? undefined);
      };
      let textBlock: number | undefined;
      const unsubscribe = session.subscribe((event) => {
        if (event.type === 'message_start' && event.message.role === 'assistant') {
          textBlock = undefined;
          input.onEvent({ type: 'message_start' });
        }
        if (event.type === 'turn_start') input.onEvent({ type: 'turn_start' });
        if (event.type === 'message_update') {
          const update = event.assistantMessageEvent;
          if (update.type === 'text_start' || update.type === 'text_delta') {
            if (textBlock !== undefined && textBlock !== update.contentIndex) {
              input.onEvent({ type: 'message_end' });
              input.onEvent({ type: 'message_start' });
            }
            textBlock = update.contentIndex;
          }
          if (update.type === 'text_delta')
            input.onEvent({ type: 'text_delta', text: update.delta });
        }
        if (event.type === 'message_end' && event.message.role === 'assistant') {
          if (event.message.stopReason === 'error') input.onEvent({ type: 'error' });
          if (event.message.stopReason === 'stop') {
            const blocks = event.message.content.filter((item) => item.type === 'text');
            const finalBlocks = blocks.filter((item) => isFinalAnswer(item.textSignature));
            input.onEvent({
              type: 'final',
              text: (finalBlocks.length ? finalBlocks : blocks).map((item) => item.text).join('\n'),
            });
          }
          input.onEvent({ type: 'message_end' });
        }
      });
      return {
        resumed,
        prompt: (text, images) => session.prompt(text, { images }),
        abort: () => session.abort(),
        dispose: () => {
          unsubscribe();
          session.dispose();
          active.delete(session);
        },
      };
    },
    async dispose() {
      disposed = true;
      await Promise.all(
        [...active].map(async (session) => {
          await session.abort();
          session.dispose();
        }),
      );
      active.clear();
    },
  };
}
