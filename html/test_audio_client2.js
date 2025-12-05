/**
 * Simple browser client for ws://<host>/audiows.
 * - Sends plain-text prompts.
 * - Receives JSON word timings (text frames) and little-endian PCM_16 audio chunks (binary frames).
 * - Streams playback via Web Audio.
 */

const SAMPLE_RATE = 44100;                      // Matches melo/ws.py `sr`.
const WS_URL = `ws://${location.host}/audiows`;

const state = {
  ws: null,
  audioCtx: null,
  playbackCursor: 0,
  connecting: false,
};

const elts = {};
const transcript = {
  words: [],
  utteranceStartTime: 0,
  awaitingFirstAudio: true,
  rafId: null,
  currentWord: null,
  bufferedUntilMs: 0,
};
const pendingTimings = [];
const TIMING_LOOKAHEAD_MS = 60;
const chunkStartWatchers = new Set();

function $(id) {
  return document.getElementById(id);
}

function reportNewChunk(startMs, durationMs) {
  const safeStart = Number.isFinite(startMs) ? startMs : 0;
  const safeDuration = Number.isFinite(durationMs) ? durationMs : 0;
  console.log(
    `[audio] queued chunk @ ${safeStart.toFixed(0)}ms for ${(safeDuration / 1000).toFixed(3)}s`
  );
}

function onChunkStart(callback) {
  if (typeof callback !== "function") return () => {};
  chunkStartWatchers.add(callback);
  return () => chunkStartWatchers.delete(callback);
}

function notifyChunkStart(startMs) {
  chunkStartWatchers.forEach((cb) => {
    try {
      cb(startMs);
    } catch (err) {
      console.error("chunkStart watcher failed:", err);
    }
  });
}

function init() {
  elts.status = $("connection-status");
  elts.statusText = $("status-text");
  elts.prompt = $("tts-input");
  elts.log = $("log-lines");
  elts.timings = $("timings");
  elts.connectBtn = $("connect-btn");
  elts.sendBtn = $("send-btn");

  elts.transcriptStream = $("transcript-stream");
  elts.transcriptStatus = $("transcript-status");
  elts.transcriptProgress = $("transcript-progress");
  elts.clearTranscript = $("clear-transcript");

  elts.connectBtn.addEventListener("click", connect);
  elts.sendBtn.addEventListener("click", sendPrompt);
  elts.clearTranscript.addEventListener("click", clearTranscript);

  connect();
}

function setStatus(text, stateAttr) {
  elts.statusText.textContent = text;
  elts.status.dataset.state = stateAttr;
}

function appendLog(text) {
  const line = document.createElement("div");
  line.className = "log-entry";
  line.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
  elts.log.prepend(line);
}

function appendTiming(wordDurList) {
  const li = document.createElement("li");
  li.textContent = wordDurList
    .map((entry, idx) => {
      const inferredEnd = inferEndMs(entry, wordDurList[idx + 1]);
      const displayEnd = inferredEnd ?? entry.end_ms;
      return `${entry.word ?? "[pause]"} (${entry.start_ms?.toFixed?.(0) ?? "?"}–${displayEnd?.toFixed?.(0) ?? "?"} ms)`;
    })
    .join(", ");
  elts.timings.prepend(li);
  while (elts.timings.children.length > 40) {
    elts.timings.removeChild(elts.timings.lastChild);
  }

  const fragment = document.createDocumentFragment();
  wordDurList.forEach((entry) => {
    const startMs = entry.start_ms ?? null;
    if (startMs != null) {
      const prev = transcript.words.at(-1);
      if (prev && (prev.end_ms == null || Number.isNaN(prev.end_ms))) {
        prev.end_ms = startMs;
      }
    }
    transcript.words.push({
      ...entry,
      element: createTranscriptWord(entry.word),
      spoken: false,
    });
    fragment.appendChild(transcript.words.at(-1).element);
  });
  elts.transcriptStream.appendChild(fragment);
  elts.transcriptStream.scrollTop = elts.transcriptStream.scrollHeight;
  elts.transcriptStatus.textContent = "Streaming…";
  updateTranscriptProgress();
}

