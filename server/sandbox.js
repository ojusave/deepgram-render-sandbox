// Render's library creates separate practice computers; its credentials remain on this server.
import { Render } from "@renderinc/sdk";
// A pause between readiness checks avoids unnecessary provider requests.
import { setTimeout as delay } from "node:timers/promises";
import { randomBytes } from "node:crypto";
import { cases, evaluateCase, validateCode } from "./exercise.js";

// Every external request has a deadline. Creation is never repeated after an uncertain response.
export async function bounded(promise, ms = 15000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("The practice computer took too long to respond.")), ms); })]); }
  finally { clearTimeout(timer); }
}
// Confirm cleanup for the exact owned ID. Listing also works when a terminated ID cannot be fetched.
export async function terminateAndConfirm(api, id) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await bounded(api.terminate(id));
      let cursor;
      for (let page = 0; page < 5; page++) {
        const entries = await bounded(api.list({ status: ["terminated", "errored"], limit: 100, ...(cursor ? { cursor } : {}) }));
        if (entries.some(row => row.sandbox.id === id && row.sandbox.status === "terminated")) return;
        if (!entries.length || !entries.at(-1).cursor || entries.at(-1).cursor === cursor) break;
        cursor = entries.at(-1).cursor;
      }
    } catch { /* Only stopping this known resource is retried. Learner code is never rerun here. */ }
    await delay(400 * (attempt + 1));
  }
  throw new Error("Closing the practice computer is not confirmed. New sessions are paused.");
}
// The trusted harness launches a fresh Python process per case inside the same practice computer.
// Its output reports actual values. Expected answers and pass/fail comparisons stay on the host.
export function checkCommand(marker) {
  const script = `import json, subprocess, sys, os, signal
cases = ${JSON.stringify(cases.map(({id,input}) => ({id,input})))}
for case in cases:
    child = "import runpy, json; f = runpy.run_path('/tmp/average.py')['average_wait']; print(json.dumps(f(" + repr(case['input']) + "), allow_nan=False))"
    process = subprocess.Popen([sys.executable, '-I', '-c', child], stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
    try:
        out, err = process.communicate(timeout=3)
        if process.returncode != 0:
            result = {'error': err.decode(errors='replace').strip().split('\\n')[-1][:240] or 'The program stopped without a result.'}
        else:
            result = {'value': json.loads(out.decode().strip())}
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.communicate()
        result = {'error': 'This check took too long. Look for a loop that never ends.'}
    except Exception:
        result = {'error': 'Return one number from average_wait. Extra printed output cannot be checked.'}
    finally:
        try: os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError: pass
    result['id'] = case['id']
    print('${marker}' + json.dumps(result), flush=True)
`;
  // Base64 is a fixed alphabet, so neither learner code nor input can become a shell command.
  const encoded = Buffer.from(script).toString("base64");
  return `ulimit -f 1024; ulimit -v 262144; timeout --signal=TERM --kill-after=2s 15s python3 -I -c 'import base64; exec(base64.b64decode("${encoded}"))'`;
}
// One workspace lives through the exercise. Each run replaces its code file, preserving the session ID.
export function createPracticeRunner(api = new Render().experimental.sandboxes) {
  const active = new Map();
  let unknownCreate = false;
  return {
    get blocked() { return unknownCreate || [...active.values()].some(item => item.cleanup === "unconfirmed"); },
    async open({ signal, report = () => {} } = {}) {
      if (this.blocked) throw new Error("A previous practice computer needs cleanup. Please try later.");
      signal?.throwIfAborted();
      let workspace, late = false;
      const pending = api.create({ timeoutSeconds: 720, networkPolicy: { default: "deny-all" } });
      // A late success still belongs to this request and is cleaned up, even after the UI timed out.
      pending.then(async item => {
        if (!late) return;
        const owned = { id: item.id, cleanup: "unconfirmed" }; active.set(item.id, owned);
        try { await this.close(owned); unknownCreate = false; } catch { /* Keep the block until confirmed. */ }
      }).catch(() => {});
      try {
        let item;
        try { item = await bounded(pending, 30000); }
        catch { late = true; unknownCreate = true; throw new Error("Starting the practice computer could not be confirmed. Please try later."); }
        workspace = { id: item.id, cleanup: "open", createdAt: Date.now() }; active.set(item.id, workspace);
        report({ workspace, detail: "Starting your separate practice computer…" });
        const deadline = Date.now() + 45000;
        while (true) {
          signal?.throwIfAborted();
          const state = await bounded(api.get(item.id));
          if ((state.networkPolicy?.type ?? state.networkPolicy?.default) !== "deny-all") throw new Error("The required offline practice environment was not confirmed.");
          if (state.status === "running") break;
          if (["terminated", "errored"].includes(state.status) || Date.now() > deadline) throw new Error("Your practice computer did not become ready. Try starting again.");
          await delay(1000, undefined, { signal });
        }
        signal?.throwIfAborted();
        return workspace;
      } catch (error) { if (workspace) await this.close(workspace); throw error; }
    },
    async run(workspace, code, { signal, onCase = () => {} } = {}) {
      validateCode(code); signal?.throwIfAborted();
      if (!workspace || workspace.cleanup !== "open") throw new Error("Start a practice session first.");
      const boundedSignal = AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(25000)]);
      await bounded(api.upload(workspace.id, "/tmp/average.py", code, undefined, { signal: boundedSignal }));
      const marker = "CHECK_" + randomBytes(12).toString("hex") + ":";
      let buffer = "", size = 0, exitCode = null;
      const results = [];
      for await (const event of await api.exec(workspace.id, checkCommand(marker), undefined, boundedSignal)) {
        signal?.throwIfAborted();
        if (event.type === "exit") { exitCode = event.exit_code; continue; }
        if (event.type !== "output") continue;
        size += event.data.length;
        if (size > 20000) throw new Error("The program produced too much output. Remove extra printing and try again.");
        if (event.stream !== "stdout") continue;
        buffer += event.data;
        let end;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          if (!line.startsWith(marker)) continue;
          let item;
          try { item = evaluateCase(JSON.parse(line.slice(marker.length))); } catch { throw new Error("The check results could not be read. Try again."); }
          if (results.some(result => result.id === item.id)) throw new Error("A check returned more than once.");
          results.push(item); onCase(item);
        }
      }
      signal?.throwIfAborted();
      if (exitCode !== 0 || results.length !== cases.length) throw new Error("The checks did not finish. Look for code that runs forever or prints too much.");
      return results;
    },
    async close(workspace) {
      if (!workspace || workspace.cleanup === "terminated") return;
      // Concurrent end/cancel/shutdown requests share one cleanup promise.
      if (workspace.closing) return workspace.closing;
      workspace.cleanup = "unconfirmed";
      workspace.closing = terminateAndConfirm(api, workspace.id).then(() => { workspace.cleanup = "terminated"; active.delete(workspace.id); }).finally(() => { workspace.closing = null; });
      return workspace.closing;
    },
    async shutdown() { await Promise.allSettled([...active.values()].map(workspace => this.close(workspace))); },
  };
}
