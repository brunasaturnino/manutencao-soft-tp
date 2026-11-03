import fs from "node:fs";
import path from "node:path";
import { discoverProductFiles, discoverTestFiles, readPublicSurface, relPath } from "./files.js";
import { parseSource, tokenize, traverse } from "./parse.js";
import { analyzeDead } from "./dead.js";
import { findClones } from "./clones.js";
import { computeMetrics } from "./metrics.js";

function load(root, abs, withTokens) {
  const code = fs.readFileSync(abs, "utf8");
  const rel = relPath(root, abs);
  try {
    const ast = parseSource(code, abs);
    return { abs, rel, code, ast, tokens: withTokens ? tokenize(ast) : [] };
  } catch (error) {
    return { abs, rel, code, ast: null, tokens: [], error: error.message };
  }
}

export function auditRepo(root, options = {}) {
  root = path.resolve(root);
  const productPaths = discoverProductFiles(root);
  const testPaths = discoverTestFiles(root);
  const product = productPaths.map((abs) => load(root, abs, true));
  const tests = testPaths.map((abs) => load(root, abs, false));
  const surface = readPublicSurface(root);
  const dead = analyzeDead(product, tests, surface);
  const clones = findClones(
    product.filter((file) => file.ast),
    options,
  );
  const metrics = computeMetrics(product, clones, dead, traverse);
  return {
    root,
    product,
    parseErrors: [...product, ...tests].filter((file) => file.error).map((file) => ({
      file: file.rel,
      message: file.error,
    })),
    dead,
    clones: clones.map((clone) => ({
      type: clone.type,
      tokens: clone.tokens,
      lines: clone.lines,
      similarity: clone.similarity,
      confirmedByAst: clone.confirmedByAst,
      detector: clone.detector,
      a: { file: clone.a.file, startLine: clone.a.startLine, endLine: clone.a.endLine },
      b: { file: clone.b.file, startLine: clone.b.startLine, endLine: clone.b.endLine },
      ranges: clone,
    })),
    metrics,
  };
}

export function renderReport(report) {
  const metrics = report.metrics;
  const lines = [
    `Ficheiros analisados: ${metrics.files}`,
    `Linhas de código: ${metrics.loc}`,
    `Complexidade ciclomática: ${metrics.cyclomaticComplexity}`,
    `Volume de Halstead: ${metrics.halsteadVolume}`,
    `Índice de manutenibilidade (0–100): ${metrics.maintainabilityIndex}`,
    `Linhas em clones de tipo 1 ou 2: ${metrics.duplicatedLines}`,
    `Densidade de duplicação: ${metrics.duplicationDensity}`,
    `Símbolos mortos: ${metrics.deadSymbols}`,
    `Instruções inalcançáveis: ${metrics.unreachableStatements}`,
    `Ficheiros não alcançáveis: ${metrics.deadFiles}`,
    `Pares de clones: ${metrics.clonePairs}`,
    `Dívida estimada de remediação: ${metrics.debtMinutes} min`,
    "",
    "Código morto e inalcançável:",
  ];
  const dead = report.dead.filter((item) => item.kind !== "unreachable" || item.removable);
  if (dead.length === 0) lines.push("  nenhum");
  for (const item of dead.slice(0, 80)) {
    lines.push(`  ${item.file}:${item.line}  ${item.name}  [${item.kind}]  ${item.reason}`);
  }
  if (dead.length > 80) lines.push(`  … ${dead.length - 80} achados omitidos`);
  lines.push("", "Duplicação:");
  if (report.clones.length === 0) lines.push("  nenhuma");
  for (const clone of report.clones.slice(0, 40)) {
    const ast = clone.confirmedByAst ? "AST" : "só tokens";
    lines.push(
      `  tipo ${clone.type}  ${clone.a.file}:${clone.a.startLine}-${clone.a.endLine}  ↔  ${clone.b.file}:${clone.b.startLine}-${clone.b.endLine}  (${clone.tokens} tokens, ${ast})`,
    );
  }
  if (report.clones.length > 40) lines.push(`  … ${report.clones.length - 40} pares omitidos`);
  if (report.parseErrors.length) {
    lines.push("", "Ficheiros não parseados:");
    for (const error of report.parseErrors) lines.push(`  ${error.file}: ${error.message}`);
  }
  return lines.join("\n");
}

export function serializable(report) {
  return {
    metrics: report.metrics,
    parseErrors: report.parseErrors,
    dead: report.dead.map(({ start, end, initStart, initEnd, importStart, importEnd, ...rest }) => rest),
    clones: report.clones.map(({ ranges, ...rest }) => rest),
  };
}
