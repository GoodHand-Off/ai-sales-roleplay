#!/usr/bin/env node
/**
 * Fails if any installed package (direct or transitive) is licensed only under
 * GPL or AGPL. Dual licences that offer a permissive option, such as
 * "(MIT OR GPL-3.0)", pass. LGPL and MPL are allowed: they are dynamically
 * linked or file-scoped and fine as dependencies.
 *
 * Reads package-lock.json for the list of installed packages and each
 * package's own package.json for its licence. No network access.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));

const COPYLEFT_ONLY = /^(A?GPL)-\d/i;
const PERMISSIVE = /^(MIT|ISC|BSD-[0-9]-Clause|BSD|Apache-2\.0|0BSD|Unlicense|CC0-1\.0|CC-BY-[34]\.0|BlueOak-1\.0\.0|Python-2\.0|MPL-2\.0|LGPL-[23]\.[01](-only|-or-later)?)$/i;

function licenceOf(pkgDir) {
  const file = join(root, pkgDir, "package.json");
  if (!existsSync(file)) return null;
  const pkg = JSON.parse(readFileSync(file, "utf8"));
  if (typeof pkg.license === "string") return pkg.license;
  if (pkg.license && typeof pkg.license.type === "string") return pkg.license.type;
  if (Array.isArray(pkg.licenses)) return pkg.licenses.map((entry) => entry.type ?? entry).join(" OR ");
  return null;
}

/** True if the SPDX expression leaves at least one non-GPL/AGPL option. */
function allowed(expression) {
  const alternatives = expression.replace(/[()]/g, "").split(/\s+OR\s+/i);
  return alternatives.some((alternative) =>
    alternative.split(/\s+AND\s+/i).every((term) => !COPYLEFT_ONLY.test(term.trim())),
  );
}

const counts = new Map();
const blocked = [];
const unknown = [];
let total = 0;

for (const [path, entry] of Object.entries(lock.packages ?? {})) {
  if (!path || entry.link) continue;
  if (!existsSync(join(root, path))) continue; // optional platform packages not installed here
  total += 1;
  const licence = licenceOf(path) ?? entry.license ?? null;
  const name = path.replace(/^.*node_modules\//, "");
  if (!licence) {
    unknown.push(name);
    continue;
  }
  counts.set(licence, (counts.get(licence) ?? 0) + 1);
  if (!allowed(licence)) blocked.push(`${name}: ${licence}`);
}

const summary = [...counts.entries()].sort((a, b) => b[1] - a[1]);
console.warn(`Checked ${total} installed packages.`);
for (const [licence, count] of summary) {
  const note = PERMISSIVE.test(licence) || licence.includes(" OR ") ? "" : "  (review)";
  console.warn(`  ${String(count).padStart(4)}  ${licence}${note}`);
}
if (unknown.length) console.warn(`No licence field: ${unknown.join(", ")}`);
if (blocked.length) {
  console.error(`GPL/AGPL-only packages found:\n  ${blocked.join("\n  ")}`);
  process.exit(1);
}
console.warn("No GPL- or AGPL-only packages.");
