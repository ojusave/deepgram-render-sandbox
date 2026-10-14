// These opt-in checks use disposable Render Sandboxes and always wait for cleanup.
import assert from "node:assert/strict";
import { createRunner } from "../server/sandbox.js";
const runner = createRunner();
const csv = "n\n1";
let cancelledId, cleanup;
const controller = new AbortController();
// Abort only after execution starts, proving that cancelling a stream also stops its sandbox.
await assert.rejects(runner.run({
  csv, code: "import time\n# Hold the test open so Stop can be exercised.\ntime.sleep(30)\n",
  signal: controller.signal,
  report: patch => { if (patch.sandboxId) cancelledId = patch.sandboxId; if (patch.cleanup) cleanup = patch.cleanup; if (patch.stage === "Calculating") setTimeout(() => controller.abort(new Error("Test Stop")), 700); },
}));
assert.equal(cleanup, "terminated");
console.log(JSON.stringify({ cancelledId, cleanup }));
// A separate fresh environment checks that no credentials or outbound access were inherited.
const result = await runner.run({ csv, code: `import json, os, socket
# A sandbox receives files only, never the web server's credential environment.
assert not os.environ.get("DEEPGRAM_API_KEY")
assert not os.environ.get("RENDER_API_KEY")
blocked = False
try:
    socket.create_connection(("1.1.1.1", 443), timeout=2)
except OSError:
    blocked = True
assert blocked
# Return ordinary JSON through the same validated output path as a real analysis.
with open("/tmp/result.json", "w") as output:
    json.dump({"title":"Isolation checked","summary":"Outbound connections are blocked and host keys are absent.","columns":["Check","Passed"],"rows":[["Network blocked",1],["Keys absent",1]]}, output)
` });
assert.equal(result.cleanup, "terminated");
console.log(JSON.stringify({ passed: true, sandboxId: result.sandboxId, cleanup: result.cleanup }));
