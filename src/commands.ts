import { SlackResponse, PaymentEntry } from './types';
import { SheetsService } from './sheets';

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
      switch (userId) {
        case 'U075AS43YKT':
          payer = '加藤';
          break;
        case 'U074HKBTAF9':
          payer = '土田';
          break;
        default:
          return {
            response_type: 'ephemeral',
            text: ':warning: 立替者を入力してください。\n例: `/pay ランチ 1200 土田`'
          };
      }
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
        const emoji = amount > 0 ? ':money_with_wings:' : ':moneybag:';
        const prefix = amount > 0 ? '受取' : '支払';
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