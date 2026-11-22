import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const bundle = await readFile(new URL('../dist/index.js', import.meta.url));
const worker = (await import(`data:text/javascript;base64,${bundle.toString('base64')}`)).default;
const origin = 'https://shinkemi-pay-slack.tsuchida.workers.dev';
const env = {
  SPREADSHEET_ID: 'test-sheet-id',
  MCP_SECRET_TOKEN_TSUCHIDA: 'secret-token-tsuchida-12345',
  MCP_SECRET_TOKEN_KATO: 'secret-token-kato-67890'
};
const context = { waitUntil() {} };
const tsuchidaUrl = `${origin}/mcp/s/${env.MCP_SECRET_TOKEN_TSUCHIDA}`;
const katoUrl = `${origin}/mcp/s/${env.MCP_SECRET_TOKEN_KATO}`;

function request(body, resource = tsuchidaUrl) {
  return new Request(resource, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

async function createServiceAccountJson(email) {
  const pair = await webcrypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify']
  );
  const pkcs8 = Buffer.from(await webcrypto.subtle.exportKey('pkcs8', pair.privateKey)).toString('base64');
  const pem = `-----BEGIN PRIVATE KEY-----\n${pkcs8.match(/.{1,64}/g).join('\n')}\n-----END PRIVATE KEY-----`;
  return JSON.stringify({
    client_email: email,
    private_key_id: 'key-1',
    private_key: pem
  });
}

test('MCP exposes no OAuth metadata and rejects invalid secret paths', async () => {
  for (const path of [
    '/.well-known/oauth-protected-resource',
    '/.well-known/oauth-protected-resource/mcp',
    '/.well-known/oauth-protected-resource/mcp/kato',
    `/.well-known/oauth-protected-resource/mcp/s/${env.MCP_SECRET_TOKEN_TSUCHIDA}`,
    '/.well-known/oauth-authorization-server'
  ]) {
    const res = await worker.fetch(new Request(`${origin}${path}`), env, context);
    assert.equal(res.status, 404, `Expected 404 for ${path}`);
  }

  for (const invalidUrl of [
    `${origin}/mcp/s/wrong-token`,
    `${origin}/mcp/s/`,
    `${origin}/mcp/s/${env.MCP_SECRET_TOKEN_TSUCHIDA}/extra`
  ]) {
    const res = await worker.fetch(request({ jsonrpc: '2.0', id: 1, method: 'initialize' }, invalidUrl), env, context);
    assert.equal(res.status, 404);
  }

  const unconfigured = await worker.fetch(
    request({ jsonrpc: '2.0', id: 2, method: 'initialize' }, tsuchidaUrl),
    {},
    context
  );
  assert.equal(unconfigured.status, 404);

  const duplicateEnv = {
    ...env,
    MCP_SECRET_TOKEN_TSUCHIDA: 'same-token',
    MCP_SECRET_TOKEN_KATO: 'same-token'
  };
  const duplicateRes = await worker.fetch(
    request({ jsonrpc: '2.0', id: 3, method: 'initialize' }, `${origin}/mcp/s/same-token`),
    duplicateEnv,
    context
  );
  assert.equal(duplicateRes.status, 404);
});

test('MCP secret URL endpoints work without API keys for both Tsuchida and Kato', async () => {
  const preflight = await worker.fetch(new Request(tsuchidaUrl, { method: 'OPTIONS' }), env, context);
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), '*');

  for (const [requested, expected] of [
    ['2025-11-25', '2025-11-25'],
    ['2025-06-18', '2025-06-18'],
    ['2025-03-26', '2025-03-26'],
    ['2024-11-05', '2025-06-18']
  ]) {
    const init = await worker.fetch(request({
      jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: requested }
    }, tsuchidaUrl), env, context);
    assert.equal(init.status, 200);
    const body = await init.json();
    assert.equal(body.result.protocolVersion, expected);
    assert.equal(body.result.serverInfo.name, 'shinkemi-pay');
    assert.match(body.result.instructions, /土田専用/);
  }

  const notification = await worker.fetch(request({ jsonrpc: '2.0', method: 'notifications/initialized' }, tsuchidaUrl), env, context);
  assert.equal(notification.status, 202);

  const getMethod = await worker.fetch(new Request(tsuchidaUrl, { method: 'GET' }), env, context);
  assert.equal(getMethod.status, 405);

  const tools = await worker.fetch(request({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, tsuchidaUrl), env, context);
  assert.equal(tools.status, 200);
  const toolsBody = await tools.json();
  assert.equal(toolsBody.result.tools.length, 6);
  assert.equal(toolsBody.result.tools.find(tool => tool.name === 'deletePayEntry').annotations.destructiveHint, true);

  for (const tool of toolsBody.result.tools) {
    assert.equal(tool.securitySchemes, undefined);
    const schemaText = JSON.stringify(tool.inputSchema);
    assert.doesNotMatch(schemaText, /"additionalProperties"/);
    assert.doesNotMatch(schemaText, /"exclusiveMinimum"/);
  }

  const badRow = await worker.fetch(request({
    jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: 'deletePayEntry', arguments: { rowNumber: 1 } }
  }, tsuchidaUrl), env, context);
  assert.equal((await badRow.json()).result.isError, true);

  const extraArg = await worker.fetch(request({
    jsonrpc: '2.0', id: 4, method: 'tools/call',
    params: { name: 'addPayEntry', arguments: { item: 'ランチ', amount: 1200, extra: true } }
  }, tsuchidaUrl), env, context);
  assert.equal((await extraArg.json()).result.isError, true);

  const katoInit = await worker.fetch(request({ jsonrpc: '2.0', id: 5, method: 'initialize' }, katoUrl), env, context);
  assert.equal(katoInit.status, 200);
  assert.match((await katoInit.json()).result.instructions, /加藤専用/);

  const katoTools = await worker.fetch(request({ jsonrpc: '2.0', id: 6, method: 'tools/list' }, katoUrl), env, context);
  const katoToolsBody = await katoTools.json();
  assert.match(katoToolsBody.result.tools[0].description, /加藤が立て替えた/);
  assert.equal(katoToolsBody.result.tools[0].securitySchemes, undefined);
});

