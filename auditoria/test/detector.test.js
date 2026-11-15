import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL, fileURLToPath } from "node:url";
import { auditRepo } from "../src/audit.js";
import { normalizedEntropy } from "../src/clones.js";
import { readPublicSurface } from "../src/files.js";
import { applyConsolidationToFiles, applyDeadToFiles, applyDelegationToFiles, applyExtractionToFiles } from "../src/apply.js";

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

test("a consolidação move função duplicada entre ficheiros para módulo partilhado", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "audit-shared-"));
  fs.mkdirSync(path.join(tmp, "lib", "helpers"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "lib", "core"), { recursive: true });
  const body = (param) => `function trim(${param}) {
  let start = 0;
  let end = ${param}.length;
  while (start < end && ${param}.charCodeAt(start) === 32) {
    start += 1;
  }
  while (end > start && ${param}.charCodeAt(end - 1) === 32) {
    end -= 1;
  }
  return ${param}.slice(start, end);
}
`;
  fs.writeFileSync(path.join(tmp, "lib", "core", "a.js"), `${body("value")}export const a = (x) => trim(x);\n`);
  fs.writeFileSync(path.join(tmp, "lib", "helpers", "b.js"), `${body("str")}export const b = (x) => trim(x);\n`);
  fs.writeFileSync(path.join(tmp, "index.js"), "export { a } from './lib/core/a.js';\nexport { b } from './lib/helpers/b.js';\n");
  fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ name: "x", type: "module", main: "index.js" }));
  const report = auditRepo(tmp, options);
  const notes = applyConsolidationToFiles(report.product);
  assert.equal(notes.length, 2, JSON.stringify(notes));
  const shared = path.join(tmp, "lib", "helpers", "trim.js");
  assert.ok(fs.existsSync(shared));
  assert.ok(notes.every((note) => note.createdAbs === shared));
  assert.match(fs.readFileSync(shared, "utf8"), /export function trim\(value\)/);
  assert.match(fs.readFileSync(path.join(tmp, "lib", "core", "a.js"), "utf8"), /import \{ trim \} from '\.\.\/helpers\/trim\.js'/);
  assert.doesNotMatch(fs.readFileSync(path.join(tmp, "lib", "helpers", "b.js"), "utf8"), /function trim/);
});

test("o filtro de variedade separa listas de lógica", () => {
  const list = Array.from({ length: 40 }, (_, i) => ({ norm: i % 2 === 0 ? "ID" : "," }));
  const logic = Array.from({ length: 40 }, (_, i) => ({ norm: ["if", "(", "ID", ")", "{", "return", "LIT", ";", "}", "=", "+", "ID"][i % 12] }));
  assert.ok(normalizedEntropy(list) < 2.9, String(normalizedEntropy(list)));
  assert.ok(normalizedEntropy(logic) > 2.9, String(normalizedEntropy(logic)));
  assert.equal(normalizedEntropy([]), 0);
});

test("uma tabela de entradas repetidas é marcada como estrutura repetitiva e não como clone", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "audit-table-"));
  fs.mkdirSync(path.join(tmp, "lib"), { recursive: true });
  const rows = Array.from({ length: 14 }, (_, i) => `  key${i}: handler${i % 3},`).join("\n");
  fs.writeFileSync(path.join(tmp, "lib", "a.js"), `const table = {\n${rows}\n};\nexport default table;\n`);
  fs.writeFileSync(path.join(tmp, "lib", "b.js"), `const other = {\n${rows}\n};\nexport default other;\n`);
  fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ name: "x", type: "module", main: "lib/a.js" }));
  const report = auditRepo(tmp, options);
  assert.ok(report.clones.length > 0);
  assert.ok(report.clones.every((clone) => clone.repetitive), JSON.stringify(report.clones.map((c) => [c.type, c.entropy])));
  assert.equal(report.metrics.clonePairs, 0);
});

test("padrões com curinga em exports tornam público o que o Node expõe, e podem ser declarados internos", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "audit-exports-"));
  fs.mkdirSync(path.join(tmp, "lib", "deep"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "lib", "deep", "x.js"), "export const x = 1;\n");
  fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ name: "x", exports: { ".": "./index.js", "./unsafe/*": "./lib/*" } }));
  const file = path.join(tmp, "lib", "deep", "x.js");
  assert.equal(readPublicSurface(tmp).isPublic(file), true);
  assert.equal(readPublicSurface(tmp, { internalExports: ["./unsafe/*"] }).isPublic(file), false);
});
