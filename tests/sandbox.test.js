// Fake only the Render transport. The real runner's cancellation and cleanup logic still executes.
import test from "node:test";
import assert from "node:assert/strict";
import { createRunner } from "../server/sandbox.js";
const result = { title: "Total", summary: "The total is 3.", columns: ["total"], rows: [[3]] };
function fake(options = {}) {
  const calls = [], stopped = new Set();
  return {
    calls,
    async create(input) { calls.push(["create", input]); return { id: "sb-test" }; },
    async get() { return { status: "running", networkPolicy: { type: options.policy ?? "deny-all" } }; },
    async upload(id, path) { calls.push(["upload", id, path]); },
    async exec(id, command) {
      calls.push(["exec", id, command]);
      return (async function* () { if (options.onExec) options.onExec(); if (!options.noExit) yield { type: "exit", exit_code: options.exitCode ?? 0 }; })();
    },
    async download() { return { data: Buffer.from(options.badJson ? "not json" : JSON.stringify(result)), size: 100 }; },
    async terminate(id) { calls.push(["terminate", id]); stopped.add(id); },
    async list() { return [...stopped].map(id => ({ sandbox: { id, status: "terminated" } })); },
  };
}
test("success collects validated output and confirms cleanup", async () => {
  const api = fake(); const output = await createRunner(api).run({ code: "pass", csv: "n\n3", signal: new AbortController().signal });
  assert.equal(output.rows[0][0], 3); assert.equal(output.cleanup, "terminated");
  assert.equal(api.calls[0][1].timeoutSeconds, 180);
  assert.equal(api.calls[0][1].networkPolicy.default, "deny-all");
  assert.ok(api.calls.some(c => c[0] === "terminate"));
});
test("a missing terminal exit cannot be called success", async () => {
  const api = fake({ noExit: true });
  await assert.rejects(createRunner(api).run({ code: "pass", csv: "a\n1" }), /failed/);
  assert.ok(api.calls.some(c => c[0] === "terminate"));
});
test("permissive networking blocks execution and still cleans up", async () => {
  const api = fake({ policy: "allow-all" });
  await assert.rejects(createRunner(api).run({ code: "pass", csv: "a\n1" }), /offline/);
  assert.ok(!api.calls.some(c => c[0] === "exec"));
  assert.ok(api.calls.some(c => c[0] === "terminate"));
});
test("bad output is rejected after collection, then cleaned up", async () => {
  const api = fake({ badJson: true });
  await assert.rejects(createRunner(api).run({ code: "pass", csv: "a\n1" }), /invalid/);
  assert.ok(api.calls.some(c => c[0] === "terminate"));
});
test("cancellation during execution cannot publish a result", async () => {
  const controller = new AbortController(), api = fake({ onExec: () => controller.abort() });
  await assert.rejects(createRunner(api).run({ code: "pass", csv: "a\n1", signal: controller.signal }));
  assert.ok(api.calls.some(c => c[0] === "terminate"));
});
test("cancellation before starting creates no sandbox", async () => {
  const api = fake(), controller = new AbortController(); controller.abort();
  await assert.rejects(createRunner(api).run({ code: "pass", csv: "a\n1", signal: controller.signal }));
  assert.equal(api.calls.length, 0);
});
