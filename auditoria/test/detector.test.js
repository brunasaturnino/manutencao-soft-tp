import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL, fileURLToPath } from "node:url";
import { auditRepo } from "../src/audit.js";
import { normalizedEntropy } from "../src/clones.js";
import { discoverProductFiles, discoverTestFiles, readPublicSurface } from "../src/files.js";
import { applyConsolidationToFiles, applyDeadToFiles, applyDelegationToFiles, applyExtractionToFiles } from "../src/apply.js";
import { evaluateRepo, renderEvaluation } from "../src/evaluate.js";

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

test("reconhece arquivos de teste JavaScript na raiz do projeto", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "audit-root-tests-"));
  try {
    fs.mkdirSync(path.join(tmp, "src"));
    fs.writeFileSync(path.join(tmp, "src", "index.js"), "export const value = 1;\n");
    fs.writeFileSync(path.join(tmp, "test.js"), "assert.equal(1, 1);\n");
    fs.writeFileSync(path.join(tmp, "test.node.js"), "assert.equal(2, 2);\n");

    assert.deepEqual(discoverProductFiles(tmp).map((file) => path.relative(tmp, file)), [path.join("src", "index.js")]);
    assert.deepEqual(
      discoverTestFiles(tmp).map((file) => path.relative(tmp, file)).sort(),
      ["test.js", "test.node.js"],
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("o relatório de avaliação usa os metadados do projeto e aceita cobertura indisponível", () => {
  const report = renderEvaluation({
    repo: "/tmp/example",
    project: { name: "example-package", version: "2.3.4", packageManager: "npm" },
    commit: "abc123",
    status: "completed",
    reverted: false,
    alterations: [],
    before: { loc: 5 },
    after: { loc: 4 },
    lint: { before: { available: false }, after: { available: false } },
    tests: {
      before: { command: "npm run test", code: 0, coverage: null, coverageReason: "provedor não encontrado" },
      after: { command: "npm run test", code: 0, coverage: null },
    },
  });

  assert.match(report, /example-package 2\.3\.4/);
  assert.match(report, /não medida/i);
  assert.match(report, /provedor não encontrado/);
  assert.doesNotMatch(report, /axios/i);

  const legacyReport = renderEvaluation({
    repo: "/tmp/axios",
    version: "axios 1.21.0",
    before: { loc: 5 },
    after: { loc: 4 },
    eslint: {
      before: { averageMs: 918, stdMs: 47 },
      after: { averageMs: 863, stdMs: 66 },
    },
    tests: { before: { coverage: { lines: 91.84 } }, after: { coverage: { lines: 91.83 } } },
    alterations: [],
    reverted: false,
  });
  assert.match(legacyReport, /axios 1\.21\.0/);
  assert.match(legacyReport, /918 ± 47/);

  const failedLintReport = renderEvaluation({
    repo: "/tmp/example",
    project: { name: "example-package", version: "2.3.4", packageManager: "npm" },
    status: "aborted",
    reason: "O lint falhou antes das refatorações.",
    reverted: false,
    alterations: [],
    before: { loc: 5 },
    lint: { before: { available: true, command: "npm run lint", ok: false, averageMs: 120, stdMs: 2 } },
    tests: { before: { command: "npm run test", code: 0 } },
  });
  assert.match(failedLintReport, /Lint antes: `npm run lint` — falhou/);
});

test("evaluate recusa um repositório Git com alterações preexistentes", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "audit-dirty-repo-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: tmp });
    fs.writeFileSync(path.join(tmp, "index.js"), "export const value = 1;\n");

    await assert.rejects(
      evaluateRepo({ repo: tmp, out: path.join(tmp, "results") }),
      /árvore Git limpa/,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("evaluate gera relatório genérico para scripts package.json sem cobertura Vitest", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "audit-evaluate-"));
  const repo = path.join(tmp, "repo");
  const out = path.join(tmp, "results");
  try {
    fs.mkdirSync(repo);
    fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({
      name: "fixture-package",
      version: "1.2.3",
      scripts: { test: "node --check index.js", lint: "node --check index.js" },
    }));
    fs.writeFileSync(path.join(repo, "index.js"), "module.exports = 1;\n");
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["add", "package.json", "index.js"], { cwd: repo });
    execFileSync("git", [
      "-c", "user.name=Audit Test",
      "-c", "user.email=audit-test@example.invalid",
      "commit", "-qm", "fixture",
    ], { cwd: repo });

    await evaluateRepo({ repo, out });

    const result = JSON.parse(fs.readFileSync(path.join(out, "avaliacao.json"), "utf8"));
    assert.equal(result.project.name, "fixture-package");
    assert.equal(result.project.version, "1.2.3");
    assert.equal(result.status, "completed");
    assert.equal(result.tests.before.code, 0);
    assert.equal(result.tests.before.coverage, null);
    assert.equal(fs.existsSync(path.join(out, "antes.json")), true);
    assert.equal(fs.existsSync(path.join(out, "depois.json")), true);
    assert.equal(fs.existsSync(path.join(out, "RELATORIO.md")), true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("evaluate reverte somente as alterações do apply quando os testes passam antes e falham depois", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "audit-evaluate-rollback-"));
  const repo = path.join(tmp, "repo");
  const out = path.join(tmp, "results");
  try {
    copyDir(fixture, repo);
    fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({
      name: "rollback-fixture",
      scripts: {
        test: "node -e \"const fs=require('node:fs'); process.exit(fs.readFileSync('a.js','utf8').includes('orphan') ? 0 : 1)\"",
      },
    }));
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["add", "."], { cwd: repo });
    execFileSync("git", [
      "-c", "user.name=Audit Test",
      "-c", "user.email=audit-test@example.invalid",
      "commit", "-qm", "fixture",
    ], { cwd: repo });

    await evaluateRepo({ repo, out, minTokens: 20, minLines: 4 });

    const result = JSON.parse(fs.readFileSync(path.join(out, "avaliacao.json"), "utf8"));
    assert.equal(result.status, "reverted");
    assert.match(fs.readFileSync(path.join(repo, "a.js"), "utf8"), /orphan/);
    assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" }).trim(), "");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
