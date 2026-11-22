# 智轨星云 · MatrixOS v3.0（高校全域科研工作台与学术数字资产操作系统）

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Turborepo](https://img.shields.io/badge/Monorepo-Turborepo_%2B_TypeScript-EF4444?logo=turborepo&logoColor=white)](https://github.com/meat-daemon-404/matrixos)
[![Spec Gates](https://img.shields.io/badge/Spec_Gates-9%2F9_Passing-2ea44f)](https://github.com/meat-daemon-404/matrixos/blob/main/scripts/validate-specs.mjs)
[![Online Matrix](https://img.shields.io/badge/Micro--Sites-18%2F18_Verified-00b894)](https://github.com/meat-daemon-404/matrixos/blob/main/scripts/verify-online.mjs)

> **MatrixOS v3.0（智轨星云）** 是一套面向高校科研团队与本科生科创训练的**全域学术数字资产操作系统**。采用 **「1 座中央星轨中枢（Orbital Hub）+ 18 座学科与功能群岛微站（Micro-Sites 01–18）+ 微信小程序口袋工作台（WeChat Pocket）+ 数字孪生统一契约（Twin Schema）」** 的联邦架构，并与 [智阅矩阵 ScholarMatrix](https://scholarmatrix.pages.dev) 及 [PAT-HOT](https://pat-hot.pages.dev) 实现实时学术情报与文献资产互通。

## 联邦架构全景（Monorepo 拓扑）

```text
matrixos/
├── apps/
│   ├── orbital-hub/                 # 中央星轨总控台（全域检索、数字孪生看板、跨微站 SSO 与知识图谱）
│   ├── micro-sites/                 # 01–18 共 18 座专项微站（文献精读、科研绘图、选刊雷达、大创立项、学术伦理等）
│   └── wechat-pocket/               # 微信小程序端（6 页面 + 2 核心组件 + 63 断言独立 mock-server）
├── packages/
│   ├── twin-schema/                 # 学术数字孪生统一 Schema（论文、实验记录、课题里程碑、引用图谱契约）
│   └── instrument-ui/               # 跨微站精密科研仪器风格 UI 组件库与暗夜星轨设计系统
├── services/
│   ├── matrix-core/                 # 核心后端服务（14 个 REST 端点 + 1 个实时协同 WebSocket 通道）
│   └── openalex-pat-worker/         # OpenAlex 文献元数据与 PAT-HOT 11 频道情报联邦聚合边缘网关
└── scripts/
    ├── validate-specs.mjs           # 9 项工程门禁（Schema、路由、微站元数据、零断链、小程序契约静态校验）
    ├── verify-online.mjs            # 18 座线上微站 + 主站真浏览器端到端可用性巡检脚本
    └── claim.mjs                    # 跨仓库微站发布与数字资产认领自动化工作流
```

## 核心子系统与工程指标

| 子系统 | 路径 | 关键实现与规模指标 |
| :--- | :--- | :--- |
| **中央星轨中枢** | `apps/orbital-hub/` | 统一调度 18 座微站入口、实时展示 `matrix-core` WebSocket 科研遥测流与个人数字孪生资产画像 |
| **18 座群岛微站** | `apps/micro-sites/01..18` | 每座微站具备独立业务闭环与统一的 `twin-schema` 数据交换协议，支持一键认领与独立边缘部署 |
| **口袋星云小程序** | `apps/wechat-pocket/` | 涵盖今日热点、文献速览、课题打卡、选刊速查、语音闪念胶囊与个人星轨页，配套 63 项离线 Mock 断言 |
| **Matrix-Core 引擎** | `services/matrix-core/` | 提供 14 个标准化 REST 接口与 `/ws` 实时状态总线，承载跨站文献入库、图谱融合与审计流水 |
| **OpenAlex × PAT 网关** | `services/openalex-pat-worker/` | 实时打通 OpenAlex 2.5 亿级学术图谱与 PAT-HOT 11 个学科频道的 `papers-index.json` |

## 快速开始与全链路门禁

```bash
git clone https://github.com/meat-daemon-404/matrixos.git
cd matrixos
npm install

# 1. 运行 9 项静态架构与 Schema 契约门禁
node scripts/validate-specs.mjs

# 2. 运行微信小程序端与 Matrix-Core 自动化测试
npm test

# 3. 执行 18 座微站线上真环境巡检（可选）
node scripts/verify-online.mjs
```

## 许可证

本项目基于 [MIT License](LICENSE) 开源。
