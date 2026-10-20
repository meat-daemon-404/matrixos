#!/usr/bin/env node
/**
 * 把 .github/labels.txt 同步到仓库标签（本地版，替代未生效的 sync-labels.yml）。
 *
 * 背景：.github/workflows/sync-labels.yml 的注释写着「权益到位前可本地跑
 * scripts/sync-labels.mjs」，但这个脚本此前并不存在（2026-10-20 实测）。
 * 现在 CI 因账户计费未生效（BLK-001），本地版是唯一能让标签落地的路径。
 *
 * 用法：
 *   node scripts/sync-labels.mjs             创建/更新缺失的标签（不删多余的）
 *   node scripts/sync-labels.mjs --dry-run   只看会改什么
 *   node scripts/sync-labels.mjs --prune     同时删除 labels.txt 里没有的非默认标签
 *
 * labels.txt 格式：name | color | description（# 开头为注释）
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DRY = process.argv.includes("--dry-run");
const PRUNE = process.argv.includes("--prune");

// GitHub 默认标签，不该被 --prune 删掉
const GITHUB_DEFAULTS = new Set([
  "bug", "documentation", "duplicate", "enhancement", "good first issue",
  "help wanted", "invalid", "question", "wontfix", "accessibility",
]);

function gh(args, allowFail = false) {
  try {
    return execFileSync("gh", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (e) {
    const msg = String(e.stderr || e.message).trim().split("\n")[0];
    if (allowFail) return null;
    console.error(`  ✗ gh ${args.slice(0, 3).join(" ")} — ${msg}`);
    return null;
  }
}

function remoteSlug() {
  const url = execFileSync("git", ["remote", "get-url", "origin"], { cwd: ROOT, encoding: "utf8" }).trim();
  const m = url.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
  if (!m) throw new Error(`无法从 origin 推导仓库：${url}`);
  return `${m[1]}/${m[2]}`;
}

const REPO = remoteSlug();

const src = readFileSync(join(ROOT, ".github", "labels.txt"), "utf8");
const wanted = [];
for (const line of src.split(/\r?\n/)) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const cells = t.split("|").map((c) => c.trim());
  if (cells.length < 2 || !cells[0] || !/^[0-9a-fA-F]{6}$/.test(cells[1])) {
    console.warn(`跳过无法解析的行：${t}`);
    continue;
  }
  wanted.push({ name: cells[0], color: cells[1].toLowerCase(), description: cells[2] || "" });
}

console.log(`\n标签同步 → ${REPO}`);
console.log(`  labels.txt 定义 ${wanted.length} 个\n`);

let existing = [];
try {
  existing = JSON.parse(gh(["label", "list", "--repo", REPO, "--limit", "200", "--json", "name,color,description"]) || "[]");
} catch {
  console.error("无法读取现有标签（gh 未登录？先跑 gh auth status）");
  process.exit(1);
}
const byName = new Map(existing.map((l) => [l.name, l]));

let created = 0, updated = 0, same = 0;
for (const w of wanted) {
  const cur = byName.get(w.name);
  if (!cur) {
    console.log(`  + ${w.name}`);
    created++;
    if (!DRY) gh(["label", "create", "--repo", REPO, "--color", w.color, "--description", w.description, w.name]);
  } else if (cur.color.toLowerCase() !== w.color || (cur.description || "") !== w.description) {
    console.log(`  ~ ${w.name}（颜色/描述变更）`);
    updated++;
    if (!DRY) gh(["label", "edit", "--repo", REPO, "--color", w.color, "--description", w.description, w.name]);
  } else {
    same++;
  }
}

if (PRUNE) {
  const keep = new Set(wanted.map((w) => w.name));
  const extras = existing.filter((l) => !keep.has(l.name) && !GITHUB_DEFAULTS.has(l.name));
  for (const l of extras) {
    console.log(`  - ${l.name}（labels.txt 中已不存在）`);
    if (!DRY) gh(["label", "delete", "--repo", REPO, l.name]);
  }
}

console.log(`\n${DRY ? "(dry-run) " : ""}新建 ${created}，更新 ${updated}，已一致 ${same}`);
if (created || updated) console.log("下一个代理/成员即可用 status:claimed 等标签认领工作。");
console.log("");
