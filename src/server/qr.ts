// QR payloads are signed URLs:  https://<host>/l/<locationId>?t=<sig>
// Verification is pure CPU (HMAC), so fake/guessed URLs are rejected without touching the DB.
// Uses Web Crypto, so this runs unchanged on Node, Deno, Bun and Cloudflare Workers.

const enc = new TextEncoder();

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
  return Buffer.from(sig.slice(0, 12)).toString('base64url');
}

export async function signQr(secret: string, locationId: string): Promise<string> {
  return `${locationId}.${await hmac(secret, locationId)}`;
}

export async function verifyQr(secret: string, token: string): Promise<string | null> {
  const dot = token.lastIndexOf('.');
  if (dot < 1) return null;
  const locationId = token.slice(0, dot);
  return (await hmac(secret, locationId)) === token.slice(dot + 1) ? locationId : null;
}
