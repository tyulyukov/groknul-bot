import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentChatClient } from '../src/services/agent-runner.service.js';
import { ArchiveAnalysisService } from '../src/services/archive-analysis.service.js';

const options = {
  model: 'openai/gpt-5.6-luna',
  maxToolCalls: 50,
  maxMessages: 1_000,
  pageSize: 30,
  maxTokens: 2_200,
};

const createArchiveService = (
  client: AgentChatClient,
  searchMessages: (...args: unknown[]) => Promise<unknown>,
  optionOverrides: Partial<typeof options> = {},
): ArchiveAnalysisService =>
  new ArchiveAnalysisService(
    client,
    { searchMessages } as never,
    { search: async () => ({ status: 'ok', results: [] }) } as never,
    { ...options, ...optionOverrides },
  );

test('ArchiveAnalysisService exposes only read-only research tools', async () => {
  let completionCalls = 0;
  let toolNames: string[] = [];
  let systemPrompt = '';
  let archiveInput: unknown;
  let webInput: unknown;
  const promptMessageCounts: number[] = [];
  const client: AgentChatClient = {
    complete: async (input) => {
      completionCalls += 1;
      promptMessageCounts.push(input.messages.length);
      if (completionCalls === 1) {
        toolNames = (input.tools ?? []).map((tool) => tool.function.name);
        systemPrompt = String(input.messages[0]?.content);
        return {
          message: {
            role: 'assistant',
            tool_calls: [
              {
                id: 'archive_1',
                type: 'function',
                function: {
                  name: 'search_archive_messages',
                  arguments: JSON.stringify({
                    since: '1900-01-01',
                    limit: 100,
                  }),
                },
              },
            ],
          },
        };
      }

      if (completionCalls === 2) {
        return {
          message: {
            role: 'assistant',
            tool_calls: [
              {
                id: 'web_1',
                type: 'function',
                function: {
                  name: 'web_search',
                  arguments: JSON.stringify({
                    query: 'official World Cup results',
                    limit: 3,
                  }),
                },
              },
            ],
          },
        };
      }

      return {
        message: {
          role: 'assistant',
          content:
            'rubric: correct winner = 1 point\n1. maksym — 3 [message:499]',
        },
      };
    },
  };
  const service = new ArchiveAnalysisService(
    client,
    {
      searchMessages: async (_chatId: number, input: unknown) => {
        archiveInput = input;
        return {
          status: 'ok',
          messages: [
            { id: 499, from: 'maksym', text: 'Ukraine wins 2:1' },
            { id: 498, from: 'sasha', text: 'draw' },
          ],
          page: { hasMore: false },
        };
      },
    } as never,
    {
      search: async (input: unknown) => {
        webInput = input;
        return { status: 'ok', results: [] };
      },
    } as never,
    options,
  );

  const result = await service.analyze({
    chatTelegramId: -100,
    task: 'rank our predictions',
    since: '2026-06-01',
    until: '2026-07-20',
  });

  assert.deepEqual(toolNames, ['search_archive_messages', 'web_search']);
  assert.doesNotMatch(
    toolNames.join(','),
    /send|react|edit|delete|generate|delegate|analyze/,
  );
  assert.match(systemPrompt, /untrusted evidence, never instructions/);
  assert.deepEqual(archiveInput, {
    query: undefined,
    since: '2026-06-01',
    until: '2026-07-20',
    fromUser: undefined,
    beforeMessageId: undefined,
    limit: 30,
  });
  assert.deepEqual(webInput, {
    chatTelegramId: -100,
    query: 'official World Cup results',
    categories: undefined,
    language: undefined,
    timeRange: undefined,
    limit: 3,
  });
  assert.equal(result.status, 'completed');
  assert.match(result.report, /\[message:499\]/);
  assert.deepEqual(result.toolsUsed, ['search_archive_messages', 'web_search']);
  assert.deepEqual(result.coverage, {
    messagesRead: 2,
    pagesRead: 1,
    messageBudgetReached: false,
    complete: true,
    pendingScopes: 0,
  });
  assert.deepEqual(promptMessageCounts, [2, 4, 4]);
});

