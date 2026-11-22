import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const bundle = await readFile(new URL('../dist/index.js', import.meta.url));
const worker = (await import(`data:text/javascript;base64,${bundle.toString('base64')}`)).default;
const origin = 'https://shinkemi-pay-slack.tsuchida.workers.dev';
const env = {
  CHATGPT_ACTION_API_KEY_TSUCHIDA: 'test-tsuchida-key',
  CHATGPT_ACTION_API_KEY_KATO: 'test-kato-key',
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
    { CHATGPT_ACTION_API_KEY_TSUCHIDA: 'test-tsuchida-key' },
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

test('MCP secret URL endpoints work for both Tsuchida and Kato with Gemini-compatible schemas', async () => {
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
