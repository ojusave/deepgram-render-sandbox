// Opt-in real-provider checks exercise failure, cancellation, retry and the credential boundary.
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
const base = process.env.BASE_URL || "http://localhost:4399";
const response = await fetch(base + "/api/state"), cookie = response.headers.get("set-cookie").split(";")[0];
const headers = { Cookie: cookie, Origin: base, "Content-Type": "application/json" };
let state;
async function api(path, body) { const response = await fetch(base + path, { headers, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) }); const data = await response.json(); if (!response.ok) throw new Error(data.error); return data; }
async function wait(predicate) { const deadline = Date.now() + 100000; do { state = await api("/api/state"); if (predicate(state)) return; await delay(500); } while (Date.now() < deadline); throw new Error("Timed out: " + state.detail); }
async function code(value) { state = await api("/api/code", { code: value, revision: state.revision }); }
try {
  await api("/api/start", {}); await wait(s => !s.busy && s.phase === "ready");
  // Syntax errors are displayed as failed checks, and do not create a false successful run.
  await code("def average_wait(:\n    return 0\n"); await api("/api/check", {});
  await wait(s => !s.busy && s.result?.revision === s.revision);
  assert.ok(state.result.checks.every(c => !c.passed && /SyntaxError/.test(c.detail)));
  // Stop an actual endless calculation. The whole owned environment must close, not only its output stream.
  await code("def average_wait(minutes):\n    while True:\n        pass\n"); const oldId = state.workspace.id;
  await api("/api/check", {}); await wait(s => s.phase === "checking"); await delay(500); await api("/api/stop", {});
  await wait(s => !s.busy && s.workspace?.cleanup === "terminated"); assert.notEqual(state.result.revision, state.revision);
  console.log(JSON.stringify({ syntaxErrorsVisible: true, cancelledWorkspace: oldId, cleanup: state.workspace.cleanup }));
  // The next run opens a new environment. The code verifies no host keys or outbound connection are present.
  await code(`def average_wait(minutes):
    import os, socket
    assert not os.environ.get('DEEPGRAM_API_KEY')
    assert not os.environ.get('RENDER_API_KEY')
    blocked = False
    try:
        socket.create_connection(('1.1.1.1', 443), timeout=0.5)
    except OSError:
        blocked = True
    assert blocked
    return sum(minutes) / len(minutes) if minutes else 0
`);
  await api("/api/check", {}); await wait(s => !s.busy && s.result?.revision === s.revision);
  assert.ok(state.result.checks.every(c => c.passed)); assert.notEqual(state.workspace.id, oldId);
  console.log(JSON.stringify({ recovered: true, networkBlocked: true, hostKeysAbsent: true, newWorkspace: state.workspace.id }));
} finally { await api("/api/end", {}); await wait(s => ["ended", "error"].includes(s.phase)); assert.equal(state.phase, "ended"); assert.equal(state.workspace.cleanup, "terminated"); console.log(JSON.stringify({ finalCleanup: state.workspace.cleanup })); }
