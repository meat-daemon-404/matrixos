# ADR-001 · 18 微站编号与命名裁决：以花名册为准

| 项 | 内容 |
| :--- | :--- |
| **状态** | ✅ 已采纳（Accepted）· 但有 1 项待业务确认 |
| **裁决人** | Tech Lead |
| **裁决日期** | 2026-10-20 |
| **上游** | [ADR-000](00-adr-000-spec-authority.md)（v3 HTML 为权威源） |
| **影响** | Stage 1 全部微站脚手架任务（`S1-15` / `S1-16`） |

---

## Context · 背景

即便在权威源（v3 HTML 图谱）内部，18 个微站的**编号与命名也存在两套不一致的版本**：

### 版本 A：Tab 3 交互式花名册（`MICRO_SITES` JS 数组）

| ID | 目录/域名 | 名称 |
| :-- | :--- | :--- |
| 01 | gpa | 学分绩点动态配重台 |
| 02 | spark | 双创互补组队雷达 |
| 03 | grant-audit | 大创五科目经费液位仪 |
| 04 | pat-hot | PAT-HOT 学科脉冲雷达 |
| 05 | lit-sonar | 五源跨库引文声呐站 |
| 06 | mentor | 星门 · 导师五维星象仪 |
| 07 | cold-email | 证据内嵌式套磁信推演器 |
| 08 | lab-kanban | 太空任务式进组跟进台账 |
| 09 | matrix-cross | Matrix-Cross 跨论文对比矩阵 |
| 10 | pdf-sniper | PDF 公式与参量狙击镜 |
| 11 | curvelab | CurveLab 非线性拟合示波器 |
| 12 | repro-check | 顶刊代码复现核验舱 |
| 13 | chart-foundry | Nature 级出版图表熔炉 |
| 14 | review-lab | 综述拓扑推演与写作舱 |
| 15 | retract-radar | 撤稿深海声呐与伦理合规仪 |
| 16 | yunheng | 云衡 · 数字天平综测核算器 |
| 17 | evidence-cv | 区块链级学术证据简历工坊 |
| 18 | prejob | 生涯多重宇宙期望决策树 |

### 版本 B：Tab 6 Agent 规范中的 Monorepo 目录树

```
01-gpa-sandbox/      02-spark-teaming/    03-grant-audit/     04-pat-radar/
05-xingmen-mentor/   06-cold-email-lab/  07-lit-sonar/       08-matrix-cross/
09-pdf-sniper/       10-curvelab-fit/    11-repro-check/     12-chart-foundry/
13-review-architect/ 14-retract-radar/   15-journal-compass/ 16-yunheng-scale/
17-evidence-cv/      18-prejob-multiverse/
```

### 两版的三处实质冲突

| # | 冲突 | 版本 A（花名册） | 版本 B（目录树） |
| :-- | :--- | :--- | :--- |
| **1** | **多出一站** | 15 = `retract-radar` 撤稿声呐 | 15 = `journal-compass` **期刊投稿罗盘**（花名册中**根本不存在**此站） |
| **2** | **星门拆分 vs 合并** | 06 `mentor` 与 08 `lab-kanban` 是**两站** | 05 `xingmen-mentor` 把「导师+进组任务看板」**合并为一站** |
| **3** | **编号整体错位** | 05=`lit-sonar`, 06=`mentor`, 09=`matrix-cross` | 07=`lit-sonar`, 05=`xingmen-mentor`, 08=`matrix-cross` |

冲突根源：版本 B 的目录树从 05 起整体错位，导致 06–18 全部对不上。

### 证据

