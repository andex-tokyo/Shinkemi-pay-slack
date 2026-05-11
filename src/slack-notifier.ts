import { PaymentEntry } from './types';

function formatAmount(amount: number): string {
  return amount.toLocaleString('ja-JP');
}

export class SlackNotifier {
  constructor(private webhookUrl?: string) {}

  notifyEntryAdded(entry: PaymentEntry): Promise<void> {
    const type = entry.splitBill ? '割り勘' : '立替';
    return this.send(
      ':house: *ChatGPTから項目を追加しました*\n\n' +
      `*項目:* ${entry.item}\n` +
      `*金額:* ¥${formatAmount(entry.amount)}\n` +
      `*立替者:* ${entry.payer}\n` +
      `*タイプ:* ${type}`
    );
  }

  notifyEntryDeleted(rowNumber: number, deletedEntry: ReturnType<typeof this.formatDeletedEntry>): Promise<void> {
    const detail = deletedEntry
      ? '\n\n削除した項目の詳細:\n' +
        `*日付:* ${deletedEntry.date}\n` +
        `*項目:* ${deletedEntry.item}\n` +
        `*金額:* ¥${formatAmount(deletedEntry.amount)}\n` +
        `*立替者:* ${deletedEntry.payer}\n` +
        `*タイプ:* ${deletedEntry.splitBill ? '割り勘' : '立替'}`
      : '';

    return this.send(`:wastebasket: *ChatGPTから行番号 ${rowNumber} の項目を削除しました*${detail}`);
  }

  formatDeletedEntry(row: string[]) {
    if (row.length < 5) {
      return null;
    }

    const [date, item, payer, splitBill, amount] = row;
    return {
      date,
      item,
      payer,
      splitBill: splitBill === 'TRUE',
      amount: Number(amount)
    };
  }

  private async send(text: string): Promise<void> {
    if (!this.webhookUrl) {
      return;
    }

    const response = await fetch(this.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });

    if (!response.ok) {
      throw new Error(`Failed to send Slack notification: ${await response.text()}`);
    }
  }
}
