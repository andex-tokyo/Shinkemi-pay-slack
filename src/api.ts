import { SheetsService } from './sheets';
import { ApiPaymentRequest, Env, PaymentEntry, Payer } from './types';

const API_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8'
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: API_HEADERS
  });
}

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

async function readJson(request: Request): Promise<ApiPaymentRequest | null> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function validateEntryRequest(body: ApiPaymentRequest | null, payer: Payer, fixedSplitBill?: boolean): string | PaymentEntry {
  if (!body) {
    return 'Request body must be valid JSON';
  }

  if (typeof body.item !== 'string' || body.item.trim() === '') {
    return 'item is required';
  }

  if (body.amount === undefined || body.amount === null || body.amount === '') {
    return 'amount is required';
  }

  if (typeof body.amount !== 'number' || !Number.isFinite(body.amount)) {
    return 'amount must be a number';
  }

  if (body.amount <= 0) {
    return 'amount must be greater than 0';
  }

  if (body.payer !== undefined && body.payer !== payer) {
    return `payer is fixed as ${payer} by API key`;
  }

  const splitBill = fixedSplitBill ?? body.splitBill === true;
  return {
    date: new Date().toISOString().split('T')[0],
    item: body.item.trim(),
    amount: body.amount,
    payer,
    splitBill
  };
}

export class ApiHandler {
  private sheets: SheetsService;
  private payer: Payer;

  constructor(env: Env, payer: Payer) {
    this.sheets = new SheetsService(env.SPREADSHEET_ID, env.GOOGLE_SERVICE_ACCOUNT_KEY);
    this.payer = payer;
  }

  static getAuthenticatedPayer(request: Request, env: Env): Payer | null {
    const authorization = request.headers.get('Authorization');
    if (env.CHATGPT_ACTION_API_KEY_TSUCHIDA && authorization === `Bearer ${env.CHATGPT_ACTION_API_KEY_TSUCHIDA}`) {
      return '土田';
    }

    if (env.CHATGPT_ACTION_API_KEY_KATO && authorization === `Bearer ${env.CHATGPT_ACTION_API_KEY_KATO}`) {
      return '加藤';
    }

    return null;
  }

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;

    try {
      if (pathname === '/api/pay' && request.method === 'POST') {
        return this.addEntry(request, true, '割り勘項目を追加しました');
      }

      if (pathname === '/api/tatekae' && request.method === 'POST') {
        return this.addEntry(request, false, '立替項目を追加しました');
      }

      if (pathname === '/api/list' && request.method === 'GET') {
        return this.listEntries();
      }

      if (pathname === '/api/amount' && request.method === 'GET') {
        return this.getUnsettledAmounts();
      }

      const deleteMatch = pathname.match(/^\/api\/entries\/(\d+)$/);
      if (deleteMatch && request.method === 'DELETE') {
        return this.deleteEntry(Number(deleteMatch[1]));
      }

      return jsonResponse({ ok: false, error: 'Not Found' }, 404);
    } catch (error) {
      console.error('API error:', error);
      return jsonResponse({ ok: false, error: 'Internal Server Error' }, 500);
    }
  }

  private async addEntry(request: Request, splitBill: boolean, message: string): Promise<Response> {
    const body = await readJson(request);
    const entryOrError = validateEntryRequest(body, this.payer, splitBill);

    if (typeof entryOrError === 'string') {
      return jsonResponse({ ok: false, error: entryOrError }, 400);
    }

    await this.sheets.addEntry(entryOrError);
    return jsonResponse({
      ok: true,
      message,
      entry: entryOrError
    });
  }

  private async listEntries(): Promise<Response> {
    const { entries, totalRows } = await this.sheets.getRecentEntries(10);
    const startRow = totalRows - entries.length + 1;

    return jsonResponse({
      ok: true,
      entries: entries.map((row, index) => parseSheetEntry(row, startRow + index))
    });
  }

  private async deleteEntry(rowNumber: number): Promise<Response> {
    if (!Number.isInteger(rowNumber) || rowNumber <= 0) {
      return jsonResponse({ ok: false, error: 'rowNumber must be a positive integer' }, 400);
    }

    const deletedEntry = await this.sheets.deleteEntry(rowNumber);
    return jsonResponse({
      ok: true,
      message: `行番号 ${rowNumber} の項目を削除しました`,
      deletedEntry: deletedEntry.length > 0 ? parseSheetEntry(deletedEntry) : null
    });
  }

  private async getUnsettledAmounts(): Promise<Response> {
    const data = await this.sheets.getUnsettledAmounts();
    const amounts = data.slice(1).map(row => ({
      name: row[0] || '',
      amount: Number(row[1] || 0)
    }));

    return jsonResponse({
      ok: true,
      amounts
    });
  }
}

export function unauthorizedResponse(): Response {
  return jsonResponse({ ok: false, error: 'Unauthorized' }, 401);
}
