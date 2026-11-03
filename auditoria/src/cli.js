#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { auditRepo, renderReport, serializable } from "./audit.js";
import { applyDeadToFiles, applyDelegationToFiles, applyExtractionToFiles } from "./apply.js";
import { evaluateRepo } from "./evaluate.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.resolve(here, "..", "..");

function args(argv) {
  const out = { repo: path.join(workspace, "alvos", "axios"), out: path.join(workspace, "resultados"), minTokens: 30, minLines: 6 };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === "--repo") out.repo = path.resolve(value);
    if (key === "--out") out.out = path.resolve(value);
    if (key === "--min-tokens") out.minTokens = Number(value);
    if (key === "--min-lines") out.minLines = Number(value);
    if (key.startsWith("--")) i += 1;
  }
  return out;
}

function writeReport(outDir, name, report) {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, `${name}.json`), JSON.stringify(serializable(report), null, 2));
  fs.writeFileSync(path.join(outDir, `${name}.txt`), renderReport(report));
}

const [command, ...rest] = process.argv.slice(2);
const options = args(rest);

if (!command || command === "help") {
  console.log("Uso: node src/cli.js scan|apply|evaluate --repo <pasta> --out <pasta>");
  process.exit(command ? 0 : 1);
}

if (command === "scan") {
  const report = auditRepo(options.repo, options);
  writeReport(options.out, "relatorio", report);
  console.log(renderReport(report));
} else if (command === "apply") {
  let report = auditRepo(options.repo, options);
  const notes = [
    ...applyDelegationToFiles(report.product),
    ...applyExtractionToFiles((report = auditRepo(options.repo, options)).product, report.clones.map((clone) => clone.ranges)),
    ...applyDeadToFiles((report = auditRepo(options.repo, options)).product, report.dead),
  ];
  report = auditRepo(options.repo, options);
  writeReport(options.out, "depois", report);
  fs.writeFileSync(path.join(options.out, "alteracoes.json"), JSON.stringify(notes, null, 2));
  console.log(renderReport(report));
  console.log(`\nAlterações: ${notes.length}`);
} else if (command === "evaluate") {
  await evaluateRepo(options);
} else {
  console.error(`Comando desconhecido: ${command}`);
  process.exit(1);
}
