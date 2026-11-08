// Post-processes the game's NetscriptDefinitions.d.ts so that every top-level
// declaration is exported (the upstream file only exports a handful, which makes
// types like Player/Person/MoneySources unimportable from a module).
//
// Usage: node tools/fix-defs.mjs [path]   (default: types/NetscriptDefinitions.d.ts)
import { readFileSync, writeFileSync } from "node:fs";

export function exportAll(src) {
  return src.replace(/^(declare\s+)?(interface|type|enum|const enum|class|function|const|namespace)\s/gm, (m, _d, kind) =>
    `export ${kind} `,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const path = process.argv[2] ?? "types/NetscriptDefinitions.d.ts";
  const before = readFileSync(path, "utf8");
  const after = exportAll(before);
  writeFileSync(path, after);
  const n = (after.match(/^export /gm) ?? []).length;
  console.log(`fix-defs: ${path} now has ${n} exported declarations`);
}
