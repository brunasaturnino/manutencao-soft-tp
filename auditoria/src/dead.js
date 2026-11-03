import path from "node:path";
import { traverse } from "./parse.js";
import { resolveSpecifier } from "./files.js";

function exportId(node) {
  if (!node) return "default";
  if (node.type === "Identifier") return node.name;
  if (node.type === "StringLiteral") return node.value;
  return "default";
}

function collectModuleLinks(ast, absFile) {
  const imports = [];
  const reexports = [];
  const stars = [];
  if (!ast) return { imports, reexports, stars };

  traverse(ast, {
    ImportDeclaration(p) {
      const resolved = resolveSpecifier(absFile, p.node.source.value);
      if (p.node.specifiers.length === 0) {
        imports.push({ resolved, kind: "side-effect", imported: "*", localReferenced: true });
        return;
      }
      for (const spec of p.node.specifiers) {
        if (spec.type === "ImportSpecifier") {
          imports.push({
            resolved,
            kind: "named",
            imported: exportId(spec.imported),
            local: spec.local.name,
          });
        } else if (spec.type === "ImportDefaultSpecifier") {
          imports.push({ resolved, kind: "default", imported: "default", local: spec.local.name });
        } else if (spec.type === "ImportNamespaceSpecifier") {
          imports.push({ resolved, kind: "namespace", imported: "*", local: spec.local.name });
        }
      }
    },
    ExportAllDeclaration(p) {
      stars.push(resolveSpecifier(absFile, p.node.source.value));
    },
    ExportNamedDeclaration(p) {
      if (!p.node.source) return;
      const resolved = resolveSpecifier(absFile, p.node.source.value);
      for (const spec of p.node.specifiers) {
        reexports.push({
          resolved,
          imported: exportId(spec.local),
          exported: exportId(spec.exported),
        });
      }
    },
    CallExpression(p) {
      const callee = p.node.callee;
      const dynamic = callee.type === "Import";
      const required =
        callee.type === "Identifier" && callee.name === "require" && p.node.arguments.length === 1;
      if (!dynamic && !required) return;
      const arg = p.node.arguments[0];
      if (arg && arg.type === "StringLiteral") {
        imports.push({
          resolved: resolveSpecifier(absFile, arg.value),
          kind: "namespace",
          imported: "*",
          localReferenced: true,
          forceAll: true,
        });
      }
    },
  });

  return { imports, reexports, stars };
}

function bindingExportNames(binding) {
  const names = new Set();
  const declaratorParent = binding.path.parentPath;
  const statementParent = declaratorParent?.parentPath;
  if (declaratorParent?.isExportDefaultDeclaration()) names.add("default");
  if (statementParent?.isExportDefaultDeclaration() && binding.path.isVariableDeclarator()) {
    names.add("default");
  }
  if (declaratorParent?.isExportNamedDeclaration() && !declaratorParent.node.source) {
    if (binding.path.isFunctionDeclaration() || binding.path.isClassDeclaration()) {
      if (binding.path.node.id) names.add(binding.path.node.id.name);
    }
  }
  if (
    binding.path.isVariableDeclarator() &&
    statementParent?.isExportNamedDeclaration() &&
    !statementParent.node.source &&
    binding.path.node.id.type === "Identifier"
  ) {
    names.add(binding.path.node.id.name);
  }
  for (const ref of binding.referencePaths ?? []) {
    const parent = ref.parentPath;
    if (parent?.isExportSpecifier() && ref.key === "local") names.add(exportId(parent.node.exported));
    if (parent?.isExportDefaultDeclaration()) names.add("default");
  }
  return names;
}

function internalRefs(binding) {
  return (binding.referencePaths ?? []).filter((ref) => {
    if (ref.node === binding.path?.node) return false;
    if (ref.node?.declaration === binding.path?.node) return false;
    const parent = ref.parentPath;
    if (!parent) return true;
    if (parent.isExportSpecifier() && ref.key === "local") return false;
    if (parent.isExportDefaultDeclaration()) return false;
    if (parent.isExportNamedDeclaration() && (ref.key === "declaration" || ref.node === parent.node.declaration)) return false;
    return true;
  });
}

