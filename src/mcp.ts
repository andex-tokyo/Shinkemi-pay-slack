import { ApiHandler } from './api';
import { Env } from './types';

type JsonRpcRequest = {
  jsonrpc?: unknown;
  id?: string | number | null;
  method?: unknown;
  params?: unknown;
};

type JsonObject = Record<string, unknown>;

const PROTOCOL_VERSION = '2025-03-26';
const SERVER_INFO = { name: 'shinkemi-pay', version: '1.0.0' };
const AUTH_SCHEMES = [{ type: 'oauth2', scopes: ['shinkemi:pay'] }];

const tools = [
  {
    name: 'addPayEntry',
    description: '土田が立て替えた割り勘の支払いを登録する。項目名と金額が明確で、ユーザーが登録を依頼した時だけ呼ぶ。再試行すると重複する。',
    inputSchema: entrySchema(),
    securitySchemes: AUTH_SCHEMES,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  },
  {
    name: 'addTatekaeEntry',
    description: '土田が立て替えた割り勘しない支払いを登録する。項目名と金額が明確で、ユーザーが登録を依頼した時だけ呼ぶ。再試行すると重複する。',
    inputSchema: entrySchema(),
    securitySchemes: AUTH_SCHEMES,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  },
  {
    name: 'settlePayment',
    description: '土田が加藤へ実際に支払った精算額を記録する。支払い済みで金額が明確な場合だけ呼ぶ。予定や希望では呼ばない。再試行すると重複する。',
    inputSchema: amountSchema(),
    securitySchemes: AUTH_SCHEMES,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  },
  {
    name: 'listPayEntries',
    description: '最近10件の支払い・立替・精算履歴と、削除に使うシート行番号を取得する。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    securitySchemes: AUTH_SCHEMES,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  },
  {
    name: 'deletePayEntry',
    description: '指定したシート行番号の1行を削除する。行番号を推測しない。行1は見出しなので削除できない。行番号は削除後に変わり得る。',
    inputSchema: {
      type: 'object',
      properties: { rowNumber: { type: 'integer', minimum: 2 } },
      required: ['rowNumber'],
      additionalProperties: false
    },
    securitySchemes: AUTH_SCHEMES,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
  },
  {
    name: 'getUnsettledAmounts',
    description: '未清算金額を取得する。正の値はその人が相手へ支払う額、負の値はその人が相手から受け取る額。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    securitySchemes: AUTH_SCHEMES,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  }
];

function entrySchema(): JsonObject {
  return {
    type: 'object',
    properties: {
      item: { type: 'string', minLength: 1 },
      amount: { type: 'number', exclusiveMinimum: 0 }
    },
    required: ['item', 'amount'],
    additionalProperties: false
  };
}

function amountSchema(): JsonObject {
  return {
    type: 'object',
    properties: { amount: { type: 'number', exclusiveMinimum: 0 } },
    required: ['amount'],
    additionalProperties: false
  };
}

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers }
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

function authChallenge(origin: string, scope: string): string {
  return `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource", scope="${scope}", error="invalid_token", error_description="Sign in to use Shinkemi Pay"`;
}

function authToolError(origin: string, scope: string): JsonObject {
  return {
    ...toolError('認証が必要です。'),
    _meta: { 'mcp/www_authenticate': [authChallenge(origin, scope)] }
  };
}

function base64UrlDecode(value: string): Uint8Array {
  const padding = '='.repeat((4 - value.length % 4) % 4);
  const bytes = atob((value + padding).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bytes, char => char.charCodeAt(0));
}

function decodeJsonPart(value: string): JsonObject {
  const parsed = JSON.parse(new TextDecoder().decode(base64UrlDecode(value))) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid JWT');
  return parsed as JsonObject;
}

let jwksCache: { issuer: string; keys: JsonWebKey[]; expires: number } | undefined;

async function getJwks(issuer: string): Promise<JsonWebKey[]> {
  if (jwksCache?.issuer === issuer && jwksCache.expires > Date.now()) return jwksCache.keys;
  const url = new URL('.well-known/jwks.json', issuer);
  const response = await fetch(url);
  if (!response.ok) throw new Error('JWKS unavailable');
  const body = await response.json() as { keys?: JsonWebKey[] };
  if (!Array.isArray(body.keys)) throw new Error('Invalid JWKS');
  jwksCache = { issuer, keys: body.keys, expires: Date.now() + 5 * 60_000 };
  return body.keys;
}

async function authorized(request: Request, env: Env): Promise<boolean> {
  if (!env.MCP_OAUTH_ISSUER || !env.MCP_OAUTH_AUDIENCE || !env.MCP_AUTHORIZED_SUBJECT) return false;
  const authorization = request.headers.get('Authorization') || '';
  if (!authorization.startsWith('Bearer ')) return false;
  const parts = authorization.slice(7).split('.');
  if (parts.length !== 3) return false;

  try {
    const header = decodeJsonPart(parts[0]);
    const payload = decodeJsonPart(parts[1]);
    const issuer = env.MCP_OAUTH_ISSUER.endsWith('/') ? env.MCP_OAUTH_ISSUER : `${env.MCP_OAUTH_ISSUER}/`;
    const audience = payload.aud;
    const now = Math.floor(Date.now() / 1000);
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') return false;
    if (payload.iss !== issuer || payload.sub !== env.MCP_AUTHORIZED_SUBJECT) return false;
    if (!(audience === env.MCP_OAUTH_AUDIENCE ||
      (Array.isArray(audience) && audience.includes(env.MCP_OAUTH_AUDIENCE)))) return false;
    if (typeof payload.exp !== 'number' || payload.exp <= now) return false;
    if (typeof payload.nbf === 'number' && payload.nbf > now) return false;
    const scope = env.MCP_REQUIRED_SCOPE || 'shinkemi:pay';
    if (typeof payload.scope !== 'string' || !payload.scope.split(' ').includes(scope)) return false;
    const keys = await getJwks(issuer);
    const jwk = keys.find(key => (key as JsonWebKey & { kid?: string }).kid === header.kid && key.kty === 'RSA' && (!key.use || key.use === 'sig'));
    if (!jwk) return false;
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    return crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, base64UrlDecode(parts[2]), signed);
  } catch {
    return false;
  }
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

async function callTool(name: string, args: unknown, env: Env, ctx: ExecutionContext, origin: string): Promise<JsonObject> {
  if (!tools.some(tool => tool.name === name)) return toolError('操作が見つかりません。');
  const validation = validateArguments(name, args);
  if (validation) return toolError(validation);
  if (!env.CHATGPT_ACTION_API_KEY_TSUCHIDA) return toolError('土田用のAPI認証が設定されていません。');

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
      Authorization: `Bearer ${env.CHATGPT_ACTION_API_KEY_TSUCHIDA}`,
      'Content-Type': 'application/json'
    },
    ...(method === 'POST' ? { body: JSON.stringify(values) } : {})
  });
  const response = await new ApiHandler(env, '土田', ctx).handle(internalRequest);
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
  const url = new URL(request.url);
  if (url.pathname === '/.well-known/oauth-protected-resource') {
    if (request.method !== 'GET') return new Response(null, { status: 405 });
    if (!env.MCP_OAUTH_ISSUER) return json({ error: 'MCP OAuth is not configured' }, 503);
    return json({
      resource: `${url.origin}/mcp`,
      authorization_servers: [env.MCP_OAUTH_ISSUER],
      scopes_supported: [env.MCP_REQUIRED_SCOPE || 'shinkemi:pay'],
      bearer_methods_supported: ['header']
    });
  }
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } });
  let rpc: JsonRpcRequest;
  try {
    rpc = await request.json() as JsonRpcRequest;
  } catch {
    return rpcError(null, -32700, 'Parse error');
  }
  if (!rpc || typeof rpc !== 'object' || rpc.jsonrpc !== '2.0' || typeof rpc.method !== 'string') {
    return rpcError(null, -32600, 'Invalid Request');
  }
  if (rpc.id === undefined) return new Response(null, { status: 202 });
  if (typeof rpc.id !== 'string' && typeof rpc.id !== 'number') return rpcError(null, -32600, 'Invalid Request');

  if (rpc.method === 'initialize') {
    return rpcResult(rpc.id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
      instructions: '土田専用の支払い記録。書き込み結果が不明な時は再試行しない。'
    });
  }
  if (rpc.method === 'ping') return rpcResult(rpc.id, {});
  if (rpc.method === 'tools/list') return rpcResult(rpc.id, { tools });
  if (rpc.method === 'tools/call') {
    const params = rpc.params as JsonObject | undefined;
    if (!params || typeof params.name !== 'string') return rpcError(rpc.id, -32602, 'Invalid params');
    if (!await authorized(request, env)) {
      return rpcResult(rpc.id, authToolError(url.origin, env.MCP_REQUIRED_SCOPE || 'shinkemi:pay'));
    }
    try {
      return rpcResult(rpc.id, await callTool(params.name, params.arguments || {}, env, ctx, url.origin));
    } catch {
      return rpcResult(rpc.id, toolError('操作の結果を確認できませんでした。自動で再実行しないでください。'));
    }
  }
  return rpcError(rpc.id, -32601, 'Method not found');
}
