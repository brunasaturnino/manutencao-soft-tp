import { traverse } from "./parse.js";

const MOD = (1n << 61n) - 1n;
const BASE = 257n;

function mod(value) {
  const reduced = value % MOD;
  return reduced >= 0n ? reduced : reduced + MOD;
}

function windowHashes(tokens, width) {
  const prefix = [0n];
  const pow = [1n];
  for (let i = 0; i < tokens.length; i += 1) {
    prefix.push(mod(prefix[i] * BASE + BigInt(tokens[i].normHash + 1)));
    pow.push(mod(pow[i] * BASE));
  }
  const hashes = [];
  for (let i = 0; i + width <= tokens.length; i += 1) {
    hashes.push(mod(prefix[i + width] - prefix[i] * pow[width]));
  }
  return hashes;
}

function sameNorms(left, leftIndex, right, rightIndex, length) {
  for (let i = 0; i < length; i += 1) {
    if (left[leftIndex + i].norm !== right[rightIndex + i].norm) return false;
  }
  return true;
}

function rawEqual(left, leftIndex, right, rightIndex, length) {
  for (let i = 0; i < length; i += 1) {
    if (left[leftIndex + i].raw !== right[rightIndex + i].raw) return false;
  }
  return true;
}

function longestRawRun(left, leftStart, right, rightStart, length) {
  let bestOffset = 0;
  let best = 0;
  let runOffset = 0;
  let run = 0;
  for (let i = 0; i < length; i += 1) {
    if (left[leftStart + i].raw === right[rightStart + i].raw) {
      if (run === 0) runOffset = i;
      run += 1;
      if (run > best) {
        best = run;
        bestOffset = runOffset;
      }
    } else {
      run = 0;
    }
  }
  return { offset: bestOffset, length: best };
}

function expand(left, i, right, j, sameFile) {
  const limit = sameFile ? Math.abs(i - j) : Number.POSITIVE_INFINITY;
  let back = 0;
  while (
    back < limit &&
    i - back > 0 &&
    j - back > 0 &&
    left[i - back - 1].norm === right[j - back - 1].norm
  ) {
    back += 1;
  }
  let forward = 0;
  const maxForward = Math.min(left.length - i, right.length - j, limit - back);
  while (forward < maxForward && left[i + forward].norm === right[j + forward].norm) forward += 1;
  return { startOffset: back, length: back + forward };
}

function rangeFrom(file, tokens, index, length) {
  const first = tokens[index];
  const last = tokens[index + length - 1];
  return {
    file: file.rel,
    abs: file.abs,
    start: first.start,
    end: last.end,
    startLine: first.line,
    endLine: last.endLine,
  };
}

function contains(outer, inner) {
  return outer.file === inner.file && outer.start <= inner.start && outer.end >= inner.end;
}

function overlaps(left, right) {
  return left.file === right.file && left.start < right.end && right.start < left.end;
}

function isBoilerplate(file, startLine, endLine) {
  const lines = file.code.split(/\r?\n/).slice(startLine - 1, endLine);
  const useful = lines.map((line) => line.trim()).filter((line) => line && !line.startsWith("//") && !line.startsWith("*") && line !== "/*");
  if (useful.length === 0) return true;
  const boring = useful.filter((line) => /^(import|export)\b/.test(line) || line === "'use strict';" || line === '"use strict";');
  return boring.length / useful.length >= 0.8;
}

function collectPatterns(pattern, into) {
  if (!pattern) return;
  if (pattern.type === "Identifier") into.add(pattern.name);
  else if (pattern.type === "RestElement") collectPatterns(pattern.argument, into);
  else if (pattern.type === "AssignmentPattern") collectPatterns(pattern.left, into);
  else if (pattern.type === "ArrayPattern") pattern.elements.forEach((el) => collectPatterns(el, into));
  else if (pattern.type === "ObjectPattern") {
    for (const prop of pattern.properties) {
      if (prop.type === "RestElement") collectPatterns(prop.argument, into);
      else collectPatterns(prop.value, into);
    }
  }
}

const CHILD_SKIP = new Set([
  "loc",
  "start",
  "end",
  "range",
  "extra",
  "leadingComments",
  "trailingComments",
  "innerComments",
  "tokens",
  "comments",
]);

function childNodes(node) {
  const children = [];
  for (const [key, value] of Object.entries(node)) {
    if (CHILD_SKIP.has(key)) continue;
    if (Array.isArray(value)) {
      for (const child of value) if (child?.type && typeof child.type === "string") children.push(child);
    } else if (value?.type && typeof value.type === "string") children.push(value);
  }
  return children;
}

