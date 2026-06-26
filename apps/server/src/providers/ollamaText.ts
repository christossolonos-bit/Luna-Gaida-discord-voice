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
