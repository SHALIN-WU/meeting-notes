// 正式環境請改成你的 Worker 網址，例如 https://meeting-ai.xxxxx.workers.dev
// 本機 wrangler dev 可暫時改成 http://127.0.0.1:8787
// 這裡只能放網址，不能放任何 API 金鑰。
export const API_URL = 'https://meeting-ai.shalin-wu.workers.dev';

// 每一段錄音的秒數。10 分鐘一段，減少轉寫請求次數。
export const SEGMENT_SECONDS = 10 * 60;

export function apiBase() {
  return String(API_URL || '').replace(/\/$/, '');
}

export function isApiConfigured() {
  try {
    const url = new URL(apiBase());
    if (!apiBase() || apiBase().includes('YOUR_SUBDOMAIN')) return false;
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && url.hostname === '127.0.0.1';
  } catch {
    return false;
  }
}
