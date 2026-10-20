#!/usr/bin/env node
/**
 * 认领工具 —— 防止重复动工的单一入口。
 *
 * 为什么需要它（2026-10-20 实测）：
 *   #1–#22 导入后一天内，main 上 27 个提交有 26 个没挂任何 Issue 号，
 *   其中不少 Stage 1 任务其实已经做完或推进了；
 *   但 Issue 全部仍为 open、0 assignee、0 关联 PR。
 *   任何人查台账都会得出「这些还没人做」的错误结论 → 重复动工。
 *
 * 规则（详见 .github/CONTRIBUTING.md 第 2.1 节「不在台账上认领，就不开工」）：
 *   没在台账上认领的活，不开工。
 *
 * 用法：
 *   node scripts/claim.mjs ls                 看台账：谁在做什么 / 什么真空着
 *   node scripts/claim.mjs ls --stage stage-1 按标签过滤
 *   node scripts/claim.mjs ls --deep          用标题关键词回查 main，标出「疑似已动工」
 *   node scripts/claim.mjs ls --days 7        调整「不可见提交」的统计窗口（默认 3 天）
 *   node scripts/claim.mjs claim 16           认领 #16（assignee + status:claimed）
 *   node scripts/claim.mjs claim 16 --note "先做 schema 生成"  认领并留痕
 *   node scripts/claim.mjs branch 16 curvelab 从认领项建分支 feat/16-curvelab
 *   node scripts/claim.mjs pr 16              用当前分支开 PR，正文自动写 Closes #16
 *   node scripts/claim.mjs done 16 --evidence "typecheck 25/25；截图见 PR"  带证据关闭
 *   node scripts/claim.mjs release 16         释放认领（不做了 / 移交给别人）
 *
 * 依赖：gh CLI 已登录（gh auth status）。
 * 退出码：0 成功；1 参数/前置条件不满足；2 gh 调用失败。
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const LABEL_CLAIMED = "status:claimed";
const LABEL_REVIEW = "status:in-review";
const LABEL_BLOCKED = "blocked";

// ---------- 基础设施 ----------

function sh(cmd, args = []) {
  try {
    return execFileSync(cmd, args, { cwd: ROOT, encoding: "utf8" }).trim();
  } catch (e) {
    const detail = String(e.stdout || e.stderr || e.message).trim().split("\n").slice(0, 4).join("\n  ");
    die(`命令失败：${cmd} ${args.join(" ")}\n  ${detail}`, 2);
  }
}

function gh(args) {
  return sh("gh", args);
}

function ghJson(args) {
  const out = gh(args);
  try {
    return JSON.parse(out || "[]");
  } catch {
    die(`无法解析 gh 输出：\n${out.slice(0, 400)}`, 2);
  }
}

function die(msg, code = 1) {
  console.error(`\n✗ ${msg}\n`);
  process.exit(code);
}

/** 从 origin 推导 owner/repo，避免硬编码仓库名。 */
function repoSlug() {
  const url = sh("git", ["remote", "get-url", "origin"]);
  const m = url.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
  if (!m) die(`无法从 origin 推导 GitHub 仓库：${url}`);
  return `${m[1]}/${m[2]}`;
}

const REPO = repoSlug();

function me() {
  return gh(["api", "user", "--jq", ".login"]);
}

// ---------- 参数解析 ----------

function parseArgs(argv) {
  const verb = argv[2];
  const rest = argv.slice(3);
  const flags = {};
  const pos = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = rest[i + 1];
      if (next === undefined || next.startsWith("--")) flags[key] = true;
      else {
        flags[key] = next;
        i++;
      }
    } else pos.push(a);
  }
  return { verb, num: pos[0], pos, flags };
}

function needIssue(num) {
  const n = Number(num);
  if (!Number.isInteger(n) || n <= 0) {
    die("缺少 Issue 编号。用法示例：node scripts/claim.mjs claim 16");
  }
  return n;
}

// ---------- 台账读取 ----------

