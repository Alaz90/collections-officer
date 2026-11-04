import type { Borrower } from '@co/shared';
import type { MessageChannel } from '../ports.js';

export class TelegramChannel implements MessageChannel {
  constructor(
    private token: string,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  async send(borrower: Borrower, text: string) {
    if (!borrower.telegramChatId) return { delivered: false, error: 'borrower has not connected Telegram' };
    const res = await this.fetchImpl(`https://api.telegram.org/bot${this.token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: borrower.telegramChatId, text, disable_web_page_preview: true }),
    });
    if (res.ok) return { delivered: true };
    return { delivered: false, error: `Telegram ${res.status}` };
  }

  /** Downloads a photo a borrower sent, for the receipt check. */
  async downloadPhoto(fileId: string): Promise<{ mimeType: string; base64: string }> {
    const meta = (await (await this.fetchImpl(`https://api.telegram.org/bot${this.token}/getFile?file_id=${fileId}`)).json()) as {
      result?: { file_path?: string };
    };
    const path = meta.result?.file_path;
    if (!path) throw new Error('Telegram file not found');
    const file = await this.fetchImpl(`https://api.telegram.org/file/bot${this.token}/${path}`);
    const bytes = Buffer.from(await file.arrayBuffer());
    return { mimeType: path.endsWith('.png') ? 'image/png' : 'image/jpeg', base64: bytes.toString('base64') };
  }
}

/** Records messages instead of sending them; used locally and in tests. */
export class OutboxChannel implements MessageChannel {
  readonly sent: Array<{ borrowerId: string; text: string }> = [];

  async send(borrower: Borrower, text: string) {
    this.sent.push({ borrowerId: borrower.id, text });
    return { delivered: true };
  }
}
