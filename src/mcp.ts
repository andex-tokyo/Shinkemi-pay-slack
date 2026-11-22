import { ApiHandler } from './api';
import { Env, Payer } from './types';

type JsonRpcRequest = {
  jsonrpc?: unknown;
  id?: string | number | null;
  method?: unknown;
  params?: unknown;
};

type JsonObject = Record<string, unknown>;

type McpActor = {
  payer: Payer;
  apiKey: string;
};

const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'] as const;
const DEFAULT_PROTOCOL_VERSION = '2025-06-18';
const SERVER_INFO = { name: 'shinkemi-pay', version: '1.0.0' };
const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept, Mcp-Protocol-Version, Mcp-Session-Id',
  'Access-Control-Expose-Headers': 'Mcp-Session-Id'
};

const toolDefinitions = [
  {
    name: 'addPayEntry',
    description: '土田が立て替えた割り勘の支払いを登録する。項目名と金額が明確で、ユーザーが登録を依頼した時だけ呼ぶ。再試行すると重複する。',
    inputSchema: entrySchema(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  },
  {
    name: 'addTatekaeEntry',
    description: '土田が立て替えた割り勘しない支払いを登録する。項目名と金額が明確で、ユーザーが登録を依頼した時だけ呼ぶ。再試行すると重複する。',
    inputSchema: entrySchema(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  },
  {
    name: 'settlePayment',
    description: '土田が加藤へ実際に支払った精算額を記録する。支払い済みで金額が明確な場合だけ呼ぶ。予定や希望では呼ばない。再試行すると重複する。',
    inputSchema: amountSchema(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  },
  {
    name: 'listPayEntries',
    description: '最近10件の支払い・立替・精算履歴と、削除に使うシート行番号を取得する。',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  },
  {
    name: 'deletePayEntry',
    description: '指定したシート行番号の1行を削除する。行番号を推測しない。行1は見出しなので削除できない。行番号は削除後に変わり得る。',
    inputSchema: {
      type: 'object',
      properties: {
        rowNumber: {
          type: 'integer',
          minimum: 2,
          description: '削除対象のシート行番号（2以上。1行目は見出し）'
        }
      },
      required: ['rowNumber']
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
  },
  {
    name: 'getUnsettledAmounts',
    description: '未清算金額を取得する。正の値はその人が相手へ支払う額、負の値はその人が相手から受け取る額。',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  }
];

function timingSafeEqual(a: string, b: string): boolean {
  const bytesA = new TextEncoder().encode(a);
  const bytesB = new TextEncoder().encode(b);
  if (bytesA.length !== bytesB.length || bytesA.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < bytesA.length; i++) {
    diff |= bytesA[i] ^ bytesB[i];
  }
  return diff === 0;
}

function secretActorForPath(pathname: string, env: Env): McpActor | null {
  if (!pathname.startsWith('/mcp/s/')) return null;
  const token = pathname.slice('/mcp/s/'.length);
  if (!token || token.includes('/')) return null;

  const tsuchidaToken = env.MCP_SECRET_TOKEN_TSUCHIDA?.trim() || '';
  const katoToken = env.MCP_SECRET_TOKEN_KATO?.trim() || '';
  if (tsuchidaToken && katoToken && timingSafeEqual(tsuchidaToken, katoToken)) {
    return null;
  }

  if (tsuchidaToken && env.CHATGPT_ACTION_API_KEY_TSUCHIDA && timingSafeEqual(token, tsuchidaToken)) {
    return { payer: '土田', apiKey: env.CHATGPT_ACTION_API_KEY_TSUCHIDA };
  }
  if (katoToken && env.CHATGPT_ACTION_API_KEY_KATO && timingSafeEqual(token, katoToken)) {
    return { payer: '加藤', apiKey: env.CHATGPT_ACTION_API_KEY_KATO };
  }
  return null;
}

function toolsFor(payer: Payer) {
  if (payer === '土田') return toolDefinitions;
  return toolDefinitions.map(tool => ({
    ...tool,
    description: tool.description.replaceAll('土田', 'PERSON').replaceAll('加藤', '土田').replaceAll('PERSON', '加藤')
  }));
}

function entrySchema(): JsonObject {
  return {
    type: 'object',
    properties: {
      item: { type: 'string', minLength: 1, description: '項目名（例: ランチ）' },
      amount: { type: 'number', minimum: 1, description: '金額（正の数値、円）' }
    },
    required: ['item', 'amount']
  };
}

function amountSchema(): JsonObject {
  return {
    type: 'object',
    properties: {
      amount: { type: 'number', minimum: 1, description: '精算金額（正の数値、円）' }
    },
    required: ['amount']
  };
}

function negotiateProtocolVersion(params: unknown): string {
  if (params && typeof params === 'object' && !Array.isArray(params)) {
    const requested = (params as JsonObject).protocolVersion;
    if (typeof requested === 'string' &&
      (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)) {
      return requested;
    }
  }
  return DEFAULT_PROTOCOL_VERSION;
}

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS, ...headers }
  });
}