function readOpenIssues(labelFilter, limitFlag) {
  const n = Number(limitFlag);
  const limit = Number.isInteger(n) && n > 0 ? Math.min(n, 300) : 200;
  const args = ["issue", "list", "--repo", REPO, "--state", "open", "--limit", String(limit),
    "--json", "number,title,assignees,labels,updatedAt"];
  if (labelFilter) args.push("--label", labelFilter);
  return ghJson(args);
}

/**
 * 把所有 PR（含已合并）的正文扫一遍，建立 issue# -> PR 列表 的映射。
 * 这是「活干到哪一步了」的唯一可靠依据：本地分支别人看不见，PR 链接看得见。
 */
function mapClosingIssues() {
  const prs = ghJson(["pr", "list", "--repo", REPO, "--state", "all", "--limit", "200",
    "--json", "number,title,state,url,headRefName,body"]);
  const map = new Map();
  for (const pr of prs) {
    const refs = new Set();
    const text = `${pr.body || ""}\n${pr.title || ""}`;
    // Closes/Fixes/Resolves #12；也认 issue 完整 URL
    for (const m of text.matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s*#(\d+)/gi)) refs.add(Number(m[1]));
    for (const m of text.matchAll(new RegExp(`${REPO}/issues/(\\d+)`, "gi"))) refs.add(Number(m[1]));
    for (const n of refs) {
      if (!map.has(n)) map.set(n, []);
      map.get(n).push(pr);
    }
  }
  return map;
}

function labelNames(issue) {
  return (issue.labels || []).map((l) => l.name);
}

/** 远端分支里是否有指向这个 issue 的（约定：feat/16-xxx / fix/16-xxx）。 */
function remoteBranches() {
  const out = sh("git", ["ls-remote", "--heads", "origin"]);
  return out.split(/\r?\n/).filter(Boolean).map((l) => l.split("\t")[1]?.replace("refs/heads/", "")).filter(Boolean);
}

function branchForIssue(branches, n) {
  return branches.filter((b) => new RegExp(`^(feat|fix|docs|chore|spec)/${n}-`).test(b));
}

// ---------- 输出 ----------

/**
 * main 上没挂任何 Issue 的提交 = 不可见工作。
 * 这是重复动工真正的来源：台账上「没人做」，实际上早做完了。
 * 认领标记和 PR 都看不见它——只有 git 看得见。
 */
function blindCommits(days) {
  const out = sh("git", ["log", "origin/main", `--since=${days} days ago`,
    "--pretty=%h\x1f%ad\x1f%s", "--date=short"]);
  const rows = out.split(/\r?\n/).filter(Boolean).map((l) => {
    const [h, d, s] = l.split("\x1f");
    return { h, d, s };
  });
  const linked = /#\d+|S[1-4]-\d+[ex]?\b|BLK-\d+/i;
  return { total: rows.length, blind: rows.filter((r) => !linked.test(r.s)) };
}

/** main 的提交（标题+正文），只读一次，供 --deep 在内存里匹配。 */
let _commitCache = null;
function mainCommits() {
  if (_commitCache === null) {
    // 提交正文写得很细（「18 站全部接入真实仪器」「typecheck 25/25」），
    // 只搜标题会漏掉大量真实信号，所以连正文一起搜。
    const out = sh("git", ["log", "origin/main", "--pretty=%s%n%b%n\x1e", "-200"]);
    _commitCache = out.split("\x1e").map((b) => b.toLowerCase().trim()).filter(Boolean);
  }
  return _commitCache;
}

/**
 * 用 Issue 标题里的技术标识符回查 main 的提交，找「疑似已动工」。
 * 只作提示，不作结论——结论要有人读代码确认。
 *
 * 为什么不能只看单词命中：本仓提交正文很长，`packages` / `services` / `token`
 * 这类词几乎每个提交都有，单命中会给出大片假信号（#23–#26 纯决策项也一样会被误标）。
 * 真正的信号是**共现**：同一个提交里同时出现这条 Issue 的多个专属词，
 * 才说明那个提交就是在做这件事。
 */
const GENERIC_TERMS = new Set([
  "services", "packages", "scripts", "github", "actions", "stage", "matrixos",
  "schema", "token", "payload", "assets", "config", "components", "typescript",
  "iframe", "scope", "domain", "monorepo", "next.js", "docs", "src", "json",
]);

function commitHint(title) {
  const commits = mainCommits();
  const idents = new Set(); // 强信号：反引号/斜杠内的标识符、英文技术词、WBS 任务号
  const words = new Set();  // 弱信号：中文词，只当旁证
  for (const m of title.matchAll(/[`/]([A-Za-z0-9_.:/-]{4,})[`/]/g)) idents.add(m[1].toLowerCase());
  for (const m of title.matchAll(/\b([A-Za-z][\w.-]{4,})\b/g)) idents.add(m[1].toLowerCase());
  for (const m of title.matchAll(/\bS[1-4]-\d+[ex]?\b/gi)) idents.add(m[0]);
  for (const m of title.matchAll(/[\u4e00-\u9fff]{3,6}/g)) words.add(m[0]);

  const specific = [...idents].filter((t) => !GENERIC_TERMS.has(t));

  // 共现打分：每个提交数它命中了几个专属词，取最高的那个提交
  let bestCo = 0;
  let bestCommit = null;
  const perTerm = new Map();
  for (const body of commits) {
    let c = 0;
    for (const t of specific) {
      if (body.includes(t)) {
        c++;
        perTerm.set(t, (perTerm.get(t) || 0) + 1);
      }
    }
    if (c > bestCo) {
      bestCo = c;
      bestCommit = body.split(/\r?\n/)[0].slice(0, 40);
    }
  }

  const top = [...perTerm].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([t, c]) => `${t}\u00d7${c}`);
  return {
    co: bestCo,             // 单个提交内同时命中最多专属词的数量
    spread: perTerm.size,   // 有多少个专属词在历史上出现过
    top,
    commit: bestCommit,
    zh: [...words].filter((w) => commits.some((b) => b.includes(w))).length,
  };
}

