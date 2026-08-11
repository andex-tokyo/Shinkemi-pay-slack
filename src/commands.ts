import { SlackResponse, PaymentEntry } from './types';
import { SheetsService } from './sheets';

function payerFromUserId(userId: string): PaymentEntry['payer'] | null {
  if (userId === 'U075AS43YKT') return '加藤';
  if (userId === 'U074HKBTAF9') return '土田';
  return null;
}

function otherPayer(payer: PaymentEntry['payer']): PaymentEntry['payer'] {
  return payer === '土田' ? '加藤' : '土田';
}

export class CommandHandler {
  private sheets: SheetsService;

  constructor(sheets: SheetsService) {
    this.sheets = sheets;
  }

  async handlePay(text: string, splitBill: boolean, userId: string): Promise<SlackResponse> {
    const parts = text.split(' ');
    if (parts.length < 2 || parts.length > 3) {
      return {
        response_type: 'ephemeral',
        text: ':warning: 使い方: `/pay <項目> <金額> [立替者名]`\n例: `/pay ランチ 1200` または `/pay ランチ 1200 土田`'
      };
    }

    const item = parts[0];
    const amount = parseFloat(parts[1]);

    if (isNaN(amount)) {
      return {
        response_type: 'ephemeral',
        text: ':x: 金額は数値で入力してください。\n例: `/pay ランチ 1200`'
      };
    }

    let payer = parts.length === 3 ? parts[2] : '';

    if (!payer) {
      payer = payerFromUserId(userId) || '';
    }

    if (!payer) {
      return {
        response_type: 'ephemeral',
        text: ':warning: 立替者を入力してください。\n例: `/pay ランチ 1200 土田`'
      };
    }

    if (payer !== '土田' && payer !== '加藤') {
      return {
        response_type: 'ephemeral',
        text: ':x: 立替者は「土田」または「加藤」のみ入力できます。'
      };
    }

    const entry: PaymentEntry = {
      date: new Date().toISOString().split('T')[0],
      item,
      payer,
      splitBill,
      amount
    };

    try {
      await this.sheets.addEntry(entry);
      
      const type = splitBill ? '割り勘' : '立替';
      const emoji = splitBill ? ':handshake:' : ':receipt:';
      
      return {
        response_type: 'in_channel',
        text: `${emoji} *${type}項目を追加しました！*\n\n` +
              `*項目:* ${item}\n` +
              `*金額:* ¥${amount.toLocaleString()}\n` +
              `*立替者:* ${payer}\n` +
              `*タイプ:* ${type}`
      };
    } catch (error) {
      console.error('Error adding entry:', error);
      return {
        response_type: 'ephemeral',
        text: ':x: データの追加中にエラーが発生しました。もう一度お試しください。'
      };
    }
  }

  async handlePayList(): Promise<SlackResponse> {
    try {
      const result = await this.sheets.getRecentEntries(10);
      const { entries, totalRows } = result;
      
      if (entries.length === 0) {
        return {
          response_type: 'in_channel',
          text: ':clipboard: 記録されている項目はありません。'
        };
      }
      
      // 実際のスプレッドシートの行番号を計算（最後の10件の実際の行番号）
      const startRow = totalRows - entries.length + 1;
      const formattedEntries = entries.map((row, index) => {
        const actualRowNumber = startRow + index;
        const [date, item, payer, splitBill, amount] = row;
        const type = splitBill === 'TRUE' ? '割' : '立';
        const formattedAmount = parseFloat(amount).toLocaleString();
        return `\`${actualRowNumber.toString().padStart(3, ' ')}\` | ${date} | ${item.padEnd(10, '　').slice(0, 10)} | ¥${formattedAmount.padStart(6, ' ')} | ${payer} | ${type}`;
      }).join('\n');

      return {
        response_type: 'in_channel',
        text: ':ledger: *最近の10項目*\n\n```\n 行  |    日付    |    項目    |   金額   | 立替 | 種別\n' + 
              '-----+------------+------------+----------+------+-----\n' +
              formattedEntries + '\n```\n\n' +
              '_削除する場合: `/pay_delete 行番号`_'
      };
    } catch (error) {
      console.error('Error getting entries:', error);
      return {
        response_type: 'ephemeral',
        text: ':x: データの取得中にエラーが発生しました。もう一度お試しください。'
      };
    }
  }

