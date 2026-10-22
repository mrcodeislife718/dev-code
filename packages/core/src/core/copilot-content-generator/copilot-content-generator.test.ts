/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { GenerateContentResponse } from '@google/genai';
import type { Config } from '../../config/config.js';
import { AuthType } from '../../utils/auth-type.js';
import { CopilotContentGenerator } from './copilot-content-generator.js';

type Listener = (event: { type: string; data: unknown }) => void;

function createFakeClient() {
  const state = {
    listener: undefined as Listener | undefined,
    sessionConfig: undefined as
      | {
          tools: Array<{
            name: string;
            handler: (
              a: unknown,
              i: { toolCallId: string },
            ) => Promise<unknown>;
          }>;
          availableTools: string[];
          systemMessage: { content: string };
        }
      | undefined,
    sent: [] as Array<{ prompt: string }>,
    disconnected: false,
  };
  const session = {
    on: (l: Listener) => {
      state.listener = l;
      return () => undefined;
    },
    send: vi.fn(async (message: { prompt: string }) => {
      state.sent.push(message);
      return 'id';
    }),
    abort: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => {
      state.disconnected = true;
    }),
  };
  const client = {
    createSession: vi.fn(async (cfg: typeof state.sessionConfig) => {
      state.sessionConfig = cfg;
      return session;
    }),
    stop: vi.fn(async () => []),
    listModels: vi.fn(async () => [
      {
        id: 'claude-sonnet-5.5',
        supportedReasoningEfforts: ['low', 'medium', 'high'],
      },
      { id: 'plain-model' },
    ]),
  };
  return { state, client };
}

vi.mock('./copilot-client.js', () => ({
  COPILOT_SIGN_IN_HINT: 'sign in',
  startCopilotClient: vi.fn(),
}));

async function makeGenerator(
  options: { model?: string; effort?: 'low' | 'xhigh' | 'max' } = {},
) {
  const fake = createFakeClient();
  const mod = await import('./copilot-client.js');
  vi.mocked(mod.startCopilotClient).mockResolvedValue(
    fake.client as unknown as Awaited<
      ReturnType<typeof mod.startCopilotClient>
    >,
  );
  const generator = new CopilotContentGenerator(
    {
      model: options.model ?? 'claude-sonnet-5.5',
      authType: AuthType.USE_GITHUB_COPILOT,
      ...(options.effort ? { reasoning: { effort: options.effort } } : {}),
    },
    { getTargetDir: () => '/tmp/work' } as unknown as Config,
  );
  return { ...fake, generator };
}

const emit = (state: { listener?: Listener }, type: string, data: unknown) =>
  state.listener?.({ type, data });