function padEnd(str, width) {
  // 中文按 2 列宽度估算，表格才对得齐
  let w = 0;
  for (const ch of str) w += /[\u3000-\u312f\uff00-\uffef\u4e00-\u9fff\u{1f000}-\u{1fbff}]/u.test(ch) ? 2 : 1;
  return str + " ".repeat(Math.max(0, width - w));
}

function cmdLs(flags) {
  const issues = readOpenIssues(flags.stage ?? flags.label, flags.limit);
  const closing = mapClosingIssues();
  const branches = remoteBranches();
  const days = Number(flags.days ?? 3);

  const claimed = [];
  const inReview = [];
  const free = [];
  const staleSuspects = [];

  for (const it of issues) {
    const labs = labelNames(it);
    const who = (it.assignees || []).map((a) => a.login).join(",");
    const prs = closing.get(it.number) || [];
    const openPr = prs.find((p) => p.state === "OPEN");
    const mergedPr = prs.find((p) => p.state === "MERGED");
    const brs = branchForIssue(branches, it.number);

    const row = {
      n: it.number, title: it.title, who, labs,
      pr: openPr ? `#${openPr.number}` : mergedPr ? `#${mergedPr.number}已合并` : "-",
      branch: brs[0] || "-",
    };

    if (openPr || labs.includes(LABEL_REVIEW)) inReview.push(row);
    else if (who || labs.includes(LABEL_CLAIMED)) claimed.push(row);
    else free.push(row);

    if (mergedPr && !who && it.state === "OPEN") staleSuspects.push({ ...row, why: "有 PR 已合并但 Issue 还开着" });
    if (brs.length && !who && !openPr) staleSuspects.push({ ...row, why: `远端有分支 ${brs[0]} 但无人认领` });
  }

  const print = (title, rows) => {
    console.log(`\n${title}（${rows.length}）`);
    if (!rows.length) return console.log("  （无）");
    for (const r of rows) {
      const pri = r.labs.find((l) => /^P\d$/.test(l)) || "?";
      console.log(`  ${padEnd("#" + r.n, 6)}${padEnd(pri, 4)}${padEnd(r.who || "—", 16)}${padEnd(`PR:${r.pr}`, 14)}${r.title.slice(0, 58)}`);
    }
  };

  console.log(`\n台账 ${REPO} · open ${issues.length} 项`);
  console.log(`  ${padEnd("编号", 6)}${padEnd("优先", 4)}${padEnd("认领人", 16)}${padEnd("PR", 14)}标题`);
  print("🔵 评审中（有开着的 PR，别碰同一批文件）", inReview);
  print("🟡 已认领（有人在写）", claimed);
  print("⚪ 空闲（可认领）", free);

  // ⚠️ 这一段刻意不给「一切正常」的安慰：台账没有 PR 记录时，
  //    "没发现失真" 恰恰是最危险的假信号。真正的失真在 git 里。
  const blind = blindCommits(days);
  if (blind.total === 0) {
    console.log(`\nℹ️ 近 ${days} 天 main 无提交，无法据此判断台账是否跟得上代码。`);
  } else {
    console.log(`\n近 ${days} 天 main 有 ${blind.total} 个提交，其中 ${blind.blind.length} 个没挂任何 Issue/任务号：`);
    if (blind.blind.length === 0) {
      console.log("  ✓ 全部可追溯到台账");
    } else {
      for (const c of blind.blind.slice(0, 12)) console.log(`  ${c.h} ${c.d}  ${c.s.slice(0, 64)}`);
      if (blind.blind.length > 12) console.log(`  …另有 ${blind.blind.length - 12} 个`);
      console.log(`\n🔴 台账落后于代码：这些活已经在 main 上了，但对应 Issue 仍显示空闲。`);
      console.log(`   照这张表开工就是重复动工。先对账：`);
      console.log(`     node scripts/claim.mjs done <编号> --evidence "..."   确认已完成的，带证据关闭`);
      console.log(`   核不动的，宁可 release / block，也不要留着误导下一个人。`);
    }
  }

  if (staleSuspects.length) {
    console.log(`\n⚠️ 状态不一致（${staleSuspects.length}）`);
    for (const r of staleSuspects) console.log(`  #${r.n} ${r.why}｜${r.title.slice(0, 50)}`);
  }

  if (flags.deep) {
    console.log(`\n🔍 深查：拿每个空闲 Issue 的技术标识符回查 main，看有没有提交就是在做它（提示，不是结论）`);
    const ranked = free.map((r) => ({ r, h: commitHint(r.title) }));
    // 排序以共现为主、命中词数为次：一个提交里共现多个专属词，才说明它就在做这件事
    ranked.sort((a, b) => (b.h.co - a.h.co) || (b.h.spread - a.h.spread));
    for (const { r, h } of ranked) {
      const decision = /\u51b3\u7b56/.test(r.title); // 标题含「决策」：代码无法"完成"它
      const dense = h.spread >= 2 && h.co >= 2;
      let tag;
      if (decision) tag = "决策项";
      else if (dense) tag = "疑似已动工";
      else if (h.co >= 1 || h.spread >= 3) tag = "有相关提交";
      else tag = "未见相关提交";
      const ev = h.commit ? `← ${h.commit}` : h.top.join(" ") || "—";
      console.log(`  #${padEnd(String(r.n), 5)}${padEnd(tag, 14)}共现 ${String(h.co).padStart(2)} 词 ${String(h.spread).padStart(2)}  ${ev}`);
    }
    console.log(`\n  「疑似已动工」必须有人读代码确认，确认后才用 done --evidence 关闭。`);
    console.log(`  「决策项」不是代码任务，用 block 标记，不要用写代码的方式关闭。`);
  } else {
    console.log(`\n加 --deep 可用标题关键词回查 main，标出「疑似已动工」的空闲项。`);
  }

  console.log(`\n下一步：node scripts/claim.mjs claim <编号>   然后   node scripts/claim.mjs branch <编号> <slug>\n`);
}

