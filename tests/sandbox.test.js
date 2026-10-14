// Replace only the Render transport, while exercising real ownership, parsing, and cancellation logic.
import test from "node:test";
import assert from "node:assert/strict";
import { createPracticeRunner } from "../server/sandbox.js";
function fake(options = {}) {
  const calls = [], stopped = new Set();
  return {
    calls,
    async create(input) { calls.push(["create", input]); return { id: "sb-practice" }; },
    async get() { return { status: "running", networkPolicy: { type: options.policy || "deny-all" } }; },
    async upload(id, path) { calls.push(["upload", id, path]); },
    async exec(id, command) {
      calls.push(["exec", id]);
      // Each run has its own random marker. Obtain it from the trusted harness command.
      const script = Buffer.from(command.match(/b64decode\("([A-Za-z0-9+/=]+)"\)/)[1], "base64").toString();
      const marker = script.match(/CHECK_[a-f0-9]+:/)[0];
      return (async function* () {
        options.onExec?.();
        const values = options.values || [{ id: "normal", value: 6 }, { id: "empty", value: 0 }, { id: "decimal", value: 2 }];
        for (const value of values) {
          const line = marker + JSON.stringify(value) + "\n";
          // Deliberately split a record across events to check streaming assembly.
          yield { type: "output", stream: "stdout", data: line.slice(0, 9) };
          yield { type: "output", stream: "stdout", data: line.slice(9) };
        }
        if (!options.noExit) yield { type: "exit", exit_code: options.exitCode ?? 0 };
      })();
    },
    async terminate(id) { calls.push(["terminate", id]); stopped.add(id); },
    async list() { return [...stopped].map(id => ({ sandbox: { id, status: "terminated" } })); },
  };
}
test("a session reuses its offline workspace, publishes actual cases and closes exactly once", async () => {
  const api = fake(), runner = createPracticeRunner(api), workspace = await runner.open();
  const progress = [], first = await runner.run(workspace, "pass", { onCase: item => progress.push(item.id) });
  await runner.run(workspace, "pass");
  assert.deepEqual(progress, ["normal", "empty", "decimal"]); assert.ok(first.every(item => item.passed));
  assert.equal(api.calls.filter(call => call[0] === "create").length, 1);
  assert.equal(api.calls[0][1].timeoutSeconds, 720); assert.equal(api.calls[0][1].networkPolicy.default, "deny-all");
  assert.equal(api.calls.filter(call => call[0] === "terminate").length, 0);
  await Promise.all([runner.close(workspace), runner.close(workspace)]);
  assert.equal(workspace.cleanup, "terminated"); assert.equal(api.calls.filter(call => call[0] === "terminate").length, 1);
});
test("missing exit, partial checks and duplicates never count as a complete run", async () => {
  for (const options of [{ noExit: true }, { values: [{ id: "normal", value: 6 }] }, { values: [{ id: "normal", value: 6 }, { id: "normal", value: 6 }] }]) {
    const runner = createPracticeRunner(fake(options)), workspace = await runner.open();
    await assert.rejects(runner.run(workspace, "pass")); await runner.close(workspace);
  }
});
test("permissive networking prevents any learner execution and confirms cleanup", async () => {
  const api = fake({ policy: "allow-all" }), runner = createPracticeRunner(api);
  await assert.rejects(runner.open(), /offline/);
  assert.ok(api.calls.some(call => call[0] === "terminate")); assert.ok(!api.calls.some(call => call[0] === "exec"));
});
test("cancelled execution cannot return results; its owner can close the same workspace", async () => {
  const controller = new AbortController(), api = fake({ onExec: () => controller.abort() });
  const runner = createPracticeRunner(api), workspace = await runner.open();
  await assert.rejects(runner.run(workspace, "pass", { signal: controller.signal }));
  await runner.close(workspace); assert.equal(workspace.cleanup, "terminated");
});
test("a pre-cancelled start creates nothing", async () => {
  const controller = new AbortController(), api = fake(); controller.abort();
  await assert.rejects(createPracticeRunner(api).open({ signal: controller.signal })); assert.equal(api.calls.length, 0);
});
