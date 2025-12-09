/**
 * Simple browser client for ws://<host>/audiows.
 * - Sends plain-text prompts.
 * - Receives JSON word timings (text frames) and little-endian PCM_16 audio chunks (binary frames).
 * - Streams playback via Web Audio.
 */

console.log('test_audio_client4.js loaded');

class TTSAudioManager {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.audioCtx = null;
    this.playbackCursor = 0;
  }

  ensureContext() {
    if (!this.audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext || AudioContext;
      this.audioCtx = new AC({ sampleRate: this.sampleRate });
      this.playbackCursor = this.audioCtx.currentTime;
    }
    if (this.audioCtx.state === "suspended") {
      return this.audioCtx.resume();
    }
    return Promise.resolve();
  }

  schedulePcmChunk(arrayBuffer) {
    if (!this.audioCtx) return null;

    const pcm16 = new Int16Array(arrayBuffer);
    const float32 = new Float32Array(pcm16.length);
    for (let i = 0; i < pcm16.length; i += 1) {
      float32[i] = pcm16[i] / 32768;
    }

    const buffer = this.audioCtx.createBuffer(1, float32.length, this.sampleRate);
    buffer.copyToChannel(float32, 0);

    const source = this.audioCtx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.audioCtx.destination);

    const startTime = Math.max(this.playbackCursor, this.audioCtx.currentTime);
    source.start(startTime);
    this.playbackCursor = startTime + buffer.duration;

    return { startTime, duration: buffer.duration };
  }

  getContext() {
    return this.audioCtx;
  }

  getCurrentTime() {
    return this.audioCtx ? this.audioCtx.currentTime : 0;
  }

  getPlaybackCursor() {
    return this.playbackCursor;
  }
}

const SAMPLE_RATE = 44100;                      // Matches melo/ws.py `sr`.
const WS_URL = `ws://${location.host}/audiows`;

const ttsAudioManager = new TTSAudioManager(SAMPLE_RATE);

const state = {
  ws: null,
  connecting: false,
};

const els = {};
const transcript = {
  words: [],
  utteranceStartTime: 0,
  awaitingFirstAudio: true,
  rafId: null,
  currentWord: null,
  streamEnded: false,
  isRunning: false,
};

function $(id) {
  return document.getElementById(id);
}

function init() {
  console.log('init');
  els.status = $("connection-status");
  els.statusText = $("status-text");
  els.prompt = $("tts-input");
  els.log = $("log-lines");
  els.timings = $("timings");
  els.connectBtn = $("connect-btn");
  els.sendBtn = $("send-btn");

  els.transcriptStream = $("transcript-stream");
  els.transcriptStatus = $("transcript-status");
  els.transcriptProgress = $("transcript-progress");
  els.clearTranscript = $("clear-transcript");

  els.connectBtn.addEventListener("click", connect);
  els.sendBtn.addEventListener("click", sendPrompt);
  els.clearTranscript.addEventListener("click", clearTranscript);

  connect();
}

function setStatus(text, stateAttr) {
  console.log('setStatus', text, stateAttr);
  els.statusText.textContent = text;
  els.status.dataset.state = stateAttr;
}

function appendLog(text) {
  console.log('appendLog', text);
  const line = document.createElement("div");
  line.className = "log-entry";
  line.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
  els.log.prepend(line);
}