function enqueueTimings(wordDurList) {
  if (!Array.isArray(wordDurList) || !wordDurList.length) return;
  pendingTimings.push(...wordDurList);
  flushPendingTimings(transcript.bufferedUntilMs);
}

function flushPendingTimings(upToMs) {
  if (!upToMs || !pendingTimings.length) return;
  const ready = [];
  while (pendingTimings.length) {
    const next = pendingTimings[0];
    const startMs = next?.start_ms;
    if (
      startMs == null ||
      Number.isNaN(startMs) ||
      startMs <= upToMs + TIMING_LOOKAHEAD_MS
    ) {
      ready.push(pendingTimings.shift());
    } else {
      break;
    }
  }
  if (ready.length) {
    appendTiming(ready);
  }
}

function ensureAudioContext() {
  if (!state.audioCtx) {
    state.audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
    state.playbackCursor = state.audioCtx.currentTime;
  }
  if (state.audioCtx.state === "suspended") {
    return state.audioCtx.resume();
  }
  return Promise.resolve();
}

function schedulePcmChunk(arrayBuffer) {
  if (!state.audioCtx) return;

  const pcm16 = new Int16Array(arrayBuffer);
  const float32 = new Float32Array(pcm16.length);
  for (let i = 0; i < pcm16.length; i += 1) {
    float32[i] = pcm16[i] / 32768;
  }

  const buffer = state.audioCtx.createBuffer(1, float32.length, SAMPLE_RATE);
  buffer.copyToChannel(float32, 0);

  const source = state.audioCtx.createBufferSource();
  source.buffer = buffer;
  source.connect(state.audioCtx.destination);

  const startTime = Math.max(state.playbackCursor, state.audioCtx.currentTime);
  let chunkStartMs;
  if (transcript.awaitingFirstAudio) {
    transcript.awaitingFirstAudio = false;
    transcript.utteranceStartTime = startTime;
    chunkStartMs = 0;
    startTranscriptLoop();
  } else {
    chunkStartMs =
      (startTime - transcript.utteranceStartTime) * 1000;
  }
  source.start(startTime);
  reportNewChunk(chunkStartMs ?? 0, buffer.duration * 1000);
  scheduleChunkStartNotification(startTime, chunkStartMs ?? 0);
  state.playbackCursor = startTime + buffer.duration;
  const chunkEndMs = chunkStartMs + buffer.duration * 1000;
  transcript.bufferedUntilMs = Math.max(transcript.bufferedUntilMs, chunkEndMs);
  flushPendingTimings(transcript.bufferedUntilMs);
}

function connect() {
  if (state.connecting) return;
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.close(1000, "Reconnecting");
  }

  appendLog("Opening WebSocket…");
  setStatus("Connecting…", "connecting");
  state.connecting = true;

  const ws = new WebSocket(WS_URL);
  ws.binaryType = "arraybuffer";

  ws.onopen = () => {
    state.connecting = false;
    setStatus("Connected", "connected");
    appendLog("WebSocket connected.");
  };

  ws.onmessage = (evt) => handleMessage(evt.data);

  ws.onerror = (evt) => {
    appendLog(`WebSocket error: ${evt.message || evt.type}`);
  };

  ws.onclose = (evt) => {
    state.ws = null;
    state.connecting = false;
    setStatus("Disconnected", "disconnected");
    appendLog(`Socket closed (${evt.code}).`);
  };

  state.ws = ws;
}

function handleMessage(data) {
  if (typeof data === "string") {
    if (!data) return;
    if (data === "EOF") {
      appendLog("Server signaled end of stream.");
      state.playbackCursor = state.audioCtx?.currentTime ?? 0;
      endTranscript();
      return;
    }

    try {
      const timings = JSON.parse(data);
      if (Array.isArray(timings)) {
        enqueueTimings(timings);
      } else {
        appendLog(`Received text frame: ${data}`);
      }
    } catch {
      appendLog(`Non‑JSON text frame: ${data}`);
    }
    return;
  }

  // Binary frame (ArrayBuffer).
  ensureAudioContext()
    .then(() => schedulePcmChunk(data))
    .catch((err) => appendLog(`AudioContext error: ${err.message}`));
}

