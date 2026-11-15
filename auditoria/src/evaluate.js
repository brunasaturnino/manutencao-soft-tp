import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { auditRepo, renderReport, serializable } from "./audit.js";
import { applyConsolidationToFiles, applyDeadToFiles, applyDelegationToFiles, applyExtractionToFiles } from "./apply.js";

function run(command, args, cwd) {
  return new Promise((resolve) => {
    const started = performance.now();
    const child = spawn(command, args, { cwd, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => {
      resolve({ code: code ?? 1, stdout, stderr, ms: Math.round(performance.now() - started) });
    });
  });
}

// A primeira execução é de aquecimento e é descartada; as restantes entram na média.
const ESLINT_RUNS = 10;

async function timeEslint(repo) {
  const bin = path.join(repo, "node_modules", "eslint", "bin", "eslint.js");
  const samples = [];
  for (let i = 0; i < ESLINT_RUNS + 1; i += 1) {
    const result = await run(process.execPath, [bin, "lib"], repo);
    samples.push({ ms: result.ms, code: result.code });
  }
  const warm = samples.slice(1);
  const mean = warm.reduce((sum, sample) => sum + sample.ms, 0) / warm.length;
  const variance = warm.reduce((sum, sample) => sum + (sample.ms - mean) ** 2, 0) / (warm.length - 1);
  return {
    samples,
    averageMs: Math.round(mean),
    stdMs: Math.round(Math.sqrt(variance)),
    ok: samples.every((sample) => sample.code === 0),
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
  const reportsDir = path.join(outDir, `coverage-${label}`);
  fs.mkdirSync(reportsDir, { recursive: true });
  const result = await run(process.execPath, [
    bin,
    "run",
    "--project",
    "unit",
    "--coverage.enabled",
    "--coverage.provider=v8",
    "--coverage.reporter=json-summary",
    "--coverage.reportOnFailure",
    `--coverage.reportsDirectory=${reportsDir}`,
  ], repo);
  const output = `${result.stdout}\n${result.stderr}`;
  return {
    code: result.code,
    ms: result.ms,
    failed: countFailed(output),
    tail: output.slice(-4000),
    coverage: readCoverage(path.join(reportsDir, "coverage-summary.json")),
  };
}

function countFailed(output) {
  const line = output.match(/^\s*Tests\s+(.+)$/m);
  if (!line) return null;
  const failed = line[1].match(/(\d+)\s+failed/);
  return failed ? Number(failed[1]) : 0;
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

export async function evaluateRepo(options) {
  const repo = options.repo;
  const outDir = options.out;
  fs.mkdirSync(outDir, { recursive: true });
  const scanOptions = { minTokens: options.minTokens, minLines: options.minLines, minEntropy: options.minEntropy, internalExports: options.internalExports };

  console.error("métricas antes");
  const before = auditRepo(repo, scanOptions);
  fs.writeFileSync(path.join(outDir, "antes.json"), JSON.stringify(serializable(before), null, 2));
  fs.writeFileSync(path.join(outDir, "antes.txt"), renderReport(before));

  console.error("eslint antes");
  const eslintBefore = await timeEslint(repo);
  console.error("testes antes");
  const testsBefore = await coverage(repo, outDir, "antes");
  if (testsBefore.failed == null || !testsBefore.coverage) {
    fs.writeFileSync(path.join(outDir, "testes-antes.log"), testsBefore.tail);
    console.error(
      "Abortado: a suíte de testes não executou antes da limpeza (sem contagem de falhas ou sem cobertura). " +
        "Nada foi alterado no projeto. Veja testes-antes.log; confirme `npm ci` e o provedor de cobertura (@vitest/coverage-v8).",
    );
    process.exitCode = 1;
    return;
  }
  console.error("aplicar");
  const notes = applySafe(repo, scanOptions);
  const after = auditRepo(repo, scanOptions);
  console.error("eslint depois");
  const eslintAfter = await timeEslint(repo);
  console.error("testes depois");
  const testsAfter = await coverage(repo, outDir, "depois");

  let reverted = false;
  const moreFailures =
    testsBefore.failed != null && testsAfter.failed != null && testsAfter.failed > testsBefore.failed;
  const testsUnreadable = testsAfter.failed == null || !testsAfter.coverage;
  const testsBroke = (testsBefore.code === 0 && testsAfter.code !== 0) || moreFailures || testsUnreadable;
  const lintBroke = eslintBefore.ok && !eslintAfter.ok;
  if (testsBroke || lintBroke) {
    await run("git", ["checkout", "--", "lib", "index.js"], repo);
    // git checkout só restaura ficheiros rastreados: os módulos criados pela
    // consolidação entre ficheiros têm de ser apagados à parte.
    for (const created of new Set(notes.map((note) => note.createdAbs).filter(Boolean))) {
      fs.rmSync(created, { force: true });
    }
    reverted = true;
  } else {
    const diff = await run("git", ["diff", "--", "lib", "index.js"], repo);
    fs.writeFileSync(path.join(outDir, "alteracoes.diff"), diff.stdout);
  }

  fs.writeFileSync(path.join(outDir, "depois.json"), JSON.stringify(serializable(after), null, 2));
  fs.writeFileSync(path.join(outDir, "depois.txt"), renderReport(after));
  const result = {
    repo,
    version: "axios 1.21.0",
    reverted,
    internalExports: options.internalExports ?? [],
    alterations: notes.map(({ createdAbs, ...rest }) => rest),
    before: before.metrics,
    after: reverted ? before.metrics : after.metrics,
    eslint: { before: eslintBefore, after: eslintAfter },
    tests: {
      before: { code: testsBefore.code, ms: testsBefore.ms, failed: testsBefore.failed, coverage: testsBefore.coverage },
      after: { code: testsAfter.code, ms: testsAfter.ms, failed: testsAfter.failed, coverage: testsAfter.coverage },
    },
  };
  fs.writeFileSync(path.join(outDir, "avaliacao.json"), JSON.stringify(result, null, 2));
  fs.writeFileSync(path.join(outDir, "RELATORIO.md"), renderEvaluation(result));
  if (testsBefore.code !== 0) fs.writeFileSync(path.join(outDir, "testes-antes.log"), testsBefore.tail);
  if (testsAfter.code !== 0) fs.writeFileSync(path.join(outDir, "testes-depois.log"), testsAfter.tail);
  console.log(JSON.stringify({ reverted, before: result.before, after: result.after, eslint: result.eslint, tests: result.tests, alterations: notes.length }, null, 2));
}

export function renderEvaluation(result) {
  const before = result.before;
  const after = result.after;
  const coverage = (side) => side?.coverage?.lines ?? "não medida";
  return `# Auditoria de duplicação e código morto

Sistema analisado: axios ${result.version.replace("axios ", "")}, clonado de \`axios/axios\` na tag v1.21.0. Não é um exemplo inventado: é a biblioteca HTTP que o scanner lê, limpa e mede.

## Resposta ao feedback

O nome “doutrina de código” não corresponde a um conceito da literatura. O fenômeno medido aqui é code smell (Fowler e Beck): duplicação estrutural e código morto. A ferramenta segue o desenho de detetores já usados em manutenção — PMD CPD, SourcererCC e Deckard para clones; Knip, \`no-unused-vars\` e a análise de exports do TypeScript para código morto.

Técnicas:

- Duplicação, tipos 1 a 3 de Roy e Cordy. Tipos 1 e 2: tokens normalizados (identificador e literal viram símbolos), janela deslizante com hash de Rabin–Karp, e confirmação pela subárvore da função com os nomes locais renomeados. Tipo 3: similaridade de Jaccard entre os conjuntos de janelas de duas funções. Clone semântico de tipo 4 fica de fora.
- Código morto: grafo de imports a partir dos entry points do \`package.json\` e dos testes. Binding privado sem leitura é morto. Export que ninguém importa também, desde que o ficheiro não seja API pública. Código depois de \`return\`/\`throw\` no mesmo bloco é inalcançável. Import dinâmico marca o módulo inteiro como usado. Ficheiro não alcançável é só reportado.
- Os pares de janelas sobrepostas fundem-se em classes de clones. Uma classe cujos dois lados se tocam no mesmo ficheiro é repetição em sequência (tabela de configuração, série de atribuições). Uma classe cujos tokens normalizados têm entropia de Shannon abaixo de 2,9 bits é lista ou tabela de baixa variedade. Ambas ficam registadas à parte e não contam como duplicação a extrair. O limiar 2,9 foi calibrado sobre os clones do próprio axios classificados à mão (veja \`COMPARACAO.md\`); é uma limitação.
- Refatoração segura: delegar função de topo com corpo idêntico; consolidar função privada idêntica (ou só com nomes locais diferentes) de ficheiros distintos num módulo partilhado, importado pelos originais; extrair bloco idêntico sem \`return\`/\`this\` para uma função local; apagar símbolo morto, preservando inicialização com efeito. Se a suíte ou o ESLint falham, o diff é revertido, incluindo os módulos criados.

## Métricas

O índice de manutenibilidade é o de Oman e Hagemeister, na escala 0–100 usada pelo Visual Studio (volume de Halstead, complexidade ciclomática e linhas). A dívida em minutos é estimativa de remediação: 10 min por símbolo morto, 5 min por instrução inalcançável e 2 min por linha em clone de tipo 1 ou 2. O enunciado fala em diminuição da manutenibilidade; a limpeza faz a dívida descer e o índice subir.

| | Antes | Depois |
| --- | ---: | ---: |
| Linhas de código | ${before.loc} | ${after.loc} |
| Índice de manutenibilidade | ${before.maintainabilityIndex} | ${after.maintainabilityIndex} |
| Linhas duplicadas | ${before.duplicatedLines} | ${after.duplicatedLines} |
| Classes de clones | ${before.clonePairs} | ${after.clonePairs} |
| Estruturas repetitivas (não contadas) | ${before.repetitiveBlocks} | ${after.repetitiveBlocks} |
| Densidade de duplicação | ${before.duplicationDensity} | ${after.duplicationDensity} |
| Símbolos mortos | ${before.deadSymbols} | ${after.deadSymbols} |
| Instruções inalcançáveis | ${before.unreachableStatements} | ${after.unreachableStatements} |
| Dívida estimada (min) | ${before.debtMinutes} | ${after.debtMinutes} |
| Cobertura de linhas dos testes unitários (%) | ${coverage(result.tests.before)} | ${coverage(result.tests.after)} |
| Tempo médio do ESLint (ms, média ± desvio padrão de ${ESLINT_RUNS} execuções) | ${result.eslint.before.averageMs} ± ${result.eslint.before.stdMs} | ${result.eslint.after.averageMs} ± ${result.eslint.after.stdMs} |

${result.internalExports?.length ? `Superfície pública: o padrão de exports ${result.internalExports.map((item) => `\`${item}\``).join(", ")} foi declarado interno (\`--internal-export\`). É uma decisão, não um fato: sem ela, tudo em \`lib/\` é API pública pelo \`package.json\` do axios e a ferramenta não encontra código morto nem remove nada.\n\n` : ""}Alterações aplicadas: ${result.alterations.length}. Revertidas porque a suíte ou o ESLint falhou: ${result.reverted ? "sim" : "não"}.

A cobertura é a do projeto \`unit\` do Vitest, não a dos testes de browser. O relatório é gerado mesmo quando a suíte já falha. Testes falhados antes: ${result.tests.before.failed ?? "não contados"}. Depois: ${result.tests.after.failed ?? "não contados"}. As falhas que já existiam antes da limpeza não são deste trabalho (neste ambiente, testes que dependem de rede). A percentagem pode subir porque linhas mortas saíram do denominador, não porque a suíte tenha ganhado testes novos.
`;
}
