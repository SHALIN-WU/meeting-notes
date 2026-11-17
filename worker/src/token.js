const encoder = new TextEncoder();
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

export async function issueToken(secret) {
  const now = Date.now();
  const exp = now + TOKEN_TTL_MS;
  const payload = bytesToBase64Url(encoder.encode(JSON.stringify({ iat: now, exp })));
  const key = await hmacKey(secret);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  return { token: `${payload}.${bytesToBase64Url(signature)}`, exp };
}

export async function verifyToken(secret, token) {
  if (typeof secret !== 'string' || !secret) return false;
  if (typeof token !== 'string' || token.length < 20 || token.length > 4000) return false;
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return false;
  let signature;
  try {
    signature = base64UrlToBytes(parts[1]);
  } catch {
    return false;
  }
  if (signature.length !== 32) return false;
  const key = await hmacKey(secret);
  const valid = await crypto.subtle.verify('HMAC', key, signature, encoder.encode(parts[0]));
  if (!valid) return false;
  try {
    const data = JSON.parse(new TextDecoder().decode(base64UrlToBytes(parts[0])));
    return Boolean(data && typeof data.exp === 'number' && Date.now() < data.exp);
  } catch {
    return false;
  }
}

export async function passwordsMatch(input, secret) {
  if (typeof secret !== 'string' || secret.length === 0) return false;
  const provided = typeof input === 'string' ? input.slice(0, 256) : '';
  const [left, right] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(provided)),
    crypto.subtle.digest('SHA-256', encoder.encode(secret))
  ]);
  return bytesEqual(new Uint8Array(left), new Uint8Array(right));
}

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

function bytesEqual(left, right) {
  if (left.length !== right.length) return false;
  if (crypto.subtle.timingSafeEqual) {
    try {
      return crypto.subtle.timingSafeEqual(left, right);
    } catch {
      return false;
    }
  }
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left[i] ^ right[i];
  return diff === 0;
}

function bytesToBase64Url(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (let i = 0; i < view.length; i += 1) binary += String.fromCharCode(view[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToBytes(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((value.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
