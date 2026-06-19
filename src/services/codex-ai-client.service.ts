import OpenAI from 'openai';
import { config } from '../common/config.js';
import {
  CodexAuthUnavailableError,
  CodexProviderUnavailableError,
  CodexOAuthService,
} from './codex-oauth.service.js';

type ChatCompletionParams =
  OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;

interface CodexResponsesRequest {
  model: string;
  instructions?: string;
  input: CodexResponseInputItem[];
  tools?: CodexResponseTool[];
  tool_choice?: 'auto';
  parallel_tool_calls?: boolean;
  reasoning?: {
    effort: string;
  };
  store: false;
  stream: true;
  include?: string[];
}

type CodexResponseInputItem =
  | CodexResponseMessageItem
  | CodexResponseFunctionCallItem
  | CodexResponseFunctionCallOutputItem;

interface CodexResponseMessageItem {
  type?: 'message';
  role: 'user' | 'assistant';
  content: CodexResponseContentItem[];
}

type CodexResponseContentItem =
  | { type: 'input_text'; text: string }
  | { type: 'output_text'; text: string }
  | { type: 'input_image'; image_url: string };

interface CodexResponseFunctionCallItem {
  type: 'function_call';
  call_id: string;
  name: string;
  arguments: string;
}

interface CodexResponseFunctionCallOutputItem {
  type: 'function_call_output';
  call_id: string;
  output: string;
}

interface CodexResponseTool {
  type: 'function';
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
  strict: false;
}

interface CodexResponseStreamEvent {
  type?: unknown;
  item?: unknown;
  response?: unknown;
  delta?: unknown;
}

interface CodexOutputItem {
  type?: unknown;
  role?: unknown;
  content?: unknown;
  call_id?: unknown;
  name?: unknown;
  arguments?: unknown;
}

export interface CodexBearerAuthProvider {
  getBearerAuth(): Promise<{
    accessToken: string;
    accountId?: string;
    isFedrampAccount: boolean;
  }>;
  refreshAuthAfterUnauthorized(): Promise<void>;
}

export class CodexAiClient {
  private readonly chatgptBaseUrl: string;

  constructor(
    private readonly oauthService: CodexBearerAuthProvider = new CodexOAuthService(),
    private readonly fetchFn: typeof fetch = fetch,
    chatgptBaseUrl = config.codex.chatgptBaseUrl,
  ) {
    this.chatgptBaseUrl = chatgptBaseUrl.replace(/\/+$/, '');
  }

  canUseModel(model: string): boolean {
    return this.isOpenAiModel(model);
  }

  async completeRaw(params: ChatCompletionParams): Promise<OpenAI.Chat.Completions.ChatCompletion> {
    if (!this.isOpenAiModel(params.model)) {
      throw new CodexAuthUnavailableError(
        `Codex OAuth is only enabled for OpenAI models: ${params.model}`,
      );
    }

    const auth = await this.oauthService.getBearerAuth();
    const request = this.buildResponsesRequest(params);
    const response = await this.fetchResponses(request, auth);

    if (response.status === 401) {
      await this.oauthService.refreshAuthAfterUnauthorized();
      const refreshedAuth = await this.oauthService.getBearerAuth();
      return this.parseResponsesStream(
        await this.fetchResponses(request, refreshedAuth),
        params.model,
      );
    }

    return this.parseResponsesStream(response, params.model);
  }

  private async fetchResponses(
    request: CodexResponsesRequest,
    auth: Awaited<ReturnType<CodexBearerAuthProvider['getBearerAuth']>>,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${auth.accessToken}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      Originator: 'codex_cli_rs',
    };
    if (auth.accountId) {
      headers['ChatGPT-Account-ID'] = auth.accountId;
    }
    if (auth.isFedrampAccount) {
      headers['X-OpenAI-Fedramp'] = 'true';
    }

