/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  CallableTool,
  Content,
  EmbedContentParameters,
  EmbedContentResponse,
  GenerateContentParameters,
  Part,
  Tool as GenAiTool,
  ToolListUnion,
} from '@google/genai';
import { FinishReason, GenerateContentResponse } from '@google/genai';
import type {
  CopilotClient,
  CopilotSession,
  MessageOptions,
  ModelInfo,
  SessionEvent,
  Tool,
  ToolResultObject,
} from '@github/copilot-sdk';
import type { Config } from '../../config/config.js';
import type {
  ContentGenerator,
  ContentGeneratorConfig,
} from '../contentGenerator.js';
import { convertLlmToolParametersToOpenAI } from '../openaiContentGenerator/converter.js';
import { clampReasoningEffort } from '../reasoning-effort.js';
import type { ReasoningEffort } from '../reasoning-effort.js';
import { startCopilotClient } from './copilot-client.js';

/**
 * Qwen Code keeps ownership of the agent loop, tool execution and permissions.
 * Copilot only supplies the model: every Qwen tool is exposed to the Copilot
 * session as a custom tool whose handler stays pending until Qwen has run the
 * tool and sends the result back in its next request. Copilot's own built-in
 * tools are hidden from the model.
 */

/** A suspended turn that waits for Qwen to run tools is dropped after this. */
const SUSPENDED_TURN_TTL_MS = 30 * 60 * 1000;
/** How long to wait for further parallel tool calls of the same model message. */
const TOOL_CALL_GATHER_MS = 400;

type QueueItem =
  | { kind: 'chunk'; chunk: GenerateContentResponse }
  | { kind: 'done' }
  | { kind: 'error'; error: Error };

class AsyncQueue {
  private items: QueueItem[] = [];
  private waiter?: (item: QueueItem) => void;

  push(item: QueueItem): void {
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = undefined;
      waiter(item);
    } else {
      this.items.push(item);
    }
  }

  next(): Promise<QueueItem> {
    const item = this.items.shift();
    if (item) return Promise.resolve(item);
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }
}

function makeChunk(
  parts: Part[],
  options: {
    finished?: boolean;
    usage?: UsageTotals;
  } = {},
): GenerateContentResponse {
  const response = new GenerateContentResponse();
  response.candidates = [
    {
      content: { role: 'model', parts },
      index: 0,
      ...(options.finished ? { finishReason: FinishReason.STOP } : {}),
    },
  ];
  if (options.usage) {
    const { input, output, cacheRead, reasoning } = options.usage;
    response.usageMetadata = {
      promptTokenCount: input,
      candidatesTokenCount: output,
      totalTokenCount: input + output,
      cachedContentTokenCount: cacheRead,
      thoughtsTokenCount: reasoning,
    };
  }
  return response;
}

interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  reasoning: number;
}

const emptyUsage = (): UsageTotals => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  reasoning: 0,
});

interface PendingCall {
  name: string;
  resolve: (result: ToolResultObject) => void;
}

/**
 * One Qwen model request (and its tool round-trips) mapped onto one Copilot
 * session. It outlives a single generateContentStream() call while it waits
 * for Qwen to execute tools.
 */
class Turn {
  readonly queue = new AsyncQueue();
  readonly pending = new Map<string, PendingCall>();
  private expectedCalls = 0;
  private roundCalls = 0;
  private usage = emptyUsage();
  private streamedMessages = new Set<string>();
  private gatherTimer?: NodeJS.Timeout;
  private ttlTimer?: NodeJS.Timeout;
  private closed = false;

  constructor(
    readonly session: CopilotSession,
    private readonly onClose: (turn: Turn) => void,
    private readonly onSuspend: (turn: Turn) => void,
  ) {}

  readonly handleEvent = (event: SessionEvent): void => {
    if (this.closed) return;
    switch (event.type) {
      case 'assistant.message_delta':
        this.streamedMessages.add(event.data.messageId);
        if (event.data.deltaContent) {
          this.queue.push({
            kind: 'chunk',
            chunk: makeChunk([{ text: event.data.deltaContent }]),
          });
        }
        break;
      case 'assistant.reasoning_delta':
        if (event.data.deltaContent) {
          this.queue.push({
            kind: 'chunk',
            chunk: makeChunk([
              { text: event.data.deltaContent, thought: true },
            ]),
          });
        }
        break;
      case 'assistant.message':
        if (
          event.data.content &&
          !this.streamedMessages.has(event.data.messageId)
        ) {
          this.queue.push({
            kind: 'chunk',
            chunk: makeChunk([{ text: event.data.content }]),
          });
        }
        this.expectedCalls = event.data.toolRequests?.length ?? 0;
        this.maybeSuspend();
        break;
      case 'assistant.usage':
        this.usage.input += event.data.inputTokens ?? 0;
        this.usage.output += event.data.outputTokens ?? 0;
        this.usage.cacheRead += event.data.cacheReadTokens ?? 0;
        this.usage.reasoning += event.data.reasoningTokens ?? 0;
        break;
      case 'session.error':
        this.fail(new Error(`GitHub Copilot error: ${event.data.message}`));
        break;
      case 'session.idle':
        this.queue.push({
          kind: 'chunk',
          chunk: makeChunk([], { finished: true, usage: this.takeUsage() }),
        });
        this.queue.push({ kind: 'done' });
        this.close();
        break;
      default:
        break;
    }
  };