```powershell
# 版本 A：从 HTML 内嵌 JS 解析，已落盘
Get-Content specs/microsites.json -Raw | ConvertFrom-Json | Select id,domain

# 版本 B：HTML 的 Tab 6 目录树
Select-String -Path bundle\MatrixOS_v3_*.html -Pattern 'journal-compass'
# 命中 1 次，位于 "## 3. Monorepo 工程目录结构规范" 的 ```text 代码块内
```

`journal-compass` 在全文件中**仅出现 1 次**，且只在目录树里——花名册、UI 拆解图、交互沙盘、虫洞投送目标中**均无此站**。

---

## Decision · 裁决

### 主裁决：以版本 A（花名册）为唯一权威

**理由**

1. **完整性**：花名册是结构化数据（18 条，含 `orbit` / `orbitName` / `name` / `domain` / `source` / `uiStyle` / `ledger` / `desc` 八字段），目录树只是注释性的目录清单
2. **被引用**：花名册被 Tab 2 交互沙盘、Tab 4 插槽协议模拟器、虫洞投送目标列表实际消费；目录树无任何代码引用
3. **可校验**：花名册已落盘为 `specs/microsites.json`，纳入 CI 校验（id 连续性、域名唯一、轨道分布 3/5/7/3）
4. **星门必须拆三站**：Tab 1 的 UI 拆解图明确分列「星门导师匹配雷达」与「四阶段太空任务进组看板」，且 `source` 标注三站均为「星门 实机原型」——合并会丢失进组看板独立台账的产品价值

### 目录命名规范（采纳版本 B 的命名风格，编号用版本 A）

版本 B 的目录名更具描述性（`gpa-sandbox` 优于 `gpa`，`curvelab-fit` 优于 `curvelab`），予以保留。**最终命名 = 版本 A 的编号与站点归属 + 版本 B 的描述性词根**：

| ID | 目录名 | 域名 |
| :-- | :--- | :--- |
| 01 | `01-gpa-sandbox` | `gpa.matrixos.edu` |
| 02 | `02-spark-teaming` | `spark.matrixos.edu` |
| 03 | `03-grant-audit` | `grant-audit.matrixos.edu` |
| 04 | `04-pat-radar` | `pat-hot.matrixos.edu` |
| 05 | `05-lit-sonar` | `lit-sonar.matrixos.edu` |
| 06 | `06-xingmen-mentor` | `mentor.matrixos.edu` |
| 07 | `07-cold-email-lab` | `cold-email.matrixos.edu` |
| 08 | `08-lab-kanban` | `lab-kanban.matrixos.edu` |
| 09 | `09-matrix-cross` | `matrix-cross.matrixos.edu` |
| 10 | `10-pdf-sniper` | `pdf-sniper.matrixos.edu` |
| 11 | `11-curvelab-fit` | `curvelab.matrixos.edu` |
| 12 | `12-repro-check` | `repro-check.matrixos.edu` |
| 13 | `13-chart-foundry` | `chart-foundry.matrixos.edu` |
| 14 | `14-review-architect` | `review-lab.matrixos.edu` |
| 15 | `15-retract-radar` | `retract-radar.matrixos.edu` |
| 16 | `16-yunheng-scale` | `yunheng.matrixos.edu` |
| 17 | `17-evidence-cv` | `evidence-cv.matrixos.edu` |
| 18 | `18-prejob-multiverse` | `prejob.matrixos.edu` |

> 注意：**域名与目录名可不一致**。域名是产品对外标识（花名册为准），目录名是工程内部命名（描述性优先）。例如 14 的目录是 `review-architect`，但域名是 `review-lab`；04 的目录是 `pat-radar`，域名是 `pat-hot`。这是**刻意**的，避免目录改名引发域名迁移。

### 关于 `journal-compass`（期刊投稿罗盘）

**判定：暂不纳入 18 官方旗舰站。** 列为 Backlog 候选。

理由：
- 花名册无此站，UI 拆解图无此站设计
- 若要做，将变成 **19 站**，破坏「18 官方旗舰」的产品叙事与轨道分布（3/5/7/3）
- 但「期刊审稿周期与命中率」是真实科研痛点，不该丢

**处置**：若业务方确认要做，作为**第 19 号插槽**通过 `@matrixos/sdk` 挂载（这也是 Q5 生态机制的本意——官方控 18，其余走插槽）。

> ⏳ **此项待业务方拍板**，已登记为 Issue 待确认项。在拍板前，Stage 1 按 18 站推进，不做 journal-compass。

---

## Consequences · 影响

### 正面

- Stage 1 脚手架生成器（`S1-15`）有了确定的命名规则，不会因编号歧义返工
- `specs/microsites.json` 与 CI 校验形成闭环，后续任何人改动花名册都会被 CI 拦下
- 目录名描述性优于纯域名，工程可读性更好

### 负面

- 目录名与域名不一致（14、04）会让新人困惑 → 在 `docs/02-engineering/01-dev-setup.md` 加映射表说明
- `journal-compass` 悬而未决，若后期加入需占用插槽名额

### 风险

| 风险 | 缓解 |
| :--- | :--- |
| 业务方坚持要 journal-compass 且要进官方 18 | 需替换掉某站，届时重新评审轨道分布 |
| 有人照抄 Tab 6 目录树建站 | CI 的花名册校验会因 id/域名不匹配而红 |

---

## Alternatives · 备选方案

| 方案 | 否决理由 |
| :--- | :--- |
| 以目录树（版本 B）为准 | 目录树含不存在的 `journal-compass`，且把星门三站合并，丢失进组看板独立价值 |
| 两版合并取并集 | 会得到 19 站，破坏产品叙事 |
| 保持两套并存，不裁决 | 脚手架生成器无法确定建几个站、叫什么名，Stage 1 无法开工 |

---

## 执行检查点

- [ ] `specs/microsites.json` 保持不变（已是权威）
- [ ] `S1-15` 脚手架生成器按本 ADR 的命名表实现
- [ ] `S1-16` 首批 6 站按本 ADR 编号（01/04/06/09/11/16）
- [ ] CI 校验已覆盖 id 连续性与轨道分布（`S1-18`）
- [ ] `journal-compass` 决策已登记为待确认 Issue

---

## 附录 · 复现方式

```bash
# 版本 A（花名册，18 条）
node -e "console.log(require('./specs/microsites.json').map(s=>s.id+'-'+s.domain).join('\n'))"

# 版本 B（目录树，从 HTML 提取）
grep -oP '├── \d\d-[a-z0-9-]+/' bundle/MatrixOS_v3_*.html

# journal-compass 出现次数（预期 1，仅在目录树）
grep -c 'journal-compass' bundle/MatrixOS_v3_*.html
```