    return this.fetchFn(`${this.chatgptBaseUrl}/codex/responses`, {
      method: 'POST',
      headers,
      body: JSON.stringify(request),
    });
  }

  private async parseResponsesStream(
    response: Response,
    model: string,
  ): Promise<OpenAI.Chat.Completions.ChatCompletion> {
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      const error = new Error(
        `Codex response failed with status ${response.status}${
          text ? `: ${text.slice(0, 300)}` : ''
        }`,
      ) as Error & { status: number };
      error.status = response.status;
      throw error;
    }

    const raw = await response.text();
    const events = this.parseSseEvents(raw);
    const outputItems: CodexOutputItem[] = [];
    let textFromDelta = '';
    let totalTokens: number | undefined;

    for (const event of events) {
      if (event.type === 'response.output_text.delta') {
        textFromDelta += typeof event.delta === 'string' ? event.delta : '';
      }

      if (event.type === 'response.output_item.done') {
        const item = this.objectField(event.item);
        if (item) outputItems.push(item);
      }

      if (event.type === 'response.completed') {
        totalTokens = this.extractTotalTokens(this.objectField(event.response));
      }
    }

    const toolCalls = outputItems
      .filter((item) => item.type === 'function_call')
      .map((item) => this.convertFunctionCall(item));

    const content =
      this.extractAssistantText(outputItems) ||
      (textFromDelta.length > 0 ? textFromDelta : null);
    if (!content && toolCalls.length === 0) {
      throw new CodexProviderUnavailableError(
        'Codex response stream did not include assistant output',
      );
    }

    return {
      id: this.extractResponseId(events) ?? `codex_${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
          logprobs: null,
          message: {
            role: 'assistant',
            content,
            refusal: null,
            tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
          },
        },
      ],
      usage: totalTokens
        ? {
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: totalTokens,
          }
        : undefined,
    };
  }

  private buildResponsesRequest(params: ChatCompletionParams): CodexResponsesRequest {
    this.assertSupportedParams(params);

    const { instructions, input } = this.convertMessages(params.messages);
    const request: CodexResponsesRequest = {
      model: this.stripOpenAiPrefix(params.model),
      instructions,
      input,
      store: false,
      stream: true,
      include: ['reasoning.encrypted_content'],
    };

    const tools = this.convertTools(params.tools);
    if (tools.length > 0) {
      request.tools = tools;
      request.tool_choice = 'auto';
      request.parallel_tool_calls = true;
    }

    // The ChatGPT /codex/responses backend rejects parameters that the codex
    // CLI never sends for gpt-5.x reasoning models ("Unsupported parameter:
    // temperature" / "max_output_tokens", HTTP 400). We accept temperature,
    // top_p, and max_completion_tokens from callers but never forward them.

    const reasoning = this.objectField(
      (params as unknown as Record<string, unknown>).reasoning,
    );
    const effort = this.stringField(reasoning?.effort);
    if (effort) {
      request.reasoning = { effort };
    }

    return request;
  }

  private assertSupportedParams(params: ChatCompletionParams): void {
    const supported = new Set([
      'model',
      'messages',
      'tools',
      'temperature',
      'top_p',
      'max_completion_tokens',
      'reasoning',
    ]);
    const unsupported = Object.entries(params)
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([key]) => key)
      .filter((key) => !supported.has(key));

    if (unsupported.length > 0) {
      throw new CodexProviderUnavailableError(
        `Codex adapter does not support request parameter(s): ${unsupported.join(', ')}`,
      );
    }
  }

  private convertMessages(
    messages: ChatCompletionParams['messages'],
  ): { instructions?: string; input: CodexResponseInputItem[] } {
    const instructions: string[] = [];
    const input: CodexResponseInputItem[] = [];

    for (const message of messages) {
      const raw = message as unknown as Record<string, unknown>;
      const role = raw.role;
      if (role === 'system' || role === 'developer') {
        const text = this.extractTextContent(raw.content);
        if (text) instructions.push(text);
        continue;
      }

      if (role === 'tool') {
        const callId = this.stringField(raw.tool_call_id);
        if (callId) {
          input.push({
            type: 'function_call_output',
            call_id: callId,
            output: this.extractTextContent(raw.content) ?? '',
          });
        }
        continue;
      }

      if (role === 'assistant') {
        const content = this.convertContent(raw.content, 'assistant');
        if (content.length > 0) {
          input.push({ role: 'assistant', content });
        }

        const toolCalls = Array.isArray(raw.tool_calls) ? raw.tool_calls : [];
        for (const toolCall of toolCalls) {
          const call = this.objectField(toolCall);
          const fn = this.objectField(call?.function);
          const id = this.stringField(call?.id);
          const name = this.stringField(fn?.name);
          if (!id || !name) continue;

          input.push({
            type: 'function_call',
            call_id: id,
            name,
            arguments: this.stringField(fn?.arguments) ?? '{}',
          });
        }
        continue;
      }

      if (role === 'user') {
        input.push({
          role: 'user',
          content: this.convertContent(raw.content, 'user'),
        });
      }
    }

    return {
      instructions: instructions.length > 0 ? instructions.join('\n\n') : undefined,
      input,
    };
  }

  private convertContent(
    content: unknown,
    role: 'user' | 'assistant',
  ): CodexResponseContentItem[] {
    if (typeof content === 'string') {
      return [
        role === 'assistant'
          ? { type: 'output_text', text: content }
          : { type: 'input_text', text: content },
      ];
    }

    if (!Array.isArray(content)) {
      return [];
    }

    const converted: CodexResponseContentItem[] = [];
    for (const item of content) {
      const raw = this.objectField(item);
      if (!raw) continue;

      if (raw.type === 'text') {
        const text = this.stringField(raw.text);
        if (text) converted.push({ type: 'input_text', text });
      }

      if (raw.type === 'image_url') {
        const imageUrl = this.objectField(raw.image_url);
        const url = this.stringField(imageUrl?.url);
        if (url) converted.push({ type: 'input_image', image_url: url });
      }
    }

    return converted;
  }

  private convertTools(
    tools: ChatCompletionParams['tools'] | undefined,
  ): CodexResponseTool[] {
    if (!Array.isArray(tools)) return [];

    return tools
      .map<CodexResponseTool | null>((tool) => {
        const raw = tool as unknown as Record<string, unknown>;
        const fn = this.objectField(raw.function);
        const name = this.stringField(fn?.name);
        const parameters = this.objectField(fn?.parameters);
        if (!name || !parameters) return null;

        return {
          type: 'function' as const,
          name,
          description: this.stringField(fn?.description),
          parameters,
          strict: false as const,
        };
      })
      .filter((tool): tool is CodexResponseTool => tool !== null);
  }

  private parseSseEvents(raw: string): CodexResponseStreamEvent[] {
    const events: CodexResponseStreamEvent[] = [];
    for (const block of raw.split(/\n\n+/)) {
      const dataLines = block
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice('data:'.length).trim())
        .filter((line) => line.length > 0 && line !== '[DONE]');

      if (dataLines.length === 0) continue;

      try {
        const parsed = JSON.parse(dataLines.join('\n')) as unknown;
        if (parsed && typeof parsed === 'object') {
          events.push(parsed as CodexResponseStreamEvent);
        }
      } catch {
        continue;
      }
    }

    return events;
  }

  private extractAssistantText(items: CodexOutputItem[]): string | null {
    const textParts: string[] = [];
    for (const item of items) {
      if (item.type !== 'message' || item.role !== 'assistant') continue;
      if (!Array.isArray(item.content)) continue;

      for (const content of item.content) {
        const raw = this.objectField(content);
        const text = this.stringField(raw?.text);
        if (raw?.type === 'output_text' && text) textParts.push(text);
      }
    }

    return textParts.length > 0 ? textParts.join('') : null;
  }

  private convertFunctionCall(item: CodexOutputItem): {
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  } {
    const id = this.stringField(item.call_id);
    const name = this.stringField(item.name);
    const args = this.stringField(item.arguments);
    if (!id || !name || !args) {
      throw new CodexProviderUnavailableError(
        'Codex response stream included a malformed function call',
      );
    }

    return {
      id,
      type: 'function',
      function: {
        name,
        arguments: args,
      },
    };
  }

  private extractResponseId(events: CodexResponseStreamEvent[]): string | undefined {
    for (const event of events) {
      const response = this.objectField(event.response);
      const id = this.stringField(response?.id);
      if (id) return id;
    }

    return undefined;
  }

  private extractTotalTokens(response: Record<string, unknown> | undefined): number | undefined {
    const usage = this.objectField(response?.usage);
    return this.numberField(usage?.total_tokens);
  }

  private extractTextContent(content: unknown): string | undefined {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return undefined;

    const text = content
      .map((item) => {
        const raw = this.objectField(item);
        return this.stringField(raw?.text);
      })
      .filter((value): value is string => !!value)
      .join('\n');

    return text || undefined;
  }

  private isOpenAiModel(model: string): boolean {
    return model.toLowerCase().startsWith('openai/');
  }

  private stripOpenAiPrefix(model: string): string {
    return this.isOpenAiModel(model) ? model.slice('openai/'.length) : model;
  }

  private objectField(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object'
      ? (value as Record<string, unknown>)
      : undefined;
  }

  private stringField(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }

  private numberField(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  }
}