function scheduleChunkStartNotification(startTime, chunkStartMs) {
  if (!state.audioCtx) return;
  const notify = () => {
    const elapsed =
      (state.audioCtx.currentTime - transcript.utteranceStartTime) * 1000;
    notifyChunkStart(chunkStartMs);
    console.log(`[audio] chunk began @ ${chunkStartMs.toFixed(0)}ms (elapsed=${elapsed.toFixed(0)}ms)`);
  };
  const tick = () => {
    const now = state.audioCtx.currentTime;
    if (now >= startTime) {
      notify();
    } else {
      requestAnimationFrame(tick);
    }
  };
  requestAnimationFrame(tick);
}

function sendPrompt() {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    appendLog("Cannot send: socket not open.");
    return;
  }

  const text = elts.prompt.value.trim();
  if (!text) {
    appendLog("Please enter text before sending.");
    return;
  }

  ensureAudioContext()
    .then(() => {
      appendLog(`Sending prompt (${text.length} chars)…`);
      resetTranscript();
      state.ws.send(text);
    })
    .catch((err) => appendLog(`AudioContext error: ${err.message}`));
}

window.addEventListener("DOMContentLoaded", init);

function createTranscriptWord(word) {
  const span = document.createElement("span");
  span.className = "transcript-word";
  span.textContent = word || "•";
  return span;
}

function resetTranscript() {
  stopTranscriptLoop();
  transcript.words = [];
  transcript.awaitingFirstAudio = true;
  transcript.utteranceStartTime = 0;
  transcript.currentWord = null;
  transcript.bufferedUntilMs = 0;
  pendingTimings.length = 0;
  elts.transcriptStream.textContent = "";
  elts.transcriptStatus.textContent = "Awaiting audio…";
  elts.transcriptProgress.textContent = "";
}

function clearTranscript() {
  resetTranscript();
  appendLog("Transcript cleared.");
}

function updateTranscriptProgress() {
  const spoken = transcript.words.filter((w) => w.spoken).length;
  const total = transcript.words.length;
  elts.transcriptProgress.textContent = total
    ? `${spoken} / ${total} words`
    : "";
}

function startTranscriptLoop() {
  if (transcript.rafId || !state.audioCtx) return;
  elts.transcriptStatus.textContent = "Playing…";
  const tick = () => {
    highlightTranscript();
    transcript.rafId = requestAnimationFrame(tick);
  };
  transcript.rafId = requestAnimationFrame(tick);
}

function stopTranscriptLoop() {
  if (transcript.rafId) {
    cancelAnimationFrame(transcript.rafId);
    transcript.rafId = null;
  }
}

function highlightTranscript() {
  if (!state.audioCtx || transcript.awaitingFirstAudio) return;
  const elapsedMs =
    (state.audioCtx.currentTime - transcript.utteranceStartTime) * 1000;
  transcript.words.forEach((word) => {
    const start = word.start_ms ?? Number.NEGATIVE_INFINITY;
    const end = word.end_ms ?? Number.POSITIVE_INFINITY;
    const el = word.element;
    if (!el) return;

    const isActive = elapsedMs >= start && elapsedMs < end;
    const isSpoken = elapsedMs >= end;
    el.classList.toggle("active", isActive);
    el.classList.toggle("spoken", isSpoken);
    word.spoken = isSpoken;

    if (isActive && transcript.currentWord !== word.element) {
      transcript.currentWord = word.element;
      console.log(
        `[transcript] active word: "${word.word ?? "[pause]"}" @ ${start.toFixed?.(
          0
        ) ?? start}ms`
      );
    }
  });
  updateTranscriptProgress();
}

function endTranscript() {
  stopTranscriptLoop();
  elts.transcriptStatus.textContent = "Completed";
  highlightTranscript();
}

function inferEndMs(current, next) {
  if (current?.end_ms != null && !Number.isNaN(current.end_ms)) {
    return current.end_ms;
  }
  if (next?.start_ms != null && !Number.isNaN(next.start_ms)) {
    return next.start_ms;
  }
  // Fallback: assume 150 ms duration if nothing else is known.
  if (current?.start_ms != null) {
    return current.start_ms + 150;
  }
  return null;
}
