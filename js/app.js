import { api, ApiError, blobToBase64 } from './api.js';
import { clearToken, getToken, isLocalHost, saveToken } from './auth.js';
import { SEGMENT_SECONDS, isApiConfigured } from './config.js';
import { deleteMeeting, listMeetings, prepareDatabase, saveMeeting } from './db.js';
import { createDocx, docxFileName } from './docx.js';
import { LANGUAGES, languageLabel } from './languages.js';
import { createRecorder } from './recorder.js';
import { formatClock, formatLocal, joinTranscript, notesToText, shiftTranscript, transcriptHint } from './text.js';
import { acquireWakeLock, releaseWakeLock } from './wakelock.js';

const BUSY_RETRY_TEXT = '服務忙碌，稍後自動重試';
const QUOTA_TEXT = '今天的免費額度已用完，明天重置後可按重試';
const CHUNK_RETRY_MS = 30000;
const CHUNK_RETRY_LIMIT = 5;

const recorder = createRecorder();
let phase = 'idle';
let selected = new Set(['auto']);
let session = null;
let sliceOffset = 0;
let currentNote = null;
let returnTo = 'home';
let saveTimer = 0;
let toastTimer = 0;
let runningUploads = 0;
let authPrompted = false;
let busyFinish = false;
let starting = false;
let noteBusy = false;
const idleWaiters = [];

const $ = (id) => document.getElementById(id);

recorder.on((type, detail) => {
  if (type === 'slice') sliceOffset = detail;
  if (type === 'tick' || type === 'state' || type === 'slice') updateClock();
  if (type === 'state') renderPhase();
  if (type === 'error') showHomeAlert(micMessage(detail));
  if (type === 'level' && $('levelNote')) $('levelNote').hidden = !detail;
});

void boot().catch(() => {
  const banner = document.getElementById('homeAlert');
  if (!banner) return;
  banner.hidden = false;
  banner.textContent = '畫面初始化失敗，請重新整理。';
});

async function boot() {
  delete document.documentElement.dataset.boot;
  bindStaticEvents();
  renderChips();
  applySegmentCopy();
  bootAuth();
  renderHome();
  try {
    await prepareDatabase();
  } catch {
    toast('無法使用瀏覽器儲存，歷史記錄可能無法保存。');
  }
}

function bindStaticEvents() {
  $('loginForm').addEventListener('submit', onLogin);
  $('skipBtn').addEventListener('click', closeGate);
  $('loginBtn').addEventListener('click', () => openGate(''));
  $('lockBtn').addEventListener('click', onLock);
  $('startBtn').addEventListener('click', () => { void onStart(); });
  $('pauseBtn').addEventListener('click', onPause);
  $('stopBtn').addEventListener('click', () => { void finishRecording(); });
  $('discardBtn').addEventListener('click', () => { void discardRecording(); });
  $('historyBtn').addEventListener('click', () => { void showHistory(); });
  $('historyBack').addEventListener('click', () => { showView('viewHome'); renderHome(); });
  $('viewNotes').addEventListener('click', onNotesClick);
  $('viewNotes').addEventListener('input', (event) => {
    if (event.target instanceof HTMLTextAreaElement && event.target.classList.contains('grow-box')) {
      fitGrowBox(event.target);
    }
    if (noteBusy || !currentNote || $('viewNotes').hidden) return;
    scheduleSave();
  });
  let growFrame = 0;
  window.addEventListener('resize', () => {
    if ($('viewNotes').hidden) return;
    cancelAnimationFrame(growFrame);
    growFrame = requestAnimationFrame(() => fitGrowBoxes($('noteForm')));
  });
  window.addEventListener('beforeunload', (event) => {
    if (phase === 'recording' || phase === 'review' || phase === 'finishing') {
      event.preventDefault();
      event.returnValue = '';
    }
  });
  window.addEventListener('pagehide', () => { void flushSave(); });
}

function bootAuth() {
  refreshAuth();
  if (!isLocalHost() && !getToken()) openGate('');
  else closeGate();
}

function refreshAuth() {
  const authed = Boolean(getToken());
  $('lockBtn').hidden = !authed;
  $('loginBtn').hidden = authed || !isLocalHost();
  const banner = $('localBanner');
  const showBanner = isLocalHost() && !authed;
  banner.hidden = !showBanner;
  if (showBanner) {
    banner.textContent = isApiConfigured()
      ? '這是本機預覽，畫面沒有上鎖。轉寫和整理仍要先按右上角「登入」。'
      : '這是本機預覽。請先把 js/config.js 的 API_URL 改成 Worker 網址，再按右上角「登入」。';
  }
}

function openGate(errorText) {
  $('app').hidden = true;
  $('gate').hidden = false;
  document.body.classList.add('gate-open');
  const local = isLocalHost();
  $('skipBtn').hidden = !local;
  $('skipHint').hidden = !local;
  $('gateLead').textContent = local
    ? '本機預覽可以先看畫面。要轉寫與整理時，請先登入。'
    : '請輸入密碼以繼續。';
  setLoginError(errorText || '');
  $('password').value = '';
  $('password').focus();
}

