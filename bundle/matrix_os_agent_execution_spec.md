# 智轨星云 (MatrixOS) - 面向工程 Agent 的系统级全域开发与执行规范 (System Prompt & Execution Blueprint)

> **文档适用对象**：全自主代码研发与系统编排 Agent（如 Cursor / Claude Code / Devin / Task-Mode LLM）。  
> **执行指令级别**：P0 级核心工程架构指令。Agent 接入本规范后，必须严格遵循本文档所定义的模块边界、状态机流转协议与原型对接规范执行开发。

---

## 1. 核心战略定位与业务意图 (Mission & Intent)

### 1.1 业务背景与终极目的
传统高校科研教育面临三大断层：**工具孤岛**（文献/拟合/写作/套磁各自割裂）、**前沿脱节**（本科生缺乏垂域前沿情报与代码复现抓手）、**成果流失**（科研过程数据无法资产化转化为综测与求职竞争力）。  
**MatrixOS (智轨星云)** 的核心目的，是将现已独立运行上线的 4 大成熟原型全面打通，重构为面向高校拔尖创新人才的**全域科研工作台与学术数字资产操作系统**，形成覆盖“学业 - 科研 - 生涯”的 7 站闭环（学阶 Study → 星火 Spark → PAT-HOT → 星门 Xingmen → 学术星轨工坊 → 云衡 Asset → 预职 Pre-Job）。

### 1.2 核心架构原则：双端不对称协同 (Asymmetric Dual-Engine)
Agent 在研发时必须严格贯彻端侧分工，杜绝将桌面重型功能盲目搬运至移动端：
1. **口袋微信小程序（移动伴侣端 · 高频碎片化）**：
   * **核心场景**：晨间情报速递（PAT-HOT 24h 前沿精选）、学业微目标每日执行打卡、星门进组与面试状态实时提醒、个人学术名片快捷展示。
   * **性能指标**：冷启动 < 800ms，以卡片式推送与单手轻交互为主，支持“一键推入电脑端 WebOS 待读队列”。
2. **桌面 WebOS 动态画布工作台（重型攻坚端 · 长周期深任务）**：
   * **核心场景**：跨论文长文本横向对比矩阵、30+ 统计非线性回归实验台、规范写作与综述初稿推演、预职全息决策树。
   * **调度机制**：用户通过自适应画布或与中台 Agent 对话，中台根据学生意图自动调度微服务池，动态装配工作区。

---

## 2. 四大现存实机原型整合与重构规范 (Prototype Integration)

Agent 必须对接并解耦以下 4 个已部署运行的原型系统：

