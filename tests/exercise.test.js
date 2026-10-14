// These checks verify actual result interpretation, including malformed or misleading output.
import test from "node:test";
import assert from "node:assert/strict";
import { evaluateCase, validateCode } from "../server/exercise.js";
test("expected numeric output passes, but strings, booleans, infinity and wrong answers do not", () => {
  assert.equal(evaluateCase({ id: "empty", value: 0 }).passed, true);
  for (const value of ["0", false, Infinity, null, 1]) assert.equal(evaluateCase({ id: "empty", value }).passed, false);
});
test("Python errors remain failures and are readable by the learner", () => {
  const result = evaluateCase({ id: "empty", error: "ZeroDivisionError: division by zero" });
  assert.equal(result.passed, false); assert.match(result.detail, /division by zero/);
});
test("unexpected cases and oversized or empty code are refused", () => {
  assert.throws(() => evaluateCase({ id: "made-up", value: 0 }));
  for (const input of [null, "", " ", "x".repeat(12001), "\0"]) assert.throws(() => validateCode(input));
});

// Long sessions must still fit the provider's initial prompt limit when the coach reconnects.
import { coachPrompt } from "../server/settings.js";
test("coach context includes the current revision without duplicating long result code", () => {
  const prompt = coachPrompt({ code: "x".repeat(12000), revision: 4, result: { revision: 3, code: "y".repeat(12000), checks: [] }, messages: Array.from({length:50}, () => ({role:"user",content:"z".repeat(4000)})) });
  assert.ok(prompt.length < 25000); assert.match(prompt, /"checksAreCurrent":false/); assert.ok(!prompt.includes("y".repeat(100)));
});
