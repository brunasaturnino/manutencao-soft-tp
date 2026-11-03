import { parse } from "@babel/parser";
import _traverse from "@babel/traverse";

const loaded = _traverse.default ?? _traverse;
export const traverse = typeof loaded === "function" ? loaded : loaded.default;

const PLUGINS = [
  "importAttributes",
  "classProperties",
  "classPrivateProperties",
  "classPrivateMethods",
  "dynamicImport",
  "optionalChaining",
  "nullishCoalescingOperator",
  "topLevelAwait",
  "importMeta",
];

const LITERAL_LABELS = new Set([
  "num",
  "string",
  "regexp",
  "bigint",
  "template",
  "templateNonTail",
  "templateTail",
]);

export function parseSource(code, filename) {
  const preferred = filename.endsWith(".cjs") ? "script" : "unambiguous";
  const attempts = preferred === "script" ? ["script", "module"] : ["unambiguous", "module", "script"];
  let lastError;
  for (const sourceType of attempts) {
    try {
      return parse(code, {
        sourceType,
        sourceFilename: filename,
        plugins: PLUGINS,
        tokens: true,
        ranges: true,
        allowReturnOutsideFunction: true,
        allowAwaitOutsideFunction: true,
      });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function fnv(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function normalize(token) {
  const label = token.type?.label;
  if (!label || label === "eof" || label === "CommentLine" || label === "CommentBlock") return null;
  if ((label === "name" || label === "privateName") && !token.type?.keyword) return "ID";
  if (token.type?.keyword) return String(token.type.keyword);
  if (LITERAL_LABELS.has(label)) return "LIT";
  if (token.value == null) return label;
  return String(token.value);
}

export function tokenize(ast) {
  const tokens = [];
  for (const token of ast.tokens ?? []) {
    if (token.start == null || !token.loc) continue;
    const norm = normalize(token);
    if (norm == null) continue;
    tokens.push({
      norm,
      raw: token.value == null ? norm : String(token.value),
      start: token.start,
      end: token.end,
      line: token.loc.start.line,
      endLine: token.loc.end.line,
      normHash: fnv(norm),
    });
  }
  return tokens;
}
