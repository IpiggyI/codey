import assert from "node:assert/strict";
import { access, readdir, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import test from "node:test";

const root = new URL("../", import.meta.url);

const STYLELESS_EXPORTS = new Set([
  "cn",
  "Collection",
  "I18nProvider",
  "Key",
  "ListLayout",
  "ToastContainerContext",
  "useFilter",
  "useToastContainer",
  "Virtualizer",
]);

const EXPORT_STYLE_SHEETS = {
  Badge: ["chip"],
  Button: ["button"],
  Card: ["card"],
  Checkbox: ["checkbox"],
  Chip: ["chip"],
  CloseButton: ["close-button"],
  ComboBox: ["combo-box", "input", "input-group", "list-box", "list-box-item", "list-box-section"],
  Dialog: ["modal", "close-button"],
  DialogContent: ["modal", "close-button"],
  DialogDescription: ["modal"],
  DialogFooter: ["modal"],
  DialogHeader: ["modal"],
  DialogTitle: ["modal"],
  Disclosure: ["disclosure"],
  Header: ["header"],
  Input: ["input"],
  InputGroup: ["input-group"],
  Label: ["label"],
  ListBox: ["list-box", "list-box-item", "list-box-section"],
  Modal: ["modal", "close-button"],
  PasswordInput: ["input", "input-group", "button"],
  Select: ["select", "list-box", "list-box-item", "list-box-section"],
  Spinner: ["spinner"],
  Switch: ["switch"],
  Table: ["table"],
  toast: ["toast"],
  ToastProvider: ["toast", "close-button", "button", "spinner"],
  Tooltip: ["tooltip"],
};

async function listFiles(dirUrl) {
  const files = [];
  for (const entry of await readdir(dirUrl, { withFileTypes: true })) {
    const next = new URL(entry.name + (entry.isDirectory() ? "/" : ""), dirUrl);
    if (entry.isDirectory()) files.push(...(await listFiles(next)));
    else files.push(next);
  }
  return files;
}

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function namedSpecifiers(clause) {
  const names = [];
  for (const part of clause.split(",")) {
    const token = part.trim();
    if (!token || token.startsWith("type ")) continue;
    names.push(token.split(/\s+as\s+/)[0].trim());
  }
  return names.filter(Boolean);
}

function collectNamedImports(source, specifierPattern) {
  const names = [];
  const importRe = new RegExp(
    String.raw`import\s+(type\s+)?(?:\{([^}]+)\}|[\w$]+)(?:\s*,\s*\{([^}]+)\})?\s+from\s+["']${specifierPattern}["']`,
    "g",
  );
  for (const match of source.matchAll(importRe)) {
    if (match[1]) continue;
    if (match[2]) names.push(...namedSpecifiers(match[2]));
    if (match[3]) names.push(...namedSpecifiers(match[3]));
  }
  return names;
}

function styleSheetsForExport(name) {
  if (STYLELESS_EXPORTS.has(name)) return [];
  const sheets = EXPORT_STYLE_SHEETS[name];
  assert.ok(
    sheets,
    `unmapped HeroUI identifier ${name}; add it to EXPORT_STYLE_SHEETS or STYLELESS_EXPORTS`,
  );
  return sheets;
}

function parseComponentImports(css) {
  return [...css.matchAll(/@import\s+"@heroui\/styles\/components\/([^"]+)\.css"/g)].map(
    (match) => match[1],
  );
}

function parseComponentSources(css) {
  return [...css.matchAll(/@source\s+"[^"]*\/components\/([^"]+)"/g)].map((match) => match[1]);
}

test("imported HeroUI component styles cover every component src/ actually renders", async () => {
  const srcFiles = (await listFiles(new URL("src/", root))).filter((file) =>
    /\.(tsx|ts)$/.test(file.pathname),
  );
  const sources = await Promise.all(srcFiles.map((file) => readFile(file, "utf8")));
  const usedSheets = new Set();

  for (const raw of sources) {
    const source = stripComments(raw);
    const herouiNames = collectNamedImports(source, String.raw`@heroui\/react`);
    const wrapperNames = collectNamedImports(source, String.raw`(?:\.\./)*components/ui`);
    for (const name of [...herouiNames, ...wrapperNames]) {
      for (const sheet of styleSheetsForExport(name)) usedSheets.add(sheet);
    }
  }

  const tailwind = await readFile(new URL("src/tailwind.css", root), "utf8");
  const importedSheets = parseComponentImports(tailwind);
  const sourcedSheets = parseComponentSources(tailwind);
  const required = [...usedSheets].sort();
  const imported = [...importedSheets].sort();
  const sourced = [...sourcedSheets].sort();

  assert.match(tailwind, /@import "@heroui\/styles\/base\/base\.css" layer\(base\)/);
  assert.match(tailwind, /@import "@heroui\/styles\/base\/scrollbar\.css" layer\(base\)/);
  assert.match(tailwind, /@source "\.\.\/node_modules\/@heroui\/react\/dist\/utils"/);
  assert.match(tailwind, /@source "\.\.\/node_modules\/@heroui\/react\/dist\/hooks"/);

  assert.deepEqual(
    imported,
    required,
    "src/tailwind.css component @import list must match HeroUI components rendered from src/",
  );
  assert.deepEqual(
    sourced,
    required,
    "src/tailwind.css @source component paths must match the imported component stylesheets",
  );

  await Promise.all(
    required.map((name) =>
      access(
        new URL(`node_modules/@heroui/styles/dist/components/${name}.css`, root),
        constants.F_OK,
      ),
    ),
  );
});
