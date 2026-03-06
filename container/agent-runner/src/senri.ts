/**
 * Senri CRM API Client
 *
 * Token cache + HTTP helper for the Senri REST API.
 * Uses native fetch — zero dependencies.
 */

const BASE_URL = 'https://senri.afri-inc.com';

let apiKey: string | undefined;
let apiSecret: string | undefined;
let cachedToken: string | undefined;

/**
 * Store Senri API credentials (called once at startup).
 */
export function initSenri(key: string, secret: string): void {
  apiKey = key;
  apiSecret = secret;
  cachedToken = undefined;
}

/**
 * Returns true if Senri credentials have been provided.
 */
export function isSenriConfigured(): boolean {
  return !!(apiKey && apiSecret);
}

/**
 * Fetch a fresh access token from Senri.
 */
async function fetchToken(): Promise<string> {
  if (!apiKey || !apiSecret) {
    throw new Error('Senri API credentials not configured');
  }

  const res = await fetch(`${BASE_URL}/open_api/v1/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: apiKey, api_secret: apiSecret }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Senri auth failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as { access_token: string };
  cachedToken = data.access_token;
  return cachedToken;
}

/**
 * GET a Senri API endpoint with Bearer token.
 * Auto-fetches token on first call, retries once on 401.
 */
export async function senriGet(
  path: string,
  params?: Record<string, string | number | undefined>,
): Promise<unknown> {
  if (!isSenriConfigured()) {
    throw new Error('Senri API not configured. Set SENRI_API_KEY and SENRI_API_SECRET.');
  }

  // Build query string, filtering out undefined values
  const url = new URL(path, BASE_URL);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== '') {
        url.searchParams.set(key, String(value));
      }
    }
  }

  const doRequest = async (token: string) => {
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    });
    return res;
  };

  // Get or use cached token
  const token = cachedToken || (await fetchToken());
  let res = await doRequest(token);

  // Retry once on 401 (token may have expired)
  if (res.status === 401) {
    const freshToken = await fetchToken();
    res = await doRequest(freshToken);
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Senri API error (${res.status} ${path}): ${text}`);
  }

  return res.json();
}