function appendTiming(wordDurList) {
  console.log('appendTiming', wordDurList);
  const li = document.createElement("li");
  li.textContent = wordDurList
    .map((entry, idx) => {
      const inferredEnd = inferEndMs(entry, wordDurList[idx + 1]);
      const displayEnd = inferredEnd ?? entry.end_ms;
      return `${entry.word ?? "[pause]"} (${entry.start_ms?.toFixed?.(0) ?? "?"}–${displayEnd?.toFixed?.(0) ?? "?"} ms)`;
    })
    .join(", ");
  els.timings.prepend(li);
  while (els.timings.children.length > 40) {
    els.timings.removeChild(els.timings.lastChild);
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
  els.transcriptStream.appendChild(fragment);
  els.transcriptStream.scrollTop = els.transcriptStream.scrollHeight;
  els.transcriptStatus.textContent = "Streaming…";
  updateTranscriptProgress();
}

function ensureAudioContext() {
  console.log('ensureAudioContext');
  return ttsAudioManager.ensureContext();
}

function schedulePcmChunk(arrayBuffer) {
  console.log('schedulePcmChunk', arrayBuffer.byteLength);
  const info = ttsAudioManager.schedulePcmChunk(arrayBuffer);
  if (!info) return;
  const startTime = info.startTime;
  if (transcript.awaitingFirstAudio) {
    transcript.awaitingFirstAudio = false;
    transcript.utteranceStartTime = startTime;
    startTranscriptLoop();
  }
}

function connect() {
  console.log('connect');
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
    if (ws !== state.ws) return;
    if (!transcript.streamEnded) {
      console.log('Setting streamEnded to true in onclose');
      transcript.streamEnded = true;
    }
    state.ws = null;
    state.connecting = false;
    setStatus("Disconnected", "disconnected");
    appendLog(`Socket closed (${evt.code}).`);
  };

  state.ws = ws;
}

function handleMessage(data) {
  console.log('handleMessage', data);
  if (typeof data === "string") {
    if (!data) return;
    if (data === "EOF") {
      appendLog("Server signaled end of stream.");
      transcript.streamEnded = true;
      return;
    }

    try {
      const timings = JSON.parse(data);
      if (Array.isArray(timings)) {
        appendTiming(timings);
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

function sendPrompt() {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    appendLog("Cannot send: socket not open.");
    return;
  }

  const text = els.prompt.value.trim();
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
  console.log('createTranscriptWord', word);
  const span = document.createElement("span");
  span.className = "transcript-word";
  span.textContent = word || "•";
  return span;
}

function resetTranscript() {
  console.log('resetTranscript');
  stopTranscriptLoop();
  transcript.words = [];
  transcript.awaitingFirstAudio = true;
  transcript.utteranceStartTime = 0;
  transcript.currentWord = null;
  transcript.streamEnded = false;
  transcript.isRunning = false;
  els.transcriptStream.textContent = "";
  els.transcriptStatus.textContent = "Awaiting audio…";
  els.transcriptProgress.textContent = "";
}

function clearTranscript() {
  console.log('clearTranscript');
  resetTranscript();
  appendLog("Transcript cleared.");
}

function updateTranscriptProgress() {
  console.log('updateTranscriptProgress');
  const spoken = transcript.words.filter((w) => w.spoken).length;
  const total = transcript.words.length;
  els.transcriptProgress.textContent = total
    ? `${spoken} / ${total} words`
    : "";
}

function transcriptionTick() {
  highlightTranscript();
  if (transcript.isRunning) {
    transcript.rafId = requestAnimationFrame(transcriptionTick);
  }
}

function startTranscriptLoop() {
  console.log('startTranscriptLoop');
  const ctx = ttsAudioManager.getContext();
  if (transcript.isRunning || !ctx) {
    console.warn('Transcript loop already running or audio context not ready');
    return;
  }
  transcript.isRunning = true;
  els.transcriptStatus.textContent = "Playing…";
  transcriptionTick();
}

function stopTranscriptLoop() {
  console.log('stopTranscriptLoop');
  transcript.isRunning = false;
  if (transcript.rafId) {
    cancelAnimationFrame(transcript.rafId);
    transcript.rafId = null;
  }
}

function highlightTranscript() {
  console.log('highlightTranscript');
  const ctx = ttsAudioManager.getContext();
  if (!ctx || transcript.awaitingFirstAudio) return;

  const currentTime = ttsAudioManager.getCurrentTime();
  const elapsedMs = (currentTime - transcript.utteranceStartTime) * 1000;
  
  // Check if playback has completed
  const playbackCompleted = currentTime >= ttsAudioManager.getPlaybackCursor() && transcript.streamEnded;
  if (playbackCompleted) {
    endTranscript();
    return;
  }
  
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
  console.log('endTranscript');
  stopTranscriptLoop();
  els.transcriptStatus.textContent = "Completed";
}

function inferEndMs(current, next) {
  //console.log('inferEndMs', current, next);
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