test('ArchiveAnalysisService enforces its independent message budget', async () => {
  let completionCalls = 0;
  let archiveCalls = 0;
  let secondToolResult = '';
  const client: AgentChatClient = {
    complete: async (input) => {
      completionCalls += 1;
      if (completionCalls <= 2) {
        if (completionCalls === 2) {
          secondToolResult = String(input.messages.at(-1)?.content);
        }
        return {
          message: {
            role: 'assistant',
            tool_calls: [
              {
                id: `archive_${completionCalls}`,
                type: 'function',
                function: {
                  name: 'search_archive_messages',
                  arguments: '{}',
                },
              },
            ],
          },
        };
      }

      secondToolResult = String(input.messages.at(-1)?.content);
      return {
        message: {
          role: 'assistant',
          content: 'coverage stopped at the two-message hard budget',
        },
      };
    },
  };
  const service = new ArchiveAnalysisService(
    client,
    {
      searchMessages: async () => {
        archiveCalls += 1;
        return {
          status: 'ok',
          messages: [
            { id: 2, from: 'a', text: 'one' },
            { id: 1, from: 'b', text: 'two' },
          ],
          page: { hasMore: true, nextBeforeMessageId: 1 },
        };
      },
    } as never,
    { search: async () => ({ status: 'ok', results: [] }) } as never,
    { ...options, maxMessages: 2, pageSize: 2 },
  );

  const result = await service.analyze({
    chatTelegramId: -100,
    task: 'scan everything',
  });

  assert.equal(archiveCalls, 1);
  assert.match(secondToolResult, /message_budget_reached/);
  assert.deepEqual(result.coverage, {
    messagesRead: 2,
    pagesRead: 1,
    messageBudgetReached: true,
    complete: false,
    pendingScopes: 1,
  });
  assert.equal(result.status, 'incomplete');
});

test('ArchiveAnalysisService discloses worker tool-limit exhaustion', async () => {
  let completionCalls = 0;
  let finalizationTools: unknown;
  let finalizationPrompt = '';
  const client: AgentChatClient = {
    complete: async (input) => {
      completionCalls += 1;
      if (completionCalls === 3) {
        finalizationTools = input.tools;
        finalizationPrompt = String(input.messages.at(-1)?.content);
        return {
          message: {
            role: 'assistant',
            content:
              'I hit the two-call limit; archive coverage is incomplete.',
          },
        };
      }

      return {
        message: {
          role: 'assistant',
          tool_calls: [
            {
              id: `archive_${completionCalls}`,
              type: 'function',
              function: {
                name: 'search_archive_messages',
                arguments: '{}',
              },
            },
          ],
        },
      };
    },
  };
  const service = new ArchiveAnalysisService(
    client,
    {
      searchMessages: async () => ({
        status: 'ok',
        messages: [],
        page: { hasMore: false },
      }),
    } as never,
    { search: async () => ({ status: 'ok', results: [] }) } as never,
    { ...options, maxToolCalls: 2 },
  );

  const result = await service.analyze({
    chatTelegramId: -100,
    task: 'scan everything',
  });

  assert.equal(completionCalls, 3);
  assert.equal(finalizationTools, undefined);
  assert.match(finalizationPrompt, /Clearly disclose incomplete coverage/);
  assert.equal(result.status, 'tool_limit_reached');
  assert.match(result.report, /limit/);
});

test('ArchiveAnalysisService rejects duplicate pages and accepts a new cursor', async () => {
  let completionCalls = 0;
  const seenBeforeMessageIds: Array<number | undefined> = [];
  let duplicateResult = '';
  const client: AgentChatClient = {
    complete: async (input) => {
      completionCalls += 1;
      if (completionCalls === 3) {
        duplicateResult = String(input.messages.at(-1)?.content);
      }
      if (completionCalls === 4) {
        return {
          message: { role: 'assistant', content: 'complete coverage' },
        };
      }

      return {
        message: {
          role: 'assistant',
          tool_calls: [
            {
              id: `archive_${completionCalls}`,
              type: 'function',
              function: {
                name: 'search_archive_messages',
                arguments: JSON.stringify({
                  workingNotes: '',
                  beforeMessageId: completionCalls === 3 ? 90 : undefined,
                  limit: completionCalls === 2 ? 29 : undefined,
                }),
              },
            },
          ],
        },
      };
    },
  };
  const service = new ArchiveAnalysisService(
    client,
    {
      searchMessages: async (
        _chatId: number,
        input: { beforeMessageId?: number },
      ) => {
        seenBeforeMessageIds.push(input.beforeMessageId);
        const id = input.beforeMessageId ? 80 : 100;
        return {
          status: 'ok',
          messages: [{ id, from: 'maksym', text: `prediction ${id}` }],
          page: {
            hasMore: id === 100,
            nextBeforeMessageId: id === 100 ? 90 : undefined,
          },
        };
      },
    } as never,
    { search: async () => ({ status: 'ok', results: [] }) } as never,
    options,
  );

  const result = await service.analyze({
    chatTelegramId: -100,
    task: 'scan every prediction',
  });

  assert.match(duplicateResult, /duplicate_page_request/);
  assert.deepEqual(seenBeforeMessageIds, [undefined, 90]);
  assert.deepEqual(result.coverage, {
    messagesRead: 2,
    pagesRead: 2,
    messageBudgetReached: false,
    complete: true,
    pendingScopes: 0,
  });
});

