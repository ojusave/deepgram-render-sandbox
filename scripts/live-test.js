// Run this explicitly against a locally running or hosted demo. It uses real provider calls.
// BASE_URL changes the destination; it never changes workspace credentials.
import assert from "node:assert/strict";
import { WebSocket } from "ws";
const base = process.env.BASE_URL || "http://localhost:4399";
const response = await fetch(base + "/api/state");
assert.equal(response.status, 200);
const cookie = response.headers.get("set-cookie").split(";")[0];
const socket = new WebSocket(base.replace(/^http/, "ws") + "/voice", { headers: { Origin: base, Cookie: cookie } });
let audioBytes = 0, finalState;
// Collect real streamed steps so a successful answer cannot hide a missing progress update.
const observedPhases = new Set();
const timeout = setTimeout(() => { console.error("Live question timed out"); socket.close(); process.exitCode = 1; }, 110000);
// Both typed and spoken input reach the same Deepgram agent and calculation tool.
await new Promise((resolve, reject) => {
  socket.on("message", (data, binary) => {
    if (binary) { audioBytes += data.length; return; }
    const event = JSON.parse(data.toString());
    if (event.type === "state" && event.state.progress) observedPhases.add(event.state.progress.phase);
    if (event.type === "ready") socket.send(JSON.stringify({ type: "ask", content: "Calculate total revenue by region across all rows. Include a chart. Use the columns Region and Revenue." }));
    if (event.type === "error") { clearTimeout(timeout); socket.close(); reject(new Error(event.message)); }
    if (event.type === "state" && event.state.run?.status === "failed") { console.error(JSON.stringify(event.state.run)); clearTimeout(timeout); socket.close(); reject(new Error(event.state.run.error)); }
    if (event.type === "state" && event.state.run?.status === "succeeded") finalState = event.state;
    // Wait for a spoken reply after computation, rather than closing as soon as the table arrives.
    if (event.type === "audio-done" && finalState) { clearTimeout(timeout); socket.close(); resolve(); }
  });
  socket.on("error", reject);
});

assert.deepEqual([...observedPhases], ["understanding", "preparing", "calculating", "checking", "closing"]);
assert.equal(finalState.progress.status, "succeeded");
assert.ok(finalState.progress.steps.every(step => step.status === "done"));
const rows = finalState.result.rows;
assert.ok(rows.some(r => r.includes("West") && r.includes(65000)));
assert.ok(rows.some(r => r.includes("East") && r.includes(56500)));
assert.equal(finalState.run.cleanup, "terminated");
assert.ok(audioBytes > 0, "Deepgram must return actual speech audio");
const file = await fetch(base + "/api/download", { headers: { Cookie: cookie } });
assert.equal(file.status, 200); assert.match(await file.text(), /65000/);
// A second browser session cannot access the first visitor's computed file.
const other = await fetch(base + "/api/state");
const otherCookie = other.headers.get("set-cookie").split(";")[0];
assert.equal((await fetch(base + "/api/download", { headers: { Cookie: otherCookie } })).status, 404);

// The chart must answer the requested totals comparison, matching its table categories.
const chartTotals = new Map(finalState.result.chart.labels.map((label, index) => [label, finalState.result.chart.values[index]]));
assert.equal(chartTotals.get("West"), 65000);
assert.equal(chartTotals.get("East"), 56500);
console.log(JSON.stringify({ passed: true, sandboxId: finalState.result.sandboxId, cleanup: finalState.run.cleanup, rows, audioBytes, observedPhases: [...observedPhases] }));
