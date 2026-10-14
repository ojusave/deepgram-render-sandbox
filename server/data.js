// CSV is a text spreadsheet. This parser handles commas inside quotes and rejects broken rows.
import { parse } from "csv-parse/sync";
// Validate computed output before it reaches the page or the voice agent.
import { z } from "zod";

// A small fictional shop makes the first question useful without uploading a file.
export const sampleCsv = `month,product,region,revenue,orders
August,Canvas tote,West,12000,400
August,Canvas tote,East,10000,350
August,Travel mug,West,9000,300
August,Travel mug,East,8000,270
August,Desk lamp,West,15000,200
August,Desk lamp,East,13000,180
September,Canvas tote,West,11500,385
September,Canvas tote,East,9500,330
September,Travel mug,West,8500,280
September,Travel mug,East,8000,265
September,Desk lamp,West,9000,120
September,Desk lamp,East,8000,110
`;

// Limit file size, columns, and rows before retaining anything in server memory.
export function readDataset(csv, name = "Your data.csv") {
  if (typeof csv !== "string" || Buffer.byteLength(csv) > 512000) throw new Error("Choose a CSV smaller than 500 KB.");
  let rows;
  try { rows = parse(csv, { bom: true, skip_empty_lines: true, max_record_size: 32000 }); }
  catch { throw new Error("This CSV has uneven rows or broken quotes. Export it as CSV and try again."); }
  const columns = rows.shift();
  if (!columns?.length || columns.length > 30 || !columns.every(c => c.trim() && c.length <= 120) || new Set(columns).size !== columns.length) throw new Error("Use 1 to 30 uniquely named columns.");
  if (!rows.length || rows.length > 10000) throw new Error("Choose a CSV with 1 to 10,000 data rows.");
  if (rows.some(r => r.length !== columns.length)) throw new Error("Each row needs the same number of columns.");
  return { csv, name: String(name).replace(/[\r\n]/g, " ").slice(0, 100), columns, count: rows.length, preview: rows.slice(0, 30) };
}

// The page receives only a preview. The complete file goes to the execution sandbox.
export function preview(dataset) { const { csv, ...rest } = dataset; return rest; }
// Each result is ordinary data, never HTML or executable browser code.
const cell = z.union([z.string().max(500), z.number().finite(), z.null()]);
export const resultSchema = z.object({
  title: z.string().min(1).max(120),
  summary: z.string().min(1).max(2000),
  columns: z.array(z.string().max(120)).min(1).max(10),
  rows: z.array(z.array(cell).max(10)).max(100),
  chart: z.object({ label: z.string().max(120), labels: z.array(z.string().max(120)).min(1).max(15), values: z.array(z.number().finite()).min(1).max(15) }).optional(),
}).superRefine((value, ctx) => {
  // A table must stay rectangular; chart labels must correspond to actual numeric values.
  if (value.rows.some(r => r.length !== value.columns.length)) ctx.addIssue({ code: "custom", message: "Uneven result table" });
  if (value.chart && value.chart.labels.length !== value.chart.values.length) ctx.addIssue({ code: "custom", message: "Uneven chart" });
  // A chart is another view of the table, so every bar must reuse one label/value pair.
  // For example, West / 65000 cannot become West / 8500 while the table still shows totals.
  // Try each pair of columns, then require all bars to match that same pair.
  if (value.chart) {
    const matchesTable = value.columns.some((_, labelColumn) =>
      value.columns.some((_, numberColumn) => labelColumn !== numberColumn &&
        value.chart.labels.every((label, index) => value.rows.some(row =>
          String(row[labelColumn]) === label && row[numberColumn] === value.chart.values[index]))));
    if (!matchesTable) ctx.addIssue({ code: "custom", message: "Chart labels and values must match the same two columns in the result table" });
  }
});

// Quote each export cell, and neutralize spreadsheet formulas supplied through uploaded data.
export function toCsv(result) {
  const quote = value => {
    const text = String(value ?? "");
    return '"' + (/^[=+@\-\t\r]/.test(text) ? "'" : "") + text.replaceAll('"', '""') + '"';
  };
  return [result.columns, ...result.rows].map(row => row.map(quote).join(",")).join("\r\n");
}
