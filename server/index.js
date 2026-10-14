// The web server serves the interface, remembers each visitor's data, and relays voice.
// HTTP is the browser request protocol; WebSocket keeps a two-way audio connection open.
import express from "express";
import session from "express-session";
import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import { readDataset, preview, sampleCsv, toCsv } from "./data.js";
import { agentSettings } from "./settings.js";
import { createRunner } from "./sandbox.js";

// These limits bound a shared, single-instance demo. No credentials enter a sandbox.
const PORT = Number(process.env.PORT || 4399);
const records = new Map();
const runner = createRunner();
let connections = 0, calculations = 0;
let starts = [];
const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");
// Prevent another site embedding the app or loading executable content from outside it.
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("Permissions-Policy", "microphone=(self), camera=()");
  res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; img-src 'self' data:; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
  next();
});
// A signed cookie separates visitors. Its secret is never sent to the browser.
const store = new session.MemoryStore();
const sessions = session({ name: "sidekick.sid", secret: process.env.SESSION_SECRET || randomBytes(32).toString("hex"), store, resave: false, saveUninitialized: false, cookie: { httpOnly: true, sameSite: "strict", secure: "auto", maxAge: 3600000 } });
app.use(sessions);
app.use(express.json({ limit: "600kb" }));
app.get("/healthz", (_req, res) => res.json({ ok: true }));

// Return a safe view. CSV contents stay server-side except for the preview the user can inspect.
function view(record) {
  return { dataset: preview(record.dataset), messages: record.messages, run: record.run, result: record.result, connected: !!record.socket, voiceAvailable: !!process.env.DEEPGRAM_API_KEY };
}
function publish(record) {
  if (record.socket?.readyState === WebSocket.OPEN) record.socket.send(JSON.stringify({ type: "state", state: view(record) }));
}
function message(record, role, content) {
  // Deepgram can repeat a typed turn as a transcript; keep one visible copy.
  if (record.messages.at(-1)?.role === role && record.messages.at(-1)?.content === content) return;
  // Deepgram streams a reply in sentence chunks. Present them as one continuous response.
  if (role === "assistant" && record.messages.at(-1)?.role === "assistant") record.messages.at(-1).content = (record.messages.at(-1).content + " " + content).slice(0, 5000);
  else record.messages.push({ id: randomUUID(), role, content: String(content).slice(0, 5000) });
  record.messages = record.messages.slice(-40);
  publish(record);
}
function getRecord(req) { return records.get(req.sessionID); }
// Establish a session only on the app's explicit bootstrap call.
app.get("/api/state", (req, res) => {
  let record = getRecord(req);
  if (!record) {
    if (records.size >= 150) return res.status(503).json({ error: "The demo is busy. Please try again later." });
    req.session.started = true;
    record = { dataset: readDataset(sampleCsv, "Monthly sales.csv"), messages: [], run: null, result: null, touched: Date.now(), socket: null };
    records.set(req.sessionID, record);
  }
  record.touched = Date.now();
  res.setHeader("Cache-Control", "no-store");
  res.json(view(record));
});
// State-changing requests must come from this app, with the visitor's cookie.
app.use("/api", (req, res, next) => {
  if (req.method !== "GET" && req.headers.origin !== `${req.protocol}://${req.get("host")}`) return res.status(403).json({ error: "Reload this page and try again." });
  if (!getRecord(req)) return res.status(401).json({ error: "Your session expired. Reload the page." });
  next();
});
app.post("/api/data", (req, res) => {
  const record = getRecord(req);
  if (record.run?.status === "running") return res.status(409).json({ error: "Stop the calculation before changing data." });
  try {
    const dataset = readDataset(req.body.sample ? sampleCsv : req.body.csv, req.body.sample ? "Monthly sales.csv" : req.body.name);
    record.stop?.();
    record.dataset = dataset;
    record.messages = []; record.run = null; record.result = null;
    res.json(view(record));
  } catch (error) { res.status(400).json({ error: error.message }); }
});
app.get("/api/download", (req, res) => {
  const result = getRecord(req).result;
  if (!result) return res.status(404).json({ error: "Run a calculation first." });
  res.setHeader("Content-Disposition", 'attachment; filename="analysis.csv"');
  res.setHeader("Cache-Control", "no-store");
  res.type("text/csv").send(toCsv(result));
});
app.post("/api/clear", (req, res) => {
  const record = getRecord(req);
  record.stop?.();
  if (record.run?.status === "running") return res.status(409).json({ error: "The calculation is stopping. Clear again when it finishes." });
  record.messages = []; record.run = null; record.result = null;
  res.json(view(record));
});
// Browser files are generated with npm run build, then served from one Render service.
app.use(express.static("dist", { maxAge: 0 }));
app.use((error, _req, res, _next) => res.status(400).json({ error: error.type === "entity.too.large" ? "Choose a CSV smaller than 500 KB." : "The request could not be read." }));
const server = createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 100000 });

