// Stream a synthetic explanation through the actual voice endpoint without using a physical microphone.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";
const base = process.env.BASE_URL || "http://localhost:4399";
const response = await fetch(base + "/api/state"), cookie = response.headers.get("set-cookie").split(";")[0];
const headers = { Cookie: cookie, Origin: base, "Content-Type": "application/json" };
let state, socket;
async function api(path, body) { const response = await fetch(base + path, { headers, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) }); const data = await response.json(); if (!response.ok) throw new Error(data.error); return data; }
async function wait(predicate) { const deadline = Date.now() + 100000; do { state = await api("/api/state"); if (predicate(state)) return; await delay(800); } while (Date.now() < deadline); throw new Error("Timed out: " + state.detail); }
// WAV files have named sections. Find the audio bytes instead of assuming a particular header length.
const wav = await readFile(new URL("../tests/question.wav", import.meta.url));
let pcm;
for (let offset = 12; offset + 8 <= wav.length;) { const size = wav.readUInt32LE(offset + 4); if (wav.toString("ascii", offset, offset + 4) === "data") { pcm = wav.subarray(offset + 8, offset + 8 + size); break; } offset += 8 + size + size % 2; }
assert.ok(pcm);
try {
  await api("/api/start", {}); await wait(s => !s.busy && s.phase === "ready");
  const before = state.attempts; let heard = "", audioBytes = 0, newRun = false;
  socket = new WebSocket(base.replace(/^http/, "ws") + "/voice", { headers: { Cookie: cookie, Origin: base } });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Synthetic speech timed out: " + heard)), 90000);
    socket.on("error", error => { clearTimeout(timer); reject(error); });
    socket.on("message", async (data, binary) => {
      if (binary) { audioBytes += data.length; return; }
      const event = JSON.parse(data.toString());
      if (event.type === "ready") {
        // The browser also sends 16 kHz mono samples. Silence at the end lets Deepgram detect the turn.
        const audio = Buffer.concat([pcm, Buffer.alloc(64000)]);
        for (let offset = 0; offset < audio.length && socket.readyState === WebSocket.OPEN; offset += 3200) { socket.send(audio.subarray(offset, offset + 3200)); await delay(100); }
      }
      if (event.type === "state") { state = event.state; heard = state.messages.filter(m => m.role === "user").map(m => m.content).join(" "); newRun = state.attempts > before; }
      if (event.type === "error") { clearTimeout(timer); reject(new Error(event.message)); }
      if (event.type === "audio-done" && newRun && heard) { clearTimeout(timer); resolve(); }
    });
  });
  assert.match(heard, /zero|empty/i); assert.ok(audioBytes > 0); assert.equal(state.result.checks.filter(c => c.passed).length, 2);
  console.log(JSON.stringify({ speechRecognized: true, heard, realToolExecution: newRun, audioBytes, coach: state.messages.filter(m => m.role === "assistant").map(m => m.content).join(" ") }));
} finally {
  socket?.close(); await api("/api/end", {}); await wait(s => ["ended", "error"].includes(s.phase));
  assert.equal(state.phase, "ended"); assert.equal(state.workspace.cleanup, "terminated"); console.log(JSON.stringify({ cleanup: state.workspace.cleanup }));
}
