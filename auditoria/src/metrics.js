const OPERATOR_LABELS = new Set(["ID", "LIT"]);

function isOperator(token) {
  return !OPERATOR_LABELS.has(token.norm);
}

function decisionPoints(ast, traverse) {
  let decisions = 0;
  let functions = 0;
  traverse(ast, {
    enter(p) {
      if (
        p.isFunctionDeclaration() ||
        p.isFunctionExpression() ||
        p.isArrowFunctionExpression() ||
        p.isObjectMethod() ||
        p.isClassMethod()
      ) {
        functions += 1;
        decisions += 1;
      }
      if (
        p.isIfStatement() ||
        p.isForStatement() ||
        p.isForInStatement() ||
        p.isForOfStatement() ||
        p.isWhileStatement() ||
        p.isDoWhileStatement() ||
        p.isCatchClause() ||
        p.isConditionalExpression()
      ) {
        decisions += 1;
      }
      if (p.isSwitchCase() && p.node.test) decisions += 1;
      if (p.isLogicalExpression() && (p.node.operator === "&&" || p.node.operator === "||" || p.node.operator === "??")) {
        decisions += 1;
      }
    },
  });
  if (functions === 0) decisions += 1;
  return decisions;
}

export function duplicatedLineCount(clones) {
  const lines = new Set();
  for (const clone of clones) {
    if (clone.type === 3) continue;
    for (const side of [clone.a, clone.b]) {
      for (let line = side.startLine; line <= side.endLine; line += 1) lines.add(`${side.file}:${line}`);
    }
  }
  return lines.size;
}

/**
 * Índice de manutenibilidade normalizado (0–100), média por ficheiro da fórmula
 * de Oman e Hagemeister usada pelo Visual Studio: volume de Halstead,
 * complexidade ciclomática e linhas. A média por ficheiro evita que a soma
 * do repositório inteiro sature o índice em zero.
 * A dívida em minutos é uma estimativa de remediação: 10 min por símbolo morto,
 * 5 min por bloco inalcançável e 2 min por linha duplicada (tipos 1 e 2).
 */
export function computeMetrics(files, clones, dead, traverse) {
  let loc = 0;
  let complexity = 0;
  let operatorTotal = 0;
  let operandTotal = 0;
  const operators = new Set();
  const operands = new Set();
  let maintainabilitySum = 0;
  let maintainabilityFiles = 0;

  for (const file of files) {
    if (!file.ast) continue;
    const codeLines = new Set();
    let fileOperators = 0;
    let fileOperands = 0;
    const fileOperatorSet = new Set();
    const fileOperandSet = new Set();
    for (const token of file.tokens) {
      for (let line = token.line; line <= token.endLine; line += 1) codeLines.add(line);
      if (isOperator(token)) {
        operatorTotal += 1;
        fileOperators += 1;
        operators.add(token.raw);
        fileOperatorSet.add(token.raw);
      } else {
        operandTotal += 1;
        fileOperands += 1;
        operands.add(`${token.norm}:${token.raw}`);
        fileOperandSet.add(`${token.norm}:${token.raw}`);
      }
    }
    const fileLoc = codeLines.size;
    const fileComplexity = decisionPoints(file.ast, traverse);
    loc += fileLoc;
    complexity += fileComplexity;
    const vocabulary = fileOperatorSet.size + fileOperandSet.size;
    const length = fileOperators + fileOperands;
    const volume = vocabulary > 0 && length > 0 ? length * Math.log2(vocabulary) : 0;
    const raw =
      volume > 0 && fileLoc > 0
        ? 171 - 5.2 * Math.log(volume) - 0.23 * fileComplexity - 16.2 * Math.log(fileLoc)
        : 171;
    maintainabilitySum += Math.max(0, Math.min(100, (raw * 100) / 171));
    maintainabilityFiles += 1;
  }

  const vocabulary = operators.size + operands.size;
  const length = operatorTotal + operandTotal;
  const volume = vocabulary > 0 && length > 0 ? length * Math.log2(vocabulary) : 0;
  const duplicatedLines = duplicatedLineCount(clones);
  const deadSymbols = dead.filter((item) => item.kind === "dead-symbol").length;
  const unreachable = dead.filter((item) => item.kind === "unreachable").length;
  const debtMinutes = deadSymbols * 10 + unreachable * 5 + duplicatedLines * 2;

  return {
    files: files.filter((file) => file.ast).length,
    loc,
    cyclomaticComplexity: complexity,
    halsteadVolume: Number(volume.toFixed(1)),
    maintainabilityIndex: Number((maintainabilityFiles ? maintainabilitySum / maintainabilityFiles : 100).toFixed(1)),
    duplicatedLines,
    duplicationDensity: loc ? Number((duplicatedLines / loc).toFixed(4)) : 0,
    deadSymbols,
    unreachableStatements: unreachable,
    deadFiles: dead.filter((item) => item.kind === "dead-file").length,
    clonePairs: clones.length,
    debtMinutes,
  };
}
