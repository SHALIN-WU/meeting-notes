export const LANGUAGES = [
  { id: 'auto', label: '自動偵測' },
  { id: 'zh', label: '中文' },
  { id: 'en', label: '英文' },
  { id: 'ja', label: '日文' },
  { id: 'ko', label: '韓文' },
  { id: 'vi', label: '越南語' },
  { id: 'nan', label: '台語' }
];

export function languageLabel(id) {
  return LANGUAGES.find((item) => item.id === id)?.label || id;
}