// ---------- 写操作 ----------

function cmdClaim(n, flags) {
  const who = me();
  const detail = ghJson(["issue", "view", String(n), "--repo", REPO,
    "--json", "number,title,state,assignees,labels"]);
  if (detail.state !== "OPEN") die(`#${n} 当前状态 ${detail.state}，不需要认领`);

  const others = (detail.assignees || []).map((a) => a.login).filter((l) => l !== who);
  const labs = (detail.labels || []).map((l) => l.name);
  if (others.length && !flags.force) {
    die(`#${n} 已被 ${others.join(", ")} 认领。\n  重复动工正是这样产生的。请先在 Issue 里沟通；确认接手再加 --force`);
  }

  gh(["issue", "edit", String(n), "--repo", REPO, "--add-assignee", who]);
  if (!labs.includes(LABEL_CLAIMED)) gh(["issue", "edit", String(n), "--repo", REPO, "--add-label", LABEL_CLAIMED]);

  const note = typeof flags.note === "string" ? `\n> 备注：${flags.note}` : "";
  gh(["issue", "comment", String(n), "--repo", REPO, "--body",
    `### 🙋 已认领\n\n认领人 @${who}（${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC）。${note}\n\n其他人请勿就同一范围开工。`]);

  console.log(`\n✓ #${n} 已认领给 ${who}｜${detail.title}`);
  console.log(`  建分支：node scripts/claim.mjs branch ${n} <slug>`);
  console.log(`  不做了就释放：node scripts/claim.mjs release ${n}\n`);
}