  async handlePayDelete(text: string): Promise<SlackResponse> {
    const rowNumber = parseInt(text, 10);
    if (isNaN(rowNumber) || rowNumber <= 0) {
      return {
        response_type: 'ephemeral',
        text: ':warning: 正しい行番号を入力してください。\n例: `/pay_delete 5`'
      };
    }

    try {
      const deletedEntry = await this.sheets.deleteEntry(rowNumber);
      
      if (deletedEntry && deletedEntry.length >= 5) {
        const [date, item, payer, splitBill, amount] = deletedEntry;
        const type = splitBill === 'TRUE' ? '割り勘' : '立替';
        const formattedAmount = parseFloat(amount).toLocaleString();
        
        return {
          response_type: 'in_channel',
          text: `:wastebasket: *行番号 ${rowNumber} の項目を削除しました*\n\n` +
                `削除した項目の詳細:\n` +
                `*日付:* ${date}\n` +
                `*項目:* ${item}\n` +
                `*金額:* ¥${formattedAmount}\n` +
                `*立替者:* ${payer}\n` +
                `*タイプ:* ${type}`
        };
      } else {
        return {
          response_type: 'in_channel',
          text: `:wastebasket: 行番号 ${rowNumber} の項目を削除しました。`
        };
      }
    } catch (error) {
      console.error('Error deleting entry:', error);
      return {
        response_type: 'ephemeral',
        text: ':x: データの削除中にエラーが発生しました。行番号を確認してもう一度お試しください。'
      };
    }
  }

  async handlePaySettle(text: string, userId: string): Promise<SlackResponse> {
    const parts = text.trim().split(/\s+/).filter(Boolean);
    if (parts.length < 1 || parts.length > 2) {
      return {
        response_type: 'ephemeral',
        text: ':warning: 使い方: `/pay_settle <金額> [支払者名]`\n例: `/pay_settle 10000` または `/pay_settle 10000 土田`'
      };
    }

    const amount = Number(parts[0].replace(/,/g, ''));
    if (!Number.isFinite(amount) || amount <= 0) {
      return {
        response_type: 'ephemeral',
        text: ':x: 精算額は0より大きい数値で入力してください。\n例: `/pay_settle 10000`'
      };
    }

    const paidBy = (parts[1] || payerFromUserId(userId)) as PaymentEntry['payer'] | null;
    if (paidBy !== '土田' && paidBy !== '加藤') {
      return {
        response_type: 'ephemeral',
        text: ':warning: 支払者を「土田」または「加藤」で入力してください。\n例: `/pay_settle 10000 土田`'
      };
    }

    const paidTo = otherPayer(paidBy);
    const entry: PaymentEntry = {
      date: new Date().toISOString().split('T')[0],
      item: `精算（${paidBy}→${paidTo}）`,
      payer: paidTo,
      splitBill: false,
      amount: -amount
    };

    try {
      await this.sheets.addEntry(entry);
      return {
        response_type: 'in_channel',
        text: ':handshake: *精算を記録しました！*\n\n' +
              `*支払者:* ${paidBy}\n` +
              `*受取者:* ${paidTo}\n` +
              `*金額:* ¥${amount.toLocaleString('ja-JP')}`
      };
    } catch (error) {
      console.error('Error settling amount:', error);
      return {
        response_type: 'ephemeral',
        text: ':x: 精算の記録中にエラーが発生しました。もう一度お試しください。'
      };
    }
  }

  async handlePayAmount(): Promise<SlackResponse> {
    try {
      const data = await this.sheets.getUnsettledAmounts();
      
      if (data.length <= 1) {
        return {
          response_type: 'in_channel',
          text: ':white_check_mark: 未清算金額はありません！'
        };
      }
      
      const amounts = data.slice(1).map(row => {
        const name = row[0];
        const amount = parseFloat(row[1]);
        const emoji = amount > 0 ? ':moneybag:' : ':money_with_wings:';
        const prefix = amount > 0 ? '支払' : '受取';
        return `${emoji} *${name}:* ${prefix} ¥${Math.abs(amount).toLocaleString()}`;
      }).join('\n');

      return {
        response_type: 'in_channel',
        text: ':bank: *未清算金額*\n\n' + amounts + '\n\n_正の値は受け取り、負の値は支払いを示します_'
      };
    } catch (error) {
      console.error('Error getting amounts:', error);
      return {
        response_type: 'ephemeral',
        text: ':x: データの取得中にエラーが発生しました。もう一度お試しください。'
      };
    }
  }
}
