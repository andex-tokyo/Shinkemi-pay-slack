export async function verifySlackRequest(
  request: Request,
  signingSecret: string
): Promise<boolean> {
  const signature = request.headers.get('x-slack-signature');
  const timestamp = request.headers.get('x-slack-request-timestamp');
  
  if (!signature || !timestamp) {
    return false;
  }
  
  const fiveMinutesAgo = Math.floor(Date.now() / 1000) - 60 * 5;
  if (parseInt(timestamp) < fiveMinutesAgo) {
    return false;
  }
  
  const body = await request.text();
  const sigBasestring = `v0:${timestamp}:${body}`;
  
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(signingSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  
  const sigData = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(sigBasestring)
  );
  
  const hash = Array.from(new Uint8Array(sigData))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  
  const expectedSignature = `v0=${hash}`;
  
  return signature === expectedSignature;
}