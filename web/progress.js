// Share plain-language progress between the server and the browser. No credentials belong here.
// A phase is one real part of the job. Time alone never advances these steps.
export const phases = [
  { id: "understanding", label: "Understand", title: "Working out how to answer", detail: "Deepgram is turning your question into a calculation." },
  { id: "preparing", label: "Prepare", title: "Preparing a temporary workspace", detail: "Render is setting up a separate place to run this calculation, away from the app." },
  { id: "calculating", label: "Calculate", title: "Calculating from your file", detail: "The program is reading your complete file, not just the preview." },
  { id: "checking", label: "Check", title: "Checking the output", detail: "Checking the table format and making sure the chart matches it. This does not verify every calculation." },
  { id: "closing", label: "Finish", title: "Closing the temporary workspace", detail: "The calculation has ended. Render is stopping its temporary workspace." },
];

// Start a fresh history for each question, including follow-up questions after a successful answer.
export function beginProgress(id, now = Date.now()) {
  return { id, startedAt: now, endedAt: null, status: "running", phase: "understanding", steps: phases.map((step, index) => ({ id: step.id, status: index ? "waiting" : "active", startedAt: index ? null : now, endedAt: null })) };
}

// The server calls this only when an actual operation starts. Cleanup may follow a failure;
// interrupted work must keep its stopped/failed marker instead of acquiring a success tick.
export function advanceProgress(progress, phase, interruption, now = Date.now()) {
  if (!progress) return;
  const previous = progress.steps.find(step => step.status === "active");
  if (previous?.id === phase) return;
  if (previous) { previous.status = interruption || "done"; previous.endedAt = now; }
  const next = progress.steps.find(step => step.id === phase);
  if (next) { next.status = "active"; next.startedAt = now; next.endedAt = null; }
  progress.phase = phase; progress.status = "running"; progress.endedAt = null;
  if (interruption) progress.interruption = interruption;
}

// Finish only after the server knows the outcome. A confirmed close remains successful even
// when the calculation itself was stopped or failed; untouched steps stay waiting.
export function finishProgress(progress, status, cleanup, now = Date.now()) {
  if (!progress) return;
  progress.status = status; progress.cleanup = cleanup; progress.endedAt = now;
  for (const step of progress.steps) if (step.status === "active") {
    step.status = status === "succeeded" || status === "replied" || (step.id === "closing" && cleanup === "terminated") ? "done" : status;
    step.endedAt = now;
  }
}

// Translate the observed state into a short explanation. Keep resource IDs and code optional.
export function progressCopy(progress, rowCount = 0) {
  if (progress.status !== "running" && progress.cleanup === "unconfirmed") return { title: "Workspace status not confirmed", detail: "New calculations are paused until we can confirm the temporary workspace has stopped." };
  if (progress.status === "succeeded") return { title: "Your answer is ready", detail: `Calculated from all ${rowCount.toLocaleString()} rows. The temporary workspace is closed.` };
  if (progress.status === "replied") return { title: "Reply ready", detail: "No calculation was needed for this reply. Ask a question about your numbers to calculate an answer." };
  if (progress.status === "cancelled") return { title: "Calculation stopped", detail: progress.cleanup === "terminated" ? "The temporary workspace is closed. You can ask another question." : "No answer was added. You can ask another question." };
  if (progress.status === "failed") return { title: "Couldn't finish this question", detail: progress.cleanup === "unconfirmed" ? "We couldn't confirm the temporary workspace closed. New calculations are paused." : "No new answer was added. Try rephrasing your question." };
  if (progress.stopping) return { title: "Stopping your calculation", detail: "Waiting for any work already started to stop. You can ask again once it closes." };
  const step = phases.find(item => item.id === progress.phase) || phases[0];
  return { title: step.title, detail: step.id === "calculating" ? `Running the calculation on all ${rowCount.toLocaleString()} rows in the temporary workspace.` : step.detail };
}
