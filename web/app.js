// Deepgram's browser helpers capture microphone audio and play spoken replies.
import { AgentMicrophone, AgentPlayer } from "@deepgram/agents";
// Plain-language descriptions are shared with the server that records the real steps.
import { phases, beginProgress, finishProgress, progressCopy } from "./progress.js";
// Keep page references in one place; no untrusted text is inserted as HTML.
const $ = id => document.getElementById(id);
let state, socket, connecting, microphone, player, talking = false, pending = false, currentResult, voiceLabel = "";
let ready = false, lastMessages = "", pollTimer, progressTimer, localProgress, previousProgressId, shownProgressKey = "";
const tabs = [...document.querySelectorAll('[role="tab"]')];
// Create DOM nodes using textContent, so uploaded cells cannot become scripts.
function element(tag, text, className) { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; }
function error(text = "") { $("error").textContent = text; $("error").hidden = !text; }
function tab(id, focus = false) {
  for (const button of tabs) { const chosen = button.id === id; button.setAttribute("aria-selected", String(chosen)); button.tabIndex = chosen ? 0 : -1; $(button.getAttribute("aria-controls")).hidden = !chosen; if (chosen && focus) button.focus(); }
}
// Arrow keys keep the tab list usable without a mouse.
tabs.forEach((button, index) => {
  button.onclick = () => tab(button.id);
  button.onkeydown = event => { const move = { ArrowRight: (index + 1) % tabs.length, ArrowLeft: (index + tabs.length - 1) % tabs.length, Home: 0, End: tabs.length - 1 }; if (event.key in move) { event.preventDefault(); tab(tabs[move[event.key]].id, true); } };
});
function table(target, columns, rows, caption) {
  const node = element("table"); const label = element("caption", caption, "sr-only"); node.append(label);
  const head = element("thead"), tr = element("tr");
  for (const column of columns) { const th = element("th", column); th.scope = "col"; tr.append(th); }
  head.append(tr); node.append(head);
  const body = element("tbody");
  for (const row of rows) { const line = element("tr"); for (const cell of row) line.append(element("td", typeof cell === "number" ? cell.toLocaleString(undefined, { maximumFractionDigits: 2 }) : cell ?? "")); body.append(line); }
  node.append(body); $(target).replaceChildren(node);
}
function drawChart(result) {
  $("chart").replaceChildren();
  if (!result.chart) return;
  const chart = result.chart, max = Math.max(...chart.values.map(Math.abs), 1);
  $("chart").append(element("p", chart.label, "chart-title"));
  const bars = element("div", undefined, "chart-bars");
  chart.labels.forEach((label, index) => {
    const value = chart.values[index], row = element("div", undefined, "bar-row"), track = element("div", undefined, "bar-track"), bar = element("div", undefined, "bar" + (value < 0 ? " negative" : ""));
    bar.style.width = Math.max(0.5, Math.abs(value) / max * 100) + "%"; track.append(bar); track.setAttribute("aria-hidden", "true");
    row.append(element("span", label, "bar-label"), track, element("span", value.toLocaleString(undefined, { maximumFractionDigits: 2 }), "bar-value")); bars.append(row);
  });
  $("chart").append(bars);
}
function render(next) {
  state = next;
  $("filename").textContent = state.dataset.name; $("row-count").textContent = state.dataset.count.toLocaleString() + " rows";
  const sample = state.dataset.name === "Monthly sales.csv";
  $("sample-label").hidden = !sample; $("sample").hidden = sample;
  table("data-table", state.dataset.columns, state.dataset.preview, "Preview of " + state.dataset.name);
  $("preview-note").textContent = state.dataset.count > 30 ? "First 30 rows shown. Calculations use all " + state.dataset.count.toLocaleString() + " rows." : "All " + state.dataset.count + " rows shown." + (sample ? " Revenue is in USD." : "");
  $("welcome").hidden = state.messages.length > 0;
  $("suggestions").hidden = !sample;
  // Avoid recreating conversation nodes on every execution status event.
  const messageKey = JSON.stringify(state.messages);
  if (messageKey !== lastMessages) {
    lastMessages = messageKey;
    $("messages").replaceChildren(...state.messages.map(msg => { const node = element("div", undefined, "message " + msg.role); node.append(element("span", msg.role === "user" ? "You" : "Sidekick", "role"), document.createTextNode(msg.content)); return node; }));
    $("conversation-scroll").scrollTop = $("conversation-scroll").scrollHeight;
  }
  if (state.result && state.result.sandboxId !== currentResult) {
    currentResult = state.result.sandboxId;
    $("result-title").textContent = state.result.title; $("result-summary").textContent = state.result.summary;
    drawChart(state.result); table("result-table", state.result.columns, state.result.rows, state.result.title);
    $("result-content").hidden = false; $("result-empty").hidden = true; $("download").hidden = false;
    tab("tab-result");
  } else if (!state.result) { currentResult = null; $("result-content").hidden = true; $("result-empty").hidden = false; $("download").hidden = true; }
  // A new server history replaces the immediate click feedback. Old answers remain clearly labeled.
  if (localProgress && state.progress?.id !== previousProgressId && state.progress) localProgress = null;
  const run = currentRun();
  if (currentProgress()?.status !== "running") pending = false;
  if (run?.error) error(run.error);

  controls();
}
// Ignore a previous question's execution when showing progress for the current question.
function currentProgress() { return localProgress || state?.progress; }
function currentRun() { return state?.run?.progressId === currentProgress()?.id ? state.run : null; }
function renderProgress() {
  const progress = currentProgress();
  $("progress").hidden = !progress;
  document.querySelector(".workspace").classList.toggle("has-progress", !!progress);
  $("activity-empty").hidden = !!progress; $("activity-content").hidden = !progress;
  if (!progress) return;
  const copy = localProgress && connecting ? { title: "Connecting your question", detail: "Opening the conversation with Deepgram. Your file is ready." } : progressCopy(progress, state.dataset.count);
  $("progress-title").textContent = copy.title; $("progress-detail").textContent = copy.detail;
  $("progress").dataset.status = progress.status;
  $("progress-marker").textContent = progress.status === "running" ? "◌" : ["succeeded", "replied"].includes(progress.status) ? "✓" : "!";
  // Update the live announcement only when the meaning changes, never for every elapsed second.
  const key = progress.id + copy.title + copy.detail + JSON.stringify(progress.steps);
  if (key !== shownProgressKey) {
    shownProgressKey = key;
    $("progress-announcement").textContent = copy.title + ". " + copy.detail;
    const statusWords = { waiting: progress.status === "running" ? "Up next" : "Not run", active: "In progress", done: "Done", failed: "Couldn't finish", cancelled: "Stopped" };
    $("progress-steps").replaceChildren(...phases.map((phase, index) => {
      const step = progress.steps[index], node = element("li", undefined, step.status);
      const mark = element("span", step.status === "done" ? "✓" : String(index + 1), "step-number"); mark.setAttribute("aria-hidden", "true");
      node.append(mark, element("span", phase.label), element("span", ": " + statusWords[step.status], "sr-only"));
      if (step.status === "active") node.setAttribute("aria-current", "step");
      return node;
    }));
    $("activity-history").replaceChildren(...phases.map((phase, index) => {
      const step = progress.steps[index], item = element("li", undefined, step.status);
      item.append(element("strong", phase.title), element("span", statusWords[step.status], "step-state"), element("p", phase.detail));
      if (step.startedAt) item.append(element("time", "Started " + new Date(step.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })));
      return item;
    }));
  }
  // The elapsed clock shows real time spent, not an invented completion percentage.
  const elapsed = Math.max(0, Math.floor(((progress.endedAt || Date.now()) - progress.startedAt) / 1000));
  $("progress-elapsed").textContent = elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`;
  const run = currentRun();
  $("technical-details").hidden = !run;
  if (run) {
    $("code").textContent = run.code || "";
    $("stderr").textContent = run.stderr || run.error || ""; $("stderr").hidden = !$("stderr").textContent;
    const fields = [["Step", run.stage], ["Internet access", "Blocked for the calculation"], ["Workspace ID", run.sandboxId || "Not created"], ["Workspace closed", run.cleanup === "terminated" ? "Confirmed" : run.cleanup === "unconfirmed" ? "Not yet confirmed" : "Not created"]];
    $("run-details").replaceChildren(...fields.flatMap(([name, value]) => [element("dt", name), element("dd", value)]));
  }
}
function controls() {
  if (!state) return;
  const progress = currentProgress(), running = currentRun()?.status === "running", working = pending || running || progress?.status === "running";
  $("question").disabled = working; $("ask").disabled = working || !$("question").value.trim();
  $("talk").disabled = !!connecting || !state.voiceAvailable; $("talk").classList.toggle("active", talking); $("talk").querySelector("span").textContent = talking ? "End voice" : "Talk";
  $("talk").setAttribute("aria-pressed", String(talking));
  $("stop").hidden = !working; $("stop").disabled = !!progress?.stopping;
  $("clear").disabled = working || !state.messages.length;
  $("upload").disabled = working; $("sample").disabled = working;
  for (const button of document.querySelectorAll("[data-question]")) button.disabled = working;
  $("activity-dot").classList.toggle("active", working);
  $("status-dot").classList.toggle("busy", working || !!connecting);
  $("voice-state").textContent = talking ? (voiceLabel || "Listening") : connecting ? "Connecting…" : "Or type a question below";
  $("status").textContent = progress ? progressCopy(progress, state.dataset.count).title : connecting ? "Connecting…" : talking ? "Listening" : "Ready";
  // Keep an earlier answer explicitly labeled after a cancelled or failed follow-up as well.
  const previousAnswer = state.result && progress && (working || currentRun()?.sandboxId !== state.result.sandboxId);
  $("result-provenance").textContent = previousAnswer ? working ? "Previous answer · New question in progress" : "Previous answer · No new result" : "Calculated from your data";
  renderProgress();
}
// Ordinary requests carry the signed session cookie automatically.
async function request(path, body) {
  const res = await fetch(path, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {});
  const result = await res.json(); if (!res.ok) throw new Error(result.error || "Please try again."); return result;
}
// Open one server-owned Deepgram conversation. Resolve only when settings are accepted.
async function connect() {
  if (socket?.readyState === WebSocket.OPEN && ready) return;
  if (connecting) return connecting;
  const ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/voice"); ws.binaryType = "arraybuffer"; socket = ws; ready = false;
  connecting = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { reject(new Error("Connection timed out. Try again.")); ws.close(); }, 20000);
    ws.onmessage = event => {
      if (socket !== ws) return;
      if (event.data instanceof ArrayBuffer) { if (talking) player?.queue(event.data); return; }
      let msg; try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.type === "ready") { clearTimeout(timeout); ready = true; resolve(); }
      if (msg.type === "state") render(msg.state);
      if (msg.type === "error") { error(msg.message); if (localProgress) finishProgress(localProgress, "failed"); pending = false; reject(new Error(msg.message)); }
      if (msg.type === "ended") { voiceLabel = msg.reason; pending = false; }
      if (msg.type === "interrupt") { player?.interrupt(); voiceLabel = "Listening"; }
      if (msg.type === "thinking") voiceLabel = "Thinking…";
      if (msg.type === "speaking") voiceLabel = "Speaking";
      if (msg.type === "audio-done" || msg.type === "turn-done") { pending = false; voiceLabel = "Listening"; }
      controls();
    };
    ws.onerror = () => { clearTimeout(timeout); reject(new Error("Could not connect. The shared demo may be busy. Try again shortly.")); };
    ws.onclose = () => {
      clearTimeout(timeout); reject(new Error("The conversation disconnected. Try again."));
      if (socket === ws) { socket = null; ready = false; talking = false; pending = false; microphone?.stop(); player?.dispose(); controls(); refresh(); }
    };
  });
  controls();
  try { await connecting; } finally { connecting = null; controls(); }
}
async function ask(content) {
  if (!content.trim()) return;
  error(); pending = true; previousProgressId = state.progress?.id;
  localProgress = beginProgress("connecting"); controls();
  // On a small screen, keep the live step and Stop button in view after sending the question.
  if (window.matchMedia("(max-width: 640px)").matches) $("progress").scrollIntoView({ block: "nearest" });
  try { await connect(); socket.send(JSON.stringify({ type: "ask", content })); $("question").value = ""; }
  catch (err) { pending = false; if (localProgress?.status !== "cancelled") { if (localProgress) finishProgress(localProgress, "failed"); error(err.message); } }
  controls();
}
$("ask-form").onsubmit = event => { event.preventDefault(); void ask($("question").value.trim()); };
// Enter sends; Shift+Enter keeps a line break for a longer question.
$("question").onkeydown = event => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); if (!$("ask").disabled) void ask($("question").value.trim()); } };
$("question").oninput = controls;
document.querySelectorAll("[data-question]").forEach(button => { button.onclick = () => void ask(button.dataset.question); });
// Ask for microphone access before opening a paid connection, and clean up if permission fails.
$("talk").onclick = async () => {
  if (talking) return stop();
  error(); $("talk").disabled = true;
  try {
    player = new AgentPlayer({ sampleRate: 24000 });
    // A silent frame unlocks playback during this deliberate user gesture.
    player.queue(new Int16Array(1).buffer);
    microphone = new AgentMicrophone(data => { if (ready && socket?.readyState === WebSocket.OPEN) socket.send(data); }, { sampleRate: 16000 });
    await microphone.start(); talking = true; voiceLabel = "Connecting…"; controls(); await connect(); voiceLabel = "Listening";
  } catch (err) {
    microphone?.stop(); player?.dispose(); talking = false;
    error(err.name === "NotAllowedError" ? "Microphone access was denied. Allow it in your browser, or type a question." : "Could not start voice. Check your microphone, or type a question.");
  }
  controls();
};
function stop() {
  const progress = currentProgress();
  if (localProgress) finishProgress(localProgress, "cancelled", "not-created");
  else if (progress?.status === "running") progress.stopping = true;
  microphone?.stop(); player?.dispose(); talking = false; pending = false;
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "stop" }));
  const oldSocket = socket; socket = null; ready = false; oldSocket?.close(); controls(); void refresh();
}
$("stop").onclick = stop;
// Changing data ends the old context, preventing answers against an unexpected file.
$("upload").onclick = () => $("file-input").click();
$("file-input").onchange = async event => {
  const file = event.target.files[0]; if (!file) return;
  error();
  try { if (file.size > 512000) throw new Error("Choose a CSV smaller than 500 KB."); const next = await request("/api/data", { name: file.name, csv: await file.text() }); localProgress = null; render(next); tab("tab-data"); }
  catch (err) { error(err.message); }
  event.target.value = "";
};
$("sample").onclick = async () => { try { error(); const next = await request("/api/data", { sample: true }); localProgress = null; render(next); tab("tab-data"); } catch (err) { error(err.message); } };
$("clear").onclick = async () => { stop(); try { error(); localProgress = null; render(await request("/api/clear", {})); tab("tab-data"); } catch (err) { error(err.message); } };
// Save only a visual preference in browser storage, never the uploaded data.
const divider = $("divider"), bench = $("workbench");
function resize(value) { value = Math.max(30, Math.min(65, value)); bench.style.setProperty("--left", value + "%"); divider.setAttribute("aria-valuenow", String(Math.round(value))); try { localStorage.setItem("sidekick.split", String(value)); } catch {} }
try { resize(Number(localStorage.getItem("sidekick.split")) || 42); } catch {}
divider.onpointerdown = event => { divider.setPointerCapture(event.pointerId); };
divider.onpointermove = event => { if (divider.hasPointerCapture(event.pointerId)) { const rect = bench.getBoundingClientRect(); resize((event.clientX - rect.left) / rect.width * 100); } };
divider.onkeydown = event => { const value = Number(divider.getAttribute("aria-valuenow")); if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) { event.preventDefault(); resize(event.key === "Home" ? 30 : event.key === "End" ? 65 : value + (event.key === "ArrowLeft" ? -2 : 2)); } };
// Refresh recovers completed results after a page reload and observes cleanup after Stop.
async function refresh() { try { render(await request("/api/state")); } catch (err) { error(err.message); } }
await refresh();
pollTimer = setInterval(() => { if (!socket && (state?.run?.status === "running" || state?.progress?.status === "running")) void refresh(); }, 1200);
// Refresh only the elapsed label once a second. Real server events still control every step.
progressTimer = setInterval(() => { if (currentProgress()?.status === "running") renderProgress(); }, 1000);
window.addEventListener("pagehide", () => { clearInterval(pollTimer); clearInterval(progressTimer); microphone?.stop(); player?.dispose(); socket?.close(); });
