#!/usr/bin/env node
/**
 * 自检：`claim.mjs pr` 的 PR 正文模板替换是否正确。
 *
 * 为什么单独测这个：模板里有两个占位点（标题下的注释、`Closes #` 行）。
 * 上一版把 Closes 同时塞进两处替换，产出两行 `Closes #28` 再加一行「关联 Issue」——
 * 三处写同一件事，GitHub 的自动关闭语义虽然还在，但正文自相矛盾。
 * 这类错误不影响脚本退出码，只能靠断言拦。
 *
 * 用法：node scripts/test-pr-template.mjs
 * 不联网、不建 PR，只验证字符串替换。
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const template = readFileSync(join(ROOT, ".github", "pull_request_template.md"), "utf8");

const n = 42;
const subject = "fix(42): 示例提交标题";

// 与 claim.mjs cmdPr 中的替换保持一致
const body = template
  .replace(/(## PR 做了什么\n\n)<!--[^>]*-->/, "$1" + subject)
  .replace(/^Closes #\s*$/m, `Closes #${n}`);

const fails = [];
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? `  ${detail}` : ""}`);
  if (!ok) fails.push(label);
};

const closes = body.match(/Closes\s+#\d+/g) || [];
check("模板仍有 Closes 占位行", /^Closes #\s*$/m.test(template));
check("替换后只剩一行 Closes", closes.length === 1, `实际 ${closes.length} 行: ${JSON.stringify(closes)}`);
check("Closes 指向正确编号", closes[0] === `Closes #${n}`, closes[0]);
check("commit subject 已填入标题段", body.includes(subject));
check("占位注释已被替换掉（首段）", !/<!--.*?-->/.test(body.split("## 变更类型")[0]));
check("未追加重复的「关联 Issue」行", !body.includes("关联 Issue："));
check("模板其余小节未被吞掉",
  body.includes("## 变更类型") && body.includes("## 验证方式") && body.includes("## 自查清单"));

console.log("");
if (fails.length) {
  console.error(`✗ PR 模板自检失败 ${fails.length} 项：${fails.join(" / ")}`);
  process.exit(1);
}
console.log("✓ PR 模板自检全部通过");
