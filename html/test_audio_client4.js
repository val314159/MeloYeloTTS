/**
 * Simple browser client for ws://<host>/audiows.
 * - Sends plain-text prompts.
 * - Receives JSON word timings (text frames) and little-endian PCM_16 audio chunks (binary frames).
 * - Streams playback via Web Audio.
 */

console.log('test_audio_client4.js loaded..! 🎵');

class TTSAudioManager {
  constructor(sampleRate = 44100) {
    this.sampleRate = sampleRate; // Matches melo/ws.py `sr`
    this.audioCtx = null;
    this.playbackEndTime = 0;
    this.utteranceStartAudioTime = null; // AudioContext.currentTime when this utterance's first chunk starts
    this.pendingWordTimings = null; // holds the next timings batch until its PCM arrives
    this.words = [];
    this.loopRunning = false;
    this.onFrame = null; // (currentTime, playbackEndTime) => void
  }

  startLoop() {
    if (this.loopRunning || !this.audioCtx) return;
    this.loopRunning = true;
    const tick = () => {
      if (!this.loopRunning) return;
      const now = this.getCurrentTime();
      const end = this.getPlaybackEndTime();
      this.onFrame?.(now, end);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  stopLoop() {
    this.loopRunning = false;
  }

  isLoopRunning() {
    return this.loopRunning;
  }

  ensureContext() {
    if (!this.audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext || AudioContext;
      this.audioCtx = new AC({ sampleRate: this.sampleRate });
      this.playbackEndTime = this.audioCtx.currentTime;
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

    const startTime = Math.max(this.playbackEndTime, this.audioCtx.currentTime);
    source.start(startTime);
    this.playbackEndTime = startTime + buffer.duration;

    // On the first chunk of an utterance, establish the audio-clock reference point.
    if (this.utteranceStartAudioTime == null) {
      this.utteranceStartAudioTime = startTime;
    }

    // Apply any pending timings batch for this chunk now that its audio is scheduled.
    if (this.pendingWordTimings) {
      const batch = this.pendingWordTimings;
      this.pendingWordTimings = null;

      // Compute this chunk's base in utterance-relative ms from the audio clock.
      const baseMs = (startTime - this.utteranceStartAudioTime) * 1000;
      this.applyWordTimings(batch, baseMs);
    }

    return { startTime, duration: buffer.duration };
  }

  getContext() {
    return this.audioCtx;
  }

  getCurrentTime() {
    return this.audioCtx ? this.audioCtx.currentTime : 0;
  }

  getPlaybackEndTime() {
    return this.playbackEndTime;
  }

  getUtteranceStartTime() {
    return this.utteranceStartAudioTime ?? 0;
  }

  isAwaitingFirstAudio() {
    return this.utteranceStartAudioTime == null;
  }

  resetWords() {
    this.words = [];
    this.utteranceStartAudioTime = null;
    this.pendingWordTimings = null;
  }

  addPendingWordTimings(wordDurList) {
    if (this.pendingWordTimings === null) {
      this.pendingWordTimings = wordDurList;
    } else {
      console.error('addPendingWordTimings called when pendingWordTimings is not null, ignoring new timings');
    }
  }

  applyWordTimings(wordDurList, baseMs) {
    const newWords = [];
    wordDurList.forEach((entry) => {
      const wordEntry = { ...entry };
      const localStart = entry.start_ms;
      const localEnd = entry.end_ms;

      let globalStart = null;
      if (localStart != null && !Number.isNaN(localStart)) {
        globalStart = baseMs + localStart;
        wordEntry.start_ms = globalStart;

        const prev = this.words.at(-1);
        if (prev && (prev.end_ms == null || Number.isNaN(prev.end_ms))) {
          prev.end_ms = globalStart;
        }
      }

      if (localEnd != null && !Number.isNaN(localEnd)) {
        wordEntry.end_ms = baseMs + localEnd;
      }

      this.words.push(wordEntry);
      newWords.push(wordEntry);
    });
    this.onApplyTiming?.(newWords);
    return newWords;
  }
}

const WS_URL = `ws://${location.host}/audiows`;

const ttsAudioManager = new TTSAudioManager();

const state = {
  ws: null,
  connecting: false,
};

const els = {};
const transcript = {
  words: [],
  currentWord: null,
  streamEnded: false,
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

function applyTiming(processedWords) {
  console.log('applyTiming', processedWords);

  const li = document.createElement("li");
  li.textContent = processedWords
    .map((entry) => {
      const displayEnd = entry.end_ms;
      return `${entry.word ?? "[pause]"} (${entry.start_ms?.toFixed?.(0) ?? "?"}–${displayEnd?.toFixed?.(0) ?? "?"} ms)`;
    })
    .join(", ");
  els.timings.prepend(li);
  while (els.timings.children.length > 40) {
    els.timings.removeChild(els.timings.lastChild);
  }

  const fragment = document.createDocumentFragment();
  processedWords.forEach((entry) => {
    const uiWord = {
      ...entry,
      element: createTranscriptWord(entry.word),
      spoken: false,
    };
    transcript.words.push(uiWord);
    fragment.appendChild(uiWord.element);
  });
  els.transcriptStream.appendChild(fragment);
  els.transcriptStream.scrollTop = els.transcriptStream.scrollHeight;
  els.transcriptStatus.textContent = "Streaming…";
  updateTranscriptProgress();
}

ttsAudioManager.onApplyTiming = applyTiming;

function appendTiming(wordDurList) {
  console.log('appendTiming', wordDurList);
  ttsAudioManager.addPendingWordTimings(wordDurList);
}

function ensureAudioContext() {
  console.log('ensureAudioContext');
  return ttsAudioManager.ensureContext();
}

function schedulePcmChunk(arrayBuffer) {
  console.log('schedulePcmChunk', arrayBuffer.byteLength);
  ttsAudioManager.schedulePcmChunk(arrayBuffer);
  if (!ttsAudioManager.isAwaitingFirstAudio()) {
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
  transcript.currentWord = null;
  transcript.streamEnded = false;
  ttsAudioManager.resetWords();
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

function startTranscriptLoop() {
  console.log('startTranscriptLoop');
  const ctx = ttsAudioManager.getContext();
  if (!ctx) {
    console.warn('Transcript loop cannot start: audio context not ready');
    return;
  }
  els.transcriptStatus.textContent = "Playing…";
  ttsAudioManager.startLoop();
}

function stopTranscriptLoop() {
  console.log('stopTranscriptLoop');
  ttsAudioManager.stopLoop();
}

function highlightTranscript() {
  console.log('highlightTranscript');
  const ctx = ttsAudioManager.getContext();
  if (!ctx || ttsAudioManager.isAwaitingFirstAudio()) return;

  const currentTime = ttsAudioManager.getCurrentTime();
  const utteranceStart = ttsAudioManager.getUtteranceStartTime();
  const elapsedMs = (currentTime - utteranceStart) * 1000;
  
  // Check if playback has completed
  const playbackCompleted = currentTime >= ttsAudioManager.getPlaybackEndTime() && transcript.streamEnded;
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

ttsAudioManager.onFrame = highlightTranscript;

function endTranscript() {
  console.log('endTranscript');
  stopTranscriptLoop();
  els.transcriptStatus.textContent = "Completed";
}
