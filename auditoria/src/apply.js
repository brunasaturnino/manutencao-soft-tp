import fs from "node:fs";
import path from "node:path";
import { parseSource, traverse } from "./parse.js";

function applyEdits(code, edits) {
  const sorted = [...edits].sort((a, b) => b.start - a.start || b.end - a.end);
  let out = code;
  let cursor = out.length + 1;
  for (const edit of sorted) {
    if (edit.end > cursor) continue;
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
    cursor = edit.start;
  }
  return out;
}

function preferOuter(edits) {
  const kept = [];
  const ordered = [...edits].sort((a, b) => b.end - b.start - (a.end - a.start));
  for (const edit of ordered) {
    const inside = kept.some((other) => edit.start >= other.start && edit.end <= other.end);
    if (!inside) kept.push(edit);
  }
  return kept;
}

function lineStart(code, index) {
  let cursor = index;
  while (cursor > 0 && code[cursor - 1] !== "\n" && code[cursor - 1] !== "\r") cursor -= 1;
  return cursor;
}

function isNamePosition(node, parent) {
  if (!parent) return true;
  if (
    (parent.type === "MemberExpression" || parent.type === "OptionalMemberExpression") &&
    parent.property === node &&
    !parent.computed
  ) {
    return false;
  }
  if (
    (parent.type === "ObjectProperty" ||
      parent.type === "ObjectMethod" ||
      parent.type === "ClassMethod" ||
      parent.type === "ClassProperty") &&
    parent.key === node &&
    !parent.computed
  ) {
    return false;
  }
  if (
    (parent.type === "BreakStatement" || parent.type === "ContinueStatement" || parent.type === "LabeledStatement") &&
    parent.label === node
  ) {
    return false;
  }
  return true;
}