  /** Tool handler registered with the SDK; resolves once Qwen returns a result. */
  invokeTool(
    toolCallId: string,
    name: string,
    args: unknown,
  ): Promise<ToolResultObject> {
    return new Promise((resolve) => {
      if (this.closed) {
        resolve(failure('The GitHub Copilot turn was closed.'));
        return;
      }
      this.pending.set(toolCallId, { name, resolve });
      this.roundCalls++;
      this.queue.push({
        kind: 'chunk',
        chunk: makeChunk([
          {
            functionCall: {
              id: toolCallId,
              name,
              args: (args ?? {}) as Record<string, unknown>,
            },
          },
        ]),
      });
      this.maybeSuspend();
    });
  }

  resume(results: Map<string, ToolResultObject>): void {
    clearTimeout(this.ttlTimer);
    this.roundCalls = 0;
    this.expectedCalls = 0;
    for (const [id, result] of results) {
      const call = this.pending.get(id);
      this.pending.delete(id);
      call?.resolve(result);
    }
  }

  /** Ends the current stream; the Copilot session stays alive for the tool results. */
  private maybeSuspend(): void {
    clearTimeout(this.gatherTimer);
    if (this.roundCalls === 0) return;
    if (this.expectedCalls > 0 && this.roundCalls >= this.expectedCalls) {
      this.suspend();
      return;
    }
    this.gatherTimer = setTimeout(() => this.suspend(), TOOL_CALL_GATHER_MS);
    this.gatherTimer.unref?.();
  }

  private suspend(): void {
    if (this.closed || this.roundCalls === 0) return;
    this.queue.push({
      kind: 'chunk',
      chunk: makeChunk([], { finished: true, usage: this.takeUsage() }),
    });
    this.queue.push({ kind: 'done' });
    this.onSuspend(this);
    this.ttlTimer = setTimeout(() => this.close(), SUSPENDED_TURN_TTL_MS);
    this.ttlTimer.unref?.();
  }

  private takeUsage(): UsageTotals {
    const usage = this.usage;
    this.usage = emptyUsage();
    return usage;
  }

  fail(error: Error): void {
    this.queue.push({ kind: 'error', error });
    this.close();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.gatherTimer);
    clearTimeout(this.ttlTimer);
    for (const call of this.pending.values()) {
      call.resolve(failure('The GitHub Copilot turn was cancelled.'));
    }
    this.pending.clear();
    this.onClose(this);
    void this.session
      .abort()
      .catch(() => undefined)
      .then(() => this.session.disconnect())
      .catch(() => undefined);
  }
}

function failure(message: string): ToolResultObject {
  return { textResultForLlm: message, resultType: 'failure', error: message };
}

function partsToText(value: unknown): string {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(partsToText).join('');
  const content = value as Content & Part;
  if (Array.isArray(content.parts)) return partsToText(content.parts);
  return content.text && !content.thought ? content.text : '';
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}

function renderPart(part: Part): string {
  if (part.text) return part.thought ? '' : part.text;
  if (part.functionCall) {
    return `[tool call ${part.functionCall.name}] ${stringify(part.functionCall.args ?? {})}`;
  }
  if (part.functionResponse) {
    return `[tool result ${part.functionResponse.name}] ${stringify(part.functionResponse.response)}`;
  }
  if (part.inlineData) return `[${part.inlineData.mimeType ?? 'file'} omitted]`;
  return '';
}

function renderContent(content: Content): string {
  const text = (content.parts ?? []).map(renderPart).filter(Boolean).join('\n');
  return text
    ? `${content.role === 'model' ? 'assistant' : 'user'}: ${text}`
    : '';
}

/**
 * Builds the single prompt for a fresh Copilot session. Earlier conversation is
 * replayed as a transcript because Qwen sends stateless, full-history requests.
 */