function closeGate() {
  $('gate').hidden = true;
  $('app').hidden = false;
  document.body.classList.remove('gate-open');
  refreshAuth();
}

function setLoginError(message) {
  $('loginError').hidden = !message;
  $('loginError').textContent = message || '';
}

async function onLogin(event) {
  event.preventDefault();
  const password = $('password').value;
  if (!password) {
    setLoginError('請輸入密碼');
    return;
  }
  if (!isApiConfigured()) {
    setLoginError('請先在 js/config.js 把 API_URL 改成 Worker 網址。');
    return;
  }
  const button = $('loginSubmit');
  button.disabled = true;
  button.textContent = '登入中…';
  try {
    const result = await api('/login', { password }, { timeoutMs: 20000 });
    saveToken(result.token, result.expiresAt);
    authPrompted = false;
    $('password').value = '';
    closeGate();
    toast('已登入');
  } catch (err) {
    setLoginError(err.message || '登入失敗');
  } finally {
    button.disabled = false;
    button.textContent = '登入';
  }
}

async function onLock() {
  if (phase === 'recording' || phase === 'finishing') {
    toast('請先結束錄音，再鎖定');
    return;
  }
  await releaseWakeLock();
  clearToken();
  refreshAuth();
  openGate('');
}

function renderChips() {
  $('langChips').replaceChildren(...LANGUAGES.map((lang) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'chip';
    button.textContent = lang.label;
    button.setAttribute('aria-pressed', String(selected.has(lang.id)));
    button.disabled = phase !== 'idle';
    button.addEventListener('click', () => toggleLanguage(lang.id));
    return button;
  }));
}

function toggleLanguage(id) {
  if (phase !== 'idle') return;
  if (id === 'auto') {
    selected = new Set(['auto']);
  } else {
    selected.delete('auto');
    if (selected.has(id)) selected.delete(id);
    else selected.add(id);
    if (!selected.size) selected.add('auto');
  }
  renderChips();
}

function renderHome() {
  const live = phase !== 'idle';
  document.body.classList.toggle('is-recording', live);
  $('idlePanel').hidden = live;
  $('recPanel').hidden = !live;
  renderPhase();
  renderChips();
  updateClock();
  renderTranscript();
  updateChunkStatus();
  if (session) $('langSummary').textContent = `語言：${session.languages.map(languageLabel).join('、')}`;
}

function renderPhase() {
  const paused = recorder.mode === 'paused';
  $('pauseBtn').hidden = phase !== 'recording';
  $('pauseBtn').textContent = paused ? '繼續' : '暫停';
  $('discardBtn').hidden = phase !== 'review';
  $('stopBtn').disabled = phase === 'finishing';
  $('stopBtn').textContent = phase === 'finishing' ? '整理中…' : phase === 'review' ? '整理會議記錄' : '結束';
  $('recDot').classList.toggle('live', phase === 'recording' && !paused);
  if (phase === 'finishing') $('recState').textContent = '整理中';
  else if (phase === 'review') $('recState').textContent = '錄音已結束';
  else if (paused) $('recState').textContent = '已暫停';
  else $('recState').textContent = '錄音中';
}

function updateClock() {
  const ms = session?.durationMs || recorder.elapsed();
  $('timer').textContent = formatClock(ms / 1000);
  if (recorder.mode === 'paused') $('segmentState').textContent = '已暫停';
  else if (phase === 'review') $('segmentState').textContent = '錄音已結束';
  else if (phase === 'finishing') $('segmentState').textContent = '正在結束';
  else {
    const limit = segmentSeconds();
    const into = Math.min(limit, Math.max(0, ms / 1000 - sliceOffset));
    $('segmentState').textContent = `本段 ${formatMinute(into)}／${formatMinute(limit)}`;
  }
}

function segmentSeconds() {
  const seconds = Number(SEGMENT_SECONDS);
  if (!Number.isFinite(seconds) || seconds < 1) return 10 * 60;
  return Math.round(seconds);
}

function segmentLengthText() {
  const seconds = segmentSeconds();
  if (seconds % 60 === 0) return `${seconds / 60} 分鐘`;
  return `${seconds} 秒`;
}

function applySegmentCopy() {
  const length = segmentLengthText();
  const hint = document.querySelector('#idlePanel .hint');
  if (hint) {
    hint.textContent = `使用麥克風錄音。約每 ${length}轉成逐字稿並標上時間，第一段會在約 ${length}後出現。錄音檔不會保存。`;
  }
}

