#!/usr/bin/env node
/**
 * Fails if the browser bundle contains anything that looks like an OpenAI key,
 * or the actual value of OPENAI_API_KEY when it is set (in the environment or in
 * .env.local, the same places Next.js reads). Run after `npm run build`.
 * Scans every file Next.js serves to the browser (.next/static).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// Values already in the environment win, as they do for Next.js.
for (const file of [".env.production.local", ".env.local", ".env.production", ".env"]) {
  if (existsSync(file)) process.loadEnvFile(file);
}

const root = join(process.cwd(), ".next", "static");
if (!existsSync(root)) {
  console.error("No .next/static folder. Run `npm run build` first.");
  process.exit(1);
}

const KEY_PATTERN = /sk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/;
const actualKey = process.env.OPENAI_API_KEY?.trim();

function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

const all = files(root);
const leaks = all.filter((file) => {
  const text = readFileSync(file, "utf8");
  return KEY_PATTERN.test(text) || (actualKey ? text.includes(actualKey) : false);
});

if (leaks.length) {
  console.error(`Possible OpenAI key in the browser bundle:\n  ${leaks.join("\n  ")}`);
  process.exit(1);
}
console.warn(`Checked ${all.length} browser files: no OpenAI key${actualKey ? " (including the configured one)" : ""}.`);
