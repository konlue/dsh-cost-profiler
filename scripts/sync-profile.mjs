#!/usr/bin/env node
/**
 * Dev helper: sync the plugin source into locally installed profile copies.
 * pnpm's file: dependency packing caches aggressively, so during development
 * run this after editing the plugin, then toggle/reload the plugin in DSH.
 *
 * Usage: node scripts/sync-profile.mjs [profile ...]   (default: dev desktop)
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const root = path.resolve(import.meta.dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const home = process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh");

const FILES = ["package.json", "cordis.patch.yml", ...pkg.files.filter((f) => f !== "cordis.patch.yml" && f !== "icon.svg")];
const COPY = ["package.json", "cordis.patch.yml", "icon.svg", "README.md", "README.zh.md", "LICENSE", "CHANGELOG.md", "lib"];

const profiles = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ["dev", "desktop"];
for (const profile of profiles) {
  const dest = path.join(home, "profiles", profile, "node_modules", pkg.name);
  if (!fs.existsSync(path.dirname(dest))) {
    console.error(`skip ${profile}: ${path.dirname(dest)} does not exist (install the profile first)`);
    continue;
  }
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of COPY) {
    const from = path.join(root, entry);
    if (!fs.existsSync(from)) continue;
    fs.cpSync(from, path.join(dest, entry), { recursive: true });
  }
  console.log(`synced ${pkg.name}@${pkg.version} -> profile ${profile}`);
}