function formatMinute(seconds) {
  const safe = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(safe / 60)).padStart(2, '0')}:${String(safe % 60).padStart(2, '0')}`;
}

async function onStart() {
  if (phase !== 'idle' || starting) return;
  clearHomeAlert();
  if (!window.isSecureContext) {
    showHomeAlert('請用 https 或 http://127.0.0.1 開啟，瀏覽器才允許使用麥克風。');
    return;
  }
  if (!isApiConfigured()) {
    showHomeAlert('請先在 js/config.js 設定 API_URL。');
    return;
  }
  if (!getToken()) {
    openGate('請先登入，才能把錄音送去轉寫。');
    return;
  }
  starting = true;
  $('startBtn').disabled = true;
  const wakePromise = acquireWakeLock();
  try {
    session = createSession();
    sliceOffset = 0;
    await recorder.start(onSlice);
    phase = 'recording';
    const wakeOk = await wakePromise;
    $('wakeNote').hidden = wakeOk;
    renderHome();
  } catch (err) {
    await releaseWakeLock();
    session = null;
    phase = 'idle';
    showHomeAlert(micMessage(err));
    renderHome();
  } finally {
    starting = false;
    $('startBtn').disabled = false;
  }
}

function createSession() {
  const started = new Date();
  return {
    languages: [...selected],
    startedAt: started.toISOString(),
    datetime: formatLocal(started),
    durationMs: 0,
    chunks: [],
    authFailed: false
  };
}

function onPause() {
  if (recorder.mode === 'recording') recorder.pause();
  else if (recorder.mode === 'paused') recorder.resume();
  renderPhase();
  updateClock();
}

function onSlice(slice) {
  if (!session) return;
  const chunk = {
    index: slice.index,
    offsetSec: slice.offsetSec,
    blob: slice.blob,
    status: 'pending',
    text: '',
    error: '',
    controller: new AbortController(),
    inflight: false,
    retryable: false,
    autoRetries: 0,
    retryTimer: 0
  };
  session.chunks.push(chunk);
  enqueue(chunk);
  renderTranscript();
  updateChunkStatus();
}

function enqueue(chunk) {
  if (!chunk?.blob || chunk.inflight) return;
  clearChunkRetry(chunk);
  chunk.inflight = true;
  const promise = uploadChunk(chunk).finally(() => { chunk.inflight = false; });
  trackUpload(promise);
}

function trackUpload(promise) {
  runningUploads += 1;
  updateChunkStatus();
  promise.finally(() => {
    runningUploads = Math.max(0, runningUploads - 1);
    updateChunkStatus();
    if (runningUploads === 0) idleWaiters.splice(0).forEach((resolve) => resolve());
  });
}

function whenUploadsIdle() {
  if (runningUploads === 0) return Promise.resolve();
  return new Promise((resolve) => idleWaiters.push(resolve));
}

function clearChunkRetry(chunk) {
  if (!chunk?.retryTimer) return;
  clearTimeout(chunk.retryTimer);
  chunk.retryTimer = 0;
}

function scheduleChunkRetry(chunk) {
  if (phase === 'finishing') return;
  if (!chunk?.retryable || !chunk.blob || chunk.controller?.signal.aborted) return;
  if ((chunk.autoRetries || 0) >= CHUNK_RETRY_LIMIT) return;
  clearChunkRetry(chunk);
  chunk.retryTimer = setTimeout(() => {
    chunk.retryTimer = 0;
    if (!session?.chunks.includes(chunk)) return;
    if (phase === 'finishing' || chunk.status !== 'error' || chunk.inflight || !chunk.blob) return;
    if (chunk.controller?.signal.aborted) return;
    chunk.autoRetries = (chunk.autoRetries || 0) + 1;
    enqueue(chunk);
  }, CHUNK_RETRY_MS);
}

async function retryFailedChunksOnce() {
  if (!session) return;
  if (session.authFailed && !getToken()) {
    session.chunks.forEach(clearChunkRetry);
    return;
  }
  session.chunks.forEach(clearChunkRetry);
  const failed = session.chunks.filter((chunk) => (
    chunk.status === 'error'
    && chunk.blob
    && !chunk.inflight
    && !chunk.controller?.signal.aborted
    && !String(chunk.error || '').includes('重新登入')
    && !isQuotaMessage(chunk.error)
  ));
  if (!failed.length) return;
  failed.forEach((chunk) => enqueue(chunk));
  await whenUploadsIdle();
}

function isQuotaMessage(message) {
  const text = String(message || '');
  if (text.includes('今天的免費額度已用完')) return true;
  const lower = text.toLowerCase().replace(/[_-]+/g, ' ');
  return lower.includes('per day') || lower.includes('free tier');
}

function isDailyQuotaError(err) {
  if (!isQuotaMessage(err?.message)) return false;
  if (String(err?.message || '').includes('今天的免費額度已用完')) return true;
  if (err instanceof ApiError && err.code && err.code !== 429) return false;
  return true;
}

function isAutoRetryError(err) {
  const message = String(err?.message || '');
  if (isDailyQuotaError(err)) return false;
  if (message.includes('金鑰無效') || message.includes('請重新登入') || message.includes('尚未設定') || message.includes('尚未完成設定')) return false;
  if (err instanceof ApiError && (err.code === 401 || err.code === 400 || err.code === 403 || err.code === 413 || err.code === 415 || err.code === 429 || err.code === 500)) {
    return false;
  }
  if (message.includes('無法連線到伺服器')) return true;
  if (message.includes('等待過久')) return true;
  if (message.includes('服務忙碌，稍後自動重試')) return true;
  if (err instanceof ApiError && err.code === 503) return true;
  return false;
}

function visibleError(err, fallback) {
  if (isDailyQuotaError(err)) return QUOTA_TEXT;
  if (isAutoRetryError(err)) return BUSY_RETRY_TEXT;
  return err?.message || fallback;
}

async function uploadChunk(chunk, attempt = 1) {
  if (!session || !chunk.blob) return;
  chunk.status = 'pending';
  chunk.error = '';
  renderTranscript();
  try {
    const audio = await blobToBase64(chunk.blob);
    const result = await api('/transcribe', {
      audio,
      mimeType: (chunk.blob.type || 'audio/webm').split(';')[0],
      languages: session.languages
    }, { signal: chunk.controller.signal, timeoutMs: 120000 });
    if (!session?.chunks.includes(chunk)) return;
    chunk.text = shiftTranscript(result.text || '', chunk.offsetSec);
    chunk.status = chunk.text ? 'done' : 'done';
    chunk.retryable = false;
    chunk.error = '';
    clearChunkRetry(chunk);
    chunk.blob = undefined;
    $('srStatus').textContent = `第 ${chunk.index + 1} 段逐字稿已更新`;
  } catch (err) {
    if (!session?.chunks.includes(chunk)) return;
    if (err instanceof ApiError && err.code === 401) {
      chunk.status = 'error';
      chunk.retryable = false;
      chunk.error = '請重新登入後再轉寫這一段';
      clearChunkRetry(chunk);
      session.authFailed = true;
      renderTranscript();
      await handle401();
      return;
    }
    if (isDailyQuotaError(err)) {
      chunk.status = 'error';
      chunk.retryable = false;
      chunk.error = QUOTA_TEXT;
      clearChunkRetry(chunk);
    } else if (attempt < 2 && !chunk.controller.signal.aborted) {
      await uploadChunk(chunk, attempt + 1);
      return;
    } else {
      chunk.status = 'error';
      chunk.retryable = false;
      chunk.error = err.message || '轉寫失敗';
      if (!chunk.controller.signal.aborted && isAutoRetryError(err)) {
        chunk.retryable = true;
        chunk.error = BUSY_RETRY_TEXT;
        scheduleChunkRetry(chunk);
      }
    }
  }
  renderTranscript();
  updateChunkStatus();
}

function renderTranscript() {
  const root = $('liveTranscript');
  const follow = root.scrollHeight - root.scrollTop - root.clientHeight < 80;
  const chunks = (session?.chunks || []).slice().sort((a, b) => a.index - b.index);
  root.replaceChildren();
  if (!chunks.length) {
    root.append(el('p', { class: 'placeholder', text: '說話後，逐字稿會出現在這裡。' }));
  }
  chunks.forEach((chunk) => {
    if (chunk.text) chunk.text.split('\n').forEach((line) => root.append(transcriptLine(line)));
    if (chunk.status === 'pending') {
      root.append(el('p', { class: 'pending', text: `${formatClock(chunk.offsetSec)} 轉寫中…` }));
    }
    if (chunk.status === 'error') {
      const row = el('div', { class: 'chunk-error' });
      const detail = chunk.retryable ? BUSY_RETRY_TEXT : (chunk.error || '轉寫失敗');
      row.append(el('p', { text: `${formatClock(chunk.offsetSec)} ${detail}` }));
      if (chunk.blob) {
        const button = el('button', { type: 'button', text: '重試' });
        button.addEventListener('click', () => {
          chunk.autoRetries = 0;
          enqueue(chunk);
        });
        row.append(button);
      }
      root.append(row);
    }
  });
  if (follow) root.scrollTop = root.scrollHeight;
}

function transcriptLine(line) {
  const match = line.match(/^(\d{2}:\d{2}:\d{2})\s+(.*)$/);
  if (!match) return el('p', { class: 'line', text: line });
  const row = el('p', { class: 'line' });
  const time = document.createElement('time');
  time.dateTime = match[1];
  time.textContent = match[1];
  row.append(time, el('span', { text: match[2] }));
  return row;
}

function updateChunkStatus() {
  if (!$('chunkStatus')) return;
  const chunks = session?.chunks || [];
  const pending = chunks.filter((chunk) => chunk.status === 'pending').length;
  if (phase === 'finishing' && runningUploads === 0) $('chunkStatus').textContent = '正在整理會議記錄…';
  else if (pending > 0) $('chunkStatus').textContent = pending > 4 ? '轉寫速度較慢，請保持這個畫面開啟。' : `正在轉寫 ${pending} 段`;
  else if (chunks.some((chunk) => chunk.text)) $('chunkStatus').textContent = '逐字稿已更新';
  else if (phase === 'recording') $('chunkStatus').textContent = '正在聽你說話';
  else $('chunkStatus').textContent = '';
}

async function finishRecording() {
  if (busyFinish || !session || phase === 'idle') return;
  busyFinish = true;
  const startedAsReview = phase === 'review';
  phase = 'finishing';
  renderHome();
  clearHomeAlert();
  try {
    if (recorder.mode !== 'idle') session.durationMs = await recorder.stop();
    await whenUploadsIdle();
    if (!session) return;
    await retryFailedChunksOnce();
    if (!session) return;
    if (session.authFailed && !getToken()) {
      phase = 'review';
      renderHome();
      return;
    }
    const failed = session.chunks.filter((chunk) => chunk.status === 'error' && chunk.blob);
    if (failed.length && !startedAsReview) {
      phase = 'review';
      renderHome();
      const ok = await ask(`有 ${failed.length} 段還沒轉寫成功。要先整理目前的逐字稿嗎？`, '整理目前內容', '返回', false);
      if (!ok) {
        (session?.chunks || []).forEach((chunk) => {
          if (chunk.status === 'error' && chunk.retryable && chunk.blob) scheduleChunkRetry(chunk);
        });
        return;
      }
      phase = 'finishing';
      renderHome();
    }
    const transcript = joinTranscript(session.chunks);
    if (!transcript.trim()) {
      await releaseWakeLock();
      session = null;
      phase = 'idle';
      renderHome();
      showHomeAlert('沒有辨識到說話內容。');
      return;
    }
    await summarizeAndOpen(transcript);
  } catch (err) {
    phase = 'review';
    renderHome();
    showHomeAlert(visibleError(err, '整理失敗'));
  } finally {
    busyFinish = false;
    renderPhase();
  }
}

async function summarizeAndOpen(transcript) {
  const note = {
    id: crypto.randomUUID ? crypto.randomUUID() : `m-${Date.now()}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    startedAt: session.startedAt,
    durationMs: session.durationMs || recorder.elapsed(),
    languages: session.languages.slice(),
    title: '',
    datetime: session.datetime,
    attendees: [],
    summary: '',
    discussions: [],
    decisions: [],
    actions: [],
    transcript
  };
  try {
    await saveMeeting(note);
  } catch {
    toast('歷史記錄暫時無法保存，這次內容仍可編輯與下載。');
  }
  try {
    const ai = await api('/summarize', {
      transcript,
      languages: note.languages,
      startedAt: note.datetime,
      durationText: formatClock(note.durationMs / 1000)
    }, { timeoutMs: 120000 });
    applySummary(note, ai);
    try { await saveMeeting(note); } catch { /* 已提示過 */ }
    await showFinishedNote(note, '');
  } catch (err) {
    if (err instanceof ApiError && err.code === 401) {
      if (session) session.authFailed = true;
      await showFinishedNote(note, '已保留逐字稿。登入後可以按「重新整理」。');
      await handle401();
      return;
    }
    await showFinishedNote(note, visibleError(err, '整理失敗，逐字稿已保留。'));
  }
}