const WALK_SKIP = new Set([
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

function walk(node, parent, visit, seen = new Set()) {
  if (!node || typeof node.type !== "string" || seen.has(node)) return;
  seen.add(node);
  visit(node, parent);
  for (const [key, value] of Object.entries(node)) {
    if (WALK_SKIP.has(key)) continue;
    if (Array.isArray(value)) {
      for (const child of value) if (typeof child?.type === "string") walk(child, node, visit, seen);
    } else if (typeof value?.type === "string") walk(value, node, visit, seen);
  }
}

function hasControlTransfer(statements) {
  let bad = false;
  for (const statement of statements) {
    walk(statement, null, (node) => {
      if (
        node.type === "ReturnStatement" ||
        node.type === "ThrowStatement" ||
        node.type === "BreakStatement" ||
        node.type === "ContinueStatement" ||
        node.type === "YieldExpression" ||
        node.type === "ThisExpression" ||
        node.type === "Super" ||
        node.type === "AwaitExpression"
      ) {
        bad = true;
      }
    });
  }
  return bad;
}

function renderImport(specifiers, source) {
  const defaultSpec = specifiers.find((spec) => spec.type === "ImportDefaultSpecifier");
  const namespaceSpec = specifiers.find((spec) => spec.type === "ImportNamespaceSpecifier");
  const named = specifiers.filter((spec) => spec.type === "ImportSpecifier");
  const parts = [];
  if (defaultSpec) parts.push(defaultSpec.local.name);
  if (namespaceSpec) parts.push(`* as ${namespaceSpec.local.name}`);
  if (named.length) {
    const list = named
      .map((spec) => {
        const imported = spec.imported.type === "Identifier" ? spec.imported.name : spec.imported.value;
        return imported === spec.local.name ? imported : `${imported} as ${spec.local.name}`;
      })
      .join(", ");
    parts.push(`{ ${list} }`);
  }
  return `import ${parts.join(", ")} from ${JSON.stringify(source)};`;
}

function importEdits(code, ast) {
  const imports = [];
  traverse(ast, {
    ImportDeclaration(p) {
      imports.push(p);
    },
  });
  const edits = [];
  for (const p of imports) {
    const kept = [];
    let removed = 0;
    for (const spec of p.node.specifiers) {
      const binding = p.scope.getBinding(spec.local.name);
      if ((binding?.referencePaths ?? []).length === 0) removed += 1;
      else kept.push(spec);
    }
    if (removed === 0) continue;
    if (kept.length === 0) {
      let end = p.node.end;
      if (code[end] === "\r") end += 1;
      if (code[end] === "\n") end += 1;
      edits.push({ start: p.node.start, end, text: "" });
      continue;
    }
    edits.push({ start: p.node.start, end: p.node.end, text: renderImport(kept, p.node.source.value) });
  }
  return edits;
}

function forbiddenFunction(fn) {
  if (!fn?.id || fn.generator) return true;
  const paramsOk = fn.params.every(
    (param) => param.type === "Identifier" || (param.type === "RestElement" && param.argument.type === "Identifier"),
  );
  if (!paramsOk) return true;
  let bad = false;
  walk(fn.body, fn, (node, parent) => {
    if (node.type === "ThisExpression" || node.type === "Super") bad = true;
    if (node.type === "Identifier" && node.name === "arguments" && isNamePosition(node, parent)) bad = true;
    if (node.type === "Identifier" && node !== fn.id && node.name === fn.id.name && isNamePosition(node, parent)) bad = true;
  });
  return bad;
}

export function delegationEdits(code, ast, minStatements = 4) {
  const functions = [];
  for (const statement of ast.program.body) {
    if (statement.type === "FunctionDeclaration") functions.push(statement);
    if (statement.type === "ExportNamedDeclaration" && statement.declaration?.type === "FunctionDeclaration") {
      functions.push(statement.declaration);
    }
  }
  const groups = new Map();
  for (const fn of functions) {
    if (forbiddenFunction(fn)) continue;
    if ((fn.body.body?.length ?? 0) < minStatements) continue;
    const params = fn.params
      .map((param) => (param.type === "RestElement" ? `...${param.argument.name}` : param.name))
      .join(",");
    const key = `${fn.async}|${params}|${code.slice(fn.body.start, fn.body.end)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(fn);
  }
  const edits = [];
  const notes = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const canonical = group[0];
    for (const fn of group.slice(1)) {
      const args = fn.params
        .map((param) => (param.type === "RestElement" ? `...${param.argument.name}` : param.name))
        .join(", ");
      edits.push({
        start: fn.body.start,
        end: fn.body.end,
        text: `{ return ${canonical.id.name}(${args}); }`,
      });
      notes.push({
        kind: "encapsulate-function",
        name: fn.id.name,
        canonical: canonical.id.name,
        line: fn.loc?.start.line ?? 1,
      });
    }
  }
  return { edits, notes };
}

function sequenceInside(ast, start, end, minStatements) {
  let best = null;
  traverse(ast, {
    BlockStatement(p) {
      const body = p.node.body;
      const selected = body.filter((statement) => statement.start >= start && statement.end <= end);
      if (selected.length < minStatements) return;
      const first = body.indexOf(selected[0]);
      const last = body.indexOf(selected[selected.length - 1]);
      if (body.slice(first, last + 1).length !== selected.length) return;
      if (!best || selected.length > best.length) best = selected;
    },
  });
  return best;
}

function isWrite(identifierPath) {
  const parent = identifierPath.parentPath;
  if (!parent) return false;
  if (parent.isAssignmentExpression() && parent.node.left === identifierPath.node) return true;
  if (parent.isUpdateExpression()) return true;
  if ((parent.isForOfStatement() || parent.isForInStatement()) && parent.node.left === identifierPath.node) return true;
  return false;
}

export function extractionEdits(code, ast, clones, fileRel, minStatements = 3) {
  const pairs = clones.filter(
    (clone) => clone.type === 1 && clone.a.file === fileRel && clone.b.file === fileRel,
  );
  const candidates = [];
  for (const clone of pairs) {
    const left = sequenceInside(ast, clone.a.start, clone.a.end, minStatements);
    const right = sequenceInside(ast, clone.b.start, clone.b.end, minStatements);
    if (!left || !right || left.length !== right.length) continue;
    if (hasControlTransfer(left) || hasControlTransfer(right)) continue;
    const plan = extractionPlan(ast, left);
    const other = extractionPlan(ast, right);
    if (!plan || !other || other.params.join(",") !== plan.params.join(",") || other.outputs.join(",") !== plan.outputs.join(",")) {
      continue;
    }
    candidates.push({ left, right, plan, span: left.length });
  }
  candidates.sort((a, b) => b.span - a.span);
  const chosen = [];
  for (const candidate of candidates) {
    const ranges = [...candidate.left, ...candidate.right];
    const hits = ranges.some((statement) =>
      chosen.some((other) =>
        [...other.left, ...other.right].some((kept) => statement.start < kept.end && kept.start < statement.end),
      ),
    );
    if (!hits) chosen.push(candidate);
  }

  let serial = 1;
  const edits = [];
  const notes = [];
  let insertAt = 0;
  for (const statement of ast.program.body) {
    if (statement.type === "ImportDeclaration") insertAt = statement.end;
    else if (statement.directive) insertAt = statement.end;
  }
  const helpers = [];
  for (const candidate of chosen) {
    let name = `extractedClone${serial}`;
    while (ast.program.body.some((statement) => statement.id?.name === name) || helpers.includes(name)) {
      serial += 1;
      name = `extractedClone${serial}`;
    }
    serial += 1;
    const params = candidate.plan.params.join(", ");
    const source = code.slice(lineStart(code, candidate.left[0].start), candidate.left.at(-1).end);
    const returned =
      candidate.plan.outputs.length === 0
        ? ""
        : candidate.plan.outputs.length === 1
          ? `\n  return ${candidate.plan.outputs[0]};\n`
          : `\n  return { ${candidate.plan.outputs.join(", ")} };\n`;
    helpers.push(`function ${name}(${params}) {\n${source}${returned}}`);
    for (const side of [candidate.left, candidate.right]) {
      const indent = code.slice(lineStart(code, side[0].start), side[0].start);
      const call =
        candidate.plan.outputs.length === 0
          ? `${indent}${name}(${params});`
          : candidate.plan.outputs.length === 1
            ? `${indent}const ${candidate.plan.outputs[0]} = ${name}(${params});`
            : `${indent}const { ${candidate.plan.outputs.join(", ")} } = ${name}(${params});`;
      edits.push({
        start: lineStart(code, side[0].start),
        end: side.at(-1).end,
        text: call,
      });
    }
    notes.push({
      kind: "extract-block",
      name,
      line: candidate.left[0].loc?.start.line ?? 1,
      statements: candidate.left.length,
    });
  }
  if (helpers.length) {
    edits.push({ start: insertAt, end: insertAt, text: `\n\n${helpers.join("\n\n")}\n` });
  }
  return { edits, notes };
}

function extractionPlan(ast, statements) {
  const start = statements[0].start;
  const end = statements.at(-1).end;
  const idents = [];
  traverse(ast, {
    BlockStatement(p) {
      if (!statements.every((statement) => p.node.body.includes(statement))) return;
      for (const statementPath of p.get("body")) {
        if (!statements.includes(statementPath.node)) continue;
        statementPath.traverse({
          Identifier(ident) {
            idents.push(ident);
          },
        });
      }
    },
  });
  const params = [];
  const outputs = [];
  let abort = false;
  for (const ident of idents) {
    if (!isNamePosition(ident.node, ident.parent)) continue;
    const binding = ident.scope.getBinding(ident.node.name);
    if (!binding?.identifier) continue;
    const declared = binding.identifier.start;
    const inside = declared >= start && declared < end;
    if (!inside) {
      if (isWrite(ident)) abort = true;
      else if (!params.includes(ident.node.name)) params.push(ident.node.name);
      continue;
    }
    const outside = (binding.referencePaths ?? []).filter((ref) => ref.node.start < start || ref.node.end > end);
    if (outside.length === 0) continue;
    if (outside.some((ref) => ref.node.start < start) || binding.kind === "hoisted" || binding.kind === "var") {
      abort = true;
      continue;
    }
    if (outside.some((ref) => isWrite(ref))) abort = true;
    if (!outputs.includes(binding.identifier.name)) outputs.push(binding.identifier.name);
  }
  if (abort) return null;
  return { params, outputs };
}

function removal(code, start, end) {
  let actualEnd = end;
  if (code[actualEnd] === "\r") actualEnd += 1;
  if (code[actualEnd] === "\n") actualEnd += 1;
  return { start, end: actualEnd, text: "" };
}

function deadEdits(code, findings) {
  const edits = [];
  for (const finding of findings) {
    if (!finding.removable || finding.start == null) continue;
    if (finding.fix === "remove") {
      edits.push(removal(code, finding.start, finding.end));
    } else if (finding.fix === "keep-init") {
      edits.push({
        start: finding.start,
        end: finding.end,
        text: `${code.slice(finding.initStart, finding.initEnd)};`,
      });
    }
    for (const extra of finding.extraRemoves ?? []) {
      edits.push(removal(code, extra.start, extra.end));
    }
  }
  return edits;
}

function writeIfChanged(abs, before, after) {
  if (before !== after) fs.writeFileSync(abs, after);
  return before !== after;
}

export function applyDelegationToFiles(files, minStatements = 4) {
  const notes = [];
  for (const file of files) {
    if (!file.ast) continue;
    const { edits, notes: fileNotes } = delegationEdits(file.code, file.ast, minStatements);
    if (!edits.length) continue;
    const next = applyEdits(file.code, preferOuter(edits));
    if (writeIfChanged(file.abs, file.code, next)) {
      notes.push(...fileNotes.map((note) => ({ ...note, file: file.rel })));
    }
  }
  return notes;
}

export function applyExtractionToFiles(files, clones, minStatements = 3) {
  const notes = [];
  for (const file of files) {
    if (!file.ast) continue;
    const { edits, notes: fileNotes } = extractionEdits(file.code, file.ast, clones, file.rel, minStatements);
    if (!edits.length) continue;
    const next = applyEdits(file.code, preferOuter(edits));
    if (writeIfChanged(file.abs, file.code, next)) {
      notes.push(...fileNotes.map((note) => ({ ...note, file: file.rel })));
    }
  }
  return notes;
}

export function applyDeadToFiles(files, findings) {
  const notes = [];
  const byFile = new Map();
  for (const finding of findings) {
    if (!finding.removable) continue;
    if (!byFile.has(finding.file)) byFile.set(finding.file, []);
    byFile.get(finding.file).push(finding);
  }
  for (const file of files) {
    if (!file.ast) continue;
    const own = byFile.get(file.rel) ?? [];
    const edits = preferOuter([...deadEdits(file.code, own), ...importEdits(file.code, file.ast)]);
    if (!edits.length) continue;
    const next = applyEdits(file.code, edits);
    if (writeIfChanged(file.abs, file.code, next)) {
      notes.push(
        ...own.filter((finding) => finding.fix !== "remove-import").map((finding) => ({
          kind: finding.kind,
          name: finding.name,
          line: finding.line,
          file: file.rel,
          fix: finding.fix,
        })),
      );
    }
  }
  return notes;
}

export function parseFresh(abs) {
  const code = fs.readFileSync(abs, "utf8");
  const ast = parseSource(code, abs);
  return { abs, code, ast, rel: path.basename(abs) };
}
