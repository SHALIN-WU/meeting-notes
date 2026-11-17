import { apiBase, isApiConfigured } from './config.js';
import { clearToken, getToken } from './auth.js';

export class ApiError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

export async function api(path, body, { timeoutMs = 120000, signal } = {}) {
  if (!isApiConfigured()) {
    throw new ApiError('請先在 js/config.js 把 API_URL 改成 Worker 網址。', 0);
  }
  const headers = { 'Content-Type': 'application/json' };
  const token = path === '/login' ? '' : getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const timeout = typeof AbortSignal !== 'undefined' && AbortSignal.timeout
    ? AbortSignal.timeout(timeoutMs)
    : undefined;
  const requestSignal = combineSignals([signal, timeout]);
  let response;
  try {
    response = await fetch(`${apiBase()}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body ?? {}),
      cache: 'no-store',
      credentials: 'omit',
      signal: requestSignal
    });
  } catch (err) {
    if (err?.name === 'AbortError') throw new ApiError('等待過久或已取消，請再試一次。', 0);
    throw new ApiError('無法連線到伺服器，請確認 API_URL 與網路。', 0);
  }
  let data = {};
  try {
    data = await response.json();
  } catch {
    data = {};
  }
  if (response.status === 401 && path !== '/login') clearToken();
  if (!response.ok) {
    throw new ApiError(data.error || `請求失敗（${response.status}）`, response.status);
  }
  return data;
}

function combineSignals(signals) {
  const list = signals.filter(Boolean);
  if (!list.length) return undefined;
  if (list.length === 1) return list[0];
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(list);
  const controller = new AbortController();
  list.forEach((item) => {
    if (item.aborted) controller.abort();
    else item.addEventListener('abort', () => controller.abort(), { once: true });
  });
  return controller.signal;
}

export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(new ApiError('無法讀取錄音內容。', 0));
    reader.readAsDataURL(blob);
  });
}