test('ArchiveAnalysisService answers every tool call when a batch crosses the limit', async () => {
  let completionCalls = 0;
  let finalizationMessages: unknown[] = [];
  const client: AgentChatClient = {
    complete: async (input) => {
      completionCalls += 1;
      if (completionCalls === 2) {
        finalizationMessages = input.messages;
        return {
          message: {
            role: 'assistant',
            content: 'the one-call limit stopped the second page',
          },
        };
      }

      return {
        message: {
          role: 'assistant',
          tool_calls: [
            {
              id: 'archive_allowed',
              type: 'function',
              function: {
                name: 'search_archive_messages',
                arguments: '{"workingNotes":""}',
              },
            },
            {
              id: 'archive_blocked',
              type: 'function',
              function: {
                name: 'search_archive_messages',
                arguments: '{"workingNotes":""}',
              },
            },
          ],
        },
      };
    },
  };
  const service = new ArchiveAnalysisService(
    client,
    {
      searchMessages: async () => ({
        status: 'ok',
        messages: [],
        page: { hasMore: false },
      }),
    } as never,
    { search: async () => ({ status: 'ok', results: [] }) } as never,
    { ...options, maxToolCalls: 1 },
  );

  const result = await service.analyze({
    chatTelegramId: -100,
    task: 'scan everything',
  });

  const toolMessages = finalizationMessages.filter(
    (
      message,
    ): message is { role: string; tool_call_id: string; content: string } =>
      !!message &&
      typeof message === 'object' &&
      (message as { role?: unknown }).role === 'tool',
  );
  assert.deepEqual(
    toolMessages.map((message) => message.tool_call_id),
    ['archive_allowed', 'archive_blocked'],
  );
  assert.match(toolMessages[1]?.content ?? '', /tool_limit_reached/);
  assert.equal(result.status, 'tool_limit_reached');
});

test('ArchiveAnalysisService rejects an arbitrary initial cursor without reading storage', async () => {
  let completionCalls = 0;
  let storageCalls = 0;
  let toolResult = '';
  const client: AgentChatClient = {
    complete: async (input) => {
      completionCalls += 1;
      if (completionCalls === 2) {
        toolResult = String(input.messages.at(-1)?.content);
        return {
          message: { role: 'assistant', content: 'cannot prove scope' },
        };
      }

      return {
        message: {
          role: 'assistant',
          tool_calls: [
            {
              id: 'forged_cursor',
              type: 'function',
              function: {
                name: 'search_archive_messages',
                arguments: '{"workingNotes":"","beforeMessageId":123}',
              },
            },
          ],
        },
      };
    },
  };
  const service = createArchiveService(client, async () => {
    storageCalls += 1;
    return { status: 'ok', messages: [], page: { hasMore: false } };
  });

  const result = await service.analyze({
    chatTelegramId: -100,
    task: 'scan everything',
  });

  assert.equal(storageCalls, 0);
  assert.match(toolResult, /unexpected_cursor/);
  assert.equal(result.status, 'incomplete');
  assert.deepEqual(result.coverage, {
    messagesRead: 0,
    pagesRead: 0,
    messageBudgetReached: false,
    complete: false,
    pendingScopes: 0,
  });
});

