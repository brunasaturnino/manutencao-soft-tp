import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { auditRepo, renderReport, serializable } from "./audit.js";
import { applyConsolidationToFiles, applyDeadToFiles, applyDelegationToFiles, applyExtractionToFiles } from "./apply.js";

const LINT_RUNS = 10;

function run(command, args, cwd) {
  return new Promise((resolve) => {
    const started = performance.now();
    const executable = process.platform === "win32" && command === "npm" ? "npm.cmd" : command;
    let child;
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (code, error) => {
      if (settled) return;
      settled = true;
      resolve({
        code,
        stdout,
        stderr,
        error,
        ms: Math.round(performance.now() - started),
      });
    };
    try {
      child = spawn(executable, args, {
        cwd,
        windowsHide: true,
        shell: process.platform === "win32",
      });
    } catch (error) {
      finish(127, error.message);
      return;
    }
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => finish(127, error.message));
    child.on("close", (code) => finish(code ?? 1));
  });
}

function readProject(repo) {
  const packagePath = path.join(repo, "package.json");
  if (!fs.existsSync(packagePath)) {
    throw new Error(`evaluate exige package.json no repositório alvo: ${repo}`);
  }
  const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  const scripts = pkg.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {};
  const declaredManager = typeof pkg.packageManager === "string" ? pkg.packageManager.split("@")[0] : null;
  const supportedManagers = new Set(["npm", "pnpm", "yarn", "bun"]);
  let packageManager = supportedManagers.has(declaredManager) ? declaredManager : null;
  if (!packageManager) {
    if (fs.existsSync(path.join(repo, "bun.lock")) || fs.existsSync(path.join(repo, "bun.lockb"))) {
      packageManager = "bun";
    } else if (fs.existsSync(path.join(repo, "pnpm-lock.yaml"))) {
      packageManager = "pnpm";
    } else if (fs.existsSync(path.join(repo, "yarn.lock"))) {
      packageManager = "yarn";
    } else {
      packageManager = "npm";
    }
  }
  return {
    name: typeof pkg.name === "string" ? pkg.name : path.basename(repo),
    version: typeof pkg.version === "string" ? pkg.version : null,
    scripts,
    packageManager,
  };
}

function scriptCommand(packageManager, script) {
  return `${packageManager} run ${script}`;
}

async function assertCleanGitRepository(repo) {
  const root = await run("git", ["rev-parse", "--show-toplevel"], repo);
  if (root.code !== 0) {
    throw new Error(`evaluate exige um repositório Git válido: ${root.stderr.trim()}`);
  }
  const status = await run("git", ["status", "--porcelain", "--untracked-files=all"], repo);
  if (status.code !== 0) {
    throw new Error(`Não foi possível verificar o estado do Git: ${status.stderr.trim()}`);
  }
  if (status.stdout.trim()) {
    throw new Error(
      `evaluate exige uma árvore Git limpa para poder reverter apenas as alterações da ferramenta. ` +
        `Arquivos pendentes:\n${status.stdout.trim()}`,
    );
  }
  return root.stdout.trim();
}

function projectScript(repo, packageManager, scripts, name) {
  if (typeof scripts[name] !== "string" || !scripts[name].trim()) {
    return {
      available: false,
      command: null,
      code: null,
      ms: null,
      stdout: "",
      stderr: "",
      error: `O package.json não define o script "${name}".`,
    };
  }
  return run(packageManager, ["run", name], repo).then((result) => ({
    ...result,
    available: true,
    command: scriptCommand(packageManager, name),
  }));
}

async function timeLint(repo, project) {
  if (!project.scripts.lint) {
    return { available: false, command: null, samples: [], averageMs: null, stdMs: null, ok: null, tail: "" };
  }
  const samples = [];
  let last = { stdout: "", stderr: "" };
  for (let i = 0; i < LINT_RUNS + 1; i += 1) {
    last = await projectScript(repo, project.packageManager, project.scripts, "lint");
    samples.push({ ms: last.ms, code: last.code });
  }
  const measured = samples.slice(1);
  const mean = measured.reduce((sum, sample) => sum + sample.ms, 0) / measured.length;
  const variance = measured.reduce((sum, sample) => sum + (sample.ms - mean) ** 2, 0) / (measured.length - 1);
  return {
    available: true,
    command: scriptCommand(project.packageManager, "lint"),
    samples,
    averageMs: Math.round(mean),
    stdMs: Math.round(Math.sqrt(variance)),
    ok: samples.every((sample) => sample.code === 0),
    error: last.error ?? null,
    tail: `${last.stdout}\n${last.stderr}${last.error ? `\n${last.error}` : ""}`,
  };
}

