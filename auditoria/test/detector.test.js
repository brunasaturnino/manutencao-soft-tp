import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL, fileURLToPath } from "node:url";
import { auditRepo } from "../src/audit.js";
import { applyDeadToFiles, applyDelegationToFiles, applyExtractionToFiles } from "../src/apply.js";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "mini");
const options = { minTokens: 20, minLines: 4 };

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else fs.writeFileSync(to, fs.readFileSync(from));
  }
}

test("encontra código morto, código inalcançável e clones de tipo 1 e 2", () => {
  const report = auditRepo(fixture, options);
  const symbols = report.dead.filter((item) => item.kind === "dead-symbol").map((item) => item.name);
  assert.ok(symbols.includes("orphan"), symbols.join(","));
  assert.ok(symbols.includes("unusedExport"), symbols.join(","));
  assert.ok(symbols.includes("afterReturn"), symbols.join(","));
  assert.ok(symbols.includes("side"), symbols.join(","));
  assert.ok(symbols.includes("adapter"), symbols.join(","));
  assert.ok(symbols.includes("written"), symbols.join(","));
  assert.ok(!symbols.includes("bytes"), symbols.join(","));
  assert.ok(!symbols.includes("used"), symbols.join(","));
  assert.ok(!symbols.includes("run"), symbols.join(","));
  assert.ok(report.dead.some((item) => item.kind === "dead-file" && item.file.endsWith("b.js")));
  assert.ok(report.dead.some((item) => item.kind === "unreachable" && item.file.endsWith("a.js")));
  assert.ok(report.clones.some((clone) => clone.type === 1 && clone.a.file.endsWith("dup.js")));
  assert.ok(report.clones.some((clone) => clone.type === 2 && clone.a.file.endsWith("dup.js")));
  assert.equal(typeof report.metrics.maintainabilityIndex, "number");
  assert.ok(report.metrics.debtMinutes > 0);
});

test("a refatoração segura preserva o resultado e remove o código morto", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "audit-"));
  copyDir(fixture, tmp);
  let report = auditRepo(tmp, options);
  applyDelegationToFiles(report.product, 4);
  report = auditRepo(tmp, options);
  applyExtractionToFiles(report.product, report.clones.map((clone) => clone.ranges), 3);
  report = auditRepo(tmp, options);
  applyDeadToFiles(report.product, report.dead);
  const after = auditRepo(tmp, options);
  const symbols = after.dead.filter((item) => item.kind === "dead-symbol" && item.removable).map((item) => item.name);
  assert.deepEqual(symbols, [], symbols.join(","));
  const dup = fs.readFileSync(path.join(tmp, "dup.js"), "utf8");
  assert.match(dup, /function twinB\(n\) \{\s*return twinA\(n\);/);
  assert.match(dup, /function extractedClone1/);
  assert.match(dup, /const sent = extractedClone1\(user\)/);
  const mod = await import(pathToFileURL(path.join(tmp, "index.js")).href);
  assert.equal(mod.run(2), 46);
  const source = fs.readFileSync(path.join(tmp, "a.js"), "utf8");
  assert.equal(source.includes("orphan"), false);
  assert.equal(source.includes("hidden"), false);
  assert.match(source, /console\.log\("boot"\)/);
  const side = fs.readFileSync(path.join(tmp, "side-effects.js"), "utf8");
  assert.equal(side.includes("export default adapter"), false);
  assert.equal(side.includes("const adapter"), false);
  assert.match(side, /getFetch\(\);/);
  assert.match(side, /let bytes = 0/);
  assert.match(side, /let written = 0/);
  assert.match(side, /written = 1/);
});
