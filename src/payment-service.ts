import { SheetsService } from './sheets';
import { SlackNotifier } from './slack-notifier';
import { Env, PaymentEntry, Payer } from './types';
import { otherPayer, todayInJst } from './utils';

function parseSheetEntry(row: string[], rowNumber?: number) {
  const [date = '', item = '', payer = '', splitBill = 'FALSE', amount = '0'] = row;
  return {
    ...(rowNumber === undefined ? {} : { rowNumber }),
    date,
    item,
    amount: Number(amount),
    payer,
    splitBill: splitBill === 'TRUE'
  };
}

export class PaymentService {
  private sheets: SheetsService;
  private slack: SlackNotifier;
  private payer: Payer;
  private ctx: ExecutionContext;

  constructor(env: Env, payer: Payer, ctx: ExecutionContext, notificationSource = 'ChatGPTから') {
    this.sheets = new SheetsService(env.SPREADSHEET_ID, env.GOOGLE_SERVICE_ACCOUNT_KEY);
    this.slack = new SlackNotifier(env.SLACK_WEBHOOK_URL, notificationSource);
    this.payer = payer;
    this.ctx = ctx;
  }

  async addEntry(item: string, amount: number, splitBill: boolean) {
    const entry: PaymentEntry = {
      date: todayInJst(),
      item: item.trim(),
      amount,
      payer: this.payer,
      splitBill
    };

    await this.sheets.addEntry(entry);
    this.notifySlack(this.slack.notifyEntryAdded(entry));

    return {
      ok: true as const,
      message: splitBill ? '割り勘項目を追加しました' : '立替項目を追加しました',
      entry
    };
  }

  async settle(amount: number) {
    const paidBy = this.payer;
    const paidTo = otherPayer(paidBy);
    const entry: PaymentEntry = {
      date: todayInJst(),
      item: `精算（${paidBy}→${paidTo}）`,
      payer: paidTo,
      splitBill: false,
      amount: -amount
    };

    await this.sheets.addEntry(entry);
    this.notifySlack(this.slack.notifySettlement(paidBy, paidTo, amount));

    return {
      ok: true as const,
      message: '精算を記録しました',
      settlement: { paidBy, paidTo, amount },
      entry
    };
  }

  async listEntries() {
    const { entries, totalRows } = await this.sheets.getRecentEntries(10);
    const startRow = totalRows - entries.length + 1;

    return {
      ok: true as const,
      entries: entries.map((row, index) => parseSheetEntry(row, startRow + index))
    };
  }

  async deleteEntry(rowNumber: number) {
    const deletedEntry = await this.sheets.deleteEntry(rowNumber);
    const formattedDeletedEntry = this.slack.formatDeletedEntry(deletedEntry);
    this.notifySlack(this.slack.notifyEntryDeleted(rowNumber, formattedDeletedEntry));

    return {
      ok: true as const,
      message: `行番号 ${rowNumber} の項目を削除しました`,
      deletedEntry: formattedDeletedEntry
    };
  }

  async getUnsettledAmounts() {
    const data = await this.sheets.getUnsettledAmounts();
    const amounts = data.slice(1).map(row => ({
      name: row[0] || '',
      amount: Number(row[1] || 0)
    }));

    return {
      ok: true as const,
      amounts
    };
  }

  private notifySlack(notification: Promise<void>): void {
    this.ctx.waitUntil(
      notification.catch(error => {
        console.error('Slack notification error:', error);
      })
    );
  }
}
