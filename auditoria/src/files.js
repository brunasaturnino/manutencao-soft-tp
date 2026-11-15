import fs from "node:fs";
import path from "node:path";

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "coverage",
  ".git",
  "docs",
  ".husky",
  ".github",
  ".devcontainer",
]);

export function toPosix(p) {
  return p.split(path.sep).join("/");
}

export function relPath(root, file) {
  return toPosix(path.relative(root, file));
}

function walk(dir, root, acc, { testsOnly = false } = {}) {
  if (!fs.existsSync(dir)) return;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name.startsWith(".") && ent.isDirectory()) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name)) continue;
      walk(full, root, acc, { testsOnly });
      continue;
    }
    if (!/\.(cjs|mjs|js)$/.test(ent.name)) continue;
    const rel = relPath(root, full);
    const isTest =
      /(^|\/)(tests?|__tests__)(\/|$)/.test(rel) ||
      /\.(test|spec)\.(cjs|mjs|js)$/.test(ent.name);
    if (testsOnly ? isTest : !isTest) acc.push(full);
  }
}

export function discoverProductFiles(root) {
  const lib = path.join(root, "lib");
  if (fs.existsSync(lib) && fs.statSync(lib).isDirectory()) {
    const files = [];
    walk(lib, root, files);
    for (const name of ["index.js", "index.mjs"]) {
      const abs = path.join(root, name);
      if (fs.existsSync(abs)) files.push(abs);
    }
    return files.sort();
  }
  const files = [];
  walk(root, root, files);
  return files
    .filter((file) => {
      const base = path.basename(file);
      if (/\.(config|setup)\.(cjs|mjs|js)$/.test(base)) return false;
      if (/^(gulpfile|gulpfile\.js|rollup\.config|webpack\.config|eslint\.config|vitest\.config)/.test(base)) {
        return false;
      }
      return true;
    })
    .sort();
}

export function discoverTestFiles(root) {
  const files = [];
  walk(root, root, files, { testsOnly: true });
  return files.sort();
}

function walkExportNode(node, exact, patterns) {
  if (typeof node === "string") {
    if (!node.startsWith(".")) return;
    if (node.includes("*")) patterns.push(node);
    else exact.push(node);
    return;
  }
  if (node && typeof node === "object") {
    for (const value of Object.values(node)) walkExportNode(value, exact, patterns);
  }
}

// Semântica de subpath patterns do Node: o `*` casa qualquer sequência de
// caracteres, inclusive `/`. Por isso "./lib/*" torna públicos todos os
// ficheiros de lib/, em qualquer profundidade.
function patternToRegExp(pattern) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*+/g, ".+");
  return new RegExp(`^${escaped}$`);
}

/**
 * Superfície pública do pacote. `internalExports` lista chaves de `exports`
 * (por exemplo "./unsafe/*") que o utilizador declara como internas: o que elas
 * expõem deixa de contar como API. É uma decisão do utilizador, não da
 * ferramenta, porque remover código assim pode quebrar quem importa esses caminhos.
 */
export function readPublicSurface(root, { internalExports = [] } = {}) {
  const pkgPath = path.join(root, "package.json");
  const exact = [];
  const patterns = [];
  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    for (const key of ["main", "module"]) {
      if (typeof pkg[key] === "string") exact.push(pkg[key]);
    }
    if (pkg.browser && typeof pkg.browser === "object") {
      for (const value of Object.values(pkg.browser)) {
        if (typeof value === "string") exact.push(value);
      }
    }
    const skipped = new Set(internalExports);
    if (pkg.exports && typeof pkg.exports === "object" && !Array.isArray(pkg.exports)) {
      for (const [key, value] of Object.entries(pkg.exports)) {
        if (!skipped.has(key)) walkExportNode(value, exact, patterns);
      }
    } else {
      walkExportNode(pkg.exports, exact, patterns);
    }
  }
  const regexes = patterns.map(patternToRegExp);
  const files = new Set();
  for (const rel of exact) {
    const abs = path.resolve(root, rel);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) files.add(path.normalize(abs));
  }
  return {
    files,
    isPublic(abs) {
      const normalized = path.normalize(abs);
      if (files.has(normalized)) return true;
      const rel = relPath(root, abs);
      const dotted = rel.startsWith(".") ? rel : `./${rel}`;
      return regexes.some((re) => re.test(rel) || re.test(dotted));
    },
  };
}

export function resolveSpecifier(fromFile, spec) {
  if (typeof spec !== "string" || !spec.startsWith(".")) return null;
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [
    base,
    `${base}.js`,
    `${base}.mjs`,
    `${base}.cjs`,
    path.join(base, "index.js"),
    path.join(base, "index.mjs"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return path.normalize(candidate);
  }
  return null;
}
