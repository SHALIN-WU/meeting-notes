import { SEGMENT_SECONDS } from './config.js';

function sliceMs() {
  const seconds = Number(SEGMENT_SECONDS);
  if (!Number.isFinite(seconds) || seconds < 1) return 10 * 60 * 1000;
  return Math.round(seconds * 1000);
}
const QUIET_RMS = 0.012;
const QUIET_MS = 2000;

export function createRecorder() {
  let stream = null;
  let mode = 'idle';
  let mime = '';
  let accumulated = 0;
  let runningSince = 0;
  let tickTimer = 0;
  let loopPromise = Promise.resolve();
  let active = null;
  let resumePause = null;
  let sliceIndex = 0;
  let audioCtx = null;
  let levelTimer = 0;
  let quietSince = 0;
  const listeners = new Set();

  function emit(type, detail) {
    listeners.forEach((listener) => listener(type, detail));
  }

  function elapsed() {
    return accumulated + (runningSince ? Date.now() - runningSince : 0);
  }

  function freezeClock() {
    if (runningSince) {
      accumulated += Date.now() - runningSince;
      runningSince = 0;
    }
    return accumulated;
  }

  function waitIfPaused() {
    if (mode !== 'paused') return Promise.resolve();
    return new Promise((resolve) => {
      resumePause = resolve;
    });
  }

  function releasePause() {
    const resume = resumePause;
    resumePause = null;
    if (resume) resume();
  }

  function openSlice() {
    const recorder = new MediaRecorder(stream, { mimeType: mime });
    const parts = [];
    const started = Date.now();
    let settled = false;
    let resolve;
    let reject;
    const finished = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const fileType = () => (recorder.mimeType || mime || 'audio/webm').split(';')[0] || 'audio/webm';
    const handle = { stop: () => {}, finished, timer: 0 };
    const finish = (ok, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(handle.timer);
      if (ok) resolve(value);
      else reject(value);
    };
    recorder.addEventListener('dataavailable', (event) => {
      if (event.data && event.data.size) parts.push(event.data);
    });
    recorder.addEventListener('stop', () => {
      finish(true, {
        blob: new Blob(parts, { type: fileType() }),
        durationSec: (Date.now() - started) / 1000
      });
    });
    recorder.addEventListener('error', () => finish(false, new Error('錄音中斷')));
    const stop = () => {
      try {
        if (recorder.state === 'recording') recorder.stop();
        else {
          finish(true, {
            blob: new Blob(parts, { type: fileType() }),
            durationSec: (Date.now() - started) / 1000
          });
        }
      } catch (err) {
        finish(false, err);
      }
    };
    handle.stop = stop;
    try {
      recorder.start();
    } catch (err) {
      finish(false, err);
    }
    return handle;
  }

  function beginSlice() {
    const slice = openSlice();
    void slice.finished.catch(() => {});
    active = slice;
    slice.timer = setTimeout(() => handoff(slice), sliceMs());
    emit('slice', Math.floor(elapsed() / 1000));
    return slice;
  }

  function handoff(slice) {
    if (active !== slice) return;
    clearTimeout(slice.timer);
    slice.stop();
    if (mode !== 'recording') {
      active = null;
      return;
    }
    beginSlice();
  }

  async function loop(onSlice) {
    while (mode === 'recording' || mode === 'paused') {
      if (mode === 'paused') {
        await waitIfPaused();
        continue;
      }
      const offsetSec = Math.floor(elapsed() / 1000);
      if (!active) beginSlice();
      const slice = active;
      let result = null;
      try {
        result = await slice.finished;
      } catch (err) {
        if (active === slice) active = null;
        emit('error', err);
        mode = 'idle';
        break;
      }
      if (active === slice) active = null;
      if (result && result.blob.size > 200 && result.durationSec >= 0.8) {
        onSlice({
          blob: result.blob,
          index: sliceIndex,
          offsetSec,
          durationSec: result.durationSec
        });
        sliceIndex += 1;
      }
    }
  }

  function watchLevel() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx || !stream) return;
    try {
      audioCtx = new Ctx();
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      const bins = new Uint8Array(analyser.fftSize);
      void audioCtx.resume().catch(() => {});
      quietSince = 0;
      levelTimer = window.setInterval(() => {
        if (mode !== 'recording' || !analyser) {
          quietSince = 0;
          emit('level', false);
          return;
        }
        analyser.getByteTimeDomainData(bins);
        let sum = 0;
        for (let i = 0; i < bins.length; i += 1) {
          const sample = (bins[i] - 128) / 128;
          sum += sample * sample;
        }
        const rms = Math.sqrt(sum / bins.length);
        const now = Date.now();
        if (rms < QUIET_RMS) {
          if (!quietSince) quietSince = now;
        } else {
          quietSince = 0;
        }
        emit('level', Boolean(quietSince) && now - quietSince >= QUIET_MS);
      }, 300);
    } catch {
      emit('level', false);
    }
  }

  function stopLevelWatch() {
    clearInterval(levelTimer);
    levelTimer = 0;
    quietSince = 0;
    emit('level', false);
    const ctx = audioCtx;
    audioCtx = null;
    if (ctx) void ctx.close().catch(() => {});
  }

  return {
    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    elapsed,
    get mode() {
      return mode;
    },
    async start(onSlice) {
      if (mode !== 'idle') return;
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
        throw new Error('這個瀏覽器不支援錄音，請改用新版 Chrome、Edge 或 Safari。');
      }
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 }
      });
      mime = pickMime();
      if (!mime) {
        stream.getTracks().forEach((track) => track.stop());
        stream = null;
        throw new Error('這個瀏覽器不支援 WebM 或 MP4 錄音。');
      }
      accumulated = 0;
      runningSince = Date.now();
      sliceIndex = 0;
      active = null;
      mode = 'recording';
      emit('state', 'recording');
      watchLevel();
      tickTimer = window.setInterval(() => emit('tick', elapsed()), 250);
      loopPromise = loop(onSlice);
    },
    pause() {
      if (mode !== 'recording') return;
      freezeClock();
      mode = 'paused';
      if (active) {
        clearTimeout(active.timer);
        const slice = active;
        active = null;
        slice.stop();
      }
      emit('level', false);
      emit('state', 'paused');
    },
    resume() {
      if (mode !== 'paused') return;
      mode = 'recording';
      runningSince = Date.now();
      releasePause();
      emit('state', 'recording');
      emit('tick', elapsed());
    },
    async stop() {
      const duration = freezeClock();
      mode = 'idle';
      if (active) {
        clearTimeout(active.timer);
        const slice = active;
        active = null;
        slice.stop();
      }
      releasePause();
      clearInterval(tickTimer);
      tickTimer = 0;
      stopLevelWatch();
      try {
        await loopPromise;
      } catch {
        /* 切片錯誤已另行通知 */
      }
      stream?.getTracks().forEach((track) => track.stop());
      stream = null;
      emit('state', 'idle');
      return duration;
    }
  };
}

function pickMime() {
  const types = ['audio/webm;codecs=opus', 'audio/mp4'];
  return types.find((type) => MediaRecorder.isTypeSupported(type)) || '';
}