// Only accept sockets with a same-origin session. A browser cannot submit provider settings or tools.
server.on("upgrade", (req, socket, head) => {
  let sameOrigin = false;
  try { sameOrigin = ["http:", "https:"].includes(new URL(req.headers.origin).protocol) && new URL(req.headers.origin).host === req.headers.host; } catch { /* Invalid Origin is rejected below. */ }
  if (req.url !== "/voice" || !sameOrigin) return socket.destroy();
  sessions(req, {}, () => {
    const record = getRecord(req);
    starts = starts.filter(time => time > Date.now() - 86400000);
    if (!record || record.socket || record.run?.status === "running" || connections >= 2 || starts.length >= 100 || starts.filter(t => t > Date.now() - 3600000).length >= 30 || !process.env.DEEPGRAM_API_KEY) {
      socket.write("HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n"); return socket.destroy();
    }
    starts.push(Date.now());
    wss.handleUpgrade(req, socket, head, client => connectVoice(client, record));
  });
});

function connectVoice(client, record) {
  connections++; record.socket = client; record.touched = Date.now();
  const upstream = new WebSocket("wss://agent.deepgram.com/v1/agent/converse", { headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY}` }, handshakeTimeout: 15000 });
  let ready = false, closed = false, activeCall = null, turnCount = 0, bytes = 0;
  const cancelled = new Set(), seen = new Set();
  // Helpers only forward application messages or allowed protocol events.
  const send = event => { if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(event)); };
  const provider = event => { if (upstream.readyState === WebSocket.OPEN) upstream.send(JSON.stringify(event)); };
  const fail = text => send({ type: "error", message: text });
  let idleTimer;
  const touch = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => { send({ type: "ended", reason: "Conversation paused. Ask another question to reconnect." }); finish(); }, 90000); };
  // Ending the call releases the microphone in the browser and stops any owned calculation.
  function finish() {
    if (closed) return;
    closed = true; clearTimeout(idleTimer); clearTimeout(maxTimer); clearInterval(keepAlive); clearInterval(byteWindow);
    activeCall?.controller.abort(new Error("Calculation stopped."));
    upstream.close(); client.close(); connections--;
    if (record.socket === client) { record.socket = null; record.stop = null; }
  }
  record.stop = finish;
  const maxTimer = setTimeout(() => { send({ type: "ended", reason: "The five-minute demo conversation ended. You can reconnect." }); finish(); }, 300000);
  const keepAlive = setInterval(() => { if (ready) provider({ type: "KeepAlive" }); }, 5000);
  const byteWindow = setInterval(() => { bytes = 0; }, 10000);
  touch(); publish(record);
  upstream.on("open", () => provider(agentSettings(record.dataset, record.result)));
  upstream.on("message", (data, isBinary) => {
    if (closed) return;
    if (isBinary) { if (client.readyState === WebSocket.OPEN && client.bufferedAmount < 1000000) client.send(data, { binary: true }); return; }
    let event;
    try { event = JSON.parse(data.toString()); } catch { return; }
    if (event.type === "SettingsApplied") { ready = true; send({ type: "ready" }); }
    if (event.type === "ConversationText") { touch(); message(record, event.role, event.content); }
    if (event.type === "UserStartedSpeaking") { touch(); send({ type: "interrupt" }); }
    if (event.type === "AgentThinking") send({ type: "thinking" });
    if (event.type === "AgentStartedSpeaking") send({ type: "speaking" });
    if (event.type === "AgentAudioDone") send({ type: "audio-done" });
    if (event.type === "InjectionRefused") { fail("The agent is still finishing. Try your question again in a moment."); send({ type: "turn-done" }); }
    if (event.type === "Error") {
      // Log the provider's error code only, never credentials or uploaded values.
      console.error(JSON.stringify({ event: "deepgram_error", code: event.code || "unknown" }));
      fail("The voice service could not complete this conversation. Reconnect to try again."); finish();
    }
    if (event.type === "FunctionCallCancelled") {
      for (const fn of event.functions ?? []) { cancelled.add(fn.id); if (activeCall?.id === fn.id) activeCall.controller.abort(new Error("Question changed.")); }
    }
    if (event.type === "FunctionCallRequest") {
      // Calls are handled independently, but a visitor can only run one at a time.
      for (const fn of event.functions ?? []) void handleCall(fn);
    }
  });
  async function handleCall(fn) {
    if (seen.has(fn.id) || cancelled.has(fn.id) || !fn.client_side) return;
    seen.add(fn.id);
    const respond = content => {
      if (!closed && !cancelled.has(fn.id)) provider({ type: "FunctionCallResponse", id: fn.id, name: fn.name, content: JSON.stringify(content), ...(fn.thought_signature ? { thought_signature: fn.thought_signature } : {}) });
    };
    if (fn.name !== "analyze_csv" || activeCall || calculations >= 2 || ++turnCount > 8) { respond({ error: "Calculation unavailable. Wait for the current result or start a new conversation." }); return; }
    let code;
    try { code = JSON.parse(fn.arguments ?? fn.input).code; if (typeof code !== "string") throw new Error(); }
    catch { respond({ error: "The calculation code was missing." }); return; }
    const controller = new AbortController();
    activeCall = { id: fn.id, controller }; calculations++;
    record.run = { id: fn.id, status: "running", stage: "Preparing calculation", code, startedAt: Date.now(), cleanup: "not-created" };
    publish(record);
    try {
      const result = await runner.run({ code, csv: record.dataset.csv, signal: controller.signal, report: patch => { Object.assign(record.run, patch); publish(record); } });
      // A result from an interrupted question must never replace the current answer.
      if (closed || cancelled.has(fn.id) || controller.signal.aborted) return;
      record.result = result;
      record.run.status = "succeeded"; record.run.stage = "Complete";
      respond(result);
    } catch (error) {
      record.run.status = controller.signal.aborted ? "cancelled" : "failed";
      record.run.stage = controller.signal.aborted ? "Stopped" : "Calculation failed";
      record.run.error = controller.signal.aborted ? null : error.message;
      respond({ error: error.message, detail: record.run.stderr || undefined });
    } finally {
      // If cancellation arrived after execution but before publication, preserve a truthful stopped state.
      if (record.run.status === "running") { record.run.status = "cancelled"; record.run.stage = "Stopped"; }
      calculations--; activeCall = null; publish(record); if (!closed) touch();
    }
  }
  client.on("message", (data, isBinary) => {
    if (closed) return;
    bytes += data.length;
    if (bytes > 800000) { fail("Too much audio arrived at once. Reconnect to try again."); return finish(); }
    if (isBinary) { if (ready && data.length <= 32000 && upstream.bufferedAmount < 300000) upstream.send(data, { binary: true }); return; }
    let event;
    try { event = JSON.parse(data.toString()); } catch { return; }
    if (event.type === "stop") return finish();
    if (event.type === "ask" && typeof event.content === "string" && event.content.trim() && event.content.length <= 1000) {
      if (!ready) return fail("Still connecting. Try again in a moment.");
      if (activeCall) return fail("Wait for this calculation, or press Stop.");
      touch(); message(record, "user", event.content.trim());
      provider({ type: "InjectUserMessage", content: event.content.trim() });
    }
  });
  client.on("close", finish);
  client.on("error", finish);
  upstream.on("error", () => { fail("Could not connect to the voice service. Try again."); finish(); });
  upstream.on("close", () => { if (!closed) { send({ type: "ended", reason: "Conversation disconnected. Ask again to reconnect." }); finish(); } });
}
// Expire inactive visitor records and signed sessions so uploads do not accumulate indefinitely.
setInterval(() => {
  for (const [id, record] of records) if (!record.socket && record.run?.status !== "running" && record.touched < Date.now() - 3600000) { records.delete(id); store.destroy(id, () => {}); }
}, 60000).unref();
server.listen(PORT, "0.0.0.0", () => console.log(`Sidekick listening on port ${PORT}`));
// Graceful termination stops active calls and waits for sandbox cleanup before exiting.
process.on("SIGTERM", async () => { for (const record of records.values()) record.stop?.(); server.close(); await runner.shutdown(); process.exit(0); });
