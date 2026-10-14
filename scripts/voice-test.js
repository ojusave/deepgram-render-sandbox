// Feed an included synthetic question into the real voice endpoint.
// This tests speech recognition, tool execution, and returned audio without opening a microphone.
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
const base = process.env.BASE_URL || "http://localhost:4399";
const response = await fetch(base + "/api/state");
const cookie = response.headers.get("set-cookie").split(";")[0];
// WAV files contain named sections. Find the audio bytes rather than assuming a 44-byte header.
const wav = await readFile(new URL("../tests/question.wav", import.meta.url));
let pcm;
for (let offset = 12; offset + 8 <= wav.length;) {
  const size = wav.readUInt32LE(offset + 4);
  if (wav.toString("ascii", offset, offset + 4) === "data") { pcm = wav.subarray(offset + 8, offset + 8 + size); break; }
  offset += 8 + size + size % 2;
}
assert.ok(pcm);
const ws = new WebSocket(base.replace(/^http/, "ws") + "/voice", { headers: { Origin: base, Cookie: cookie } });
let finalState, audioBytes = 0, heard = "";
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => { ws.close(); reject(new Error("Speech test timed out")); }, 110000);
  ws.on("message", async (data, binary) => {
    if (binary) { audioBytes += data.length; return; }
    const event = JSON.parse(data.toString());
    if (event.type === "ready") {
      // Send 100 milliseconds at a time at the microphone's actual 16 kHz rate.
      const speech = Buffer.concat([pcm, Buffer.alloc(16000 * 2 * 2)]);
      for (let offset = 0; offset < speech.length && ws.readyState === WebSocket.OPEN; offset += 3200) { ws.send(speech.subarray(offset, offset + 3200)); await delay(100); }
    }
    if (event.type === "state") {
      heard = event.state.messages.filter(m => m.role === "user").map(m => m.content).join(" ");
      if (event.state.run?.status === "failed") { clearTimeout(timer); ws.close(); reject(new Error(event.state.run.error)); }
      if (event.state.run?.status === "succeeded") finalState = event.state;
    }
    if (event.type === "error") { clearTimeout(timer); ws.close(); reject(new Error(event.message)); }
    if (event.type === "audio-done" && finalState) { clearTimeout(timer); ws.close(); resolve(); }
  });
  ws.on("error", reject);
});
assert.match(heard, /region/i); assert.ok(audioBytes > 0);
assert.equal(finalState.run.cleanup, "terminated");
const numeric = JSON.stringify(finalState.result);
assert.match(numeric, /65000/); assert.match(numeric, /56500/);
console.log(JSON.stringify({ passed: true, heard, audioBytes, result: finalState.result, cleanup: finalState.run.cleanup }));
