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
  error?: { message?: string };
}

export class GroqTextClient {
  constructor(private readonly config: AppConfig, private readonly platform?: PlatformStore) {}

  async generate(input: {
    apiKey?: string;
    system: string;
    userText: string;
    tools?: Array<Record<string, unknown>>;
    executeTools?: (calls: GroqToolCall[]) => Promise<Array<{ id: string; name: string; response: unknown }>>;
  }) {
    const messages: GroqMessage[] = [
      { role: 'system', content: input.system },
      { role: 'user', content: input.userText }
    ];
    let explicitKey = input.apiKey;
    for (let toolRound = 0; toolRound < 5; toolRound += 1) {
      const result = await this.requestWithRotation(messages, input.tools ?? [], explicitKey);
      explicitKey = result.explicitKey;
      const message = result.payload.choices?.[0]?.message;
      const calls = message?.tool_calls ?? [];
      if (!calls.length) {
        const text = message?.content?.trim();
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

  private async requestWithRotation(messages: GroqMessage[], tools: Array<Record<string, unknown>>, explicitKey?: string) {
    const attempted = new Set<string>();
    const maxAttempts = explicitKey ? 1 : 8;
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const selected = explicitKey
        ? { id: 'byok', value: explicitKey }
        : await this.pickSharedKey(attempted);
      if (!selected) break;
      attempted.add(selected.id);
      const response = await fetch(this.config.GROQ_API_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${selected.value}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.config.GROQ_MODEL,
          messages,
          ...(tools.length ? { tools: tools.map((declaration) => ({ type: 'function', function: normalizeDeclaration(declaration) })), tool_choice: 'auto' } : {}),
          temperature: 0.8,
          max_completion_tokens: 2048
        }),
        signal: AbortSignal.timeout(60_000)
      });
      const raw = await response.text();
      let payload: GroqResponse;
      try { payload = JSON.parse(raw) as GroqResponse; } catch { payload = {}; }
      if (response.ok) return { payload, explicitKey };
      lastError = new Error(`Groq HTTP ${response.status}: ${payload.error?.message ?? raw.slice(0, 300)}`);
      if (response.status !== 429 || explicitKey) throw lastError;
      if (this.platform) {
        await this.platform.coolDownProviderKey(selected.id, parseRetryAfter(response.headers.get('retry-after')));
      }
    }
    throw lastError ?? new Error('No Groq API key is available');
  }

  private async pickSharedKey(attempted: Set<string>) {
    if (this.platform) {
      for (let i = 0; i < 8; i += 1) {
        const key = await this.platform.pickProviderKey('groq');
        if (!key || !attempted.has(key.id)) return key;
      }
    }
    return null;
  }
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