async function collect(stream: AsyncGenerator<GenerateContentResponse>) {
  const out: GenerateContentResponse[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

describe('CopilotContentGenerator', () => {
  it('streams text, reasoning and usage, then closes the session', async () => {
    const { generator, state } = await makeGenerator();
    const stream = await generator.generateContentStream(
      {
        model: 'claude-sonnet-5.5',
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        config: { systemInstruction: 'be brief' },
      },
      'p1',
    );
    const pending = collect(stream);
    await vi.waitFor(() => expect(state.sent).toHaveLength(1));
    emit(state, 'assistant.reasoning_delta', { deltaContent: 'thinking' });
    emit(state, 'assistant.message_delta', {
      messageId: 'm',
      deltaContent: 'Hel',
    });
    emit(state, 'assistant.message_delta', {
      messageId: 'm',
      deltaContent: 'lo',
    });
    emit(state, 'assistant.message', { messageId: 'm', content: 'Hello' });
    emit(state, 'assistant.usage', { inputTokens: 5, outputTokens: 2 });
    emit(state, 'session.idle', {});

    const chunks = await pending;
    const texts = chunks.flatMap((c) =>
      (c.candidates?.[0]?.content?.parts ?? []).map((p) => [p.thought, p.text]),
    );
    expect(texts).toContainEqual([true, 'thinking']);
    expect(texts).toContainEqual([undefined, 'Hel']);
    expect(texts).toContainEqual([undefined, 'lo']);
    expect(texts.filter(([, t]) => t === 'Hello')).toHaveLength(0);
    const last = chunks[chunks.length - 1]!;
    expect(last.candidates?.[0]?.finishReason).toBe('STOP');
    expect(last.usageMetadata?.promptTokenCount).toBe(5);
    expect(state.sessionConfig?.systemMessage.content).toContain('be brief');
    expect(state.disconnected).toBe(true);
  });

  it('suspends on a tool call and resumes with the function response', async () => {
    const { generator, state } = await makeGenerator();
    const tools = [
      {
        functionDeclarations: [
          {
            name: 'read_file',
            description: 'read',
            parametersJsonSchema: { type: 'object', properties: {} },
          },
        ],
      },
    ];
    const first = await generator.generateContentStream(
      {
        model: 'claude-sonnet-5.5',
        contents: [{ role: 'user', parts: [{ text: 'read a.txt' }] }],
        config: { tools },
      },
      'p1',
    );
    const firstChunks = collect(first);
    await vi.waitFor(() => expect(state.sessionConfig).toBeDefined());
    expect(state.sessionConfig!.availableTools).toEqual(['read_file']);

    emit(state, 'assistant.message', {
      messageId: 'm1',
      content: '',
      toolRequests: [
        { toolCallId: 'call-1', name: 'read_file', arguments: {} },
      ],
    });
    const handlerResult = state.sessionConfig!.tools[0]!.handler(
      { path: 'a.txt' },
      { toolCallId: 'call-1' },
    );

    const chunks = await firstChunks;
    const calls = chunks.flatMap((c) => c.functionCalls ?? []);
    expect(calls).toMatchObject([
      { id: 'call-1', name: 'read_file', args: { path: 'a.txt' } },
    ]);
    expect(state.disconnected).toBe(false);

    const second = await generator.generateContentStream(
      {
        model: 'claude-sonnet-5.5',
        contents: [
          { role: 'user', parts: [{ text: 'read a.txt' }] },
          {
            role: 'model',
            parts: [
              { functionCall: { id: 'call-1', name: 'read_file', args: {} } },
            ],
          },
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: 'call-1',
                  name: 'read_file',
                  response: { output: 'hello' },
                },
              },
            ],
          },
        ],
        config: { tools },
      },
      'p2',
    );
    const secondChunks = collect(second);
    await expect(handlerResult).resolves.toMatchObject({
      resultType: 'success',
      textResultForLlm: expect.stringContaining('hello'),
    });
    emit(state, 'assistant.message_delta', {
      messageId: 'm2',
      deltaContent: 'done',
    });
    emit(state, 'session.idle', {});
    const text = (await secondChunks)
      .flatMap((c) => c.candidates?.[0]?.content?.parts ?? [])
      .map((p) => p.text)
      .join('');
    expect(text).toBe('done');
    expect(state.sent).toHaveLength(1);
    expect(state.disconnected).toBe(true);
  });

  it('surfaces Copilot session errors', async () => {
    const { generator, state } = await makeGenerator();
    const stream = await generator.generateContentStream(
      {
        model: 'claude-sonnet-5.5',
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      },
      'p1',
    );
    const pending = collect(stream);
    await vi.waitFor(() => expect(state.sent).toHaveLength(1));
    emit(state, 'session.error', { message: 'rate limited' });
    await expect(pending).rejects.toThrow(/rate limited/);
  });

  it('does not support embeddings', async () => {
    const { generator } = await makeGenerator();
    await expect(
      generator.embedContent({ model: 'm', contents: 'x' }),
    ).rejects.toThrow(/not supported/i);
  });

  describe('reasoning effort', () => {
    const startAndFinish = async (
      generator: CopilotContentGenerator,
      state: { listener?: Listener; sent: unknown[] },
      model: string,
    ) => {
      const stream = await generator.generateContentStream(
        { model, contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
        'p',
      );
      const pending = collect(stream);
      await vi.waitFor(() => expect(state.sent).toHaveLength(1));
      emit(state, 'assistant.message', { messageId: 'm', content: 'ok' });
      emit(state, 'session.idle', {});
      await pending;
    };

    it('forwards a supported effort to the session', async () => {
      const { generator, state } = await makeGenerator({ effort: 'low' });
      await startAndFinish(generator, state, 'claude-sonnet-5.5');
      expect(state.sessionConfig).toMatchObject({ reasoningEffort: 'low' });
    });

    it('clamps an unsupported effort to the strongest supported tier', async () => {
      const { generator, state } = await makeGenerator({ effort: 'max' });
      await startAndFinish(generator, state, 'claude-sonnet-5.5');
      expect(state.sessionConfig).toMatchObject({ reasoningEffort: 'high' });
    });

    it('omits the effort for a model without reasoning control', async () => {
      const { generator, state } = await makeGenerator({
        effort: 'low',
        model: 'plain-model',
      });
      await startAndFinish(generator, state, 'plain-model');
      expect(state.sessionConfig).not.toHaveProperty('reasoningEffort');
    });

    it('omits the effort when none is requested', async () => {
      const { generator, state } = await makeGenerator();
      await startAndFinish(generator, state, 'claude-sonnet-5.5');
      expect(state.sessionConfig).not.toHaveProperty('reasoningEffort');
    });
  });
});