test('MCP tools sanitize formulas, cache Google OAuth tokens, and notify Slack as MCP', async () => {
  const saKey = await createServiceAccountJson('mcp-test@example.iam.gserviceaccount.com');
  const fullEnv = {
    ...env,
    GOOGLE_SERVICE_ACCOUNT_KEY: saKey,
    SLACK_WEBHOOK_URL: 'https://hooks.slack.test/services/mcp'
  };

  let tokenFetches = 0;
  let appendedRow = null;
  let batchUpdateCalled = false;
  const slackMessages = [];
  const pending = [];
  const waitCtx = { waitUntil(promise) { pending.push(promise); } };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url === 'https://oauth2.googleapis.com/token') {
      tokenFetches += 1;
      return Response.json({ access_token: 'mock-google-token', expires_in: 3600 });
    }
    if (url.includes(':append')) {
      appendedRow = JSON.parse(init.body).values[0];
      return Response.json({ updates: { updatedRows: 1 } });
    }
    if (url.includes(encodeURIComponent('入力!A99:E99'))) {
      return Response.json({});
    }
    if (url.includes(':batchUpdate')) {
      batchUpdateCalled = true;
      return Response.json({});
    }
    if (url === fullEnv.SLACK_WEBHOOK_URL) {
      slackMessages.push(JSON.parse(init.body).text);
      return new Response('ok', { status: 200 });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    const addRes = await worker.fetch(request({
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: { name: 'addPayEntry', arguments: { item: '=SUM(A1)', amount: 1200 } }
    }, tsuchidaUrl), fullEnv, waitCtx);
    assert.equal(addRes.status, 200);
    const addBody = await addRes.json();
    assert.equal(addBody.result.structuredContent.ok, true);
    assert.equal(appendedRow[1], "'=SUM(A1)");
    assert.equal(appendedRow[2], '土田');

    const deleteMissing = await worker.fetch(request({
      jsonrpc: '2.0',
      id: 11,
      method: 'tools/call',
      params: { name: 'deletePayEntry', arguments: { rowNumber: 99 } }
    }, tsuchidaUrl), fullEnv, waitCtx);
    const deleteBody = await deleteMissing.json();
    assert.equal(deleteBody.result.isError, true);
    assert.match(deleteBody.result.content[0].text, /見つかりません/);
    assert.equal(batchUpdateCalled, false);

    await Promise.all(pending);
    assert.equal(tokenFetches, 1);
    assert.equal(slackMessages.length, 1);
    assert.match(slackMessages[0], /MCPサーバー経由で項目を追加しました/);
    assert.doesNotMatch(slackMessages[0], /ChatGPT/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