function applySummary(note, ai) {
  note.title = ai.title || note.title || '未命名會議';
  note.datetime = ai.datetime || note.datetime;
  note.attendees = Array.isArray(ai.attendees) ? ai.attendees : [];
  note.summary = ai.summary || '';
  note.discussions = Array.isArray(ai.discussions) ? ai.discussions : [];
  note.decisions = Array.isArray(ai.decisions) ? ai.decisions : [];
  note.actions = Array.isArray(ai.actions) ? ai.actions : [];
}

async function showFinishedNote(note, alertText) {
  currentNote = note;
  returnTo = 'home';
  phase = 'idle';
  session?.chunks.forEach((chunk) => {
    clearChunkRetry(chunk);
    chunk.controller?.abort();
  });
  session = null;
  await releaseWakeLock();
  renderEditor();
  setNoteAlert(alertText);
  showView('viewNotes');
  renderHome();
}

async function discardRecording() {
  const ok = await ask('要捨棄這次錄音的逐字稿嗎？錄音檔本來就不會保存。', '捨棄', '取消', true);
  if (!ok) return;
  session?.chunks.forEach((chunk) => {
    clearChunkRetry(chunk);
    chunk.controller?.abort();
  });
  if (recorder.mode !== 'idle') await recorder.stop();
  await releaseWakeLock();
  session = null;
  phase = 'idle';
  renderHome();
  showView('viewHome');
}

