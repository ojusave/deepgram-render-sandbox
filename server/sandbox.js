// Render's SDK keeps platform credentials on this server, outside generated programs.
import { Render } from "@renderinc/sdk";
// The output validator accepts data only. It does not evaluate returned code.
import { resultSchema } from "./data.js";
// Timer helpers allow readiness checks to stop when the user cancels.
import { setTimeout as delay } from "node:timers/promises";

// Wrap a provider call with a deadline. An expired create is never automatically repeated.
export async function bounded(promise, ms = 15000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("The provider took too long to respond.")), ms); })]); }
  finally { clearTimeout(timer); }
}

// Confirm the exact sandbox has stopped, including SDK versions that cannot get a terminated ID.
export async function terminateAndConfirm(api, id) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await bounded(api.terminate(id));
      let cursor;
      for (let page = 0; page < 5; page++) {
        const entries = await bounded(api.list({ status: ["terminated", "errored"], limit: 100, ...(cursor ? { cursor } : {}) }));
        const item = entries.find(row => row.sandbox.id === id)?.sandbox;
        if (item?.status === "terminated") return;
        if (!entries.length || !entries.at(-1).cursor || entries.at(-1).cursor === cursor) break;
        cursor = entries.at(-1).cursor;
      }
    } catch { /* Retry only stopping this known resource, never its program. */ }
    await delay(500 * (attempt + 1));
  }
  throw new Error("Cleanup is not confirmed. New calculations are paused.");
}

// Each run owns one disposable environment. No user code executes on the web server.
export function createRunner(api = new Render().experimental.sandboxes) {
  const active = new Map();
  let uncertain = false;
  async function run({ code, csv, signal, report = () => {} }) {
    if (uncertain) throw new Error("A previous sandbox needs cleanup. Please try later.");
    if (typeof code !== "string" || !code.trim() || code.length > 24000) throw new Error("The generated calculation was too large. Try a narrower question.");
    const started = Date.now();
    let id, output, cleanup = "not-created", expired = false;
    const check = () => signal?.throwIfAborted();
    try {
      check();
      report({ stage: "Preparing calculation", phase: "preparing", code });
      const pending = api.create({ timeoutSeconds: 180, networkPolicy: { default: "deny-all" } });
      // If the provider answers after our deadline, retain ownership and stop that late resource.
      pending.then(sandbox => { if (expired) { active.set(sandbox.id, true); void terminateAndConfirm(api, sandbox.id).then(() => { active.delete(sandbox.id); uncertain = false; }).catch(() => {}); } }).catch(() => {});
      let sandbox;
      try { sandbox = await bounded(pending, 30000); }
      catch (error) { expired = true; uncertain = true; cleanup = "unconfirmed"; throw new Error("Sandbox creation could not be confirmed. Please try later."); }
      id = sandbox.id; active.set(id, true); cleanup = "unconfirmed";
      report({ stage: "Starting isolated calculation", sandboxId: id, cleanup: "unconfirmed" });
      const readyDeadline = Date.now() + 45000;
      while (true) {
        check();
        const state = await bounded(api.get(id));
        const policy = state.networkPolicy;
        if ((policy?.type ?? policy?.default) !== "deny-all") throw new Error("The required offline environment was not confirmed.");
        if (state.status === "running") break;
        if (["errored", "terminated"].includes(state.status) || Date.now() > readyDeadline) throw new Error("The calculation environment did not start.");
        await delay(750, undefined, { signal });
      }
      // Fixed paths and a fixed command prevent tool arguments from becoming shell commands.
      check();
      await bounded(api.upload(id, "/tmp/data.csv", csv));
      await bounded(api.upload(id, "/tmp/program.py", code));
      report({ stage: "Calculating", phase: "calculating", sandboxId: id });
      let stdout = "", stderr = "", exitCode = null;
      const execSignal = AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(30000)]);
      for await (const event of await api.exec(id, "ulimit -f 2048; timeout --signal=TERM --kill-after=2s 20s python3 -I /tmp/program.py", undefined, execSignal)) {
        if (event.type === "output") {
          if (stdout.length + stderr.length + event.data.length > 32000) throw new Error("The calculation produced too much output.");
          if (event.stream === "stdout") stdout += event.data; else stderr += event.data;
        } else if (event.type === "exit") exitCode = event.exit_code;
      }
      check();
      if (exitCode !== 0) {
        report({ stderr: stderr.slice(-3000), exitCode });
        throw new Error(exitCode === 124 ? "The calculation reached its time limit." : "The generated calculation failed. Try rephrasing the question.");
      }
      report({ stage: "Checking output", phase: "checking" });
      // Bound the returned file before downloading it, even when the generated program misbehaves.
      let collectExit = null;
      for await (const event of await api.exec(id, "test -f /tmp/result.json && head -c 65537 /tmp/result.json > /tmp/collected.json", undefined, execSignal)) {
        if (event.type === "exit") collectExit = event.exit_code;
      }
      if (collectExit !== 0) throw new Error("The calculation did not produce a result.");
      const file = await bounded(api.download(id, "/tmp/collected.json", undefined, execSignal));
      if (file.size > 65536) throw new Error("The result is too large. Ask for a smaller table.");
      try { output = resultSchema.parse(JSON.parse(file.data.toString("utf8"))); }
      catch { throw new Error("The calculation returned an invalid result. Try rephrasing the question."); }
    } finally {
      if (id) {
        report({ stage: "Finishing", phase: "closing", interruption: signal?.aborted ? "cancelled" : !output ? "failed" : undefined, sandboxId: id });
        try { await terminateAndConfirm(api, id); active.delete(id); cleanup = "terminated"; }
        catch (error) { uncertain = true; throw error; }
      }
      report({ cleanup, durationMs: Date.now() - started, sandboxId: id });
    }
    check();
    return { ...output, sandboxId: id, cleanup, durationMs: Date.now() - started };
  }
  // Shutdown waits for our known environments only; it never stops unrelated workspace resources.
  return { run, shutdown: () => Promise.allSettled([...active.keys()].map(id => terminateAndConfirm(api, id))) };
}