function localsOf(fn) {
  const locals = new Set();
  if (fn.id?.name) locals.add(fn.id.name);
  for (const param of fn.params ?? []) collectPatterns(param, locals);
  const stack = [fn.body];
  const seen = new Set();
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node.type !== "string" || seen.has(node)) continue;
    seen.add(node);
    if (node.type === "FunctionDeclaration" && node.id) locals.add(node.id.name);
    if (node.type === "ClassDeclaration" && node.id) locals.add(node.id.name);
    if (node.type === "VariableDeclarator") collectPatterns(node.id, locals);
    if (node.type === "CatchClause" && node.param) collectPatterns(node.param, locals);
    stack.push(...childNodes(node));
  }
  return locals;
}

function isNamePosition(node, parent) {
  if (!parent) return true;
  if ((parent.type === "MemberExpression" || parent.type === "OptionalMemberExpression") && parent.property === node && !parent.computed) {
    return false;
  }
  if ((parent.type === "ObjectProperty" || parent.type === "ObjectMethod" || parent.type === "ClassMethod" || parent.type === "ClassProperty") && parent.key === node && !parent.computed) {
    return false;
  }
  if ((parent.type === "BreakStatement" || parent.type === "ContinueStatement" || parent.type === "LabeledStatement") && parent.label === node) {
    return false;
  }
  return true;
}

function structuralKey(fn) {
  const locals = localsOf(fn);
  const rename = new Map();
  const seen = new Set();
  let counter = 0;
  function rec(node, parent) {
    if (!node || typeof node.type !== "string" || seen.has(node)) return "";
    seen.add(node);
    if (node.type === "Identifier") {
      if (!isNamePosition(node, parent) || !locals.has(node.name)) return node.name;
      if (!rename.has(node.name)) {
        counter += 1;
        rename.set(node.name, `#${counter}`);
      }
      return rename.get(node.name);
    }
    if (node.type === "StringLiteral" || node.type === "NumericLiteral" || node.type === "BooleanLiteral") {
      return `${node.type}:${node.value}`;
    }
    if (node.type === "NullLiteral") return "null";
    return `${node.type}|${childNodes(node).map((child) => rec(child, node)).join(",")}`;
  }
  return rec(fn.body, fn);
}

function functionsOf(ast) {
  const fns = [];
  if (!ast) return fns;
  traverse(ast, {
    "FunctionDeclaration|FunctionExpression|ArrowFunctionExpression|ObjectMethod|ClassMethod"(p) {
      if (p.node.body) fns.push(p.node);
    },
  });
  return fns;
}

function functionTokens(file, fn) {
  return file.tokens.filter((token) => token.start >= fn.body.start && token.end <= fn.body.end);
}

function jaccard(left, right) {
  if (!left.size && !right.size) return 1;
  let inter = 0;
  const [small, large] = left.size < right.size ? [left, right] : [right, left];
  for (const value of small) if (large.has(value)) inter += 1;
  return inter / (left.size + right.size - inter);
}

/**
 * Duplicação pelos tipos 1–3 de Roy e Cordy.
 * Tipo 1 e 2: janela deslizante com hash de Rabin–Karp sobre tokens normalizados
 * (identificadores e literais viram símbolos), com confirmação pelo texto.
 * A confirmação estrutural compara a chave da subárvore da função, com locais renomeados.
 * Tipo 3: similaridade de Jaccard entre conjuntos de janelas de duas funções.
 */
