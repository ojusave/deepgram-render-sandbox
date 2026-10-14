// Node's built-in test runner checks inputs and output safety without paid API calls.
import test from "node:test";
import assert from "node:assert/strict";
import { readDataset, sampleCsv, resultSchema, toCsv } from "../server/data.js";
import { agentSettings } from "../server/settings.js";

test("CSV quotes, row limits, and duplicate headers are validated", () => {
  assert.equal(readDataset('name,n\n"Smith, Sam",4').preview[0][0], "Smith, Sam");
  assert.equal(readDataset(sampleCsv).count, 12);
  for (const csv of ["a,a\n1,2", "a,b\n1", "a,b\n", "a\n" + "x".repeat(512001)]) assert.throws(() => readDataset(csv));
});
test("computed results must contain finite numbers and rectangular tables", () => {
  const result = { title: "Totals", summary: "Done", columns: ["A"], rows: [[3]] };
  assert.deepEqual(resultSchema.parse(result), result);
  assert.throws(() => resultSchema.parse({ ...result, rows: [[3, 4]] }));
  assert.throws(() => resultSchema.parse({ ...result, chart: { label: "A", labels: ["a"], values: [Infinity] } }));
});
test("CSV exports neutralize formulas and preserve quoted cells", () => {
  const csv = toCsv({ columns: ["name"], rows: [['=HYPERLINK("x")'], ["safe, text"]] });
  assert.ok(csv.includes('"\'=HYPERLINK(""x"")"'));
  assert.ok(csv.includes('"safe, text"'));
});
test("the voice tool waits for the completed turn and uses the full uploaded file", () => {
  const settings = agentSettings(readDataset(sampleCsv));
  assert.equal(settings.agent.think.functions[0].defer_until_eot, true);
  assert.match(settings.agent.think.prompt, /COMPLETE CSV/);
  assert.equal(settings.audio.input.sample_rate, 16000);
});

// This reproduces a hosted response whose table showed totals but whose bars showed differences.
// Accept either metric when it appears in the table; reject a chart that silently changes it.
test("chart bars must match a consistent metric in the result table", () => {
  const totals = { title: "Revenue", summary: "West leads", columns: ["Region", "Revenue"], rows: [["West", 65000], ["East", 56500]] };
  const chart = { label: "Revenue", labels: ["West", "East"], values: [65000, 56500] };
  assert.ok(resultSchema.safeParse({ ...totals, chart }).success);
  assert.equal(resultSchema.safeParse({ ...totals, chart: { ...chart, values: [8500, -8500] } }).success, false);
  const changes = { ...totals, columns: ["Product", "August", "September", "Change"], rows: [["Lamp", 28000, 17000, -11000], ["Tote", 22000, 21000, -1000]] };
  assert.ok(resultSchema.safeParse({ ...changes, chart: { label: "Change", labels: ["Lamp", "Tote"], values: [-11000, -1000] } }).success);
});