| 原型模块 | 线上基准地址 | 现有能力资产 | Agent 解耦与集成目标 |
| :--- | :--- | :--- | :--- |
| **ScholarMatrix** | [在线地址](https://www.google.com/search?q=https%3A%2F%2Fscholarmatrix.cc.cd)<br>(备用: [镜像](https://www.google.com/search?q=https%3A%2F%2Fscholarmatrix.pages.dev%2Fland%2F)) | 42+ 工具、Cross-Paper 对比矩阵、统计拟合实验台、综述初稿生成 | 拆解为原子微服务（Microservices），封装为标准化 REST/gRPC 协议工具池。 |
| **星门 (Xingmen)** | [在线地址](https://www.google.com/search?q=https%3A%2F%2Fxingmen-mentor.pages.dev%2F) | 导师全景学术画像、自适应个性化套磁信推演、进组进度台账管理 | 对接 OpenAlex 导师图谱 API，将套磁信生成与跟进台账作为独立工作流接入 Agent。 |
| **PAT-HOT** | [在线地址](https://www.google.com/search?q=https%3A%2F%2Fpat-hot.pages.dev) | 物理、天文、光电垂直学科 24h 流式情报监听、热度评估算法 | 封装流式爬虫监听 Worker，每日 08:00 定时向小程序端推送结构化早报 JSON。 |
| **预职 (Pre-Job)** | [在线地址](https://www.google.com/search?q=https%3A%2F%2Fa9b81a7031ed59d7a.app.workbuddy.host%2F) | 证据级学术智能简历、升学/考公/求职多维决策树、成长档案 | 承接科研过程资产，自动生成符合高校“云衡”综测申报规范的格式化成果包。 |

---

## 3. 2026 前沿大模型调度矩阵与成本控制 (Model Architecture)

Agent 必须配置分级调度路由，实现极低推理成本与极致吞吐：

```
[用户意图输入]
      │
      ▼
┌───────────────────────────────┐
│ 意图路由层：DeepSeek V4.1 Flash │ ◄── ¥0.3/百万Token (高频分词/早报/意图分类)
└──────────────┬────────────────┘
               │
      ┌────────┴────────┬─────────────────────────┐
      ▼                 ▼                         ▼
[轻量自愈与校验]   [长文本科研攻坚]            [垂直学科端侧蒸馏]
 Qwen 3.8 Flash    DeepSeek V4 Pro           Qwen 3.8-7B LoRA
 (¥0.4/百万Token)  (¥2.0/百万Token)          (本地算力 · 免Token费)
 • 参数格式校验    • 跨论文长上下文对比矩阵    • 物理/光电专业术语校准
 • 代码自动修复    • 30+ 统计回归建模推演     • 导师匹配度向量空间对齐
 • Agent链路重试   • 综述与申报书初稿生成     • 课题组本地数据隐私隔离
```

---

## 4. 中台调度 Agent 状态机与工作流执行协议 (Workflow Specification)

### 4.1 五步执行流水线 (Execution Pipeline)
1. **Step 1 (Intent Parse)**：接收自然语言指令，解析目标学科、阶段阶段（0-6 对应 7 站）与所需微服务。
2. **Step 2 (Plan & Route)**：生成 DAG（有向无环图）执行计划，明确前置依赖（如：先拉取 PAT-HOT 文献，再提取参量，最后装配对比矩阵）。
3. **Step 3 (Specialist Dispatch)**：唤醒对应垂直专席 Agent（物理光电、生物医药、计算工程、人文法学）。
4. **Step 4 (Microservice Invocation)**：并发调用微服务 API，捕获异常并通过 Qwen 3.8 Flash 自愈修复。
5. **Step 5 (Canvas Render & Asset Sync)**：将结构化结果推送至桌面 WebOS 画布渲染，同时向移动端同步状态。

### 4.2 统一数据交换协议 (JSON Schema)
```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "MatrixOS_Dispatch_Contract",
  "type": "object",
  "required": ["trace_id", "user_id", "intent", "station_id", "workflow"],
  "properties": {
    "trace_id": { "type": "string" },
    "user_id": { "type": "string" },
    "station_id": { 
      "type": "string", 
      "enum": ["study", "spark", "pat_hot", "xingmen", "workshop", "cloud_balance", "pre_job"] 
    },
    "intent": {
      "type": "object",
      "properties": {
        "action": { "type": "string" },
        "discipline": { "type": "string" },
        "parameters": { "type": "object" }
      }
    },
    "workflow": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "step_id": { "type": "integer" },
          "service_name": { "type": "string" },
          "model_tier": { "type": "string", "enum": ["flash", "pro", "local"] },
          "input_payload": { "type": "object" },
          "status": { "type": "string", "enum": ["pending", "running", "success", "failed"] }
        }
      }
    }
  }
}
```

---

## 5. 工程目录结构与代码组织规范 (Project Structure)

```bash
matrix-os/
├── services/                     # 42+ 原子微服务池 (源自 ScholarMatrix 解耦)
│   ├── literature/               # 文献发现与知识舱 (语义检索、对比矩阵、速读)
│   ├── experiment/               # 实验台 (30+ 统计拟合、复现清单、图表工坊)
│   ├── writing/                  # 规范写作舱 (综述助手、开题报告、论文大纲)
│   ├── xingmen/                  # 星门工坊 (OpenAlex导师画像、自适应套磁信、进组台账)
│   ├── pat_hot/                  # PAT-HOT 雷达 (arXiv/Nature流式监听、热度评估)
│   └── pre_job/                  # 预职工坊 (证据级简历、升学求职决策树、综测导出)
├── core-agent/                   # 中台调度 Agent 核心状态机
│   ├── router/                   # 意图分词与 DAG 工作流调度器
│   ├── models/                   # 2026 模型 API 适配网关 (DeepSeek / Qwen)
│   ├── security/                 # 本地隐私保险箱 (端侧隔离与数据脱敏)
│   └── state_machine.py          # 7 站全生命周期状态跟踪机
├── clients/                      # 双端交互客户端
│   ├── miniprogram/              # 微信小程序端 (原生 WXML/WXSS/TS)
│   └── webos-canvas/             # 桌面端 WebOS 动态画布 (React/Vue3 + Tailwind + Vite)
├── contracts/                    # API 定义、ProtoBuf 与 JSON Schemas
└── deployment/                   # Dockerfile、K8s 编排与 CI/CD 自动化流水线
```

---

## 6. 四阶段工程交付与验收标准 (Milestones)

* **Stage 1 (解耦与接口协议标准化 · 2个月)**：完成 ScholarMatrix 42 个工具的解耦，封装为独立无状态 API，建立统一调度 JSON Schema。
* **Stage 2 (双端协同感知与大模型微调 · 3个月)**：上线微信小程序口袋端，完成 WebOS 动态装配画布引擎；接入 DeepSeek V4.1 与本地 Qwen 3.8-7B LoRA。
* **Stage 3 (原型联调与高校试点部署 · 4个月)**：在 3 所重点大学物理/光电实验室开展种子用户部署（500+ 用户），打通星门与 PAT-HOT 数据流。
* **Stage 4 (资产闭环与立项验收 · 3个月)**：实现成果自动沉淀为“云衡”综测加分材料与预职简历，完成大创结题报告与 3 件软件著作权交付。