async function handle401() {
  if (!authPrompted && recorder.mode !== 'idle') {
    authPrompted = true;
    if (session) session.durationMs = await recorder.stop();
    phase = 'review';
    renderHome();
  } else {
    authPrompted = true;
  }
  clearToken();
  refreshAuth();
  await releaseWakeLock();
  openGate('登入已逾期，請重新輸入密碼。');
}

async function showHistory() {
  showView('viewHistory');
  const list = $('historyList');
  list.replaceChildren(el('p', { class: 'placeholder', text: '讀取中…' }));
  try {
    const items = await listMeetings();
    if (!items.length) {
      list.replaceChildren(el('p', { class: 'placeholder', text: '還沒有會議記錄。結束一場錄音後會出現在這裡。' }));
      return;
    }
    list.replaceChildren(...items.map(historyCard));
  } catch (err) {
    list.replaceChildren(el('p', { class: 'alert', text: err.message || '無法讀取歷史記錄' }));
  }
}

function historyCard(note) {
  const card = el('article', { class: 'history-card' });
  const open = el('button', { type: 'button', class: 'history-open' });
  open.append(
    el('h3', { text: note.title || '未命名會議' }),
    el('p', { class: 'meta', text: `${noteWhen(note)} · ${formatClock((note.durationMs || 0) / 1000)}` }),
    el('p', { class: 'preview', text: (note.summary || note.transcript || '沒有摘要').replace(/\s+/g, ' ').slice(0, 80) })
  );
  open.addEventListener('click', () => openNote(note, 'history'));
  const remove = el('button', { type: 'button', class: 'danger-text', text: '刪除' });
  remove.addEventListener('click', () => { void deleteFromHistory(note.id); });
  card.append(open, remove);
  return card;
}