function readCoverage(summaryPath) {
  if (!fs.existsSync(summaryPath)) return null;
  const json = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
  const total = json.total ?? json;
  return {
    lines: total.lines?.pct ?? null,
    statements: total.statements?.pct ?? null,
    functions: total.functions?.pct ?? null,
    branches: total.branches?.pct ?? null,
  };
}

async function coverage(repo, outDir, label) {
  const bin = path.join(repo, "node_modules", "vitest", "vitest.mjs");
  if (!fs.existsSync(bin)) {
    return { available: false, reason: "Vitest não está instalado; cobertura não medida.", coverage: null };
  }
  const provider = ["v8", "istanbul"].find((name) =>
    fs.existsSync(path.join(repo, "node_modules", "@vitest", `coverage-${name}`, "package.json")),
  );
  if (!provider) {
    return { available: false, reason: "Provedor de cobertura do Vitest não encontrado; cobertura não medida.", coverage: null };
  }

  const reportsDir = path.join(outDir, `coverage-${label}`);
  fs.mkdirSync(reportsDir, { recursive: true });
  const result = await run(process.execPath, [
    bin,
    "run",
    "--coverage.enabled",
    `--coverage.provider=${provider}`,
    "--coverage.reporter=json-summary",
    "--coverage.reportOnFailure",
    `--coverage.reportsDirectory=${reportsDir}`,
  ], repo);
  const output = `${result.stdout}\n${result.stderr}`;
  let measured = null;
  let error;
  try {
    measured = readCoverage(path.join(reportsDir, "coverage-summary.json"));
  } catch (caught) {
    error = caught.message;
  }
  return {
    available: measured !== null,
    command: `${process.execPath} ${path.relative(repo, bin)} run --coverage.enabled`,
    code: result.code,
    ms: result.ms,
    coverage: measured,
    log: output,
    error: result.error ?? null,
    reason: measured ? null : result.error ?? error ?? "O Vitest não produziu coverage-summary.json.",
  };
}

function applySafe(repo, options) {
  let report = auditRepo(repo, options);
  const notes = [];
  notes.push(...applyDelegationToFiles(report.product));
  report = auditRepo(repo, options);
  notes.push(...applyConsolidationToFiles(report.product));
  report = auditRepo(repo, options);
  notes.push(...applyExtractionToFiles(report.product, report.clones.map((clone) => clone.ranges)));
  report = auditRepo(repo, options);
  notes.push(...applyDeadToFiles(report.product, report.dead));
  return notes;
}

function saveReport(outDir, result) {
  fs.writeFileSync(path.join(outDir, "avaliacao.json"), JSON.stringify(result, null, 2));
  fs.writeFileSync(path.join(outDir, "RELATORIO.md"), renderEvaluation(result));
}

function captureProduct(repo, report) {
  return new Map(report.product.map((file) => [file.abs, fs.readFileSync(file.abs)]));
}

function restoreProduct(snapshot, notes) {
  for (const [file, contents] of snapshot) fs.writeFileSync(file, contents);
  for (const file of new Set(notes.map((note) => note.createdAbs).filter(Boolean))) {
    if (!snapshot.has(file)) fs.rmSync(file, { force: true });
  }
}

async function gitDiff(repo, notes) {
  const diff = await run("git", ["diff", "--binary"], repo);
  if (diff.code !== 0) throw new Error(`Não foi possível gerar o diff: ${diff.stderr.trim()}`);
  const added = [];
  for (const file of new Set(notes.map((note) => note.createdAbs).filter(Boolean))) {
    const relative = path.relative(repo, file);
    const nullFile = process.platform === "win32" ? "NUL" : "/dev/null";
    const created = await run("git", ["diff", "--no-index", "--binary", "--", nullFile, relative], repo);
    if (created.code !== 0 && created.code !== 1) {
      throw new Error(`Não foi possível incluir o arquivo criado no diff: ${created.stderr.trim()}`);
    }
    added.push(created.stdout);
  }
  return [diff.stdout, ...added].filter(Boolean).join("\n");
}

function writeTestLog(outDir, label, test) {
  if (test?.available) {
    fs.writeFileSync(
      path.join(outDir, `testes-${label}.log`),
      `${test.stdout}\n${test.stderr}${test.error ? `\n${test.error}` : ""}`,
    );
  }
  if (test?.coverage?.log) {
    fs.writeFileSync(
      path.join(outDir, `cobertura-${label}.log`),
      `${test.coverage.log}${test.coverage.error ? `\n${test.coverage.error}` : ""}`,
    );
  }
}

