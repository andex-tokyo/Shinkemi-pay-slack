import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import test from 'node:test';

const bundle = await readFile(new URL('../dist/index.js', import.meta.url));
const worker = (await import(`data:text/javascript;base64,${bundle.toString('base64')}`)).default;
const origin = 'https://shinkemi-pay-slack.tsuchida.workers.dev';
const issuer = 'https://example.auth0.com/';
const audience = `${origin}/mcp`;
const katoAudience = `${origin}/mcp/kato`;
const env = {
  MCP_OAUTH_ISSUER: issuer,
  MCP_OAUTH_AUDIENCE: audience,
  MCP_AUTHORIZED_SUBJECT: 'auth0|tsuchida',
  MCP_OAUTH_AUDIENCE_KATO: katoAudience,
  MCP_AUTHORIZED_SUBJECT_KATO: 'google-oauth2|kato',
  CHATGPT_ACTION_API_KEY_TSUCHIDA: 'test-tsuchida-key',
  CHATGPT_ACTION_API_KEY_KATO: 'test-kato-key',
  MCP_REQUIRED_SCOPE: 'shinkemi:pay'
};
const context = { waitUntil() {} };

function request(body, token, resource = audience) {
  return new Request(resource, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(body)
  });
}

function base64Url(value) {
  return Buffer.from(value).toString('base64url');
}

test('MCP advertises OAuth and challenges private tool calls', async () => {
  const response = await worker.fetch(request({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), env, context);
  assert.equal(response.status, 200);
  const listed = await response.json();
  assert.deepEqual(listed.result.tools[0].securitySchemes, [{ type: 'oauth2', scopes: ['shinkemi:pay'] }]);
  const denied = await worker.fetch(request({
    jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'listPayEntries', arguments: {} }
  }), env, context);
  const challenge = (await denied.json()).result;
  assert.equal(challenge.isError, true);
  assert.match(challenge._meta['mcp/www_authenticate'][0], /oauth-protected-resource/);
  const metadata = await worker.fetch(new Request(`${origin}/.well-known/oauth-protected-resource`), env, context);
  assert.deepEqual(await metadata.json(), {
    resource: audience,
    authorization_servers: [issuer],
    scopes_supported: ['shinkemi:pay'],
    bearer_methods_supported: ['header']
  });
  const katoMetadata = await worker.fetch(new Request(`${origin}/.well-known/oauth-protected-resource/mcp/kato`), env, context);
  assert.equal((await katoMetadata.json()).resource, katoAudience);
  const katoTools = await worker.fetch(request({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, undefined, katoAudience), env, context);
  assert.match((await katoTools.json()).result.tools[0].description, /加藤が立て替えた/);
  const katoDenied = await worker.fetch(request({
    jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'listPayEntries', arguments: {} }
  }, undefined, katoAudience), env, context);
  assert.match((await katoDenied.json()).result._meta['mcp/www_authenticate'][0], /oauth-protected-resource\/mcp\/kato/);
  const withoutKatoIdentity = { ...env, MCP_AUTHORIZED_SUBJECT_KATO: undefined };
  const unavailable = await worker.fetch(request({ jsonrpc: '2.0', id: 5, method: 'tools/list' }, undefined, katoAudience), withoutKatoIdentity, context);
  assert.equal(unavailable.status, 503);
});

test('MCP verifies issuer, audience, subject, scope and signature', async () => {
  const pair = await webcrypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify']
  );
  const jwk = await webcrypto.subtle.exportKey('jwk', pair.publicKey);
  jwk.kid = 'test-key';
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    assert.equal(String(url), `${issuer}.well-known/jwks.json`);
    return Response.json({ keys: [jwk] });
  };
  async function token(changes = {}) {
    const header = base64Url(JSON.stringify({ alg: 'RS256', kid: 'test-key' }));
    const payload = base64Url(JSON.stringify({
      iss: issuer,
      aud: audience,
      sub: 'auth0|tsuchida',
      scope: 'shinkemi:pay',
      exp: Math.floor(Date.now() / 1000) + 60,
      ...changes
    }));
    const signed = `${header}.${payload}`;
    const signature = await webcrypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(signed));
    return `${signed}.${base64Url(signature)}`;
  }
  try {
    const good = await token();
    const response = await worker.fetch(request({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, good), env, context);
    assert.equal(response.status, 200);
    const rpc = await response.json();
    assert.equal(rpc.result.tools.length, 6);
    assert.equal(rpc.result.tools.find(tool => tool.name === 'deletePayEntry').annotations.destructiveHint, true);
    const init = await worker.fetch(request({ jsonrpc: '2.0', id: 4, method: 'initialize', params: { protocolVersion: '2025-03-26' } }, good), env, context);
    assert.equal((await init.json()).result.serverInfo.name, 'shinkemi-pay');
    const badRow = await worker.fetch(request({
      jsonrpc: '2.0', id: 5, method: 'tools/call',
      params: { name: 'deletePayEntry', arguments: { rowNumber: 1 } }
    }, good), env, context);
    assert.equal((await badRow.json()).result.isError, true);
    const katoToken = await token({ aud: katoAudience, sub: 'google-oauth2|kato' });
    const katoInit = await worker.fetch(request({ jsonrpc: '2.0', id: 6, method: 'initialize' }, katoToken, katoAudience), env, context);
    assert.match((await katoInit.json()).result.instructions, /加藤専用/);
    const katoBadRow = await worker.fetch(request({
      jsonrpc: '2.0', id: 7, method: 'tools/call',
      params: { name: 'deletePayEntry', arguments: { rowNumber: 1 } }
    }, katoToken, katoAudience), env, context);
    const katoBadRowResult = (await katoBadRow.json()).result;
    assert.equal(katoBadRowResult.isError, true);
    assert.equal(katoBadRowResult._meta, undefined);
    for (const [wrongToken, resource] of [[good, katoAudience], [katoToken, audience]]) {
      const denied = await worker.fetch(request({
        jsonrpc: '2.0', id: 8, method: 'tools/call',
        params: { name: 'deletePayEntry', arguments: { rowNumber: 1 } }
      }, wrongToken, resource), env, context);
      assert.equal((await denied.json()).result._meta['mcp/www_authenticate'].length, 1);
    }
    for (const changes of [
      { sub: 'auth0|someone-else' },
      { aud: 'https://other.example/mcp' },
      { scope: 'openid' },
      { exp: 1 }
    ]) {
      const denied = await worker.fetch(request({
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'deletePayEntry', arguments: { rowNumber: 1 } }
      }, await token(changes)), env, context);
      assert.equal((await denied.json()).result._meta['mcp/www_authenticate'].length, 1);
    }
    const [tokenHeader, tokenPayload, tokenSignature] = good.split('.');
    const tampered = `${tokenHeader}.${tokenPayload}.${tokenSignature[0] === 'A' ? 'B' : 'A'}${tokenSignature.slice(1)}`;
    const denied = await worker.fetch(request({
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'deletePayEntry', arguments: { rowNumber: 1 } }
    }, tampered), env, context);
    assert.equal((await denied.json()).result._meta['mcp/www_authenticate'].length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
