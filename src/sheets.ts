import { PaymentEntry } from './types';
import { GoogleAuth } from './google-auth';
import { sanitizeSheetCell } from './utils';

interface ValuesResponse {
  values?: unknown[][];
}

interface SpreadsheetResponse {
  sheets?: Array<{
    properties: {
      title: string;
      sheetId: number;
    };
  }>;
}

export class SheetError extends Error {
  constructor(message: string, public readonly statusCode: number) {
    super(message);
    this.name = 'SheetError';
  }
}

const sheetIdCache = new Map<string, number>();

export class SheetsService {
  private spreadsheetId: string;
  private auth: GoogleAuth;
  private baseUrl = 'https://sheets.googleapis.com/v4/spreadsheets';

  constructor(spreadsheetId: string, serviceAccountKey: string) {
    this.spreadsheetId = spreadsheetId;
    this.auth = new GoogleAuth(serviceAccountKey);
  }

  async addEntry(entry: PaymentEntry): Promise<void> {
    const accessToken = await this.auth.getAccessToken();

    const range = encodeURIComponent('入力!A:E');
    const url = `${this.baseUrl}/${this.spreadsheetId}/values/${range}:append?valueInputOption=USER_ENTERED`;

    const requestBody = {
      values: [[
        entry.date,
        sanitizeSheetCell(entry.item),
        entry.payer,
        entry.splitBill ? 'TRUE' : 'FALSE',
        entry.amount
      ]]
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to add entry: ${errorText}`);
    }
  }

  async getRecentEntries(count: number = 10): Promise<{ entries: string[][], totalRows: number }> {
    const accessToken = await this.auth.getAccessToken();

    const range = encodeURIComponent('入力!A:E');
    const url = `${this.baseUrl}/${this.spreadsheetId}/values/${range}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
      }
    });

    if (!response.ok) {
      throw new Error(`Failed to get entries: ${await response.text()}`);
    }

    const data = await response.json() as ValuesResponse;
    const values = (data.values || []).map(row => row.map(value => String(value)));
    const totalRows = values.length;
    if (totalRows <= 1) {
      return { entries: [], totalRows };
    }

    const startIndex = Math.max(1, totalRows - count);
    return {
      entries: values.slice(startIndex),
      totalRows
    };
  }

  async deleteEntry(rowNumber: number): Promise<string[]> {
    if (!Number.isInteger(rowNumber) || rowNumber < 2) {
      throw new SheetError('行番号は2以上の整数を指定してください（1行目は見出しのため削除できません）', 400);
    }

    const accessToken = await this.auth.getAccessToken();

    const range = encodeURIComponent(`入力!A${rowNumber}:E${rowNumber}`);
    const getUrl = `${this.baseUrl}/${this.spreadsheetId}/values/${range}`;

    const getResponse = await fetch(getUrl, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
      }
    });

    if (!getResponse.ok) {
      throw new Error(`Failed to get entry data: ${await getResponse.text()}`);
    }

    const getData = await getResponse.json() as ValuesResponse;
    const deletedEntry = getData.values?.[0]?.map(value => String(value)) || [];
    if (deletedEntry.length === 0 || deletedEntry.every(value => value.trim() === '')) {
      throw new SheetError(`行番号 ${rowNumber} にデータが見つかりません`, 404);
    }

    const sheetId = await this.getInputSheetId(accessToken);

    const url = `${this.baseUrl}/${this.spreadsheetId}:batchUpdate`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        requests: [{
          deleteDimension: {
            range: {
              sheetId,
              dimension: 'ROWS',
              startIndex: rowNumber - 1,
              endIndex: rowNumber
            }
          }
        }]
      })
    });

    if (!response.ok) {
      throw new Error(`Failed to delete entry: ${await response.text()}`);
    }

    return deletedEntry;
  }

  async getUnsettledAmounts(): Promise<string[][]> {
    const accessToken = await this.auth.getAccessToken();

    const range = encodeURIComponent('未清算金額!A:B');
    const url = `${this.baseUrl}/${this.spreadsheetId}/values/${range}?valueRenderOption=UNFORMATTED_VALUE`;

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
      }
    });

    if (!response.ok) {
      throw new Error(`Failed to get unsettled amounts: ${await response.text()}`);
    }

    const data = await response.json() as ValuesResponse;
    return (data.values || []).map(row => row.map(value => String(value)));
  }

  private async getInputSheetId(accessToken: string): Promise<number> {
    const cacheKey = `${this.spreadsheetId}:入力`;
    const cached = sheetIdCache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    const fields = encodeURIComponent('sheets.properties(sheetId,title)');
    const sheetsResponse = await fetch(`${this.baseUrl}/${this.spreadsheetId}?fields=${fields}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
      }
    });

    if (!sheetsResponse.ok) {
      throw new Error(`Failed to get spreadsheet info: ${await sheetsResponse.text()}`);
    }

    const sheetsData = await sheetsResponse.json() as SpreadsheetResponse;
    const sheet = sheetsData.sheets?.find(s => s.properties.title === '入力');

    if (!sheet) {
      throw new Error('Sheet "入力" not found');
    }

    sheetIdCache.set(cacheKey, sheet.properties.sheetId);
    return sheet.properties.sheetId;
  }
}