function noteWhen(note) {
  if (note.datetime) return note.datetime;
  const date = new Date(note.createdAt);
  return Number.isNaN(date.getTime()) ? '' : formatLocal(date);
}

async function deleteFromHistory(id) {
  const ok = await ask('確定刪除這筆會議記錄？此動作無法復原。', '刪除', '取消', true);
  if (!ok) return;
  await deleteMeeting(id);
  if (currentNote?.id === id) currentNote = null;
  toast('已刪除');
  await showHistory();
}

function openNote(note, from) {
  currentNote = note;
  returnTo = from;
  clearTimeout(saveTimer);
  renderEditor();
  setNoteAlert('');
  setSaveState('');
  showView('viewNotes');
}

function renderEditor() {
  const note = currentNote;
  const form = $('noteForm');
  if (!note) {
    form.replaceChildren();
    return;
  }
  const title = textInput(note.title, { 'data-field': 'title', placeholder: '這場會議在談什麼' });
  const datetime = textInput(note.datetime, { 'data-field': 'datetime', placeholder: '2026-11-17 11:20' });
  const summary = textArea(note.summary, { 'data-field': 'summary' });
  const transcript = textArea(note.transcript, { 'data-field': 'transcript', class: 'transcript-box' });
  const hint = transcriptHint(note.languages);
  form.replaceChildren(
    el('p', { class: 'meta', text: `錄音長度 ${formatClock((note.durationMs || 0) / 1000)} · ${ (note.languages || ['auto']).map(languageLabel).join('、') }` }),
    labeled('會議主題', title),
    labeled('日期時間', datetime),
    listBlock('與會者', 'attendees', note.attendees, '姓名或稱謂'),
    labeled('摘要', summary),
    listBlock('討論重點', 'discussions', note.discussions, '討論內容', true),
    listBlock('決議事項', 'decisions', note.decisions, '已決定的事項', true),
    actionBlock(note.actions),
    labeled('逐字稿', transcript),
    hint ? el('p', { class: 'fine', text: hint }) : null
  );
  fitGrowBoxes(form);
  requestAnimationFrame(() => {
    if (form.isConnected) fitGrowBoxes(form);
  });
}

function listBlock(title, key, items, placeholder, grow) {
  const rows = (items || []).map((item, index) => {
    const attrs = { 'data-list': key, placeholder, 'aria-label': title };
    const input = grow ? growArea(item, attrs) : textInput(item, attrs);
    const remove = el('button', { type: 'button', class: 'ghost', text: '移除', 'data-action': 'remove', 'data-key': key, 'data-index': String(index) });
    return el('div', { class: grow ? 'row-line is-top' : 'row-line' }, input, remove);
  });
  return el('section', { class: 'block' },
    el('div', { class: 'block-head' },
      el('h3', { text: title }),
      el('button', { type: 'button', class: 'ghost', text: '新增', 'data-action': 'add', 'data-key': key })
    ),
    ...(rows.length ? rows : [el('p', { class: 'fine', text: '尚未新增' })])
  );
}

