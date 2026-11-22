import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const bundle = await readFile(new URL('../dist/index.js', import.meta.url));
const worker = (await import(`data:text/javascript;base64,${bundle.toString('base64')}`)).default;
const origin = 'https://shinkemi-pay-slack.tsuchida.workers.dev';

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

async function signSlack(body, secret, timestamp) {
  const key = await webcrypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await webcrypto.subtle.sign('HMAC', key, new TextEncoder().encode(`v0:${timestamp}:${body}`));
  const hex = Buffer.from(sig).toString('hex');
  return `v0=${hex}`;
}

test('OpenAPI YAML endpoint stays in sync with openapi.yaml', async () => {
  const fileYaml = await readFile(new URL('../openapi.yaml', import.meta.url), 'utf8');
  const res = await worker.fetch(new Request(`${origin}/openapi.yaml`), {}, { waitUntil() {} });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), fileYaml);
});

test('REST API enforces auth, protects header row, excludes header from list, and sends ChatGPT Slack label', async () => {
  const saKey = await createServiceAccountJson('api-test@example.iam.gserviceaccount.com');
  const env = {
    SPREADSHEET_ID: 'api-test-sheet',
    GOOGLE_SERVICE_ACCOUNT_KEY: saKey,
    CHATGPT_ACTION_API_KEY_TSUCHIDA: 'tsuchida-api-key',
    CHATGPT_ACTION_API_KEY_KATO: 'kato-api-key',
    SLACK_WEBHOOK_URL: 'https://hooks.slack.test/services/api'
  };

  const pending = [];
  const ctx = { waitUntil(promise) { pending.push(promise); } };
  const slackMessages = [];

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url === 'https://oauth2.googleapis.com/token') {
      return Response.json({ access_token: 'mock-api-token', expires_in: 3600 });
    }
    if (url.includes(':append')) {
      return Response.json({ updates: { updatedRows: 1 } });
    }
    if (url.endsWith(`/values/${encodeURIComponent('入力!A:E')}`)) {
      return Response.json({
        values: [
          ['日付', '項目', '立替者', '割り勘フラグ', '金額'],
          ['2026-11-22', 'ランチ', '土田', 'TRUE', '1200'],
          ['2026-11-22', '電気代', '加藤', 'FALSE', '8000']
        ]
      });
    }
    if (url.includes(encodeURIComponent('入力!A99:E99'))) {
      return Response.json({});
    }
    if (url === env.SLACK_WEBHOOK_URL) {
      slackMessages.push(JSON.parse(init.body).text);
      return new Response('ok', { status: 200 });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    const unauth = await worker.fetch(new Request(`${origin}/api/list`), env, ctx);
    assert.equal(unauth.status, 401);

    const dupKeyRes = await worker.fetch(new Request(`${origin}/api/list`, {
      headers: { Authorization: 'Bearer same-key' }
    }), {
      ...env,
      CHATGPT_ACTION_API_KEY_TSUCHIDA: 'same-key',
      CHATGPT_ACTION_API_KEY_KATO: 'same-key'
    }, ctx);
    assert.equal(dupKeyRes.status, 401);

    const listRes = await worker.fetch(new Request(`${origin}/api/list`, {
      headers: { Authorization: `Bearer ${env.CHATGPT_ACTION_API_KEY_TSUCHIDA}` }
    }), env, ctx);
    assert.equal(listRes.status, 200);
    const listBody = await listRes.json();
    assert.equal(listBody.entries.length, 2);
    assert.equal(listBody.entries[0].rowNumber, 2);
    assert.equal(listBody.entries[0].item, 'ランチ');
    assert.equal(listBody.entries[1].rowNumber, 3);

    const delHeader = await worker.fetch(new Request(`${origin}/api/entries/1`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${env.CHATGPT_ACTION_API_KEY_TSUCHIDA}` }
    }), env, ctx);
    assert.equal(delHeader.status, 400);

    const delMissing = await worker.fetch(new Request(`${origin}/api/entries/99`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${env.CHATGPT_ACTION_API_KEY_TSUCHIDA}` }
    }), env, ctx);
    assert.equal(delMissing.status, 404);

    const addRes = await worker.fetch(new Request(`${origin}/api/pay`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.CHATGPT_ACTION_API_KEY_TSUCHIDA}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ item: 'コーヒー', amount: 500 })
    }), env, ctx);
    assert.equal(addRes.status, 200);

    await Promise.all(pending);
    assert.equal(slackMessages.length, 1);
    assert.match(slackMessages[0], /ChatGPTから項目を追加しました/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Slack verification rejects non-numeric, stale, future, and tampered signatures', async () => {
  const secret = 'test-slack-signing-secret';
  const env = { SLACK_SIGNING_SECRET: secret };
  const ctx = { waitUntil() {} };
  const body = 'command=%2Fpay_list&text=';
  const now = Math.floor(Date.now() / 1000);

  const validSig = await signSlack(body, secret, String(now));
  const okRes = await worker.fetch(new Request(origin, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'x-slack-request-timestamp': String(now),
      'x-slack-signature': validSig
    },
    body
  }), env, ctx);
  assert.equal(okRes.status, 200);

  for (const [ts, sig] of [
    ['not-a-number', validSig],
    [String(now - 600), await signSlack(body, secret, String(now - 600))],
    [String(now + 600), await signSlack(body, secret, String(now + 600))],
    [String(now), `${validSig.slice(0, -1)}${validSig.endsWith('0') ? '1' : '0'}`]
  ]) {
    const res = await worker.fetch(new Request(origin, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'x-slack-request-timestamp': ts,
        'x-slack-signature': sig
      },
      body
    }), env, ctx);
    assert.equal(res.status, 401, `Expected 401 for timestamp=${ts}`);
  }
});