function buildPrompt(contents: Content[]): MessageOptions {
  const last = contents[contents.length - 1];
  const lastIsUser = last?.role === 'user';
  const history = (lastIsUser ? contents.slice(0, -1) : contents)
    .map(renderContent)
    .filter(Boolean)
    .join('\n\n');

  const attachments: NonNullable<MessageOptions['attachments']> = [];
  let message = '';
  if (lastIsUser) {
    for (const part of last.parts ?? []) {
      if (
        part.inlineData?.data &&
        part.inlineData.mimeType?.startsWith('image/')
      ) {
        attachments.push({
          type: 'blob',
          data: part.inlineData.data,
          mimeType: part.inlineData.mimeType,
        });
      } else {
        message += (message ? '\n' : '') + renderPart(part);
      }
    }
  }
  const prompt = [
    history
      ? `Conversation so far (continue from it):\n<conversation>\n${history}\n</conversation>`
      : '',
    message || (history ? 'Continue.' : ''),
  ]
    .filter(Boolean)
    .join('\n\n');
  return { prompt, ...(attachments.length ? { attachments } : {}) };
}

/** Function responses that close the previous model turn, if the request ends with them. */
function trailingFunctionResponses(
  contents: Content[],
): Map<string, ToolResultObject> | undefined {
  const last = contents[contents.length - 1];
  if (last?.role !== 'user') return undefined;
  const results = new Map<string, ToolResultObject>();
  const extraText: string[] = [];
  for (const part of last.parts ?? []) {
    const response = part.functionResponse;
    if (response?.id) {
      const body = (response.response ?? {}) as Record<string, unknown>;
      const error = body['error'];
      const text = stringify(error ?? body['output'] ?? body);
      const images = (response.parts ?? []).flatMap((p) =>
        p.inlineData?.data && p.inlineData.mimeType?.startsWith('image/')
          ? [
              {
                type: 'image' as const,
                data: p.inlineData.data,
                mimeType: p.inlineData.mimeType,
              },
            ]
          : [],
      );
      results.set(response.id, {
        textResultForLlm: text,
        resultType: error ? 'failure' : 'success',
        ...(error ? { error: stringify(error) } : {}),
        ...(images.length ? { binaryResultsForLlm: images } : {}),
      });
    } else if (part.text) {
      extraText.push(part.text);
    }
  }
  if (results.size === 0) return undefined;
  if (extraText.length) {
    const lastResult = [...results.values()].pop()!;
    lastResult.textResultForLlm += `\n\n${extraText.join('\n')}`;
  }
  return results;
}

interface ToolDeclaration {
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
}

async function collectToolDeclarations(
  tools: ToolListUnion | undefined,
): Promise<ToolDeclaration[]> {
  const declarations: ToolDeclaration[] = [];
  for (const entry of tools ?? []) {
    const tool: GenAiTool =
      'tool' in entry
        ? await (entry as CallableTool).tool()
        : (entry as GenAiTool);
    for (const fn of tool.functionDeclarations ?? []) {
      if (!fn.name) continue;
      const schema = fn.parametersJsonSchema
        ? { ...(fn.parametersJsonSchema as Record<string, unknown>) }
        : fn.parameters
          ? convertLlmToolParametersToOpenAI(
              fn.parameters as Record<string, unknown>,
            )
          : { type: 'object', properties: {} };
      declarations.push({
        name: fn.name,
        description: fn.description,
        parameters: schema as Record<string, unknown>,
      });
    }
  }
  return declarations;
}

function buildSystemMessage(request: GenerateContentParameters): string {
  const base = partsToText(request.config?.systemInstruction);
  const wantsJson =
    request.config?.responseMimeType === 'application/json' ||
    request.config?.responseJsonSchema !== undefined ||
    request.config?.responseSchema !== undefined;
  if (!wantsJson) return base;
  const schema =
    request.config?.responseJsonSchema ?? request.config?.responseSchema;
  return `${base}\n\nRespond with a single valid JSON value only, with no prose or code fences.${
    schema ? ` It must match this JSON schema: ${stringify(schema)}` : ''
  }`.trim();
}

export class CopilotContentGenerator implements ContentGenerator {
  private clientPromise?: Promise<CopilotClient>;
  private modelsPromise?: Promise<ModelInfo[]>;
  private readonly suspended = new Map<string, Turn>();

  constructor(
    private readonly generatorConfig: ContentGeneratorConfig,
    private readonly cliConfig: Config,
  ) {}

  private getClient(): Promise<CopilotClient> {
    this.clientPromise ??= startCopilotClient().catch((error) => {
      this.clientPromise = undefined;
      throw error;
    });
    return this.clientPromise;
  }