function actionBlock(actions) {
  const rows = (actions || []).map((item, index) => el('div', { class: 'action-grid', 'data-action-row': '1' },
    labeled('事項', growArea(item.task, { 'data-part': 'task', placeholder: '要做的事' })),
    labeled('負責人', growArea(item.owner, { 'data-part': 'owner', placeholder: '誰負責' })),
    labeled('期限', growArea(item.due, { 'data-part': 'due', placeholder: '何時完成' })),
    el('button', { type: 'button', class: 'ghost', text: '移除', 'data-action': 'remove', 'data-key': 'actions', 'data-index': String(index) })
  ));
  return el('section', { class: 'block' },
    el('div', { class: 'block-head' },
      el('h3', { text: '待辦事項' }),
      el('button', { type: 'button', class: 'ghost', text: '新增', 'data-action': 'add', 'data-key': 'actions' })
    ),
    ...(rows.length ? rows : [el('p', { class: 'fine', text: '尚未新增' })])
  );
}

function labeled(title, control) {
  const label = el('label', { class: 'field' });
  label.append(el('span', { text: title }), control);
  return label;
}

function textInput(value, attrs) {
  const node = el('input', { type: 'text', ...attrs });
  node.value = value || '';
  return node;
}

function textArea(value, attrs) {
  const node = el('textarea', attrs);
  node.value = value || '';
  return node;
}

function growArea(value, attrs = {}) {
  const classes = ['grow-box', attrs.class].filter(Boolean).join(' ');
  return textArea(value, { ...attrs, class: classes, rows: '1' });
}

function fitGrowBox(node) {
  if (!node || node.clientWidth === 0) return;
  node.style.height = 'auto';
  const border = node.offsetHeight - node.clientHeight;
  node.style.height = `${node.scrollHeight + Math.max(0, border)}px`;
}

function fitGrowBoxes(root) {
  if (!root) return;
  root.querySelectorAll('textarea.grow-box').forEach(fitGrowBox);
}

function onNotesClick(event) {
  const button = event.target.closest('[data-action]');
  if (!button || !currentNote) return;
  const action = button.dataset.action;
  if (action === 'back') { void backFromNotes(); return; }
  if (action === 'download') { void onDownload(); return; }
  if (action === 'copy') { void onCopy(); return; }
  if (action === 'save') { void flushSave().then(() => toast('已儲存')); return; }
  if (action === 'regen') { void regenerate(); return; }
  if (action === 'delete') { void deleteCurrent(); return; }
  if (action === 'add') addRow(button.dataset.key);
  if (action === 'remove') removeRow(button.dataset.key, Number(button.dataset.index));
}

function addRow(key) {
  currentNote = readForm();
  if (key === 'actions') currentNote.actions.push({ task: '', owner: '', due: '' });
  else currentNote[key].push('');
  renderEditor();
  const selector = key === 'actions' ? '[data-part="task"]' : `[data-list="${key}"]`;
  const nodes = document.querySelectorAll(selector);
  nodes[nodes.length - 1]?.focus();
}

function removeRow(key, index) {
  currentNote = readForm();
  currentNote[key].splice(index, 1);
  renderEditor();
  scheduleSave();
}

function readForm() {
  const root = $('noteForm');
  return {
    ...currentNote,
    title: fieldValue(root, '[data-field="title"]'),
    datetime: fieldValue(root, '[data-field="datetime"]'),
    summary: fieldValue(root, '[data-field="summary"]'),
    transcript: fieldValue(root, '[data-field="transcript"]'),
    attendees: listValues(root, '[data-list="attendees"]'),
    discussions: listValues(root, '[data-list="discussions"]'),
    decisions: listValues(root, '[data-list="decisions"]'),
    actions: [...root.querySelectorAll('[data-action-row]')].map((row) => ({
      task: row.querySelector('[data-part="task"]').value,
      owner: row.querySelector('[data-part="owner"]').value,
      due: row.querySelector('[data-part="due"]').value
    }))
  };
}

function fieldValue(root, selector) {
  return root.querySelector(selector)?.value || '';
}

function listValues(root, selector) {
  return [...root.querySelectorAll(selector)].map((node) => node.value);
}

function scheduleSave() {
  if (noteBusy) return;
  clearTimeout(saveTimer);
  setSaveState('編輯中…');
  saveTimer = setTimeout(() => { void flushSave(); }, 500);
}

async function flushSave() {
  clearTimeout(saveTimer);
  if (!currentNote || $('viewNotes').hidden || !$('noteForm').querySelector('[data-field="title"]')) return;
  currentNote = readForm();
  try {
    currentNote = await saveMeeting(currentNote);
    setSaveState('已儲存');
  } catch (err) {
    setSaveState(err?.name === 'QuotaExceededError' ? '瀏覽器儲存空間不足' : '儲存失敗');
  }
}

async function backFromNotes() {
  await flushSave();
  currentNote = null;
  if (returnTo === 'history') await showHistory();
  else {
    showView('viewHome');
    renderHome();
  }
}