test('Slack commands parse full-width spaces and commas, guard delete, and render unsettled amounts accurately', async () => {
  const saKey = await createServiceAccountJson('slack-test@example.iam.gserviceaccount.com');
  const env = {
    SPREADSHEET_ID: 'slack-test-sheet',
    GOOGLE_SERVICE_ACCOUNT_KEY: saKey
  };

  let lastAppended = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url === 'https://oauth2.googleapis.com/token') {
      return Response.json({ access_token: 'mock-slack-token', expires_in: 3600 });
    }
    if (url.includes(':append')) {
      lastAppended = JSON.parse(init.body).values[0];
      return Response.json({ updates: { updatedRows: 1 } });
    }
    if (url.includes(encodeURIComponent('未清算金額!A:B'))) {
      return Response.json({
        values: [
          ['名前', '金額'],
          ['土田', 1500],
          ['加藤', -1500],
          ['ゼロ', 0]
        ]
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    const okPay = await worker.handleCommand({
      command: '/pay',
      text: '  ランチ　1,200  ',
      user_id: 'U074HKBTAF9'
    }, env);
    assert.equal(okPay.response_type, 'in_channel');
    assert.equal(lastAppended[1], 'ランチ');
    assert.equal(lastAppended[2], '土田');
    assert.equal(lastAppended[4], 1200);

    const zeroPay = await worker.handleCommand({
      command: '/pay',
      text: 'ランチ 0 土田',
      user_id: 'U074HKBTAF9'
    }, env);
    assert.equal(zeroPay.response_type, 'ephemeral');

    const badDelete1 = await worker.handleCommand({ command: '/pay_delete', text: '1' }, env);
    assert.equal(badDelete1.response_type, 'ephemeral');
    assert.match(badDelete1.text, /見出し/);

    const badDeleteText = await worker.handleCommand({ command: '/pay_delete', text: '5abc' }, env);
    assert.equal(badDeleteText.response_type, 'ephemeral');

    const amountRes = await worker.handleCommand({ command: '/pay_amount', text: '' }, env);
    assert.equal(amountRes.response_type, 'in_channel');
    assert.match(amountRes.text, /土田:\* 支払 ¥1,500/);
    assert.match(amountRes.text, /加藤:\* 受取 ¥1,500/);
    assert.match(amountRes.text, /ゼロ:\* 精算済み \(¥0\)/);
    assert.match(amountRes.text, /正の値は支払い、負の値は受け取りを示します/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
