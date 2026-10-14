// This small exercise is shared by the browser, coach, and server-owned checks.
// Learners edit only the function. Expected answers stay on the trusted server.
export const exercise = {
  id: "empty-wait", title: "The empty-list bug", filename: "average.py",
  description: "A support dashboard shows the average customer wait. It works until there are no customers. Find the bug, explain it, and make the function return 0 for an empty list.",
  starter: `# Find the average customer wait, measured in minutes.
# For example, [4, 8] should return 6.
def average_wait(minutes):
    # Add the waits and count how many customers there are.
    total = sum(minutes)
    count = len(minutes)
    return total / count
`,
};
// The labels explain each case without requiring familiarity with automated tests.
export const cases = [
  { id: "normal", label: "Several customers", input: [4, 8, 6], expected: 6 },
  { id: "empty", label: "No customers", input: [], expected: 0 },
  { id: "decimal", label: "Partial minutes", input: [1.5, 2.5], expected: 2 },
];
// A bounded string is the only learner input the execution adapter accepts.
export function validateCode(code) {
  if (typeof code !== "string" || !code.trim() || code.length > 12000 || code.includes("\0")) throw new Error("Keep your Python code between 1 and 12,000 characters.");
  return code;
}
// Compare actual numbers here, outside the learner's environment. The coach cannot mark checks green.
export function evaluateCase(item) {
  const fixture = cases.find(candidate => candidate.id === item.id);
  if (!fixture) throw new Error("An unexpected check was returned.");
  const passed = !item.error && typeof item.value === "number" && Number.isFinite(item.value) && Math.abs(item.value - fixture.expected) < 1e-9;
  const actual = item.error ? String(item.error).slice(0, 240) : JSON.stringify(item.value)?.slice(0, 240) ?? "No result";
  return { ...fixture, passed, actual, detail: passed ? `Returned ${fixture.expected}, as expected.` : item.error ? actual : `Expected ${fixture.expected}; received ${actual}.` };
}
