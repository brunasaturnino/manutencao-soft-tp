#!/usr/bin/env node
/**
 * Gabarito por injeção de clones.
 *
 * Copia lib/ do projeto alvo para uma pasta nova, injeta clones conhecidos de
 * funções reais (tipo 1: cópia exata; tipo 2: nomes locais e literais trocados;
 * tipo 3: cópia com 10, 20 ou 30 % das instruções removidas ou acrescentadas)
 * e mede quantos a ferramenta encontra. Como a injeção é conhecida, mede a
 * revocação, que a revisão manual de achados não consegue medir.
 *
 * Uso: node bench/gabarito.js --repo <projeto> --work <pasta que não existe> --out <json> [--seed 1] [--jscpd]
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { auditRepo } from "../src/audit.js";
import { discoverProductFiles, relPath } from "../src/files.js";
import { parseSource, traverse } from "../src/parse.js";

const opts = { seed: 1, jscpd: false };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === "--jscpd") opts.jscpd = true;
  else if (argv[i].startsWith("--")) opts[argv[i].slice(2)] = argv[++i];
}
if (!opts.repo || !opts.work) {
  console.error("Uso: node bench/gabarito.js --repo <projeto> --work <pasta nova> --out <json> [--seed 1] [--jscpd]");
  process.exit(1);
}
const repo = path.resolve(opts.repo);
const work = path.resolve(opts.work);
if (fs.existsSync(work)) {
  console.error(`A pasta ${work} já existe; indique uma que não exista.`);
  process.exit(1);
}

function rng(seed) {
  let a = Number(seed) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function applyEdits(code, edits) {
  let out = code;
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  }
  return out;
}

// 1. Funções candidatas: declarações de topo com bloco de 10 a 60 linhas e pelo menos 4 instruções.
const candidates = [];
for (const abs of discoverProductFiles(repo)) {
  const code = fs.readFileSync(abs, "utf8");
  let ast;
  try {
    ast = parseSource(code, abs);
  } catch {
    continue;
  }
  traverse(ast, {
    Program(programPath) {
      for (const statementPath of programPath.get("body")) {
        const node = statementPath.node;
        let fn = null;
        let id = null;
        if (node.type === "FunctionDeclaration" && node.id) {
          fn = node;
          id = node.id;
        } else if (
          node.type === "VariableDeclaration" &&
          node.declarations.length === 1 &&
          node.declarations[0].id.type === "Identifier" &&
          ["ArrowFunctionExpression", "FunctionExpression"].includes(node.declarations[0].init?.type)
        ) {
          fn = node.declarations[0].init;
          id = node.declarations[0].id;
        }
        if (!fn || fn.body.type !== "BlockStatement" || fn.body.body.length < 4) continue;
        const lines = node.loc.end.line - node.loc.start.line + 1;
        if (lines < 10 || lines > 60) continue;
        candidates.push({ abs, rel: relPath(repo, abs), code, statementPath, node, fn, id, lines });
      }
    },
  });
}
candidates.sort((a, b) => `${a.rel}:${a.node.start}`.localeCompare(`${b.rel}:${b.node.start}`));
const random = rng(opts.seed);
for (let i = candidates.length - 1; i > 0; i -= 1) {
  const j = Math.floor(random() * (i + 1));
  [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
}

const plan = [
  ...Array.from({ length: 10 }, () => ({ type: 1, level: 0 })),
  ...Array.from({ length: 15 }, () => ({ type: 2, level: 0 })),
  ...[0.1, 0.2, 0.3].flatMap((level) => Array.from({ length: 5 }, () => ({ type: 3, level }))),
];
if (candidates.length < plan.length) {
  console.error(`Só há ${candidates.length} funções candidatas; preciso de ${plan.length}.`);
  process.exit(1);
}

function localRenames(candidate) {
  const names = new Map();
  const edits = [];
  candidate.statementPath.traverse({
    Identifier(p) {
      const binding = p.scope.getBinding(p.node.name);
      if (!binding || binding.path === candidate.statementPath) return;
      if (!binding.path.findParent((up) => up === candidate.statementPath)) return;
      const parent = p.parent;
      if ((parent.type === "MemberExpression" || parent.type === "OptionalMemberExpression") && parent.property === p.node && !parent.computed) return;
      if (["ObjectProperty", "ObjectMethod", "ClassMethod", "ClassProperty"].includes(parent.type) && parent.key === p.node && !parent.computed) return;
      if (!names.has(p.node.name)) names.set(p.node.name, `v${names.size + 1}`);
      edits.push({ start: p.node.start, end: p.node.end, text: names.get(p.node.name) });
    },
    StringLiteral(p) {
      const raw = p.node.extra?.raw;
      if (!raw || p.parent.type === "ImportDeclaration") return;
      edits.push({ start: p.node.start, end: p.node.end, text: `${raw[0]}${raw.slice(1, -1)}B${raw[0]}` });
    },
    NumericLiteral(p) {
      edits.push({ start: p.node.start, end: p.node.end, text: String(p.node.value + 7) });
    },
  });
  return edits;
}

const truth = [];
fs.mkdirSync(path.join(work, "lib", "_bench"), { recursive: true });
for (const name of ["lib", "index.js", "package.json"]) {
  const from = path.join(repo, name);
  if (fs.existsSync(from)) fs.cpSync(from, path.join(work, name), { recursive: true, filter: (src) => !src.includes("node_modules") });
}
let cursor = 0;
for (const [index, item] of plan.entries()) {
  const candidate = candidates[cursor];
  cursor += 1;
  const base = candidate.node.start;
  const rel = (n) => n - base;
  const text = candidate.code.slice(base, candidate.node.end);
  const copyName = `${candidate.id.name}Copy${index}`;
  let edits = [{ start: rel(candidate.id.start), end: rel(candidate.id.end), text: copyName }];
  if (item.type === 2) {
    edits = [
      ...edits,
      ...localRenames(candidate).map((e) => ({ ...e, start: rel(e.start), end: rel(e.end) })),
    ];
  }
  if (item.type === 3) {
    const statements = candidate.fn.body.body;
    const changes = Math.max(1, Math.round(item.level * statements.length));
    for (let k = 0; k < changes; k += 1) {
      const stmt = statements[Math.min(statements.length - 1, 1 + Math.floor((k * statements.length) / changes))];
      if (k % 2 === 0) edits.push({ start: rel(stmt.start), end: rel(stmt.end), text: "" });
      else edits.push({ start: rel(stmt.end), end: rel(stmt.end), text: `\n  console.log('bench ${index}', ${k});` });
    }
  }
  // remove edições sobrepostas (mantém a primeira de cada região)
  edits.sort((a, b) => a.start - b.start || b.end - a.end);
  const clean = [];
  for (const edit of edits) {
    const last = clean.at(-1);
    if (!last || edit.start >= last.end) clean.push(edit);
  }
  const injected = applyEdits(text, clean) + "\n";
  const file = `lib/_bench/inj_${String(index).padStart(2, "0")}.js`;
  fs.writeFileSync(path.join(work, file), injected);
  truth.push({
    id: index,
    type: item.type,
    level: item.level,
    origin: candidate.rel,
    originStart: candidate.node.loc.start.line,
    originEnd: candidate.node.loc.end.line,
    file,
    injectedLines: injected.split("\n").length - 1,
  });
}

// Fração da função (intervalo f) coberta pelo trecho de clone (intervalo c).
function overlapRatio(cStart, cEnd, fStart, fEnd) {
  const inter = Math.min(cEnd, fEnd) - Math.max(cStart, fStart) + 1;
  return inter <= 0 ? 0 : inter / (fEnd - fStart + 1);
}

function matches(item, left, right) {
  const [inj, org] = left.file === item.file ? [left, right] : right.file === item.file ? [right, left] : [null, null];
  if (!inj || org.file !== item.origin) return false;
  return (
    overlapRatio(inj.startLine, inj.endLine, 1, item.injectedLines) >= 0.5 &&
    overlapRatio(org.startLine, org.endLine, item.originStart, item.originEnd) >= 0.5
  );
}

function evaluateTool(minEntropy) {
  const report = auditRepo(work, { minTokens: 30, minLines: 6, minEntropy });
  return truth.map((item) => {
    const hits = report.clones.filter((clone) => matches(item, clone.a, clone.b));
    return {
      id: item.id,
      found: hits.some((clone) => !clone.repetitive),
      filtered: hits.length > 0 && hits.every((clone) => clone.repetitive),
      types: [...new Set(hits.map((clone) => clone.type))],
    };
  });
}

function evaluateJscpd() {
  const out = path.join(path.dirname(work), `${path.basename(work)}-jscpd`);
  const run = spawnSync(
    "npx",
    ["--yes", "jscpd@5.4.3", "lib", "--min-tokens", "30", "--min-lines", "6", "--max-size", "5mb", "--max-lines", "100000", "--reporters", "json", "--output", out, "--silent"],
    // No Windows o npx é um .cmd, que o spawn só executa por meio do shell.
    { cwd: work, encoding: "utf8", shell: process.platform === "win32" },
  );
  const file = path.join(out, "jscpd-report.json");
  if (!fs.existsSync(file)) return { error: run.stderr.slice(-300) };
  const duplicates = JSON.parse(fs.readFileSync(file, "utf8")).duplicates;
  // Conforme a versão, o jscpd dá o nome relativo à pasta escaneada ("adapters/x.js") ou à raiz ("lib/adapters/x.js").
  const toRel = (name) => {
    const posix = name.split(path.sep).join("/");
    return fs.existsSync(path.join(work, posix)) ? posix : `lib/${posix}`;
  };
  const toSide = (side) => ({ file: toRel(side.name), startLine: side.startLoc.line, endLine: side.endLoc.line });
  return truth.map((item) => ({
    id: item.id,
    found: duplicates.some((clone) => matches(item, toSide(clone.firstFile), toSide(clone.secondFile))),
  }));
}

const results = {
  seed: Number(opts.seed),
  injetados: truth.length,
  ferramenta: evaluateTool(undefined),
  ferramentaSemFiltro: evaluateTool(0),
};
if (opts.jscpd) results.jscpd = evaluateJscpd();

const groups = [
  ["tipo 1 (cópia exata)", (t) => t.type === 1],
  ["tipo 2 (nomes e literais trocados)", (t) => t.type === 2],
  ["tipo 3 com 10 % de instruções alteradas", (t) => t.type === 3 && t.level === 0.1],
  ["tipo 3 com 20 % de instruções alteradas", (t) => t.type === 3 && t.level === 0.2],
  ["tipo 3 com 30 % de instruções alteradas", (t) => t.type === 3 && t.level === 0.3],
];
const summary = groups.map(([label, test]) => {
  const ids = truth.filter(test).map((t) => t.id);
  const count = (list) => list?.error ? null : list?.filter((r) => ids.includes(r.id) && r.found).length;
  return {
    grupo: label,
    injetados: ids.length,
    ferramenta: count(results.ferramenta),
    ferramentaSemFiltro: count(results.ferramentaSemFiltro),
    jscpd: results.jscpd ? count(results.jscpd) : undefined,
  };
});
results.resumo = summary;
results.verdade = truth;
console.log(["grupo".padEnd(44), "injetados", "ferramenta", "sem filtro", "jscpd"].join("  "));
for (const row of summary) {
  console.log([row.grupo.padEnd(44), String(row.injetados).padStart(9), String(row.ferramenta).padStart(10), String(row.ferramentaSemFiltro).padStart(10), String(row.jscpd ?? "-").padStart(5)].join("  "));
}
const total = (key) => summary.reduce((sum, row) => sum + (row[key] ?? 0), 0);
console.log(`total: ${truth.length} injetados | ferramenta ${total("ferramenta")} | sem filtro ${total("ferramentaSemFiltro")}${results.jscpd ? ` | jscpd ${total("jscpd")}` : ""}`);
if (opts.out) fs.writeFileSync(path.resolve(opts.out), JSON.stringify(results, null, 2));