function violationOf(binding, viol) {
  const name = binding.identifier?.name;
  const node = viol?.node;
  if (!name || !node) return null;
  if (node === binding.path?.node || node === binding.path?.parentPath?.node) return null;
  if (node.type === "UpdateExpression" && node.argument?.type === "Identifier" && node.argument.name === name) {
    return { reads: true };
  }
  if (node.type === "AssignmentExpression" && node.left?.type === "Identifier" && node.left.name === name) {
    return { reads: node.operator !== "=" };
  }
  return null;
}

function bindingViolations(binding) {
  const reads = [];
  const writes = [];
  for (const viol of binding.constantViolations ?? []) {
    const effect = violationOf(binding, viol);
    if (!effect) continue;
    if (effect.reads) reads.push(viol);
    else writes.push(viol);
  }
  return { reads, writes };
}

function danglingDefaultExports(binding, removeNode) {
  const nodes = [];
  for (const ref of binding.referencePaths ?? []) {
    const parent = ref.parentPath;
    if (!parent?.isExportDefaultDeclaration() || parent.node.declaration !== ref.node) continue;
    const node = parent.node;
    if (removeNode && node.start >= removeNode.start && node.end <= removeNode.end) continue;
    nodes.push(node);
  }
  return nodes;
}

function isPureNode(node) {
  if (!node) return true;
  switch (node.type) {
    case "StringLiteral":
    case "NumericLiteral":
    case "BooleanLiteral":
    case "NullLiteral":
    case "BigIntLiteral":
    case "Identifier":
    case "FunctionExpression":
    case "ArrowFunctionExpression":
    case "ClassExpression":
      return true;
    case "UnaryExpression":
      return node.operator !== "delete" && node.operator !== "void" && isPureNode(node.argument);
    case "BinaryExpression":
    case "LogicalExpression":
      return isPureNode(node.left) && isPureNode(node.right);
    case "ConditionalExpression":
      return isPureNode(node.test) && isPureNode(node.consequent) && isPureNode(node.alternate);
    case "ArrayExpression":
      return node.elements.every((el) => el == null || (el.type !== "SpreadElement" ? isPureNode(el) : isPureNode(el.argument)));
    case "ObjectExpression":
      return node.properties.every((prop) => {
        if (prop.type === "SpreadElement") return isPureNode(prop.argument);
        if (prop.type !== "ObjectProperty") return false;
        return (!prop.computed || isPureNode(prop.key)) && isPureNode(prop.value);
      });
    case "TemplateLiteral":
      return node.expressions.every(isPureNode);
    case "ParenthesizedExpression":
      return isPureNode(node.expression);
    default:
      return false;
  }
}

function completesAbrupt(node, seen = new Set()) {
  if (!node || seen.has(node)) return false;
  seen.add(node);
  if (
    node.type === "ReturnStatement" ||
    node.type === "ThrowStatement" ||
    node.type === "BreakStatement" ||
    node.type === "ContinueStatement"
  ) {
    return true;
  }
  if (node.type === "BlockStatement") {
    let abrupt = false;
    for (const statement of node.body) {
      if (abrupt) return true;
      abrupt = completesAbrupt(statement, seen);
    }
    return abrupt;
  }
  if (node.type === "IfStatement" && node.alternate) {
    return completesAbrupt(node.consequent, seen) && completesAbrupt(node.alternate, seen);
  }
  return false;
}

function scanUnreachable(ast, fileRel) {
  const findings = [];
  traverse(ast, {
    BlockStatement(blockPath) {
      let abrupt = false;
      for (const stmt of blockPath.get("body")) {
        if (abrupt) {
          if (stmt.isFunctionDeclaration() || stmt.isEmptyStatement()) continue;
          findings.push({
            kind: "unreachable",
            file: fileRel,
            line: stmt.node.loc?.start.line ?? 1,
            name: stmt.node.type,
            confidence: "high",
            removable: true,
            reason: "Instrução depois de um return, throw, break ou continue no mesmo bloco.",
            start: stmt.node.start,
            end: stmt.node.end,
            fix: "remove",
          });
          continue;
        }
        if (completesAbrupt(stmt.node)) abrupt = true;
      }
    },
  });
  return findings;
}