export function findClones(files, options) {
  const minTokens = options.minTokens ?? 30;
  const minLines = options.minLines ?? 6;
  const width = Math.min(12, minTokens);
  const groups = new Map();

  for (const file of files) {
    if (!file.ast || file.tokens.length < width) continue;
    const hashes = windowHashes(file.tokens, width);
    for (let i = 0; i < hashes.length; i += 1) {
      const key = hashes[i].toString();
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ file, index: i });
    }
  }

  const pairs = [];
  for (const occurrences of groups.values()) {
    if (occurrences.length < 2 || occurrences.length > 40) continue;
    for (let a = 0; a < occurrences.length; a += 1) {
      for (let b = a + 1; b < occurrences.length; b += 1) {
        const left = occurrences[a];
        const right = occurrences[b];
        if (!sameNorms(left.file.tokens, left.index, right.file.tokens, right.index, width)) continue;
        const grown = expand(left.file.tokens, left.index, right.file.tokens, right.index, left.file === right.file);
        const length = grown.length;
        if (length < minTokens) continue;
        const leftStart = left.index - grown.startOffset;
        const rightStart = right.index - grown.startOffset;
        const aRange = rangeFrom(left.file, left.file.tokens, leftStart, length);
        const bRange = rangeFrom(right.file, right.file.tokens, rightStart, length);
        if (overlaps(aRange, bRange)) continue;
        const lines = Math.min(
          aRange.endLine - aRange.startLine + 1,
          bRange.endLine - bRange.startLine + 1,
        );
        if (lines < minLines) continue;
        if (isBoilerplate(left.file, aRange.startLine, aRange.endLine) || isBoilerplate(right.file, bRange.startLine, bRange.endLine)) {
          continue;
        }
        const type = rawEqual(left.file.tokens, leftStart, right.file.tokens, rightStart, length) ? 1 : 2;
        const [first, second] = aRange.file < bRange.file || (aRange.file === bRange.file && aRange.start <= bRange.start)
          ? [aRange, bRange]
          : [bRange, aRange];
        pairs.push({ type, tokens: length, lines, a: first, b: second, confirmedByAst: false, detector: "rabin-karp" });
        if (type === 2) {
          const raw = longestRawRun(left.file.tokens, leftStart, right.file.tokens, rightStart, length);
          if (raw.length >= minTokens) {
            const rawA = rangeFrom(left.file, left.file.tokens, leftStart + raw.offset, raw.length);
            const rawB = rangeFrom(right.file, right.file.tokens, rightStart + raw.offset, raw.length);
            const rawLines = Math.min(rawA.endLine - rawA.startLine + 1, rawB.endLine - rawB.startLine + 1);
            if (rawLines >= minLines && !overlaps(rawA, rawB)) {
              const [rawFirst, rawSecond] = rawA.file < rawB.file || (rawA.file === rawB.file && rawA.start <= rawB.start)
                ? [rawA, rawB]
                : [rawB, rawA];
              pairs.push({
                type: 1,
                tokens: raw.length,
                lines: rawLines,
                a: rawFirst,
                b: rawSecond,
                confirmedByAst: false,
                detector: "rabin-karp",
              });
            }
          }
        }
      }
    }
  }

  pairs.sort((left, right) => right.tokens - left.tokens);
  const kept = [];
  for (const pair of pairs) {
    const dominated = kept.some((other) => {
      const covers =
        (contains(other.a, pair.a) && contains(other.b, pair.b)) ||
        (contains(other.a, pair.b) && contains(other.b, pair.a));
      if (!covers) return false;
      return !(pair.type === 1 && other.type !== 1);
    });
    if (!dominated) kept.push(pair);
  }

  const fnByFile = new Map(files.map((file) => [file.rel, functionsOf(file.ast)]));
  for (const pair of kept) {
    const leftFn = (fnByFile.get(pair.a.file) ?? []).find((fn) => fn.start <= pair.a.start && fn.end >= pair.a.end);
    const rightFn = (fnByFile.get(pair.b.file) ?? []).find((fn) => fn.start <= pair.b.start && fn.end >= pair.b.end);
    if (leftFn && rightFn && structuralKey(leftFn) === structuralKey(rightFn) && structuralKey(leftFn).length > 0) {
      pair.confirmedByAst = true;
    }
  }

  const seenType3 = new Set(kept.map((pair) => `${pair.a.file}:${pair.a.startLine}:${pair.b.file}:${pair.b.startLine}`));
  const functionUnits = [];
  for (const file of files) {
    if (!file.ast) continue;
    for (const fn of functionsOf(file.ast)) {
      const tokens = functionTokens(file, fn);
      if (tokens.length < Math.max(minTokens, 40)) continue;
      const hashes = new Set(windowHashes(tokens, width).map((hash) => hash.toString()));
      functionUnits.push({
        file,
        fn,
        hashes,
        startLine: fn.loc?.start.line ?? 1,
        endLine: fn.loc?.end.line ?? 1,
      });
    }
  }
  for (let i = 0; i < functionUnits.length; i += 1) {
    for (let j = i + 1; j < functionUnits.length; j += 1) {
      const left = functionUnits[i];
      const right = functionUnits[j];
      if (left.fn.start < right.fn.end && right.fn.start < left.fn.end && left.file.rel === right.file.rel) continue;
      const score = jaccard(left.hashes, right.hashes);
      if (score < 0.75 || score > 0.97) continue;
      const key = `${left.file.rel}:${left.startLine}:${right.file.rel}:${right.startLine}`;
      if (seenType3.has(key)) continue;
      kept.push({
        type: 3,
        tokens: Math.min(left.hashes.size, right.hashes.size),
        lines: Math.min(left.endLine - left.startLine + 1, right.endLine - right.startLine + 1),
        similarity: Number(score.toFixed(2)),
        a: {
          file: left.file.rel,
          abs: left.file.abs,
          start: left.fn.start,
          end: left.fn.end,
          startLine: left.startLine,
          endLine: left.endLine,
        },
        b: {
          file: right.file.rel,
          abs: right.file.abs,
          start: right.fn.start,
          end: right.fn.end,
          startLine: right.startLine,
          endLine: right.endLine,
        },
        confirmedByAst: structuralKey(left.fn) === structuralKey(right.fn),
        detector: "jaccard-função",
      });
    }
  }

  const exact = kept.filter((clone) => clone.type !== 3);
  const near = kept
    .filter((clone) => clone.type === 3)
    .sort((left, right) => right.similarity - left.similarity)
    .slice(0, 40);
  return [...exact, ...near];
}