function evaluationResult({ repo, project, commit, before, after = null, testsBefore, testsAfter = null, lintBefore, lintAfter = null, notes = [], internalExports = [], reverted = false, status, reason = null }) {
  return {
    repo,
    project: { name: project.name, version: project.version, packageManager: project.packageManager },
    commit,
    status,
    reason,
    reverted,
    internalExports,
    alterations: notes.map(({ createdAbs, ...rest }) => rest),
    before: before.metrics,
    after: after?.metrics ?? null,
    lint: { before: lintBefore, after: lintAfter },
    tests: {
      before: {
        command: testsBefore.command,
        code: testsBefore.code,
        ms: testsBefore.ms,
        error: testsBefore.error ?? null,
        coverage: testsBefore.coverage?.coverage ?? null,
        coverageReason: testsBefore.coverage?.reason ?? null,
      },
      after: testsAfter
        ? {
            command: testsAfter.command,
            code: testsAfter.code,
            ms: testsAfter.ms,
            error: testsAfter.error ?? null,
            coverage: testsAfter.coverage?.coverage ?? null,
            coverageReason: testsAfter.coverage?.reason ?? null,
          }
        : null,
    },
  };
}

export async function evaluateRepo(options) {
  const repo = path.resolve(options.repo);
  const outDir = path.resolve(options.out);
  const root = await assertCleanGitRepository(repo);
  if (path.resolve(root) !== repo) {
    throw new Error(`--repo precisa apontar para a raiz do repositório Git: ${root}`);
  }
  const project = readProject(repo);
  const scanOptions = {
    minTokens: options.minTokens,
    minLines: options.minLines,
    minEntropy: options.minEntropy,
    internalExports: options.internalExports ?? [],
  };
  fs.mkdirSync(outDir, { recursive: true });

  console.error("métricas antes");
  const before = auditRepo(repo, scanOptions);
  fs.writeFileSync(path.join(outDir, "antes.json"), JSON.stringify(serializable(before), null, 2));
  fs.writeFileSync(path.join(outDir, "antes.txt"), renderReport(before));
  const commitResult = await run("git", ["rev-parse", "--short", "HEAD"], repo);
  const commit = commitResult.code === 0 ? commitResult.stdout.trim() : null;

  console.error("lint antes");
  const lintBefore = await timeLint(repo, project);
  if (lintBefore.available) fs.writeFileSync(path.join(outDir, "lint-antes.log"), lintBefore.tail);
  console.error("testes antes");
  const testsBefore = await projectScript(repo, project.packageManager, project.scripts, "test");
  testsBefore.coverage = testsBefore.code === 0 ? await coverage(repo, outDir, "antes") : null;
  writeTestLog(outDir, "antes", testsBefore);

  const baselineReasons = [];
  if (!testsBefore.available) {
    baselineReasons.push(testsBefore.error);
  } else if (testsBefore.code !== 0) {
    baselineReasons.push(testsBefore.error ?? "O script de testes falhou antes das refatorações.");
  }
  if (lintBefore.available && !lintBefore.ok) {
    baselineReasons.push(lintBefore.error ?? "O script de lint falhou antes das refatorações.");
  }
  if (baselineReasons.length) {
    const reason = `${baselineReasons.join(" ")} Nada foi alterado.`;
    const result = evaluationResult({
      repo, project, commit, before, testsBefore, lintBefore,
      internalExports: scanOptions.internalExports, status: "aborted", reason,
    });
    saveReport(outDir, result);
    process.exitCode = 1;
    console.error(`Avaliação abortada: ${reason}`);
    return;
  }

  const snapshot = captureProduct(repo, before);
  console.error("aplicar");
  const notes = applySafe(repo, scanOptions);
  const after = auditRepo(repo, scanOptions);
  fs.writeFileSync(path.join(outDir, "depois.json"), JSON.stringify(serializable(after), null, 2));
  fs.writeFileSync(path.join(outDir, "depois.txt"), renderReport(after));
  const diff = await gitDiff(repo, notes);

  console.error("lint depois");
  const lintAfter = lintBefore.available ? await timeLint(repo, project) : lintBefore;
  if (lintAfter.available) {
    fs.writeFileSync(path.join(outDir, "lint-depois.log"), lintAfter.tail);
  }
  console.error("testes depois");
  const testsAfter = await projectScript(repo, project.packageManager, project.scripts, "test");
  testsAfter.coverage = testsAfter.code === 0 ? await coverage(repo, outDir, "depois") : null;
  writeTestLog(outDir, "depois", testsAfter);

  const testsBroke = testsAfter.code !== 0;
  const lintBroke = lintBefore.available && lintBefore.ok && !lintAfter.ok;
  const reverted = testsBroke || lintBroke;
  if (reverted) restoreProduct(snapshot, notes);
  fs.writeFileSync(path.join(outDir, "alteracoes.diff"), diff);
  fs.writeFileSync(path.join(outDir, "alteracoes.json"), JSON.stringify(notes.map(({ createdAbs, ...rest }) => rest), null, 2));

  const result = evaluationResult({
    repo, project, commit, before, after, testsBefore, testsAfter, lintBefore, lintAfter,
    notes, internalExports: scanOptions.internalExports, reverted, status: reverted ? "reverted" : "completed",
    reason: testsBroke ? "Os testes falharam depois das refatorações." : lintBroke ? "O lint falhou depois das refatorações." : null,
  });
  saveReport(outDir, result);
  console.log(JSON.stringify({
    status: result.status,
    before: result.before,
    after: result.after,
    lint: result.lint,
    tests: result.tests,
    alterations: notes.length,
  }, null, 2));
}