function cmdRelease(n, flags) {
  const who = me();
  const detail = ghJson(["issue", "view", String(n), "--repo", REPO, "--json", "state,assignees,labels"]);
  if (detail.state !== "OPEN") die(`#${n} 已关闭，无需释放`);
  const labs = (detail.labels || []).map((l) => l.name);
  const mine = (detail.assignees || []).map((a) => a.login);
  if (!mine.includes(who) && !flags.force) {
    die(`#${n} 的认领人是 ${mine.join(", ") || "（空）"}，不是你。要强制接管请直接用 claim --force 并与对方沟通`);
  }
  gh(["issue", "edit", String(n), "--repo", REPO, "--remove-assignee", who]);
  if (labs.includes(LABEL_CLAIMED)) gh(["issue", "edit", String(n), "--repo", REPO, "--remove-label", LABEL_CLAIMED]);
  gh(["issue", "comment", String(n), "--repo", REPO, "--body", `↩️ @${who} 已释放认领，回到空闲。`]);
  console.log(`\n✓ #${n} 已释放\n`);
}

function cmdDone(n, flags) {
  const evidence = flags.evidence || flags.note;
  if (!evidence || evidence === true) {
    die("关闭必须带证据：node scripts/claim.mjs done 16 --evidence \"typecheck 25/25 + 385 测试通过，见 PR #7\"\n" +
      "  没有证据的关闭会让下一个人在同一处重复开工。");
  }
  const detail = ghJson(["issue", "view", String(n), "--repo", REPO, "--json", "state,title"]);
  if (detail.state !== "OPEN") {
    console.log(`\n#${n} 已经是 ${detail.state}，只需补证据评论。\n`);
  }
  const who = me();
  gh(["issue", "comment", String(n), "--repo", REPO, "--body",
    `### ✅ 完成证据\n\n${evidence}\n\n由 @${who} 于 ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC 关闭。`]);
  gh(["issue", "close", String(n), "--repo", REPO, "--reason", "completed"]);
  console.log(`\n✓ #${n} 已关闭｜${detail.title}\n`);
}

// ---------- 分支与 PR ----------

function slugFromTitle(title) {
  const ascii = title.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
  return ascii.split("-").filter((w) => w.length > 1).slice(0, 3).join("-");
}

function cmdBranch(n, flags, slugArg) {
  const detail = ghJson(["issue", "view", String(n), "--repo", REPO, "--json", "title,labels,assignees"]);
  const who = me();
  const mine = (detail.assignees || []).map((a) => a.login);
  if (!mine.includes(who) && !flags.force) {
    die(`#${n} 的认领人不是你（${mine.join(", ") || "无人"}）。先 claim ${n}，别绕过台账直接开工。`);
  }
  const type = guessType(detail.title, detail.labels.map((l) => l.name));
  const slug = slugArg || slugFromTitle(detail.title) || `issue-${n}`;
  const branch = `${type}/${n}-${slug}`;
  const base = flags.base || "main";
  sh("git", ["fetch", "origin", base]);
  if (branchExists(branch)) die(`分支 ${branch} 已存在。切过去继续做：git checkout ${branch}`);
  sh("git", ["worktree", "add", `.worktrees/${branch}`, "-b", branch, `origin/${base}`]);
  console.log(`\n✓ 已在独立 worktree 建分支：${branch}`);
  console.log(`  进入：cd .worktrees/${branch}`);
  console.log(`  独立 worktree 的约定见 CONTRIBUTING「二、开工前必须认领」——不动别人正在改的工作区\n`);
}