function rpcResult(id: string | number | null, result: unknown): Response {
  return json({ jsonrpc: '2.0', id, result });
}

function rpcError(id: string | number | null, code: number, message: string): Response {
  return json({ jsonrpc: '2.0', id, error: { code, message } });
}

function toolError(message: string): JsonObject {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

function validateArguments(name: string, args: unknown): string | null {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return '引数が正しくありません。';
  const values = args as JsonObject;
  const allowed = name === 'addPayEntry' || name === 'addTatekaeEntry'
    ? ['item', 'amount'] : name === 'settlePayment' ? ['amount']
      : name === 'deletePayEntry' ? ['rowNumber'] : [];
  if (Object.keys(values).some(key => !allowed.includes(key))) return '指定できない引数があります。';
  if (allowed.includes('item') && (typeof values.item !== 'string' || !values.item.trim())) return '項目名が必要です。';
  if (allowed.includes('amount') && (typeof values.amount !== 'number' || !Number.isFinite(values.amount) || values.amount <= 0)) return '正の金額が必要です。';
  if (allowed.includes('rowNumber') && (!Number.isInteger(values.rowNumber) || (values.rowNumber as number) < 2)) return '2以上の行番号が必要です。';
  return null;
}

async function callTool(name: string, args: unknown, env: Env, ctx: ExecutionContext, origin: string, actor: McpActor): Promise<JsonObject> {
  if (!toolDefinitions.some(tool => tool.name === name)) return toolError('操作が見つかりません。');
  const validation = validateArguments(name, args);
  if (validation) return toolError(validation);

  const values = args as JsonObject;
  const route: Record<string, [string, string]> = {
    addPayEntry: ['POST', '/api/pay'],
    addTatekaeEntry: ['POST', '/api/tatekae'],
    settlePayment: ['POST', '/api/settle'],
    listPayEntries: ['GET', '/api/list'],
    deletePayEntry: ['DELETE', `/api/entries/${values.rowNumber}`],
    getUnsettledAmounts: ['GET', '/api/amount']
  };
  const [method, path] = route[name];
  const internalRequest = new Request(new URL(path, origin), {
    method,
    headers: {
      Authorization: `Bearer ${actor.apiKey}`,
      'Content-Type': 'application/json'
    },
    ...(method === 'POST' ? { body: JSON.stringify(values) } : {})
  });
  const response = await new ApiHandler(env, actor.payer, ctx).handle(internalRequest);
  const body = await response.json() as JsonObject;
  if (!response.ok || body.ok !== true) {
    return toolError(typeof body.error === 'string' ? body.error : '操作の結果を確認できませんでした。');
  }
  return {
    content: [{ type: 'text', text: JSON.stringify(body) }],
    structuredContent: body
  };
}

export async function handleMcpRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const url = new URL(request.url);
  const actor = secretActorForPath(url.pathname, env);
  if (!actor) {
    return json({ error: 'Not Found' }, 404);
  }

  if (request.method !== 'POST') {
    return new Response(null, { status: 405, headers: { Allow: 'POST, OPTIONS', ...CORS_HEADERS } });
  }

  let rpc: JsonRpcRequest;
  try {
    rpc = await request.json() as JsonRpcRequest;
  } catch {
    return rpcError(null, -32700, 'Parse error');
  }
  if (!rpc || typeof rpc !== 'object' || rpc.jsonrpc !== '2.0' || typeof rpc.method !== 'string') {
    return rpcError(null, -32600, 'Invalid Request');
  }
  if (rpc.id === undefined) return new Response(null, { status: 202, headers: CORS_HEADERS });
  if (typeof rpc.id !== 'string' && typeof rpc.id !== 'number') return rpcError(null, -32600, 'Invalid Request');

  if (rpc.method === 'initialize') {
    return rpcResult(rpc.id, {
      protocolVersion: negotiateProtocolVersion(rpc.params),
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
      instructions: `${actor.payer}専用の支払い記録。書き込み結果が不明な時は再試行しない。`
    });
  }
  if (rpc.method === 'ping') return rpcResult(rpc.id, {});
  if (rpc.method === 'tools/list') return rpcResult(rpc.id, { tools: toolsFor(actor.payer) });
  if (rpc.method === 'tools/call') {
    const params = rpc.params as JsonObject | undefined;
    if (!params || typeof params.name !== 'string') return rpcError(rpc.id, -32602, 'Invalid params');
    try {
      return rpcResult(rpc.id, await callTool(params.name, params.arguments || {}, env, ctx, url.origin, actor));
    } catch {
      return rpcResult(rpc.id, toolError('操作の結果を確認できませんでした。自動で再実行しないでください。'));
    }
  }
  return rpcError(rpc.id, -32601, 'Method not found');
}
