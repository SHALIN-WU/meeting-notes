const DB_NAME = 'meeting-ai';
const STORE = 'meetings';

function openDatabase() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
      reject(new Error('這個瀏覽器不支援歷史記錄。'));
      return;
    }
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('無法開啟歷史記錄。'));
  });
}

function run(mode, fn) {
  return openDatabase().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const store = tx.objectStore(STORE);
    let result;
    const request = fn(store);
    request.onsuccess = () => {
      result = request.result;
    };
    tx.oncomplete = () => {
      db.close();
      resolve(result);
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error || new Error('儲存失敗。'));
    };
    tx.onabort = () => {
      db.close();
      reject(tx.error || new Error('儲存已中止。'));
    };
  }));
}

export function prepareDatabase() {
  return openDatabase().then((db) => db.close());
}

export function saveMeeting(note) {
  const clean = sanitize(note);
  clean.updatedAt = new Date().toISOString();
  return run('readwrite', (store) => store.put(clean)).then(() => clean);
}

export function deleteMeeting(id) {
  return run('readwrite', (store) => store.delete(id));
}

export function getMeeting(id) {
  return run('readonly', (store) => store.get(id)).then((value) => sanitize(value));
}

export function listMeetings() {
  return run('readonly', (store) => store.getAll()).then((items) => (
    (items || [])
      .map(sanitize)
      .filter((item) => item.id)
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
  ));
}

function sanitize(raw) {
  if (!raw || typeof raw !== 'object') return blank();
  const note = blank();
  note.id = typeof raw.id === 'string' ? raw.id : '';
  note.createdAt = typeof raw.createdAt === 'string' ? raw.createdAt : note.createdAt;
  note.updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : note.updatedAt;
  note.startedAt = typeof raw.startedAt === 'string' ? raw.startedAt : '';
  note.durationMs = Number.isFinite(raw.durationMs) ? raw.durationMs : 0;
  note.languages = Array.isArray(raw.languages) ? raw.languages.filter((item) => typeof item === 'string') : ['auto'];
  note.title = text(raw.title);
  note.datetime = text(raw.datetime);
  note.attendees = stringList(raw.attendees);
  note.summary = text(raw.summary);
  note.discussions = stringList(raw.discussions);
  note.decisions = stringList(raw.decisions);
  note.actions = Array.isArray(raw.actions) ? raw.actions.map((item) => ({
    task: text(item?.task),
    owner: text(item?.owner),
    due: text(item?.due)
  })) : [];
  note.transcript = text(raw.transcript);
  return note;
}

function blank() {
  const now = new Date().toISOString();
  return {
    id: '',
    createdAt: now,
    updatedAt: now,
    startedAt: '',
    durationMs: 0,
    languages: ['auto'],
    title: '',
    datetime: '',
    attendees: [],
    summary: '',
    discussions: [],
    decisions: [],
    actions: [],
    transcript: ''
  };
}

function text(value) {
  return typeof value === 'string' ? value : '';
}

function stringList(value) {
  return Array.isArray(value) ? value.map((item) => text(item)) : [];
}
