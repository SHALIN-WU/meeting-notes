import { languageLabel } from './languages.js';

export function formatClock(totalSeconds) {
  const safe = Number.isFinite(totalSeconds) ? Math.max(0, Math.floor(totalSeconds)) : 0;
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;
  return [hours, minutes, seconds].map((part) => String(part).padStart(2, '0')).join(':');
}

export function formatLocal(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function shiftTranscript(text, offsetSec) {
  const offset = Number.isFinite(offsetSec) ? Math.max(0, Math.floor(offsetSec)) : 0;
  return String(text || '')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parsed = parseStamp(line);
      const body = parsed.text.trim();
      if (!body) return '';
      return `${formatClock(parsed.seconds + offset)} ${body}`;
    })
    .filter(Boolean)
    .join('\n');
}

export function joinTranscript(chunks) {
  return (chunks || [])
    .slice()
    .sort((a, b) => a.index - b.index)
    .map((chunk) => String(chunk.text || '').trim())
    .filter(Boolean)
    .join('\n');
}

export function shouldKeepOriginalNote(languages) {
  const list = Array.isArray(languages) && languages.length ? languages : ['auto'];
  if (list.includes('auto')) return true;
  return list.some((lang) => lang !== 'zh' && lang !== 'nan');
}

export function transcriptHint(languages) {
  const list = Array.isArray(languages) && languages.length ? languages : ['auto'];
  const foreign = list.some((lang) => ['en', 'ja', 'ko', 'vi', 'auto'].includes(lang));
  if (list.includes('nan') && !foreign) return '台語已轉寫成繁體中文意思。';
  if (shouldKeepOriginalNote(list)) return '會議記錄以繁體中文撰寫，這裡保留逐字稿。';
  return '';
}

export function noteBlocks(note) {
  const languages = Array.isArray(note.languages) && note.languages.length ? note.languages : ['auto'];
  const attendees = cleanList(note.attendees);
  const discussions = cleanList(note.discussions);
  const decisions = cleanList(note.decisions);
  const actions = (note.actions || []).filter((item) => clean(item?.task) || clean(item?.owner) || clean(item?.due));
  const blocks = [
    { type: 'h1', text: clean(note.title) || '未命名會議' },
    { type: 'p', text: `日期時間：${clean(note.datetime) || '（未填）'}` },
    { type: 'p', text: `錄音長度：${formatClock((Number(note.durationMs) || 0) / 1000)}` },
    { type: 'p', text: `會議語言：${languages.map(languageLabel).join('、')}` },
    { type: 'p', text: `與會者：${attendees.join('、') || '（未能辨識）'}` }
  ];
  if (shouldKeepOriginalNote(languages)) {
    blocks.push({ type: 'p', text: '本記錄以繁體中文撰寫，文末保留逐字稿。' });
  }
  blocks.push({ type: 'h2', text: '摘要' });
  pushLines(blocks, note.summary);
  blocks.push({ type: 'h2', text: '討論重點' });
  pushItems(blocks, discussions);
  blocks.push({ type: 'h2', text: '決議事項' });
  pushItems(blocks, decisions);
  blocks.push({ type: 'h2', text: '待辦事項' });
  if (!actions.length) blocks.push({ type: 'p', text: '（無）' });
  actions.forEach((item, index) => {
    const extra = [];
    if (clean(item.owner)) extra.push(`負責人：${clean(item.owner)}`);
    if (clean(item.due)) extra.push(`期限：${clean(item.due)}`);
    const suffix = extra.length ? `（${extra.join('，')}）` : '';
    blocks.push({ type: 'p', text: `${index + 1}. ${clean(item.task) || '（未填事項）'}${suffix}` });
  });
  blocks.push({ type: 'h2', text: '逐字稿' });
  const transcript = clean(note.transcript);
  if (!transcript) blocks.push({ type: 'p', text: '（無）' });
  else transcript.split('\n').forEach((line) => {
    if (line.trim()) blocks.push({ type: 'p', text: line.trim() });
  });
  return blocks;
}

export function notesToText(note) {
  const lines = [];
  noteBlocks(note).forEach((block) => {
    if (block.type === 'h2') lines.push('', block.text);
    else lines.push(block.text);
  });
  return `${lines.join('\n').trim()}\n`;
}

export function docxFileName(note) {
  const title = (clean(note.title) || '會議記錄')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40) || '會議記錄';
  const day = clean(note.datetime).slice(0, 10);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : formatLocal(new Date()).slice(0, 10);
  return `${title}-${date}.docx`;
}

function parseStamp(line) {
  const match = line.match(/^\[(\d{1,2}):(\d{2})(?::(\d{2}))?\]\s*(.*)$/);
  if (!match) return { seconds: 0, text: line };
  const first = Number(match[1]);
  const second = Number(match[2]);
  const seconds = match[3] == null
    ? first * 60 + second
    : first * 3600 + second * 60 + Number(match[3]);
  return { seconds, text: match[4] || '' };
}

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function cleanList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => clean(item)).filter(Boolean);
}

function pushLines(blocks, value) {
  const text = clean(value);
  if (!text) {
    blocks.push({ type: 'p', text: '（無）' });
    return;
  }
  text.split('\n').forEach((line) => {
    if (line.trim()) blocks.push({ type: 'p', text: line.trim() });
  });
}

function pushItems(blocks, items) {
  if (!items.length) {
    blocks.push({ type: 'p', text: '（無）' });
    return;
  }
  items.forEach((item, index) => blocks.push({ type: 'p', text: `${index + 1}. ${item}` }));
}
