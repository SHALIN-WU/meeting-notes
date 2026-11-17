import { registerAttempt } from './guard.js';
import {
  GeminiError,
  listGenerateModels,
  normalizeBase64,
  normalizeLanguages,
  normalizeMime,
  summarizeTranscript,
  transcribeAudio
} from './gemini.js';
import { issueToken, passwordsMatch, verifyToken } from './token.js';

const ALLOWED_ORIGINS = new Set([
  'https://shalin-wu.github.io',
  'http://127.0.0.1:8080',
  'http://127.0.0.1:8081'
]);

export default {
  async fetch(request, env) {
    try {
      return await route(request, env);
    } catch (err) {
      if (err instanceof GeminiError) return respond(request, err.status, { error: err.message });
      console.error('worker error');
      return respond(request, 500, { error: '伺服器發生錯誤' });
    }
  }
};

async function route(request, env) {
  const cors = corsHeaders(request);
  if (cors === null) return respond(request, 403, { error: '不允許的來源' });
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: baseHeaders(cors) });

  const path = new URL(request.url).pathname.replace(/\/+$/, '') || '/';
  if (request.method === 'GET' && path === '/models') return listModels(request, env);
  if (request.method !== 'POST') {
    return respond(request, 405, { error: '只接受 POST' }, { Allow: 'POST, GET, OPTIONS' });
  }
  const length = Number(request.headers.get('content-length') || 0);
  if (Number.isFinite(length) && length > 24_000_000) return respond(request, 413, { error: '請求內容太大' });
  const contentType = request.headers.get('content-type') || '';
  if (contentType && !contentType.includes('application/json')) {
    return respond(request, 415, { error: '請使用 JSON' });
  }

  if (path === '/login') return login(request, env);
  if (path === '/transcribe') return transcribe(request, env);
  if (path === '/summarize') return summarize(request, env);
  return respond(request, 404, { error: '找不到這個功能' });
}

async function login(request, env) {
  if (!hasSecrets(env, ['MEETING_PASS', 'TOKEN_SECRET'])) {
    return respond(request, 500, { error: '服務尚未完成設定，請檢查 MEETING_PASS 與 TOKEN_SECRET。' });
  }
  const body = await readJson(request);
  const password = typeof body.password === 'string' ? body.password : '';
  const matched = await passwordsMatch(password, env.MEETING_PASS);
  const outcome = await registerAttempt(env, clientIp(request), matched);
  if (outcome.locked) {
    return respond(request, 429, {
      error: lockMessage(outcome.retryAfterSec),
      retryAfterSec: outcome.retryAfterSec
    }, { 'Retry-After': String(outcome.retryAfterSec) });
  }
  if (!matched) {
    return respond(request, 401, {
      error: `密碼錯誤，還可以再試 ${outcome.remaining} 次`,
      remaining: outcome.remaining
    });
  }
  const issued = await issueToken(env.TOKEN_SECRET);
  return respond(request, 200, { token: issued.token, expiresAt: issued.exp });
}

async function transcribe(request, env) {
  const denied = await requireAuth(request, env);
  if (denied) return denied;
  if (!hasSecrets(env, ['GEMINI_API_KEY'])) {
    return respond(request, 500, { error: '語音服務尚未設定，請檢查 GEMINI_API_KEY。' });
  }
  const body = await readJson(request);
  const audio = normalizeBase64(body.audio);
  const mimeType = normalizeMime(body.mimeType);
  if (!audio) return respond(request, 400, { error: '沒有收到音訊' });
  if (!mimeType) return respond(request, 400, { error: '不支援的音訊格式' });
  const text = await transcribeAudio(env, {
    audio,
    mimeType,
    languages: normalizeLanguages(body.languages)
  });
  return respond(request, 200, { text });
}

async function summarize(request, env) {
  const denied = await requireAuth(request, env);
  if (denied) return denied;
  if (!hasSecrets(env, ['GEMINI_API_KEY'])) {
    return respond(request, 500, { error: '語音服務尚未設定，請檢查 GEMINI_API_KEY。' });
  }
  const body = await readJson(request);
  if (typeof body.transcript !== 'string' || !body.transcript.trim()) {
    return respond(request, 400, { error: '沒有逐字稿可以整理' });
  }
  const notes = await summarizeTranscript(env, {
    transcript: body.transcript,
    languages: normalizeLanguages(body.languages),
    startedAt: body.startedAt,
    durationText: body.durationText
  });
  return respond(request, 200, notes);
}

async function listModels(request, env) {
  const denied = await requireAuth(request, env);
  if (denied) return denied;
  if (!hasSecrets(env, ['GEMINI_API_KEY'])) {
    return respond(request, 500, { error: '語音服務尚未設定，請檢查 GEMINI_API_KEY。' });
  }
  const models = await listGenerateModels(env);
  return respond(request, 200, { models });
}

async function requireAuth(request, env) {
  if (!hasSecrets(env, ['TOKEN_SECRET'])) {
    return respond(request, 500, { error: '服務尚未完成設定，請檢查 TOKEN_SECRET。' });
  }
  const header = request.headers.get('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const valid = await verifyToken(env.TOKEN_SECRET, token);
  if (!valid) return respond(request, 401, { error: '請重新登入' });
  return null;
}

async function readJson(request) {
  try {
    const body = await request.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new GeminiError('請求格式不正確', 400);
    }
    return body;
  } catch (err) {
    if (err instanceof GeminiError) throw err;
    throw new GeminiError('請求格式不正確', 400);
  }
}

function hasSecrets(env, names) {
  return names.every((name) => typeof env?.[name] === 'string' && env[name].length > 0);
}

function clientIp(request) {
  return request.headers.get('CF-Connecting-IP') || 'local';
}

function lockMessage(seconds) {
  const safe = Math.max(1, Number(seconds) || 1);
  if (safe >= 60) return `密碼錯誤次數過多，請 ${Math.ceil(safe / 60)} 分鐘後再試`;
  return `密碼錯誤次數過多，請 ${safe} 秒後再試`;
}

function corsHeaders(request) {
  const origin = request.headers.get('Origin');
  if (!origin) return {};
  if (!ALLOWED_ORIGINS.has(origin)) return null;
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin'
  };
}

function respond(request, status, body, extra = {}) {
  const cors = corsHeaders(request);
  if (cors === null) {
    return new Response(JSON.stringify({ error: '不允許的來源' }), {
      status: 403,
      headers: baseHeaders({})
    });
  }
  return new Response(JSON.stringify(body), {
    status,
    headers: baseHeaders({ ...cors, ...extra })
  });
}

function baseHeaders(extra) {
  return {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extra
  };
}
