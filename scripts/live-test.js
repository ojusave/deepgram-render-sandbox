// Explicit live checks use real provider services and always finish their owned session.
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";
const base = process.env.BASE_URL || "http://localhost:4399";
const first = await fetch(base + "/api/state"), cookie = first.headers.get("set-cookie").split(";")[0];
let state = await first.json(), socket;
const headers = { Cookie: cookie, Origin: base, "Content-Type": "application/json" };
async function api(path, body) { const response = await fetch(base + path, { headers, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) }); const data = await response.json(); if (!response.ok) throw new Error(data.error); return data; }
async function wait(predicate, ms = 100000) { const deadline = Date.now() + ms; do { state = await api("/api/state"); if (predicate(state)) return state; await delay(800); } while (Date.now() < deadline); throw new Error("Timed out: " + state.detail); }
try {
  assert.equal(state.phase, "idle"); assert.equal(state.workspace, null);
  state = await api("/api/start", {}); assert.ok(["preparing", "checking"].includes(state.phase));
  await wait(s => !s.busy && s.phase === "ready"); assert.equal(state.error, null);
  const workspaceId = state.workspace.id;
  assert.equal(state.result.checks.filter(c => c.passed).length, 2);
  assert.match(state.result.checks.find(c => c.id === "empty").detail, /division by zero/);
  console.log(JSON.stringify({ baseline: "2/3", workspaceId }));
  // Correct the real bug, then ensure previous passing checks cannot describe untested edits.
  const fixed = state.exercise.starter.replace("    total = sum(minutes)", "    # With no customers, the dashboard should show zero minutes.\n    if not minutes:\n        return 0\n    total = sum(minutes)");
  state = await api("/api/code", { code: fixed, revision: state.revision });
  assert.notEqual(state.result.revision, state.revision);
  await api("/api/check", {}); await wait(s => !s.busy && s.result?.revision === s.revision);
  assert.ok(state.result.checks.every(c => c.passed)); assert.equal(state.workspace.id, workspaceId);
  console.log(JSON.stringify({ fixed: "3/3", sameWorkspace: true }));
  // A different visitor and a different site cannot change or download this visitor's practice.
  const other = await fetch(base + "/api/state"), otherCookie = other.headers.get("set-cookie").split(";")[0];
  assert.equal((await other.json()).phase, "idle");
  assert.equal((await fetch(base + "/api/download", { headers: { Cookie: otherCookie } })).status, 404);
  assert.equal((await fetch(base + "/api/code", { method: "POST", headers: { ...headers, Origin: "https://example.invalid" }, body: JSON.stringify({ code: fixed, revision: state.revision }) })).status, 403);
  assert.equal((await fetch(base + "/api/code", { method: "POST", headers, body: JSON.stringify({ code: "pass", revision: -1 }) })).status, 409);
  // Ask the actual Deepgram coach to run checks. Require a new run and returned speech bytes.
  const before = state.attempts; let bytes = 0, completed = false, reply = "";
  socket = new WebSocket(base.replace(/^http/, "ws") + "/voice", { headers: { Cookie: cookie, Origin: base } });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { console.log(JSON.stringify({ diagnostic: { attempts: state.attempts, phase: state.phase, messages: state.messages } })); reject(new Error("Voice tool check timed out")); }, 70000);
    socket.on("error", error => { clearTimeout(timer); reject(error); });
    socket.on("message", (data, binary) => {
      if (binary) { bytes += data.length; return; }
      const event = JSON.parse(data.toString());
      if (event.type === "ready") socket.send(JSON.stringify({ type: "ask", content: "I found that an empty list makes count zero, so dividing fails. I added an early return of zero when the list is empty. Please run the checks on my saved code and give me feedback on that explanation." }));
      if (event.type === "state") { state = event.state; if (state.attempts > before && state.result?.checks.every(c => c.passed)) completed = true; reply = state.messages.filter(m => m.role === "assistant").map(m => m.content).join(" "); }
      if (event.type === "error") { clearTimeout(timer); reject(new Error(event.message)); }
      if (event.type === "audio-done" && completed && reply) { clearTimeout(timer); resolve(); }
    });
  });
  assert.ok(bytes > 0); assert.ok(completed); console.log(JSON.stringify({ deepgramToolRun: true, audioBytes: bytes, coach: reply }));
  socket.close(); socket = null;
  // Reloading state preserves the session's file and actual check result.
  state = await api("/api/state"); assert.equal(state.code, fixed); assert.equal(state.result.revision, state.revision);
  const file = await fetch(base + "/api/download", { headers }); assert.equal(file.status, 200); assert.match(await file.text(), /3\/3 checks passed/);
} finally {
  socket?.close(); await api("/api/end", {}); await wait(s => s.phase === "ended" || s.phase === "error");
  assert.equal(state.phase, "ended"); assert.equal(state.workspace?.cleanup, "terminated");
  console.log(JSON.stringify({ cleanup: state.workspace?.cleanup }));
}
