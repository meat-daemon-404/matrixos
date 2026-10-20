# openalex-pat-worker

PAT-HOT 与星门两个微站的数据底座。负责：

- **04 站 PAT-HOT**：监听 arXiv / Nature / Crossref 前沿动态，按热度算法排序，每日 08:00 合成三卡晨间早报
- **06 站星门**：对接 OpenAlex 构建导师五维学术画像

---

## 快速开始

```bash
cd services/openalex-pat-worker

# 依赖（全局环境已装齐；如需隔离请用 venv）
python -m pip install -e ".[dev]"

# 跑测试（默认全部离线，用 mock，不打真实 API）
python -m pytest

# 只跑需要真实网络的用例
python -m pytest -m live
```

> 本项目采用 `src/` 布局，`pyproject.toml` 已配 `pythonpath = ["src"]`，
> 不装包也能直接 `import pat_worker`。

---

## 环境变量

复制根目录 `.env.example` 为 `.env.local`，至少填：

| 变量 | 必填 | 说明 |
| :--- | :--- | :--- |
| `OPENALEX_MAILTO` | ✅ | 你的邮箱。OpenAlex 礼貌池要求带此标识，可显著提升限速配额 |
| `OPENALEX_BASE_URL` | — | 默认 `https://api.openalex.org` |
| `ARXIV_BASE_URL` | — | 默认 `https://export.arxiv.org/api` |
| `CROSSREF_MAILTO` | — | 同 OpenAlex，礼貌池用 |

> 🔴 不填 `OPENALEX_MAILTO` 会被 OpenAlex 限速到几乎不可用。这是礼貌池的硬要求。

---

## 模块结构

```
src/pat_worker/
├── collectors/        # 信源采集：arxiv / nature / openalex / crossref
├── domain/            # 纯计算，无 IO：heat（热度）/ mentor（五维）/ fit
├── pipeline/          # 编排：merge（去重合并）/ brief（早报合成）/ runner
├── services/          # 业务服务：mentor_service
├── store/             # 持久化（SQLite，开发期）
├── http/              # HTTP 客户端（限速、重试）
├── models.py          # 数据模型
├── scheduler.py       # 每日 08:00 定时任务
└── settings.py        # 配置加载
```

---

## 两个设计说明（Bundle 里没给，本仓库自行定义）

### 热度评估算法

`domain/heat.py`。Bundle 只写了「热度评估算法」四个字，没有定义。本仓库的实现考虑：

- 引用增速（相对该领域均值）
- 期刊/会议影响力
- 跨源提及（arXiv + Nature + Crossref 同时出现加分）
- 时效衰减

权重与公式见该文件顶部注释。**改动权重需要更新测试中的不变量断言。**

### 早报 JSON 结构

`schema` 定义在 `specs/contracts/morning-brief.schema.json`（仓库根）。
之所以放在根 `specs/` 而非本服务目录：微信小程序端也要消费这个结构，属于跨端契约。

---

## 导师五维画像

`domain/mentor.py`。五个维度：

| 维度 | 数据来源 | 说明 |
| :--- | :--- | :--- |
| 近 3 年活跃度 | OpenAlex works | 论文产出频率与时间分布 |
| H-index 斜率 | OpenAlex author | 声誉增长速度，比绝对值更能反映上升期 |
| 经费充足度 | OpenAlex grants | 有经费才能支持本科生做实验 |
| 本科生友好度 | 启发式 | 基于合作者多样性、论文作者数、是否有本科生一作 |
| 方向契合度 | 向量相似度 | 与学生课题的嵌入距离 |

每维输出 `{ score, confidence, evidence[] }`，**confidence 低时该维权重自动下降**——
避免用不可靠数据给出过于自信的匹配度。

---

## 定时任务

`scheduler.py` 用 APScheduler，每日 08:00 生成早报。手动触发：

```bash
python -m pat_worker --brief-now
```

---

## 测试策略

- **默认全离线**：所有 HTTP 调用走 `respx` mock，不依赖网络
- `-m live` 标记的用例才会真打 API，CI 不跑
- 重点验证的是**契约与不变量**，不是覆盖率数字：
  - 热度算法：单调性（引用更多 → 分更高）、归一化边界、空输入不崩
  - 五维画像：置信度加权、缺数据时的降级
  - 早报：输出必须通过 `morning-brief.schema.json` 校验

---

## 已知限制

| 项 | 说明 |
| :--- | :--- |
| SQLite 而非 PostgreSQL | 开发期选择。生产环境对接 `matrix-core` 的 AssetGraph |
| 无真实调度常驻 | 需要 `python -m pat_worker` 常驻进程；生产用容器 |
| 本科生友好度是启发式 | 没有可靠数据源，属于估算，报告中要标注 |
