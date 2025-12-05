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

const els = {};

function $(id) {
  return document.getElementById(id);
}

function init() {
  els.status = $("connection-status");
  els.statusText = $("status-text");
  els.prompt = $("tts-input");
  els.log = $("log-lines");
  els.timings = $("timings");
  els.connectBtn = $("connect-btn");
  els.sendBtn = $("send-btn");

  els.connectBtn.addEventListener("click", connect);
  els.sendBtn.addEventListener("click", sendPrompt);

  connect();
}

function setStatus(text, stateAttr) {
  els.statusText.textContent = text;
  els.status.dataset.state = stateAttr;
}

function appendLog(text) {
  const line = document.createElement("div");
  line.className = "log-entry";
  line.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
  els.log.prepend(line);
}

function appendTiming(wordDurList) {
  const li = document.createElement("li");
  li.textContent = wordDurList
    .map(({ word, start_ms, end_ms }) =>
      `${word} (${start_ms?.toFixed?.(0) ?? "?"}–${end_ms?.toFixed?.(0) ?? "?"} ms)`
    )
    .join(", ");
  els.timings.prepend(li);

  // Trim list so it doesn't grow forever.
  while (els.timings.children.length > 40) {
    els.timings.removeChild(els.timings.lastChild);
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
  source.start(startTime);
  state.playbackCursor = startTime + buffer.duration;
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
      state.ws.send(text);
    })
    .catch((err) => appendLog(`AudioContext error: ${err.message}`));
}

window.addEventListener("DOMContentLoaded", init);