function mark(used, file, name) {
  if (!file) return;
  const key = path.normalize(file);
  if (!used.has(key)) used.set(key, new Set());
  used.get(key).add(name);
}

/**
 * Código morto estático.
 * Raízes: entry points públicos do package.json e ficheiros de teste.
 * Um export é vivo se um módulo vivo o importa, ou se o ficheiro é API pública.
 * Um binding privado sem referências internas é morto.
 * Import dinâmico com caminho literal marca o módulo inteiro como usado.
 */
export function analyzeDead(product, tests, surface) {
  const byFile = new Map();
  for (const file of product) {
    if (!file.ast) continue;
    byFile.set(path.normalize(file.abs), { ...file, links: collectModuleLinks(file.ast, file.abs) });
  }
  const testLinks = [];
  for (const file of tests) {
    if (!file.ast) continue;
    testLinks.push(collectModuleLinks(file.ast, file.abs));
  }

  const live = new Set();
  const queue = [];
  for (const abs of surface.files) queue.push(path.normalize(abs));
  for (const links of testLinks) {
    for (const imp of links.imports) if (imp.resolved) queue.push(path.normalize(imp.resolved));
    for (const star of links.stars) if (star) queue.push(path.normalize(star));
    for (const re of links.reexports) if (re.resolved) queue.push(path.normalize(re.resolved));
  }
  while (queue.length) {
    const current = queue.pop();
    if (live.has(current)) continue;
    live.add(current);
    const info = byFile.get(current);
    if (!info) continue;
    for (const imp of info.links.imports) if (imp.resolved) queue.push(path.normalize(imp.resolved));
    for (const star of info.links.stars) if (star) queue.push(path.normalize(star));
    for (const re of info.links.reexports) if (re.resolved) queue.push(path.normalize(re.resolved));
  }

  const used = new Map();
  for (const file of product) {
    const abs = path.normalize(file.abs);
    if (surface.isPublic(file.abs)) mark(used, abs, "*");
  }

  const consider = [];
  for (const info of byFile.values()) consider.push({ info, fromTest: false });
  for (const links of testLinks) consider.push({ info: { links, abs: null }, fromTest: true });

  let changed = true;
  while (changed) {
    changed = false;
    const before = new Map([...used.entries()].map(([k, v]) => [k, new Set(v)]));
    for (const item of consider) {
      const { links } = item.info;
      const origin = item.info.abs ? path.normalize(item.info.abs) : null;
      const originUsed = origin ? used.get(origin) : null;
      const originPublic = origin ? surface.isPublic(item.info.abs) : false;
      for (const imp of links.imports) {
        if (!imp.resolved) continue;
        if (imp.forceAll || item.fromTest || imp.localReferenced || imp.kind === "side-effect") {
          mark(used, imp.resolved, imp.kind === "named" || imp.kind === "default" ? imp.imported : "*");
          if (imp.kind === "namespace" || imp.kind === "side-effect" || imp.forceAll) mark(used, imp.resolved, "*");
        }
      }
      if (!origin) {
        for (const re of links.reexports) if (re.resolved) mark(used, re.resolved, re.imported);
        for (const star of links.stars) if (star) mark(used, star, "*");
        continue;
      }
      const exposesAll = originPublic || originUsed?.has("*");
      for (const re of links.reexports) {
        if (!re.resolved) continue;
        if (exposesAll || originUsed?.has(re.exported)) mark(used, re.resolved, re.imported);
      }
      if (exposesAll) {
        for (const star of links.stars) if (star) mark(used, star, "*");
      }
    }
    for (const [file, names] of used) {
      const prev = before.get(file);
      if (!prev || prev.size !== names.size) changed = true;
    }
  }

  for (const info of byFile.values()) {
    let programPath = null;
    traverse(info.ast, {
      Program(p) {
        programPath = p;
      },
    });
    if (!programPath) continue;
    for (const imp of info.links.imports) {
      if (!imp.local || imp.forceAll) continue;
      const binding = programPath.scope.getBinding(imp.local);
      imp.localReferenced = itemReferenced(binding);
      if (imp.kind === "namespace" && binding) {
        const precise = preciseNamespaceUses(binding);
        imp.namespaceNames = precise;
        if (precise === "*") imp.forceAll = true;
      }
    }
  }

  // Second propagation now that localReferenced is known.
  changed = true;
  while (changed) {
    changed = false;
    const before = new Map([...used.entries()].map(([k, v]) => [k, new Set(v)]));
    for (const info of byFile.values()) {
      const origin = path.normalize(info.abs);
      const originUsed = used.get(origin);
      const originPublic = surface.isPublic(info.abs);
      for (const imp of info.links.imports) {
        if (!imp.resolved || !imp.localReferenced) continue;
        if (imp.kind === "namespace") {
          if (imp.namespaceNames === "*" || imp.forceAll) mark(used, imp.resolved, "*");
          else for (const name of imp.namespaceNames ?? []) mark(used, imp.resolved, name);
        } else if (imp.kind === "named" || imp.kind === "default") {
          mark(used, imp.resolved, imp.imported);
        } else {
          mark(used, imp.resolved, "*");
        }
      }
      const exposesAll = originPublic || originUsed?.has("*");
      for (const re of info.links.reexports) {
        if (!re.resolved) continue;
        if (exposesAll || originUsed?.has(re.exported)) mark(used, re.resolved, re.imported);
      }
      if (exposesAll) for (const star of info.links.stars) if (star) mark(used, star, "*");
    }
    for (const links of testLinks) {
      for (const imp of links.imports) {
        if (!imp.resolved) continue;
        if (imp.kind === "named" || imp.kind === "default") mark(used, imp.resolved, imp.imported);
        else mark(used, imp.resolved, "*");
      }
      for (const re of links.reexports) if (re.resolved) mark(used, re.resolved, re.imported);
      for (const star of links.stars) if (star) mark(used, star, "*");
    }
    for (const [file, names] of used) {
      const prev = before.get(file);
      if (!prev || prev.size !== names.size) changed = true;
    }
  }

  const findings = [];
  for (const file of product) {
    const abs = path.normalize(file.abs);
    if (!live.has(abs) && !surface.isPublic(file.abs)) {
      findings.push({
        kind: "dead-file",
        file: file.rel,
        line: 1,
        name: file.rel,
        confidence: "medium",
        removable: false,
        reason: "Módulo não alcançável a partir dos entry points públicos nem dos testes. Não é apagado: pode ser carregado por caminho dinâmico.",
      });
    }
    if (!file.ast) continue;
    const usedNames = used.get(abs) ?? new Set();
    const scopePaths = [];
    traverse(file.ast, {
      Scopable(scopePath) {
        scopePaths.push(scopePath);
      },
    });
    for (const scopePath of scopePaths) {
      if (scopePath.scope.block !== scopePath.node) continue;
      for (const binding of Object.values(scopePath.scope.bindings)) {
        const finding = deadBinding(binding, file, usedNames, surface.isPublic(file.abs));
        if (finding) findings.push(finding);
      }
    }
    findings.push(...scanUnreachable(file.ast, file.rel));
  }
  return findings;
}

