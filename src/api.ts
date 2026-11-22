import { PaymentService } from './payment-service';
import { SheetError } from './sheets';
import { ApiPaymentRequest, ApiSettlementRequest, Env, Payer } from './types';
import { timingSafeEqual } from './utils';

const API_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8'
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: API_HEADERS
  });
}

async function readJson<T>(request: Request): Promise<T | null> {
  try {
    return await request.json() as T;
  } catch {
    return null;
  }
}

function validateEntryRequest(
  body: ApiPaymentRequest | null,
  payer: Payer,
  fixedSplitBill?: boolean
): string | { item: string; amount: number; splitBill: boolean } {
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

  return {
    item: body.item.trim(),
    amount: body.amount,
    splitBill: fixedSplitBill ?? body.splitBill === true
  };
}

export class ApiHandler {
  private service: PaymentService;
  private payer: Payer;

  constructor(env: Env, payer: Payer, ctx: ExecutionContext, notificationSource = 'ChatGPTから') {
    this.service = new PaymentService(env, payer, ctx, notificationSource);
    this.payer = payer;
  }

  static getAuthenticatedPayer(request: Request, env: Env): Payer | null {
    const authorization = request.headers.get('Authorization') || '';
    if (!authorization.startsWith('Bearer ')) {
      return null;
    }

    const token = authorization.slice('Bearer '.length);
    const tsuchidaKey = env.CHATGPT_ACTION_API_KEY_TSUCHIDA || '';
    const katoKey = env.CHATGPT_ACTION_API_KEY_KATO || '';

    if (tsuchidaKey && katoKey && timingSafeEqual(tsuchidaKey, katoKey)) {
      return null;
    }

    if (tsuchidaKey && timingSafeEqual(token, tsuchidaKey)) {
      return '土田';
    }

    if (katoKey && timingSafeEqual(token, katoKey)) {
      return '加藤';
    }

    return null;
  }

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;

    try {
      if (pathname === '/api/pay' && request.method === 'POST') {
        return await this.addEntry(request, true);
      }

      if (pathname === '/api/tatekae' && request.method === 'POST') {
        return await this.addEntry(request, false);
      }

      if (pathname === '/api/settle' && request.method === 'POST') {
        return await this.settle(request);
      }

      if (pathname === '/api/list' && request.method === 'GET') {
        return jsonResponse(await this.service.listEntries());
      }

      if (pathname === '/api/amount' && request.method === 'GET') {
        return jsonResponse(await this.service.getUnsettledAmounts());
      }

      const deleteMatch = pathname.match(/^\/api\/entries\/(\d+)$/);
      if (deleteMatch && request.method === 'DELETE') {
        return await this.deleteEntry(Number(deleteMatch[1]));
      }

      return jsonResponse({ ok: false, error: 'Not Found' }, 404);
    } catch (error) {
      if (error instanceof SheetError) {
        return jsonResponse({ ok: false, error: error.message }, error.statusCode);
      }
      console.error('API error:', error);
      return jsonResponse({ ok: false, error: 'Internal Server Error' }, 500);
    }
  }

  private async addEntry(request: Request, splitBill: boolean): Promise<Response> {
    const body = await readJson<ApiPaymentRequest>(request);
    const entryOrError = validateEntryRequest(body, this.payer, splitBill);

    if (typeof entryOrError === 'string') {
      return jsonResponse({ ok: false, error: entryOrError }, 400);
    }

    const result = await this.service.addEntry(entryOrError.item, entryOrError.amount, entryOrError.splitBill);
    return jsonResponse(result);
  }

  private async settle(request: Request): Promise<Response> {
    const body = await readJson<ApiSettlementRequest>(request);
    if (!body) {
      return jsonResponse({ ok: false, error: 'Request body must be valid JSON' }, 400);
    }

    if (typeof body.amount !== 'number' || !Number.isFinite(body.amount) || body.amount <= 0) {
      return jsonResponse({ ok: false, error: 'amount must be a number greater than 0' }, 400);
    }

    const result = await this.service.settle(body.amount);
    return jsonResponse(result);
  }

  private async deleteEntry(rowNumber: number): Promise<Response> {
    if (!Number.isInteger(rowNumber) || rowNumber < 2) {
      return jsonResponse({ ok: false, error: 'rowNumber must be an integer greater than or equal to 2' }, 400);
    }

    const result = await this.service.deleteEntry(rowNumber);
    return jsonResponse(result);
  }
}

export function unauthorizedResponse(): Response {
  return jsonResponse({ ok: false, error: 'Unauthorized' }, 401);
}
