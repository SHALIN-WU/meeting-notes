const TOKEN_KEY = 'meeting-ai-token';
const EXP_KEY = 'meeting-ai-exp';

export function isLocalHost() {
  return location.hostname === '127.0.0.1';
}

export function getToken() {
  const token = sessionStorage.getItem(TOKEN_KEY) || '';
  const exp = Number(sessionStorage.getItem(EXP_KEY) || 0);
  if (!token || !Number.isFinite(exp) || Date.now() >= exp) {
    clearToken();
    return '';
  }
  return token;
}

export function saveToken(token, expiresAt) {
  sessionStorage.setItem(TOKEN_KEY, token);
  sessionStorage.setItem(EXP_KEY, String(expiresAt));
}

export function clearToken() {
  sessionStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(EXP_KEY);
}