function itemReferenced(binding) {
  if (!binding) return false;
  return internalRefs(binding).length > 0 || (binding.referencePaths ?? []).length > 0;
}

function preciseNamespaceUses(binding) {
  const names = new Set();
  for (const ref of binding.referencePaths ?? []) {
    const parent = ref.parentPath;
    if (
      parent?.isMemberExpression() &&
      parent.node.object === ref.node &&
      !parent.node.computed &&
      parent.node.property.type === "Identifier"
    ) {
      names.add(parent.node.property.name);
      continue;
    }
    return "*";
  }
  return [...names];
}

function deadBinding(binding, file, usedNames, isPublic) {
  if (!binding.path?.node) return null;
  if (binding.kind === "param") return null;
  if (binding.path.isCatchClause()) return null;
  const name = binding.identifier?.name;
  if (!name || name.startsWith("_")) return null;
  if (
    binding.path.isImportSpecifier() ||
    binding.path.isImportDefaultSpecifier() ||
    binding.path.isImportNamespaceSpecifier()
  ) {
    if ((binding.referencePaths ?? []).length > 0) return null;
    const decl = binding.path.parentPath.node;
    return {
      kind: "dead-symbol",
      file: file.rel,
      line: binding.path.node.loc?.start.line ?? 1,
      name,
      confidence: "high",
      removable: true,
      exported: false,
      reason: `Import «${name}» não é usado.`,
      start: binding.path.node.start,
      end: binding.path.node.end,
      importStart: decl.start,
      importEnd: decl.end,
      fix: "remove-import",
    };
  }
  const exportNames = bindingExportNames(binding);
  const internallyUsed = internalRefs(binding).length > 0;
  const { reads, writes } = bindingViolations(binding);
  if (internallyUsed || reads.length > 0) return null;
  const externallyUsed =
    usedNames.has("*") || [...exportNames].some((exportName) => usedNames.has(exportName));
  if (exportNames.size > 0 && (externallyUsed || isPublic)) return null;
  if (exportNames.size === 0 && internallyUsed) return null;

  const loopParent = binding.path.parentPath;
  if (loopParent && (loopParent.isForStatement() || loopParent.isForInStatement() || loopParent.isForOfStatement())) {
    return null;
  }

  let node = binding.path.node;
  let removePathNode = node;
  if (binding.path.isVariableDeclarator() && binding.path.parentPath?.isVariableDeclaration()) {
    const declaration = binding.path.parentPath;
    if (declaration.node.declarations.length === 1) {
      removePathNode = declaration.parentPath?.isExportNamedDeclaration()
        ? declaration.parentPath.node
        : declaration.node;
    }
  } else if (binding.path.parentPath?.isExportNamedDeclaration() && !binding.path.parentPath.node.source) {
    removePathNode = binding.path.parentPath.node;
  } else if (binding.path.parentPath?.isExportDefaultDeclaration()) {
    removePathNode = binding.path.parentPath.node;
  }

  const isFunction =
    binding.path.isFunctionDeclaration() ||
    (binding.path.isVariableDeclarator() &&
      binding.path.node.init &&
      (binding.path.node.init.type === "FunctionExpression" ||
        binding.path.node.init.type === "ArrowFunctionExpression"));
  const isClass = binding.path.isClassDeclaration();
  const isVar = binding.path.isVariableDeclarator();
  if (!isFunction && !isClass && !isVar) return null;

  if (isVar && binding.path.parentPath?.node.declarations?.length !== 1) {
    return {
      kind: "dead-symbol",
      file: file.rel,
      line: node.loc?.start.line ?? 1,
      name,
      confidence: "low",
      removable: false,
      exported: exportNames.size > 0,
      reason: "Variável sem uso num declarador múltiplo. Fica só no relatório.",
    };
  }

  const init = isVar ? binding.path.node.init : null;
  const pure = !isVar || isPureNode(init);
  const reason = exportNames.size
    ? `Export «${name}» não é importado pelo entry público nem pelos testes.`
    : isFunction
      ? `Função «${name}» não é referenciada.`
      : `Variável «${name}» não é lida.`;

  const finding = {
    kind: "dead-symbol",
    file: file.rel,
    line: removePathNode.loc?.start.line ?? 1,
    name,
    confidence: "high",
    removable: true,
    exported: exportNames.size > 0,
    reason,
    start: removePathNode.start,
    end: removePathNode.end,
    fix: "remove",
  };

  if (isVar && !pure && init) {
    finding.fix = "keep-init";
    finding.initStart = init.start;
    finding.initEnd = init.end;
    finding.reason += " A inicialização tem efeito e é preservada.";
  }
  if (writes.length > 0) {
    finding.removable = false;
    finding.confidence = "medium";
    finding.reason += " O nome ainda é escrito, por isso a declaração fica.";
    return finding;
  }
  const extras = danglingDefaultExports(binding, removePathNode);
  if (extras.length > 0) {
    finding.extraRemoves = extras.map((node) => ({ start: node.start, end: node.end }));
    finding.reason += " O export default que só reexporta este nome é removido junto.";
  }
  return finding;
}
