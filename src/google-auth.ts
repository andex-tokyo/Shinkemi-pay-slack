interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  private_key_id?: string;
}

interface CachedToken {
  accessToken: string;
  tokenExpiry: number;
}

const tokenCache = new Map<string, CachedToken>();

export class GoogleAuth {
  private serviceAccountKey: ServiceAccountKey;
  private cacheKey: string;

  constructor(serviceAccountKeyJson: string) {
    this.serviceAccountKey = JSON.parse(serviceAccountKeyJson) as ServiceAccountKey;
    this.cacheKey = `${this.serviceAccountKey.client_email}:${this.serviceAccountKey.private_key_id || ''}`;
  }

  async getAccessToken(): Promise<string> {
    const cached = tokenCache.get(this.cacheKey);
    if (cached && Date.now() < cached.tokenExpiry) {
      return cached.accessToken;
    }

    const now = Math.floor(Date.now() / 1000);
    const expiry = now + 3600;

    const payload = {
      iss: this.serviceAccountKey.client_email,
      scope: 'https://www.googleapis.com/auth/spreadsheets',
      aud: 'https://oauth2.googleapis.com/token',
      exp: expiry,
      iat: now,
    };

    const jwt = await this.createJWT(payload);

    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: jwt,
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to get access token: ${await response.text()}`);
    }

    const data = await response.json() as { access_token: string; expires_in: number };
    tokenCache.set(this.cacheKey, {
      accessToken: data.access_token,
      tokenExpiry: Date.now() + (data.expires_in * 1000) - 60000,
    });

    return data.access_token;
  }

  private async createJWT(payload: Record<string, string | number>): Promise<string> {
    const header = {
      alg: 'RS256',
      typ: 'JWT',
    };

    const encodedHeader = this.base64urlEncode(JSON.stringify(header));
    const encodedPayload = this.base64urlEncode(JSON.stringify(payload));
    const signatureInput = `${encodedHeader}.${encodedPayload}`;

    const signature = await this.signRS256(signatureInput, this.serviceAccountKey.private_key);

    return `${signatureInput}.${signature}`;
  }

  private async signRS256(data: string, privateKey: string): Promise<string> {
    const pemContents = privateKey
      .split('\n')
      .filter(line => !line.includes('BEGIN') && !line.includes('END'))
      .join('');

    const binaryDer = Uint8Array.from(atob(pemContents), c => c.charCodeAt(0));

    const cryptoKey = await crypto.subtle.importKey(
      'pkcs8',
      binaryDer,
      {
        name: 'RSASSA-PKCS1-v1_5',
        hash: 'SHA-256',
      },
      false,
      ['sign']
    );

    const encoder = new TextEncoder();
    const signatureBuffer = await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      cryptoKey,
      encoder.encode(data)
    );

    return this.base64urlEncode(new Uint8Array(signatureBuffer));
  }

  private base64urlEncode(data: string | Uint8Array): string {
    let base64: string;

    if (typeof data === 'string') {
      base64 = btoa(data);
    } else {
      const binary = String.fromCharCode(...data);
      base64 = btoa(binary);
    }

    return base64
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');
  }
}