  /**
   * Maps the `/effort` tier onto what the active Copilot model accepts.
   * Returns undefined when no effort is requested or the model has no
   * reasoning-effort control, so the session keeps the model's default.
   */
  private async resolveReasoningEffort(
    model: string,
  ): Promise<ReasoningEffort | undefined> {
    const reasoning = this.generatorConfig.reasoning;
    const requested = reasoning ? reasoning.effort : undefined;
    if (!requested) return undefined;
    try {
      this.modelsPromise ??= this.getClient().then((client) =>
        client.listModels(),
      );
      const info = (await this.modelsPromise).find((m) => m.id === model);
      const supported = info?.supportedReasoningEfforts;
      if (!supported || supported.length === 0) return undefined;
      return clampReasoningEffort(requested, supported);
    } catch {
      this.modelsPromise = undefined;
      return undefined;
    }
  }

  async generateContent(
    request: GenerateContentParameters,
    userPromptId: string,
  ): Promise<GenerateContentResponse> {
    const stream = await this.generateContentStream(request, userPromptId);
    const parts: Part[] = [];
    let usage: GenerateContentResponse['usageMetadata'];
    for await (const chunk of stream) {
      parts.push(...(chunk.candidates?.[0]?.content?.parts ?? []));
      usage = chunk.usageMetadata ?? usage;
    }
    const merged: Part[] = [];
    for (const part of parts) {
      const prev = merged[merged.length - 1];
      if (part.text && prev?.text && !prev.thought === !part.thought) {
        prev.text += part.text;
      } else {
        merged.push({ ...part });
      }
    }
    const response = makeChunk(merged, { finished: true });
    response.usageMetadata = usage;
    return response;
  }

  async generateContentStream(
    request: GenerateContentParameters,
    _userPromptId: string,
  ): Promise<AsyncGenerator<GenerateContentResponse>> {
    const contents = (request.contents ?? []) as Content[];
    const results = trailingFunctionResponses(contents);
    const turn = (results && this.findSuspendedTurn(results)) ?? undefined;

    let active: Turn;
    if (turn && results) {
      active = turn;
      for (const id of results.keys()) this.suspended.delete(id);
      active.resume(results);
    } else {
      active = await this.startTurn(request, contents);
    }
    return this.drain(active, request.config?.abortSignal);
  }

  async embedContent(
    _request: EmbedContentParameters,
  ): Promise<EmbedContentResponse> {
    throw new Error('Embeddings are not supported with GitHub Copilot.');
  }

  private findSuspendedTurn(
    results: Map<string, ToolResultObject>,
  ): Turn | undefined {
    const turn = this.suspended.get([...results.keys()][0]!);
    if (!turn) return undefined;
    for (const id of results.keys()) {
      if (this.suspended.get(id) !== turn) return undefined;
    }
    return turn;
  }

  private async startTurn(
    request: GenerateContentParameters,
    contents: Content[],
  ): Promise<Turn> {
    const client = await this.getClient();
    const declarations = await collectToolDeclarations(request.config?.tools);
    // Tool handlers close over the turn, which needs the session created below.
    // eslint-disable-next-line prefer-const
    let turn!: Turn;

    const tools: Tool[] = declarations.map((declaration) => ({
      name: declaration.name,
      description: declaration.description,
      parameters: declaration.parameters,
      overridesBuiltInTool: true,
      skipPermission: true,
      handler: (args: unknown, invocation: { toolCallId: string }) =>
        turn.invokeTool(invocation.toolCallId, declaration.name, args),
    }));

    const model = request.model || this.generatorConfig.model;
    const reasoningEffort = await this.resolveReasoningEffort(model);
    const session = await client.createSession({
      model,
      ...(reasoningEffort ? { reasoningEffort } : {}),
      streaming: true,
      tools,
      // Only Qwen's tools are visible; Copilot's shell/edit/MCP tools stay hidden.
      availableTools: declarations.map((d) => d.name),
      systemMessage: { mode: 'replace', content: buildSystemMessage(request) },
      workingDirectory: this.cliConfig.getTargetDir(),
      enableConfigDiscovery: false,
      skipCustomInstructions: true,
      infiniteSessions: { enabled: false },
      onPermissionRequest: () => ({ kind: 'reject' }),
    });

    turn = new Turn(
      session,
      (closed) => {
        for (const [id, owner] of this.suspended) {
          if (owner === closed) this.suspended.delete(id);
        }
      },
      (suspendedTurn) => {
        for (const id of suspendedTurn.pending.keys()) {
          this.suspended.set(id, suspendedTurn);
        }
      },
    );
    session.on(turn.handleEvent);
    try {
      await session.send(buildPrompt(contents));
    } catch (error) {
      turn.close();
      throw error;
    }
    return turn;
  }

  private async *drain(
    turn: Turn,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<GenerateContentResponse> {
    const onAbort = () => {
      turn.close();
      turn.queue.push({ kind: 'done' });
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      for (;;) {
        const item = await turn.queue.next();
        if (item.kind === 'chunk') yield item.chunk;
        else if (item.kind === 'error') throw item.error;
        else return;
      }
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }
}