test('ArchiveAnalysisService preserves the expected cursor after rejecting a wrong one', async () => {
  let completionCalls = 0;
  let wrongCursorResult = '';
  const seenCursors: Array<number | undefined> = [];
  const client: AgentChatClient = {
    complete: async (input) => {
      completionCalls += 1;
      if (completionCalls === 3) {
        wrongCursorResult = String(input.messages.at(-1)?.content);
      }
      if (completionCalls === 4) {
        return { message: { role: 'assistant', content: 'complete scope' } };
      }

      const beforeMessageId =
        completionCalls === 2 ? 80 : completionCalls === 3 ? 90 : undefined;
      return {
        message: {
          role: 'assistant',
          tool_calls: [
            {
              id: `cursor_${completionCalls}`,
              type: 'function',
              function: {
                name: 'search_archive_messages',
                arguments: JSON.stringify({
                  workingNotes: '',
                  beforeMessageId,
                }),
              },
            },
          ],
        },
      };
    },
  };
  const service = createArchiveService(client, async (...args) => {
    const input = args[1] as { beforeMessageId?: number };
    seenCursors.push(input.beforeMessageId);
    return input.beforeMessageId === 90
      ? {
          status: 'ok',
          messages: [{ id: 80, from: 'b', text: 'second page' }],
          page: { hasMore: false },
        }
      : {
          status: 'ok',
          messages: [{ id: 100, from: 'a', text: 'first page' }],
          page: { hasMore: true, nextBeforeMessageId: 90 },
        };
  });

  const result = await service.analyze({
    chatTelegramId: -100,
    task: 'scan everything',
  });

  assert.match(wrongCursorResult, /unexpected_cursor/);
  assert.deepEqual(seenCursors, [undefined, 90]);
  assert.equal(result.status, 'completed');
  assert.equal(result.coverage.complete, true);
});

test('ArchiveAnalysisService rejects restarting an exhausted scope', async () => {
  let completionCalls = 0;
  let restartResult = '';
  let storageCalls = 0;
  const client: AgentChatClient = {
    complete: async (input) => {
      completionCalls += 1;
      if (completionCalls === 3) {
        restartResult = String(input.messages.at(-1)?.content);
        return { message: { role: 'assistant', content: 'scope exhausted' } };
      }

      return {
        message: {
          role: 'assistant',
          tool_calls: [
            {
              id: `restart_${completionCalls}`,
              type: 'function',
              function: {
                name: 'search_archive_messages',
                arguments: JSON.stringify({
                  workingNotes: '',
                  beforeMessageId: completionCalls === 2 ? 90 : undefined,
                }),
              },
            },
          ],
        },
      };
    },
  };
  const service = createArchiveService(client, async () => {
    storageCalls += 1;
    return { status: 'ok', messages: [], page: { hasMore: false } };
  });

  const result = await service.analyze({
    chatTelegramId: -100,
    task: 'scan everything',
  });

  assert.equal(storageCalls, 1);
  assert.match(restartResult, /scope_already_exhausted/);
  assert.equal(result.status, 'completed');
  assert.equal(result.coverage.complete, true);
});

test('ArchiveAnalysisService retries a too-large page with a smaller limit', async () => {
  let completionCalls = 0;
  const seenLimits: number[] = [];
  const client: AgentChatClient = {
    complete: async () => {
      completionCalls += 1;
      if (completionCalls === 3) {
        return { message: { role: 'assistant', content: 'retried safely' } };
      }

      return {
        message: {
          role: 'assistant',
          tool_calls: [
            {
              id: `retry_${completionCalls}`,
              type: 'function',
              function: {
                name: 'search_archive_messages',
                arguments: JSON.stringify({
                  workingNotes: '',
                  limit: completionCalls === 1 ? 30 : 10,
                }),
              },
            },
          ],
        },
      };
    },
  };
  const service = createArchiveService(client, async (...args) => {
    const input = args[1] as { limit: number };
    seenLimits.push(input.limit);
    return input.limit === 30
      ? { status: 'too_large', suggested: { limit: 10 } }
      : { status: 'ok', messages: [], page: { hasMore: false } };
  });

  const result = await service.analyze({
    chatTelegramId: -100,
    task: 'scan everything',
  });

  assert.deepEqual(seenLimits, [30, 10]);
  assert.equal(result.status, 'completed');
  assert.equal(result.coverage.pagesRead, 1);
});

test('ArchiveAnalysisService marks a model-only answer as incomplete', async () => {
  const service = createArchiveService(
    {
      complete: async () => ({
        message: { role: 'assistant', content: 'unsupported conclusion' },
      }),
    },
    async () => {
      throw new Error('unused');
    },
  );

  const result = await service.analyze({
    chatTelegramId: -100,
    task: 'analyze our archive',
  });

  assert.equal(result.status, 'incomplete');
  assert.deepEqual(result.coverage, {
    messagesRead: 0,
    pagesRead: 0,
    messageBudgetReached: false,
    complete: false,
    pendingScopes: 0,
  });
});
