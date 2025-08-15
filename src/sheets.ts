import { PaymentEntry } from './types';
import { GoogleAuth } from './google-auth';

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
        entry.item,
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

    const data = await response.json();
    const values = data.values || [];
    const totalRows = values.length;
    const startIndex = Math.max(0, values.length - count);
    return {
      entries: values.slice(startIndex),
      totalRows: totalRows
    };
  }

  async deleteEntry(rowNumber: number): Promise<string[]> {
    const accessToken = await this.auth.getAccessToken();
    
    // First, get the entry data before deleting
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

    const getData = await getResponse.json();
    const deletedEntry = getData.values ? getData.values[0] : [];

    // Get the sheet ID
    const sheetsResponse = await fetch(`${this.baseUrl}/${this.spreadsheetId}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
      }
    });

    if (!sheetsResponse.ok) {
      throw new Error(`Failed to get spreadsheet info: ${await sheetsResponse.text()}`);
    }

    const sheetsData = await sheetsResponse.json();
    const sheet = sheetsData.sheets.find((s: any) => s.properties.title === '入力');
    
    if (!sheet) {
      throw new Error('Sheet "入力" not found');
    }

    const sheetId = sheet.properties.sheetId;

    // Delete the row
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
              sheetId: sheetId,
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
    const url = `${this.baseUrl}/${this.spreadsheetId}/values/${range}`;
    
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
      }
    });

    if (!response.ok) {
      throw new Error(`Failed to get unsettled amounts: ${await response.text()}`);
    }

    const data = await response.json();
    return data.values || [];
  }
}