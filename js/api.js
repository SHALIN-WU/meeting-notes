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
  if (response.status === 401 && path !== '/login') clearToken();
  if (path === '/summarize' && response.ok && isEventStream(response)) {
    try {
      return await readSummaryStream(response);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      if (err?.name === 'AbortError' || err?.name === 'TimeoutError') {
        throw new ApiError('等待過久或已取消，請再試一次。', 0);
      }
      throw new ApiError('整理過程連線中斷，請再試一次。', 0);
    }
  }
  let data = {};
  try {
    data = await response.json();
  } catch {
    data = {};
  }
  if (!response.ok) {
    throw new ApiError(data.error || `請求失敗（${response.status}）`, response.status);
  }
  return data;
}

function isEventStream(response) {
  return (response.headers.get('content-type') || '').toLowerCase().includes('text/event-stream');
}

async function readSummaryStream(response) {
  if (!response.body) throw new ApiError('整理失敗，模型沒有回傳有效的記錄。', 502);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const drained = drainSse(buffer);
      buffer = drained.buffer;
      text += eventsText(drained.events);
    }
    buffer += decoder.decode();
    if (buffer.trim()) text += eventsText(drainSse(`${buffer}\n\n`).events);
  } finally {
    try { reader.releaseLock(); } catch { /* 串流已結束 */ }
  }
  return notesFromModelText(text);
}

function eventsText(events) {
  let text = '';
  events.forEach((event) => {
    text += applySummaryEvent(event);
  });
  return text;
}

function applySummaryEvent(block) {
  let eventName = 'message';
  const dataLines = [];
  String(block || '').split(/\n/).forEach((line) => {
    if (!line || line.startsWith(':')) return;
    if (line.startsWith('event:')) {
      eventName = line.slice(6).trim();
      return;
    }
    if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
  });
  if (!dataLines.length) return '';
  let payload;
  try {
    payload = JSON.parse(dataLines.join('\n'));
  } catch {
    throw new ApiError('整理失敗，模型沒有回傳有效的記錄。', 502);
  }
  if (eventName === 'error') {
    const status = Number(payload?.status);
    const message = typeof payload?.error === 'string' && payload.error ? payload.error : '整理失敗';
    throw new ApiError(message, Number.isFinite(status) ? status : 502);
  }
  return typeof payload?.text === 'string' ? payload.text : '';
}

function drainSse(buffer) {
  const events = [];
  let rest = buffer;
  while (rest) {
    const match = /\r?\n\r?\n/.exec(rest);
    if (!match) break;
    events.push(rest.slice(0, match.index));
    rest = rest.slice(match.index + match[0].length);
  }
  return { events, buffer: rest };
}

function notesFromModelText(text) {
  try {
    const parsed = parseModelJson(text);
    const notes = normalizeNotes(parsed);
    if (!hasNoteFields(parsed) || isBlankNotes(notes)) {
      throw new ApiError('整理失敗，模型沒有回傳有效的記錄。', 502);
    }
    return notes;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError('整理失敗，模型沒有回傳有效的記錄。', 502);
  }
}

function parseModelJson(text) {
  let raw = String(text || '').trim();
  raw = raw.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw new ApiError('整理失敗，模型沒有回傳有效的記錄。', 502);
  }
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new ApiError('整理失敗，模型沒有回傳有效的記錄。', 502);
    }
    return parsed;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError('整理失敗，模型沒有回傳有效的記錄。', 502);
  }
}

function hasNoteFields(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  return ['title', 'datetime', 'attendees', 'summary', 'discussions', 'decisions', 'actions']
    .some((key) => Object.prototype.hasOwnProperty.call(raw, key));
}

function isBlankNotes(notes) {
  return !noteText(notes?.summary)
    && !(notes?.discussions || []).length
    && !(notes?.decisions || []).length
    && !(notes?.actions || []).length;
}

function normalizeNotes(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const generic = new Set(['我們', '大家', '與會者', '全體', '未知']);
  return {
    title: noteText(source.title) || '未命名會議',
    datetime: noteText(source.datetime),
    attendees: stringList(source.attendees).filter((name) => !generic.has(name)),
    summary: noteText(source.summary),
    discussions: stringList(source.discussions),
    decisions: stringList(source.decisions),
    actions: actionList(source.actions)
  };
}

function actionList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => ({
    task: noteText(item?.task ?? item?.['事項']),
    owner: noteText(item?.owner ?? item?.['負責人']),
    due: noteText(item?.due ?? item?.deadline ?? item?.['期限'])
  })).filter((item) => item.task || item.owner || item.due);
}

function stringList(value) {
  if (Array.isArray(value)) return value.map(noteText).filter(Boolean);
  if (typeof value === 'string') return value.split(/[、,，]/).map((item) => item.trim()).filter(Boolean);
  return [];
}

function noteText(value) {
  return typeof value === 'string' ? value.trim() : '';
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
