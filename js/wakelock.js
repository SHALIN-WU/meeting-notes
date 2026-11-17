let wanted = false;
let sentinel = null;

export async function acquireWakeLock() {
  wanted = true;
  if (!('wakeLock' in navigator)) return false;
  try {
    const next = await navigator.wakeLock.request('screen');
    if (!wanted) {
      try { await next.release(); } catch { /* 錄音沒有開始 */ }
      return false;
    }
    sentinel = next;
    sentinel.addEventListener('release', () => {
      if (sentinel === next) sentinel = null;
    });
    return true;
  } catch {
    return false;
  }
}

export async function releaseWakeLock() {
  wanted = false;
  const current = sentinel;
  sentinel = null;
  if (!current) return;
  try {
    await current.release();
  } catch {
    /* 已經放開 */
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && wanted) {
    void acquireWakeLock();
  }
});