function branchExists(name) {
  try {
    execFileSync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${name}`], { cwd: ROOT, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function guessType(title, labels) {
  const t = title.toLowerCase();
  if (labels.includes("type:spec")) return "spec";
  if (labels.includes("type:docs") || /文档|docs/.test(t)) return "docs";
  if (labels.includes("type:bug") || /修复|bug|失败/.test(t)) return "fix";
  if (labels.includes("type:infra") || labels.includes("type:chore")) return "chore";
  return "feat";
}

function cmdPr(n) {
  const branch = sh("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch === "main" || branch === "master") die("在 main 上，不能开 PR。先 node scripts/claim.mjs branch <编号> <slug>");
  const detail = ghJson(["issue", "view", String(n), "--repo", REPO, "--json", "title,state"]);
  if (detail.state !== "OPEN") die(`#${n} 已关闭，不要为它开 PR`);

  const template = (() => {
    try {
      return readFileSync(join(ROOT, ".github", "pull_request_template.md"), "utf8");
    } catch {
      return "";
    }
  })();
  const subject = sh("git", ["log", "-1", "--pretty=%s"]);
  const body = template
    .replace(/^Closes #\s*$/m, `Closes #${n}`)
    .replace(/^## PR 做了什么\n\n<!--.*?-->\n/m, `## PR 做了什么\n\n${subject}\n\nCloses #${n}\n`)
    .concat(`\n关联 Issue：#${n}\n`);

  const url = gh(["pr", "create", "--repo", REPO, "--base", "main", "--head", branch,
    "--title", subject.slice(0, 140), "--body", body]);
  gh(["issue", "edit", String(n), "--repo", REPO, "--add-label", LABEL_REVIEW]);
  gh(["issue", "comment", String(n), "--repo", REPO, "--body", `🔍 PR 已开：${url}\n评审通过并合并后本 Issue 会自动关闭（正文含 Closes #${n}）。`]);
  console.log(`\n✓ ${url}\n  #${n} 已打 ${LABEL_REVIEW}。合并前请确保本地 pnpm check 通过（远端 CI 见 BLK-001）。\n`);
}

// ---------- 主流程 ----------

const { verb, num, pos, flags } = parseArgs(process.argv);
const issueNum = num ? needIssue(num) : null;

switch (verb) {
  case undefined:
  case "help":
  case "--help":
  case "-h":
    console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0].replace(/^\/\*\*?/, ""));
    break;
  case "ls":
  case "list":
    cmdLs(flags);
    break;
  case "claim":
    cmdClaim(issueNum, flags);
    break;
  case "release":
    cmdRelease(issueNum, flags);
    break;
  case "done":
    cmdDone(issueNum, flags);
    break;
  case "branch":
    cmdBranch(issueNum, flags, pos[1]);
    break;
  case "pr":
    cmdPr(issueNum);
    break;
  case "block": {
    gh(["issue", "edit", String(issueNum), "--repo", REPO, "--add-label", LABEL_BLOCKED]);
    gh(["issue", "comment", String(issueNum), "--repo", REPO,
      "--body", `⛔ 标记为 ${LABEL_BLOCKED}：${flags.note || "需外部条件才能推进"}\n\n这不是「待办」，不要用写代码的方式关闭它——见 docs/02-engineering/00-known-issues.md。`]);
    console.log(`\n✓ #${issueNum} 已标记 ${LABEL_BLOCKED}\n`);
    break;
  }
  default:
    die(`未知命令 "${verb}"。可用：ls / claim / release / done / branch / pr / block`);
}
