// Official Deepgram helpers capture microphone audio and play the coach's spoken replies.
import { AgentMicrophone, AgentPlayer } from "@deepgram/agents";
// Browser state is only presentation. Code revisions and real test results belong to the server.
const $ = id => document.getElementById(id);
let state, socket, connecting, ready = false, microphone, player, talking = false, muted = false;
let busy = false, pendingReply = false, saving, saveTimer, polling = false, loaded = false, lastMessages = "", undoCode;
let voiceLabel = "Coach is disconnected", voiceMode = "quiet", lastChecks = "", showWelcome = false, typing = false, lastView = "welcome";
const node = (tag, text, className) => { const item = document.createElement(tag); if (text !== undefined) item.textContent = text; if (className) item.className = className; return item; };
// All user/provider text goes through textContent, never interpreted HTML.
function showError(text = "") { $("error").textContent = text; $("error").hidden = !text; }
async function request(path, body) {
  const response = await fetch(path, body === undefined ? { cache: "no-store" } : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await response.json(); if (!response.ok) throw new Error(data.error || "The request failed. Try again."); return data;
}
function isActive() { return !!state?.startedAt && !state.endedAt && !["closing", "ended", "error"].includes(state.phase); }
function currentChecks() { return !!state?.result && state.result.revision === state.revision && $("code").value === state.code; }
function render(next, replaceCode = false) {
  // An earlier response must not overwrite newer editor contents received over the voice connection.
  if (state && next.revision < state.revision) return;
  const dirty = loaded && $("code").value !== state?.code;
  state = next;
  if (!loaded || replaceCode || !dirty) $("code").value = state.code;
  loaded = true;
  if (state.error) showError(state.error);
  const key = JSON.stringify(state.messages);
  if (key !== lastMessages) {
    lastMessages = key;
    $("messages").replaceChildren(...state.messages.map(message => {
      const item = node("div", undefined, "message " + message.role);
      item.append(node("span", message.role === "user" ? "You" : "Coach", "role"), document.createTextNode(message.content)); return item;
    }));
    $("messages").scrollTop = $("messages").scrollHeight;
  }
  // Show the real latest reply as the compact caption; the full exchange remains in Conversation.
  const latest = state.messages.filter(message => message.role === "assistant").at(-1);
  $("caption").textContent = latest?.content || "Connecting your coach…";
  if (state.phase === "ended" || state.phase === "closing") disconnectVoice();
  controls();
}
function renderChecks() {
  const current = currentChecks(), running = state.phase === "checking", results = running ? state.partial : state.result?.checks || [];
  const key = JSON.stringify({ results, current, phase: state.phase, dirty: $("code").value !== state.code });
  if (key === lastChecks) return; lastChecks = key;
  $("checks").replaceChildren(...state.cases.map(fixture => {
    const result = results.find(item => item.id === fixture.id);
    const stale = !!result && !current && !running;
    const row = node("div", undefined, "check-row" + (result ? result.passed ? " passed" : " failed" : "") + (stale ? " stale" : ""));
    const icon = node("span", result ? result.passed ? "✓" : "!" : "○", "check-icon"); icon.setAttribute("aria-hidden", "true");
    const title = node("div", fixture.label, "check-label"); title.append(node("span", `${JSON.stringify(fixture.input)} → ${fixture.expected}`, "check-input"));
    row.append(icon, title, node("span", result ? stale ? "Earlier version" : result.passed ? "Passed" : "Needs a fix" : running ? "Checking…" : "Not run", "check-state"));
    if (result && !result.passed) row.append(node("p", result.detail, "check-detail"));
    return row;
  }));
}
function controls() {
  if (!state) return;
  const active = isActive(), checking = state.busy || ["preparing", "checking", "stopping"].includes(state.phase), current = currentChecks();
  // Reveal each screen only when needed. Moving focus makes the change clear to keyboard users.
  const view = showWelcome || !state.startedAt ? "welcome" : state.endedAt ? "recap" : "practice";
  $("welcome").hidden = view !== "welcome"; $("practice").hidden = view !== "practice"; $("recap").hidden = view !== "recap";
  const viewChanged = lastView !== view, stopFocused = document.activeElement === $("stop-checks");
  $("start").disabled = busy || !state.voiceAvailable || !state.practiceAvailable;
  $("start-text").disabled = busy || !state.practiceAvailable;
  $("start").textContent = busy ? "Starting practice…" : "Start with voice ↗";
  $("voice-controls").hidden = !active;
  $("voice-scene").dataset.mode = talking && !muted ? voiceMode : "quiet";
  $("voice-status").textContent = voiceLabel;
  $("voice-status").hidden = !talking || pendingReply;
  $("coach-tag").textContent = talking ? muted ? "Mic muted" : "Voice on" : state.connected ? "Text mode" : "Offline";
  $("talk").textContent = talking ? "End voice" : connecting ? "Connecting…" : "Connect voice";
  $("talk").disabled = !!connecting || !state.voiceAvailable || busy;
  $("mute").hidden = !talking; $("mute").textContent = muted ? "Unmute mic" : "Mute mic"; $("mute").setAttribute("aria-pressed", String(muted));
  $("ask-form").hidden = talking && !typing;
  $("type-toggle").hidden = !talking; $("type-toggle").textContent = typing ? "Hide typing" : "Type a message"; $("type-toggle").setAttribute("aria-expanded", String(typing));
  $("question").disabled = !active || busy || !!connecting || pendingReply;
  $("send").disabled = $("question").disabled || !$("question").value.trim();
  $("feedback").hidden = !(current && state.result?.checks.every(item => item.passed));
  $("feedback").disabled = !active || pendingReply || !state.messages.some(message => message.role === "user");
  $("thinking").hidden = !pendingReply || !!connecting;
  $("coach-offline").hidden = !active || !!socket || !!connecting;
  $("code").readOnly = !active || state.phase === "preparing" || busy;
  $("reset").disabled = $("code").readOnly || checking;
  $("reset").textContent = undoCode === undefined ? "Reset code" : "Undo reset";
  $("run").hidden = checking; $("run").disabled = !active || busy || !!saving || state.attempts >= 15;
  $("stop-checks").hidden = !checking || state.phase === "closing"; $("stop-checks").disabled = state.phase === "stopping";
  const edited = $("code").value !== state.code;
  $("save-state").textContent = !state.startedAt ? "Start practice to edit" : state.endedAt ? "Session complete" : saving ? "Saving…" : edited ? "Unsaved changes" : "Saved";
  const passed = state.result?.checks.filter(item => item.passed).length || 0;
  // Keep the outcome concise; the individual inputs and errors are available in Details.
  $("check-details").hidden = !state.result && !state.partial?.length;
  $("check-details").dataset.passed = String(current && passed === 3);
  $("check-summary").textContent = checking ? "Checking your change…" : current ? passed === 3 ? "All 3 checks passed." : `${passed} of 3 passed. ${3 - passed === 1 ? "One needs" : "Some need"} a fix.` : "Code changed. Run checks again.";
  $("progress-copy").textContent = !state.startedAt ? "Your separate practice computer starts when you do." : edited ? "You have unsaved edits. They haven’t been checked." : !checking && state.result && !current ? "Your latest edits haven’t been checked yet." : state.detail;
  $("progress").hidden = !checking && state.phase !== "closing" && !state.error;
  $("progress").dataset.busy = String(checking || state.phase === "closing"); $("progress").dataset.success = String(current && passed === 3);
  $("finish").hidden = !active && state.phase !== "error"; $("finish").disabled = busy;
  $("recap-title").textContent = current && passed === 3 ? "Your fix passed." : "Practice complete.";
  $("recap-detail").textContent = `${state.attempts} completed check ${state.attempts === 1 ? "run" : "runs"}. ` + (current ? `${passed} of 3 checks passed on your final code.` : "Your final edits have not been checked.");
  $("again").disabled = busy || state.phase !== "ended";
  $("workspace-detail").textContent = state.workspace ? `Practice computer: ${state.workspace.id}. ${state.workspace.cleanup === "terminated" ? "Closure confirmed." : state.workspace.cleanup === "open" ? "Open for this exercise. Outbound internet access is blocked." : "Closure is not yet confirmed."}` : "No practice computer has been created.";
  renderChecks(); renderClock();
  // Update text before announcing a new screen, and return keyboard focus after a check finishes.
  if (viewChanged) { $(view === "practice" ? "exercise-title" : view === "recap" ? "recap-title" : "welcome-title").focus(); lastView = view; }
  else if (stopFocused && !checking && active) $("run").focus();
}
// Save edits in order. New typing is preserved while an earlier save is in flight.
async function flushCode() {
  clearTimeout(saveTimer);
  if (saving) await saving;
  if (!isActive() || $("code").value === state.code) return;
  const value = $("code").value, revision = state.revision;
  saving = request("/api/code", { code: value, revision }).then(next => render(next)); controls();
  try { await saving; } finally { saving = null; controls(); }
  if ($("code").value !== value) await flushCode();
}
$("code").oninput = () => { clearTimeout(saveTimer); controls(); saveTimer = setTimeout(() => { void flushCode().catch(error => showError(error.message)); }, 450); };
// Enter preserves the current line's spaces. Tab remains available for ordinary keyboard navigation.
$("code").onkeydown = event => {
  if (event.key !== "Enter" || $("code").readOnly) return;
  const field = $("code"), start = field.selectionStart;
  const line = field.value.slice(0, start).split("\n").at(-1), indentation = line.match(/^ */)[0] + (line.trimEnd().endsWith(":") ? "    " : "");
  event.preventDefault(); field.setRangeText("\n" + indentation, start, field.selectionEnd, "end"); field.dispatchEvent(new Event("input"));
};
$("reset").onclick = () => { const previous = $("code").value; $("code").value = undoCode === undefined ? state.exercise.starter : undoCode; undoCode = undoCode === undefined ? previous : undefined; $("code").dispatchEvent(new Event("input")); $("code").focus(); };

// A single server-owned connection carries audio, conversation text, and real execution progress.
async function connect() {
  if (socket?.readyState === WebSocket.OPEN && ready) return;
  if (connecting) return connecting;
  const ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/voice"); ws.binaryType = "arraybuffer"; socket = ws; ready = false;
  connecting = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { reject(new Error("The coach took too long to connect. Try again.")); ws.close(); }, 20000);
    ws.onmessage = event => {
      if (socket !== ws) return;
      if (event.data instanceof ArrayBuffer) { if (talking) player?.queue(event.data); return; }
      let message; try { message = JSON.parse(event.data); } catch { return; }
      if (message.type === "ready") { clearTimeout(timeout); ready = true; voiceLabel = talking ? "Listening. Take your time." : "Connected in text mode"; voiceMode = "listening"; resolve(); }
      if (message.type === "state") render(message.state);
      if (message.type === "error") { showError(message.message); pendingReply = false; if (!ready) reject(new Error(message.message)); }
      if (message.type === "ended") { voiceLabel = message.reason; pendingReply = false; }
      if (message.type === "interrupt") { player?.interrupt(); voiceMode = "listening"; voiceLabel = "Listening. Take your time."; }
      if (message.type === "thinking") { pendingReply = true; voiceLabel = "Thinking about your explanation…"; voiceMode = "quiet"; }
      if (message.type === "speaking") { voiceLabel = "Coach is speaking. You can interrupt."; voiceMode = "speaking"; }
      if (message.type === "audio-done") { pendingReply = false; voiceLabel = talking ? muted ? "Microphone muted. You can still hear your coach." : "Listening. Take your time." : "Connected in text mode"; voiceMode = "listening"; }
      controls();
    };
    ws.onerror = () => { clearTimeout(timeout); reject(new Error("The coach could not connect. Please try again shortly.")); };
    ws.onclose = () => {
      clearTimeout(timeout); reject(new Error("The coach disconnected. Reconnect when ready."));
      if (socket === ws) { socket = null; ready = false; pendingReply = false; releaseAudio(); voiceLabel = "Coach is disconnected. Your exercise is kept."; controls(); }
    };
  });
  controls();
  try { await connecting; } finally { connecting = null; controls(); }
}
function releaseAudio() { microphone?.stop(); player?.dispose(); microphone = null; player = null; talking = false; muted = false; voiceMode = "quiet"; }
function disconnectVoice() { const old = socket; socket = null; ready = false; pendingReply = false; releaseAudio(); old?.close(); voiceLabel = "Voice ended. Your exercise is kept."; }
// Audio begins only after a deliberate click, before connecting any paid voice service.
async function enableAudio() {
  player = new AgentPlayer({ sampleRate: 24000 }); player.queue(new Int16Array(1).buffer);
  microphone = new AgentMicrophone(data => { if (ready && !muted && socket?.readyState === WebSocket.OPEN) socket.send(data); }, { sampleRate: 16000 });
  await microphone.start(); talking = true; muted = false; voiceLabel = "Connecting your coach…";
}
async function ask(content) {
  if (!content.trim()) return;
  showError(); pendingReply = true; controls();
  try { await flushCode(); await connect(); socket.send(JSON.stringify({ type: "ask", content })); $("question").value = ""; }
  catch (error) { pendingReply = false; showError(error.message); }
  controls();
}
async function start(withVoice) {
  if (busy) return;
  busy = true; showError(); controls();
  try {
    if (withVoice) await enableAudio();
    const next = await request("/api/start", {});
    showWelcome = false; typing = false; $("check-details").open = false; $("conversation").open = false;
    render(next, true); undoCode = undefined;
    busy = false; controls();
    await ask("Let's begin the exercise. Ask me where I would look first.");
    if (!withVoice) $("question").focus();
  } catch (error) {
    releaseAudio(); showError(error.name === "NotAllowedError" ? "Microphone access was denied. Allow it in your browser, or choose Use text instead." : error.message);
  } finally { busy = false; controls(); }
}
$("start").onclick = () => void start(true); $("start-text").onclick = () => void start(false);
// Starting again returns to the invitation before creating another paid practice computer.
$("again").onclick = () => { showWelcome = true; showError(); controls(); };
$("type-toggle").onclick = () => { typing = !typing; controls(); if (typing) $("question").focus(); };
$("talk").onclick = async () => {
  if (talking) { disconnectVoice(); controls(); return; }
  showError(); busy = true; controls();
  try { await enableAudio(); await connect(); }
  catch (error) { releaseAudio(); showError(error.name === "NotAllowedError" ? "Allow microphone access in your browser, or type your message below." : error.message); }
  finally { busy = false; controls(); }
};
$("mute").onclick = async () => {
  try {
    if (!muted) { microphone?.stop(); muted = true; voiceLabel = "Microphone muted. You can still hear your coach."; }
    else { await microphone?.start(); muted = false; voiceLabel = "Listening. Take your time."; }
  } catch { showError("Could not restart your microphone. End voice and reconnect."); }
  controls();
};
$("ask-form").onsubmit = event => { event.preventDefault(); void ask($("question").value.trim()); };
$("question").oninput = controls;
$("feedback").onclick = () => void ask("Give me brief feedback on how I explained my reasoning so far, and one next practice step.");
$("run").onclick = async () => { busy = true; showError(); controls(); try { await flushCode(); render(await request("/api/check", {})); $("stop-checks").focus(); } catch (error) { showError(error.message); } finally { busy = false; controls(); } };
$("stop-checks").onclick = async () => { try { render(await request("/api/stop", {})); } catch (error) { showError(error.message); } };
$("finish").onclick = async () => {
  busy = true; showError(); controls();
  try { await flushCode(); disconnectVoice(); render(await request("/api/end", {})); }
  catch (error) { showError(error.message); }
  finally { busy = false; controls(); }
};
// The clock reports real session time. It never estimates execution progress.
function renderClock() {
  if (!state) return;
  const remaining = Math.max(0, Math.ceil(((state.expiresAt || Date.now()) - Date.now()) / 1000));
  $("clock").textContent = isActive() ? `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}` : state.endedAt ? "Practice complete" : "10-minute practice";
  $("session-note").textContent = state.endedAt ? "Your practice computer is closed. Your recap is ready to keep." : isActive() ? `Your workspace stays open for this exercise. ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")} left.` : state.phase === "closing" ? "Closing your workspace and preparing the recap…" : "One exercise. Your own temporary workspace. Start over any time.";
}
// Polling restores results after refresh and observes cleanup even without a voice connection.
async function refresh() { if (polling) return; polling = true; try { render(await request("/api/state")); } catch (error) { showError(error.message); } finally { polling = false; } }
await refresh();
const pollTimer = setInterval(() => { if (state?.startedAt && !state.endedAt) void refresh(); }, 1500);
const clockTimer = setInterval(renderClock, 1000);
window.addEventListener("pagehide", () => { clearInterval(pollTimer); clearInterval(clockTimer); clearTimeout(saveTimer); disconnectVoice(); });
