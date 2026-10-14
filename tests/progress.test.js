// Check the states people see, especially when stopping or failing during a calculation.
import test from "node:test";
import assert from "node:assert/strict";
import { beginProgress, advanceProgress, finishProgress, progressCopy } from "../web/progress.js";

test("a complete calculation records each observed step and closes before success", () => {
  const progress = beginProgress("first", 1000);
  ["preparing", "calculating", "checking", "closing"].forEach((phase, index) => advanceProgress(progress, phase, undefined, 2000 + index * 1000));
  assert.equal(progress.status, "running");
  finishProgress(progress, "succeeded", "terminated", 6000);
  assert.ok(progress.steps.every(step => step.status === "done"));
  assert.equal(progress.endedAt, 6000);
  assert.match(progressCopy(progress, 120).detail, /all 120 rows/);
});

test("cancelling work does not pretend the calculation or unchecked output finished", () => {
  const progress = beginProgress("cancelled");
  advanceProgress(progress, "preparing"); advanceProgress(progress, "calculating");
  advanceProgress(progress, "closing", "cancelled"); finishProgress(progress, "cancelled", "terminated");
  assert.equal(progress.steps[2].status, "cancelled");
  assert.equal(progress.steps[3].status, "waiting");
  assert.equal(progress.steps[4].status, "done");
  assert.match(progressCopy(progress).detail, /workspace is closed/);
});

test("unconfirmed cleanup never tells the user that the workspace closed", () => {
  const progress = beginProgress("uncertain");
  advanceProgress(progress, "preparing"); advanceProgress(progress, "closing", "cancelled");
  finishProgress(progress, "cancelled", "unconfirmed");
  assert.match(progressCopy(progress).title, /not confirmed/);
  assert.match(progressCopy(progress).detail, /paused/);
});

test("a follow-up starts fresh and a reply without calculation leaves unused steps untouched", () => {
  const old = beginProgress("old"); finishProgress(old, "replied", "not-created");
  const next = beginProgress("new");
  assert.equal(next.status, "running");
  assert.equal(next.steps[0].status, "active");
  assert.ok(old.steps.slice(1).every(step => step.status === "waiting"));
  assert.equal(progressCopy(old).title, "Reply ready");
});
