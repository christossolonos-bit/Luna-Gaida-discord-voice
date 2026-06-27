import type { AppConfig } from '../config/env.js';
import type { PlatformStore } from '../platform/store.js';

interface GroqToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface GroqMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_call_id?: string;
  name?: string;
  tool_calls?: GroqToolCall[];
}

interface GroqResponse {
  choices?: Array<{ message?: { content?: string | null; tool_calls?: GroqToolCall[] } }>;
  error?: { message?: string; code?: string; failed_generation?: string };
}

export class GroqTextClient {
  constructor(private readonly config: AppConfig, private readonly platform?: PlatformStore) {}

  async generate(input: {
    apiKey?: string;
    system: string;
    userText: string;
    maxCompletionTokens?: number;
    temperature?: number;
    tools?: Array<Record<string, unknown>>;
    executeTools?: (calls: GroqToolCall[]) => Promise<Array<{ id: string; name: string; response: unknown }>>;
  }) {
    const messages: GroqMessage[] = [
      { role: 'system', content: input.system },
      { role: 'user', content: input.userText }
    ];
    let explicitKey = input.apiKey;
    for (let toolRound = 0; toolRound < 5; toolRound += 1) {
      let result;
      try {
        result = await this.requestWithRotation(messages, input.tools ?? [], explicitKey, input.maxCompletionTokens, input.temperature);
      } catch (error) {
        if (!(input.tools?.length) || !shouldRetryWithoutTools(error)) throw error;
        result = await this.requestWithRotation(messages, [], explicitKey, input.maxCompletionTokens, input.temperature);
      }
      explicitKey = result.explicitKey;
      const message = result.payload.choices?.[0]?.message;
      const calls = message?.tool_calls ?? [];
      if (!calls.length) {
        const text = extractAssistantText(message);
        if (!text) throw new Error('Groq returned no text');
        return text;
      }
      if (!input.executeTools) throw new Error('Groq requested tools without an executor');
      messages.push({ role: 'assistant', content: message?.content ?? null, tool_calls: calls });
      for (const output of await input.executeTools(calls)) {
        messages.push({ role: 'tool', tool_call_id: output.id, name: output.name, content: JSON.stringify(output.response) });
      }
    }
    throw new Error('Groq exceeded the tool-call round limit');
  }

  private async requestWithRotation(
    messages: GroqMessage[],
    tools: Array<Record<string, unknown>>,
    explicitKey?: string,
    maxCompletionTokens = 2048,
    temperature = 0.8
  ) {
    const attemptedKeyIds = new Set<string>();
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < (explicitKey ? 1 : 8); attempt += 1) {
      const selected = explicitKey
        ? { id: 'byok', value: explicitKey }
        : await this.platform?.pickProviderKey('groq');
      if (!selected || attemptedKeyIds.has(selected.id)) break;
      attemptedKeyIds.add(selected.id);

      const localOllama = explicitKey === 'ollama';
      const apiUrl = localOllama ? this.config.ollamaApiUrl : this.config.GROQ_API_URL;
      const model = localOllama ? this.config.ollamaModel : this.config.GROQ_MODEL;
      const timeoutMs = localOllama ? this.config.ollamaTimeoutMs : this.config.GROQ_TIMEOUT_MS;

      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${selected.value}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages,
          ...(tools.length ? { tools: tools.map((declaration) => ({ type: 'function', function: normalizeDeclaration(declaration) })), tool_choice: 'auto' } : {}),
          temperature,
          max_completion_tokens: maxCompletionTokens,
          ...ollamaRequestExtras(this.config, localOllama)
        }),
        signal: AbortSignal.timeout(timeoutMs)
      });
      const raw = await response.text();
      let payload: GroqResponse;
      try { payload = JSON.parse(raw) as GroqResponse; } catch { payload = {}; }
      if (response.ok) return { payload, explicitKey };
      const detail = payload.error?.failed_generation?.trim();
      lastError = new GroqRequestError(
        response.status,
        payload.error?.code,
        `Groq HTTP ${response.status}: ${payload.error?.message ?? raw.slice(0, 300)}${detail ? ` Failed generation: ${detail.slice(0, 500)}` : ''}`
      );
      if (response.status !== 429 || explicitKey || !this.platform) throw lastError;
      await this.platform.coolDownProviderKey(selected.id, parseRetryAfter(response.headers.get('retry-after')));
    }
    throw lastError ?? new Error('No Groq API key is available');
  }
}

class GroqRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string
  ) {
    super(message);
    this.name = 'GroqRequestError';
  }
}

function ollamaRequestExtras(config: AppConfig, localOllama: boolean) {
  if (!localOllama && !isOllamaEndpoint(config.GROQ_API_URL)) return {};
  const effort = localOllama
    ? config.ollamaReasoningEffort
    : (config.GROQ_REASONING_EFFORT ?? config.ollamaReasoningEffort ?? 'none');
  return {
    reasoning_effort: effort,
    chat_template_kwargs: { enable_thinking: effort === 'none' ? false : true }
  };
}

function isOllamaEndpoint(url: string) {
  try {
    const host = new URL(url).host;
    return host === '127.0.0.1:11434' || host === 'localhost:11434';
  } catch {
    return false;
  }
}

function isGroqFunctionCallGenerationError(error: unknown) {
  return error instanceof GroqRequestError
    && error.status === 400
    && (error.code === 'tool_use_failed' || /failed to call a function/i.test(error.message));
}

function shouldRetryWithoutTools(error: unknown) {
  if (isGroqFunctionCallGenerationError(error)) return true;
  return error instanceof GroqRequestError
    && error.status >= 400
    && /expected element type <function>|tool|parameter/i.test(error.message);
}

import { stripModelArtifacts } from '../live/voiceReply.js';

function extractAssistantText(message: { content?: string | null; reasoning?: string | null } | undefined) {
  const content = message?.content?.trim();
  if (content) {
    const stripped = stripModelArtifacts(content);
    if (stripped) return stripped;
  }
  const reasoning = (message as { reasoning?: string | null } | undefined)?.reasoning?.trim();
  if (!reasoning) return '';
  const withoutThinking = stripModelArtifacts(reasoning.replace(/^Thinking Process:\s*/i, '').trim());
  return withoutThinking.split('\n').find((line) => line.trim())?.trim() ?? withoutThinking.slice(0, 500);
}

function normalizeDeclaration(declaration: Record<string, unknown>) {
  return {
    name: declaration.name,
    description: declaration.description,
    parameters: normalizeTypes(declaration.parameters)
  };
}

function normalizeTypes(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeTypes);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    key,
    key === 'type' && typeof child === 'string' ? child.toLowerCase() : normalizeTypes(child)
  ]));
}

function parseRetryAfter(value: string | null) {
  if (!value) return 30_000;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(1000, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(1000, date - Date.now()) : 30_000;
}