async function onCopy() {
  currentNote = readForm();
  const text = notesToText(currentNote);
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    document.body.append(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
  toast('已複製文字');
  scheduleSave();
}

async function onDownload() {
  currentNote = readForm();
  const saving = saveMeeting(currentNote).then((saved) => {
    currentNote = saved;
    setSaveState('已儲存');
  }).catch(() => setSaveState('尚未寫入歷史記錄'));
  try {
    const blob = await createDocx(currentNote);
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = docxFileName(currentNote);
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast('已下載 Word');
  } catch (err) {
    toast(err.message || '無法產生 Word');
  }
  await saving;
}

async function regenerate() {
  currentNote = readForm();
  if (!currentNote.transcript.trim()) {
    setNoteAlert('沒有逐字稿可以整理。');
    return;
  }
  const ok = await ask('重新整理會覆寫主題、摘要、討論、決議與待辦。逐字稿會保留。', '重新整理', '取消', false);
  if (!ok) return;
  setNotesBusy(true);
  try {
    const ai = await api('/summarize', {
      transcript: currentNote.transcript,
      languages: currentNote.languages,
      startedAt: currentNote.datetime,
      durationText: formatClock((currentNote.durationMs || 0) / 1000)
    }, { timeoutMs: 120000 });
    applySummary(currentNote, ai);
    try {
      currentNote = await saveMeeting(currentNote);
      setSaveState('已儲存');
    } catch {
      setSaveState('尚未寫入歷史記錄');
    }
    renderEditor();
    setNoteAlert('');
    toast('已重新整理');
  } catch (err) {
    if (err instanceof ApiError && err.code === 401) {
      renderEditor();
      await handle401();
      return;
    }
    setNoteAlert(visibleError(err, '整理失敗'));
  } finally {
    setNotesBusy(false);
  }
}

async function deleteCurrent() {
  if (!currentNote?.id) return;
  const ok = await ask('確定刪除這筆會議記錄？此動作無法復原。', '刪除', '取消', true);
  if (!ok) return;
  await deleteMeeting(currentNote.id);
  currentNote = null;
  toast('已刪除');
  if (returnTo === 'history') await showHistory();
  else {
    showView('viewHome');
    renderHome();
  }
}

function setNotesBusy(busy) {
  noteBusy = busy;
  ['btnDownload', 'btnCopy', 'btnSave', 'btnRegen', 'btnDelete', 'notesBack'].forEach((id) => {
    $(id).disabled = busy;
  });
  if (busy) setSaveState('整理中…');
  else if ($('saveState').textContent === '整理中…') setSaveState('');
}

function setNoteAlert(message) {
  $('noteAlert').hidden = !message;
  $('noteAlert').textContent = message || '';
}

function setSaveState(message) {
  $('saveState').textContent = message || '';
}

function showView(id) {
  ['viewHome', 'viewHistory', 'viewNotes'].forEach((view) => {
    $(view).hidden = view !== id;
  });
  window.scrollTo(0, 0);
}

function showHomeAlert(message) {
  $('homeAlert').hidden = !message;
  $('homeAlert').textContent = message || '';
}

function clearHomeAlert() {
  showHomeAlert('');
}

function micMessage(err) {
  const name = err?.name || '';
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') return '請允許麥克風權限才能錄音。';
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return '找不到麥克風。';
  if (name === 'NotReadableError') return '麥克風正在被其他程式使用。';
  if (typeof err?.message === 'string' && err.message) return err.message;
  return '無法開始錄音';
}

function ask(message, okText, cancelText, danger) {
  return new Promise((resolve) => {
    const modal = $('modal');
    const ok = $('modalOk');
    const cancel = $('modalCancel');
    $('modalText').textContent = message;
    ok.textContent = okText;
    cancel.textContent = cancelText;
    ok.classList.toggle('danger', Boolean(danger));
    modal.hidden = false;
    const finish = (value) => {
      modal.hidden = true;
      ok.removeEventListener('click', onOk);
      cancel.removeEventListener('click', onCancel);
      document.removeEventListener('keydown', onKey);
      modal.removeEventListener('click', onBackdrop);
      resolve(value);
    };
    const onOk = () => finish(true);
    const onCancel = () => finish(false);
    const onKey = (event) => { if (event.key === 'Escape') finish(false); };
    const onBackdrop = (event) => { if (event.target === modal) finish(false); };
    ok.addEventListener('click', onOk);
    cancel.addEventListener('click', onCancel);
    document.addEventListener('keydown', onKey);
    modal.addEventListener('click', onBackdrop);
    cancel.focus();
  });
}

function toast(message) {
  const node = $('toast');
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, 2600);
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  Object.entries(props).forEach(([key, value]) => {
    if (value == null || value === false) return;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else node.setAttribute(key, value === true ? '' : String(value));
  });
  children.flat().forEach((child) => {
    if (child == null || child === false) return;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  });
  return node;
}
