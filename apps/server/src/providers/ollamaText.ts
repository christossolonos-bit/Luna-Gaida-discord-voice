import type { AppConfig } from '../config/env.js';
import { stripModelArtifacts } from '../live/voiceReply.js';

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface ChatResponse {
  choices?: Array<{ message?: { content?: string | null; reasoning?: string | null } }>;
  error?: { message?: string };
}

interface NativeChatMessage {
  content?: string;
  thinking?: string;
}

/** Local Ollama chat completions (OpenAI-compatible API). */
export class OllamaTextClient {
  constructor(private readonly config: AppConfig) {}

  async generate(input: {
    system: string;
    userText: string;
    maxCompletionTokens?: number;
    temperature?: number;
  }) {
    const messages: ChatMessage[] = [
      { role: 'system', content: input.system },
      { role: 'user', content: input.userText }
    ];

    const response = await fetch(this.config.ollamaApiUrl, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ollama',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: this.config.ollamaModel,
        messages,
        temperature: input.temperature ?? 0.8,
        max_completion_tokens: input.maxCompletionTokens ?? 2048,
        reasoning_effort: this.config.ollamaReasoningEffort,
        chat_template_kwargs: {
          enable_thinking: this.config.ollamaReasoningEffort !== 'none'
        }
      }),
      signal: AbortSignal.timeout(this.config.ollamaTimeoutMs)
    });

    const raw = await response.text();
    let payload: ChatResponse;
    try {
      payload = JSON.parse(raw) as ChatResponse;
    } catch {
      payload = {};
    }

    if (!response.ok) {
      throw new Error(`Ollama HTTP ${response.status}: ${payload.error?.message ?? raw.slice(0, 300)}`);
    }

    const text = extractAssistantText(payload.choices?.[0]?.message);
    if (!text) {
      throw new Error('Ollama returned no text');
    }
    return text;
  }

  /** Native Ollama /api/chat with JSON output (initiative, DMs, curiosity). */
  async generateJson(input: {
    system: string;
    userText: string;
    format: Record<string, unknown>;
    maxCompletionTokens?: number;
    temperature?: number;
  }) {
    const schemaHint = describeJsonFormat(input.format);
    const system = [
      input.system,
      `Respond with valid JSON only matching this shape: ${schemaHint}`,
      'No markdown, no prose outside the JSON object.'
    ].join('\n');

    const native = await this.tryNativeJsonChat(system, input.userText, input.temperature, input.maxCompletionTokens);
    if (native) return native;

    const fallback = await this.generate({
      system,
      userText: input.userText,
      maxCompletionTokens: input.maxCompletionTokens ?? 280,
      temperature: input.temperature ?? 0.75
    });
    const extracted = extractJsonObject(fallback);
    if (!extracted) {
      throw new Error('Ollama JSON chat returned no content');
    }
    return extracted;
  }

  private async tryNativeJsonChat(
    system: string,
    userText: string,
    temperature?: number,
    maxCompletionTokens?: number
  ) {
    const url = resolveOllamaNativeChatUrl(this.config.ollamaApiUrl);
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.config.ollamaModel,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: userText }
        ],
        stream: false,
        think: false,
        format: 'json',
        options: {
          temperature: temperature ?? 0.75,
          num_predict: maxCompletionTokens ?? 280
        }
      }),
      signal: AbortSignal.timeout(this.config.ollamaTimeoutMs)
    });

    const raw = await response.text();
    let payload: { message?: NativeChatMessage; done_reason?: string };
    try {
      payload = JSON.parse(raw) as { message?: NativeChatMessage; done_reason?: string };
    } catch {
      payload = {};
    }

    if (!response.ok) {
      throw new Error(`Ollama JSON chat HTTP ${response.status}: ${raw.slice(0, 300)}`);
    }

    return extractNativeJson(payload.message);
  }
}

function resolveOllamaNativeChatUrl(apiUrl: string) {
  try {
    const parsed = new URL(apiUrl);
    return `${parsed.origin}/api/chat`;
  } catch {
    return 'http://127.0.0.1:11434/api/chat';
  }
}

function describeJsonFormat(format: Record<string, unknown>) {
  const props = format.properties as Record<string, { type?: string }> | undefined;
  const required = format.required as string[] | undefined;
  if (!props) return JSON.stringify(format);
  const shape: Record<string, string> = {};
  for (const [key, def] of Object.entries(props)) {
    shape[key] = def.type ?? 'string';
  }
  if (required?.length) {
    return `${JSON.stringify(shape)} (required: ${required.join(', ')})`;
  }
  return JSON.stringify(shape);
}

function extractNativeJson(message: NativeChatMessage | undefined) {
  const content = message?.content?.trim();
  if (content) {
    const json = extractJsonObject(content);
    if (json) return json;
  }

  const thinking = message?.thinking?.trim();
  if (!thinking) return null;

  const fromThinking = extractJsonObject(thinking);
  if (fromThinking) return fromThinking;

  const stripped = stripModelArtifacts(thinking.replace(/^Thinking Process:\s*/i, '').trim());
  return extractJsonObject(stripped);
}

function extractJsonObject(text: string) {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const candidate = fenced || trimmed;

  try {
    JSON.parse(candidate);
    return candidate;
  } catch {
    // continue
  }

  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start >= 0 && end > start) {
    const slice = candidate.slice(start, end + 1);
    try {
      JSON.parse(slice);
      return slice;
    } catch {
      return null;
    }
  }

  return null;
}

function extractAssistantText(message: { content?: string | null; reasoning?: string | null } | undefined) {
  const content = message?.content?.trim();
  if (content) {
    const stripped = stripModelArtifacts(content);
    if (stripped) return stripped;
  }
  const reasoning = message?.reasoning?.trim();
  if (!reasoning) return '';
  const withoutThinking = stripModelArtifacts(reasoning.replace(/^Thinking Process:\s*/i, '').trim());
  return withoutThinking.split('\n').find((line) => line.trim())?.trim() ?? withoutThinking.slice(0, 500);
}