export function renderEvaluation(result) {
  const value = (metric, after = false) => {
    const metrics = after ? result.after : result.before;
    return metrics?.[metric] ?? "—";
  };
  const percent = (side) => side?.coverage?.lines ?? "não medida";
  const lint = (side) => typeof side?.averageMs === "number"
    ? `${side.averageMs} ± ${side.stdMs}`
    : "não configurado";
  const lintStatus = (side) => side?.ok === true
    ? "passou"
    : side?.ok === false
      ? "falhou"
      : side?.available === false
        ? "não configurado"
        : "não executado";
  const legacyVersion = typeof result.version === "string" ? result.version : null;
  const project = result.project ?? {
    name: legacyVersion?.replace(/\s+\d.*$/, "") ?? "projeto",
    version: legacyVersion?.match(/\s+(.+)$/)?.[1] ?? null,
    packageManager: null,
  };
  const version = project.version ? ` ${project.version}` : "";
  const testsBefore = result.tests?.before;
  const testsAfter = result.tests?.after;
  const coverageReason = testsBefore?.coverageReason ?? testsAfter?.coverageReason;
  const lintBefore = result.lint?.before ?? result.eslint?.before;
  const lintAfter = result.lint?.after ?? result.eslint?.after;

  return `# Avaliação de duplicação e código morto

Projeto: **${project.name}${version}**

- Repositório: \`${result.repo}\`
- Commit: ${result.commit ?? "não disponível"}
- Gerenciador de pacotes: ${project.packageManager ?? "não identificado"}
- Estado da avaliação: ${result.status}
${result.reason ? `- Motivo: ${result.reason}\n` : ""}
## Métricas

| | Antes | Depois |
| --- | ---: | ---: |
| Linhas de código | ${value("loc")} | ${value("loc", true)} |
| Índice de manutenibilidade | ${value("maintainabilityIndex")} | ${value("maintainabilityIndex", true)} |
| Linhas duplicadas | ${value("duplicatedLines")} | ${value("duplicatedLines", true)} |
| Classes de clones | ${value("clonePairs")} | ${value("clonePairs", true)} |
| Estruturas repetitivas (não contadas) | ${value("repetitiveBlocks")} | ${value("repetitiveBlocks", true)} |
| Densidade de duplicação | ${value("duplicationDensity")} | ${value("duplicationDensity", true)} |
| Símbolos mortos | ${value("deadSymbols")} | ${value("deadSymbols", true)} |
| Instruções inalcançáveis | ${value("unreachableStatements")} | ${value("unreachableStatements", true)} |
| Dívida estimada (min) | ${value("debtMinutes")} | ${value("debtMinutes", true)} |
| Cobertura de linhas (%) | ${percent(testsBefore)} | ${percent(testsAfter)} |
| Tempo médio do lint (ms) | ${lint(lintBefore)} | ${lint(lintAfter)} |

## Verificações

- Testes antes: \`${testsBefore?.command ?? "não disponível"}\` — código ${testsBefore?.code ?? "não executado"}.
- Testes depois: \`${testsAfter?.command ?? "não executado"}\` — código ${testsAfter?.code ?? "não executado"}.
- Erro de execução dos testes: ${testsBefore?.error ?? testsAfter?.error ?? "nenhum"}.
- Lint antes: \`${lintBefore?.command ?? "não configurado"}\` — ${lintStatus(lintBefore)}.
- Lint depois: \`${lintAfter?.command ?? "não executado"}\` — ${lintStatus(lintAfter)}.
- Erro de execução do lint: ${lintBefore?.error ?? lintAfter?.error ?? "nenhum"}.
- Alterações aplicadas: ${result.alterations?.length ?? 0}.
- Alterações revertidas após falha: ${result.reverted ? "sim" : "não"}.
${result.internalExports?.length ? `- Exports declarados internos: ${result.internalExports.join(", ")}.\n` : ""}
${coverageReason ? `\nCobertura: ${coverageReason}\n` : ""}
A avaliação executa os scripts \`test\` e, quando definido, \`lint\` no \`package.json\`. A cobertura é medida automaticamente apenas quando o Vitest e um provedor V8/Istanbul compatível estão instalados; em outros casos, aparece como “não medida”. Os arquivos de log dos testes e do lint ficam junto aos relatórios.
`;
}
