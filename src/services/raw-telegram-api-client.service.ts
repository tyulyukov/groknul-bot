export interface RawTelegramApiClientLike {
  sendRichMessage(
    chatId: number,
    richMarkdown: string,
    options?: RawRichMessageOptions,
  ): Promise<unknown>;
}

export interface RawRichMessageOptions {
  reply_to_message_id?: number;
}

export class RawTelegramApiClient implements RawTelegramApiClientLike {
  constructor(
    private readonly token: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async sendRichMessage(
    chatId: number,
    richMarkdown: string,
    options: RawRichMessageOptions = {},
  ): Promise<unknown> {
    const payload: Record<string, unknown> = {
      chat_id: chatId,
      rich_message: {
        markdown: richMarkdown,
      },
    };

    if (typeof options.reply_to_message_id === 'number') {
      payload.reply_parameters = {
        message_id: options.reply_to_message_id,
      };
    }

    return this.request('sendRichMessage', {
      ...payload,
    });
  }

  private async request<T>(
    method: string,
    payload: Record<string, unknown>,
  ): Promise<T> {
    const response = await this.fetcher(
      `https://api.telegram.org/bot${this.token}/${method}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      },
    );
    const data = (await response.json()) as {
      ok?: boolean;
      result?: T;
      description?: string;
    };

    if (!response.ok || !data.ok) {
      throw new Error(data.description || `Telegram ${method} failed`);
    }

    return data.result as T;
  }
}
