#!/usr/bin/env node
/**
 * MatrixOS 微站脚手架生成器（任务 S1-15）
 * =====================================================================================
 *
 * 用法
 * -----
 *   pnpm gen:site                                  # 不带参数 = 打印 ADR-001 命名表与可用 ID
 *   pnpm gen:site --id=07                          # 只生成 07 号微站
 *   pnpm gen:site --id=07 --domain=cold-email      # 带域名校验（推荐，防止编号/域名串味）
 *   pnpm gen:site --id=01,04,06,09,11,16           # 首批 6 站（ADR-001 执行检查点）
 *   pnpm gen:site --all                            # 18 站全量
 *   pnpm gen:site --id=07 --dry-run                # 只打印将写入的文件，不落盘
 *   pnpm gen:site --id=07 --force                  # 覆盖已存在的文件（默认跳过已存在文件）
 *   pnpm gen:site --emit-registry                  # 只刷新 orbital-hub 的花名册注册表
 *   pnpm gen:site --verify                         # 语法自检 apps/ 下所有 .ts/.tsx
 *
 * 命名铁律
 * --------
 *   目录名**唯一**依据 docs/01-plan/00-adr-001-microsite-numbering.md 的命名表：
 *     编号与站点归属 ← 花名册（specs/microsites.json，版本 A）
 *     目录词根       ← 描述性命名（版本 B 风格）
 *   因此**目录名与域名可以不一致，且这是刻意的**：14 是 `review-architect` 但域名 `review-lab`；
 *   04 是 `pat-radar` 但域名 `pat-hot`。改目录名会引发域名迁移，禁止。
 *
 * 生成物（每个微站）
 * ------------------
 *   apps/micro-sites/<id>-<dirName>/
 *   ├── package.json                 # 端口 = 3010 + (id - 1)，见 docs/02-engineering/01-dev-setup.md
 *   ├── next.config.ts               # workspace 包未就位时自动切本地 shim（保证 pnpm dev 可跑）
 *   ├── tsconfig.json
 *   ├── next-env.d.ts
 *   ├── matrix-app.manifest.json     # 符合 specs/contracts/matrix-app-manifest.schema.json
 *   ├── .env.example
 *   ├── README.md
 *   └── src/
 *       ├── site.config.ts           # 该站身份（名称/轨道/UI 风格/台账）来自花名册
 *       ├── app/{layout.tsx,page.tsx,globals.css}
 *       ├── components/site-shell.tsx
 *       └── lib/{sdk-facade.ts,instrument-facade.tsx,shims/*.ts}
 *
 * 设计取舍（为什么长这样）
 * ------------------------
 * 1. **不用 Tailwind、不引 CDN**：visual-system §十 V10 指出 Tailwind CDN / Google Fonts /
 *    FontAwesome 三个 CDN 在内网环境会全失效。骨架阶段直接吃 tokens.css，零外部请求。
 * 2. **workspace 依赖用 `workspace:*`，但 import 走 facade**：`@matrixos/sdk` 与
 *    `@matrixos/instrument-ui` 由其他同学并行开发。next.config.ts 在包不可 resolve 时把
 *    这两个 specifier（含 instrument-ui 的 styles.css 子路径）别名到本地 shim ——
 *    于是「import 已写好」与「pnpm dev 能跑」不冲突，包一旦就位别名自动失效，源码不用改。
 *    两个包的接口已与 owner 对齐（2026-10-20）：
 *      @matrixos/sdk         源码直出 ./src/index.ts；initSSO() 返回 Promise<SSOSession>；
 *                            onWormholeDrop(handler) 返回取消订阅函数；
 *                            无 WormholeDropRing（UI 归 instrument-ui）。
 *      @matrixos/instrument-ui 源码直出 + 子路径 ./styles.css（含 tokens.css），
 *                            必须在应用里显式 import 一次。
 * 3. **facade 只做形状归一，不藏业务**：它不模拟 SSO、不伪造虫洞，包缺失时 UI 明说
 *    「SDK 未就位」，绝不假装登录成功。
 *
 * 退出码：0 成功 / 1 校验或写入失败 / 2 用法错误
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// 图标与 metadata 段来自 scripts/site-icons.mjs，与 scripts/gen-site-assets.mjs 共用同一份实现。
// 为什么必须共用：这两处曾各持一份模板 —— 脚手架生成的 layout.tsx 缺 SITE_ORIGIN/icons/robots，
// 而补丁器生成的是另一形态；跑一次 `gen:site --force` 就会把补齐的 metadata 覆盖回旧形态。
// 单一事实源让「新站脚手架」与「旧站补丁」产出逐字节一致，不再漂移。
import { renderMetadataBlock } from './site-icons.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROSTER_PATH = join(ROOT, 'specs', 'microsites.json');
const MICRO_ROOT = join(ROOT, 'apps', 'micro-sites');
const HUB_DIR = join(ROOT, 'apps', 'orbital-hub');
const REGISTRY_PATH = join(HUB_DIR, 'src', 'lib', 'microsites.generated.ts');

// =====================================================================================
// 1. ADR-001 命名表（唯一事实源：docs/01-plan/00-adr-001-microsite-numbering.md）
// =====================================================================================

/** 编号 → 目录名。逐行抄自 ADR-001「目录命名规范」表，不得自行推导。 */
const ADR_001_DIR_TABLE = {
  '01': '01-gpa-sandbox',
  '02': '02-spark-teaming',
  '03': '03-grant-audit',
  '04': '04-pat-radar',
  '05': '05-lit-sonar',
  '06': '06-xingmen-mentor',
  '07': '07-cold-email-lab',
  '08': '08-lab-kanban',
  '09': '09-matrix-cross',
  '10': '10-pdf-sniper',
  '11': '11-curvelab-fit',
  '12': '12-repro-check',
  '13': '13-chart-foundry',
  '14': '14-review-architect',
  '15': '15-retract-radar',
  '16': '16-yunheng-scale',
  '17': '17-evidence-cv',
  '18': '18-prejob-multiverse',
};

/**
 * 轨道编号 → 契约枚举 + 强调色。
 * - `key` 必须与 specs/contracts/matrix-app-manifest.schema.json 的 orbit_station 枚举一致
 *   （validate-specs.mjs 会校验 7 站枚举，这里是同一份名单的镜像）。
 * - `label` 会与花名册的 orbitName 逐字比对，防止「轨道 N」编号漂移。
 * - 强调色全部取自 Tailwind 默认 500 档（visual-system §2.2 六色），不发明新色。
 */
const ORBIT_META = {
  1: { key: 'study', label: '轨道 1 · 学阶', accent: '#6366f1' },
  2: { key: 'spark', label: '轨道 2 · 星火', accent: '#8b5cf6' },
  3: { key: 'pat_hot', label: '轨道 3 · 情报', accent: '#f59e0b' },
  4: { key: 'xingmen', label: '轨道 4 · 星门', accent: '#06b6d4' },
  5: { key: 'workshop', label: '轨道 5 · 工坊', accent: '#10b981' },
  6: { key: 'cloud_balance', label: '轨道 6 · 云衡', accent: '#22d3ee' },
  7: { key: 'pre_job', label: '轨道 7 · 预职', accent: '#f43f5e' },
};

const PAYLOAD_TYPES = [
  'paper_doi_bundle',
  'comparison_matrix_row',
  'curve_fit_parameters',
  'mentor_match_card',
  'verified_cv_evidence',
];

/**
 * 每站的虫洞钩子默认值（accepts / emits）。
 * 这是**脚手架默认值**，S3 做功能完备化时以站点实际能力为准改这里；
 * 枚举受 wormhole-envelope.schema.json 封闭约束，不得扩展。
 */
const HOOKS = {
  '01': { accepts: [], emits: [] },
  '02': { accepts: ['verified_cv_evidence'], emits: [] },
  '03': { accepts: [], emits: [] },
  '04': { accepts: ['paper_doi_bundle'], emits: ['paper_doi_bundle'] },
  '05': { accepts: ['paper_doi_bundle'], emits: ['paper_doi_bundle'] },
  '06': { accepts: ['paper_doi_bundle', 'curve_fit_parameters'], emits: ['mentor_match_card'] },
  '07': { accepts: ['mentor_match_card', 'curve_fit_parameters'], emits: [] },
  '08': { accepts: ['mentor_match_card'], emits: [] },
  '09': { accepts: ['paper_doi_bundle'], emits: ['comparison_matrix_row'] },
  '10': { accepts: ['paper_doi_bundle'], emits: ['comparison_matrix_row'] },
  '11': { accepts: ['comparison_matrix_row'], emits: ['curve_fit_parameters'] },
  '12': { accepts: ['paper_doi_bundle', 'curve_fit_parameters'], emits: [] },
  '13': { accepts: ['curve_fit_parameters', 'comparison_matrix_row'], emits: [] },
  '14': { accepts: ['paper_doi_bundle', 'comparison_matrix_row'], emits: [] },
  '15': { accepts: ['paper_doi_bundle'], emits: [] },
  '16': { accepts: ['paper_doi_bundle', 'verified_cv_evidence'], emits: [] },
  '17': {
    accepts: [
      'paper_doi_bundle',
      'comparison_matrix_row',
      'curve_fit_parameters',
      'mentor_match_card',
    ],
    emits: ['verified_cv_evidence'],
  },
  '18': { accepts: ['verified_cv_evidence'], emits: [] },
};

/** 端口约定：orbital-hub 3000，微站 3010~3027（docs/02-engineering/01-dev-setup.md §四）。 */
const MICRO_PORT_BASE = 3010;
const HUB_PORT = 3000;

/**
 * workspace 包名兜底值（来自 docs/01-plan/01-architecture.md §3.3 的对外包名）。
 * 生成时会先读 packages/<dir>/package.json 的真实 name，读不到才用这里。
 * 若包名与此处不一致，`pnpm gen:site --all --force` 重跑一次即可自动对齐。
 */
const WORKSPACE_PACKAGES = {
  'matrix-sdk': '@matrixos/sdk',
  'instrument-ui': '@matrixos/instrument-ui',
  'twin-schema': '@matrixos/twin-schema',
};

// =====================================================================================
// 2. 参数解析
// =====================================================================================

const USAGE = `MatrixOS 微站脚手架生成器

  pnpm gen:site                                 列出 ADR-001 命名表与可用 ID
  pnpm gen:site --id=07 --domain=cold-email     生成单站（--domain 会与花名册校验）
  pnpm gen:site --id=01,04,06,09,11,16          生成多站
  pnpm gen:site --all                           生成全部 18 站
  pnpm gen:site --emit-registry                 刷新 apps/orbital-hub 的花名册注册表
  pnpm gen:site --verify                        对 apps/ 下 .ts/.tsx 做语法自检

  可选旗标
    --dry-run        只打印将写入的文件路径，不落盘
    --force          覆盖已存在的文件（默认：已存在则跳过，只补缺失文件）
    --json           机器可读输出（CI 用）

  退出码：0 成功 / 1 校验失败 / 2 用法错误`;

function parseArgs(argv) {
  const opts = {
    ids: null,
    domain: null,
    all: false,
    force: false,
    dryRun: false,
    emitRegistry: false,
    verify: false,
    json: false,
    help: false,
  };
  const errors = [];

  for (const raw of argv) {
    if (!raw.startsWith('--')) {
      errors.push(`无法识别的参数：${raw}`);
      continue;
    }
    const body = raw.slice(2);
    const eq = body.indexOf('=');
    const key = eq === -1 ? body : body.slice(0, eq);
    const value = eq === -1 ? '' : body.slice(eq + 1);

    switch (key) {
      case 'id':
      case 'ids':
        opts.ids = value
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        break;
      case 'domain':
        opts.domain = value.trim();
        break;
      case 'all':
        opts.all = true;
        break;
      case 'force':
        opts.force = true;
        break;
      case 'dry-run':
        opts.dryRun = true;
        break;
      case 'emit-registry':
        opts.emitRegistry = true;
        break;
      case 'verify':
        opts.verify = true;
        break;
      case 'json':
        opts.json = true;
        break;
      case 'help':
      case 'h':
        opts.help = true;
        break;
      default:
        errors.push(`未知旗标：--${key}`);
    }
  }

  return { opts, errors };
}

// =====================================================================================
// 3. 花名册读取与交叉校验
// =====================================================================================

class GenError extends Error {}

function readJson(path, label) {
  if (!existsSync(path)) throw new GenError(`${label} 不存在：${relative(ROOT, path)}`);
  const raw = readFileSync(path, 'utf8');
  if (raw.charCodeAt(0) === 0xfeff) throw new GenError(`${label} 含 UTF-8 BOM，JSON.parse 会失败`);
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new GenError(`${label} 解析失败：${e.message}`);
  }
}

/** 读 packages/<dir>/package.json 的真实包名；读不到返回兜底值。 */
function resolveWorkspacePackageName(dirName) {
  const pkgJson = join(ROOT, 'packages', dirName, 'package.json');
  if (existsSync(pkgJson)) {
    try {
      const name = JSON.parse(readFileSync(pkgJson, 'utf8')).name;
      if (typeof name === 'string' && name.length > 0) return { name, source: 'packages/' + dirName };
    } catch {
      /* 落到兜底值 */
    }
  }
  return { name: WORKSPACE_PACKAGES[dirName], source: 'docs/01-plan/01-architecture.md §3.3' };
}

function parseOrbitName(orbitName) {
  const m = /^轨道\s*(\d)\s*[·•]\s*(.+)$/.exec(String(orbitName ?? '').trim());
  if (!m) return null;
  const index = Number(m[1]);
  return { index: Number.isFinite(index) ? index : null, label: m[2].trim() };
}

/**
 * 读取 18 站花名册，并与 ADR-001 命名表、轨道元数据交叉校验。
 * 任何一处对不上都直接失败——这比生成出一棵错目录树便宜得多。
 */
function loadStations() {
  const roster = readJson(ROSTER_PATH, 'specs/microsites.json');
  if (!Array.isArray(roster)) throw new GenError('specs/microsites.json 顶层必须是数组');
  if (roster.length !== 18) throw new GenError(`花名册应为 18 条，实际 ${roster.length} 条`);

  const problems = [];
  const stations = [];
  const seenDirs = new Set();

  for (const raw of roster) {
    const id = String(raw?.id ?? '');
    const dirName = ADR_001_DIR_TABLE[id];
    if (!dirName) {
      problems.push(`id=${id} 在 ADR-001 命名表中没有对应目录名（花名册与 ADR 不同步）`);
      continue;
    }
    if (seenDirs.has(dirName)) problems.push(`目录名重复：${dirName}`);
    seenDirs.add(dirName);

    const orbit = parseOrbitName(raw.orbitName);
    if (!orbit) {
      problems.push(`id=${id} 的 orbitName 无法解析（期望形如「轨道 4 · 星门」）：${raw.orbitName}`);
      continue;
    }
    const meta = ORBIT_META[orbit.index];
    if (!meta) {
      problems.push(`id=${id} 的轨道编号 ${orbit.index} 不在 1..7 之内`);
      continue;
    }
    if (meta.label !== String(raw.orbitName).trim()) {
      problems.push(
        `id=${id} 的轨道标签与 ORBIT_META 不一致：花名册「${raw.orbitName}」vs 生成器「${meta.label}」`,
      );
    }

    const domain = String(raw.domain ?? '');
    if (!/^[a-z0-9-]+\.matrixos\.edu$/.test(domain)) {
      problems.push(`id=${id} 域名不合规：${domain}`);
    }
    const appId = domain.replace(/\.matrixos\.edu$/, '');
    if (ADR_001_DIR_TABLE[id] && !appId) problems.push(`id=${id} 域名为空`);

    const hooks = HOOKS[id] ?? { accepts: [], emits: [] };
    const badHook = [...hooks.accepts, ...hooks.emits].filter((t) => !PAYLOAD_TYPES.includes(t));
    if (badHook.length) problems.push(`id=${id} 的虫洞钩子含非法 payload_type：${badHook.join(', ')}`);

    stations.push({
      id,
      name: String(raw.name ?? ''),
      domain,
      appId,
      dirName,
      pkgName: '@matrixos/microsite-' + dirName,
      devPort: MICRO_PORT_BASE + (Number(id) - 1),
      orbitIndex: orbit.index,
      orbitKey: meta.key,
      orbitName: String(raw.orbitName).trim(),
      orbitGroup: String(raw.orbit ?? ''),
      accent: meta.accent,
      source: String(raw.source ?? ''),
      uiStyle: String(raw.uiStyle ?? ''),
      ledger: String(raw.ledger ?? ''),
      desc: String(raw.desc ?? ''),
      accepts: [...hooks.accepts],
      emits: [...hooks.emits],
    });
  }

  const missingDirs = Object.keys(ADR_001_DIR_TABLE).filter((id) => !stations.some((s) => s.id === id));
  if (missingDirs.length) problems.push(`花名册缺少 ADR-001 表中的 id：${missingDirs.join(', ')}`);

  // 轨道分组分布必须为 3 / 5 / 7 / 3 合计 18（架构 §2.1 落地规则 4）
  const groupCount = stations.reduce((acc, s) => {
    acc[s.orbitGroup] = (acc[s.orbitGroup] ?? 0) + 1;
    return acc;
  }, {});
  const expectedGroups = { '1-2': 3, '3-4': 5, '5': 7, '6-7': 3 };
  for (const [group, want] of Object.entries(expectedGroups)) {
    const got = groupCount[group] ?? 0;
    if (got !== want) problems.push(`轨道分组 ${group} 应为 ${want} 站，实际 ${got} 站`);
  }

  if (problems.length) {
    throw new GenError('花名册 / ADR-001 / 轨道元数据交叉校验失败：\n  - ' + problems.join('\n  - '));
  }

  stations.sort((a, b) => a.id.localeCompare(b.id));
  return stations;
}

// =====================================================================================
// 4. 站点选择
// =====================================================================================

/**
 * 解析目标站点。`--domain` 只做**校验**，不参与命名推导（命名只认 ADR-001 表）。
 * 之所以要校验：S1-15 的任务书里出现过 `--id=07 --domain=lit-sonar` 这种串味组合，
 * 而 lit-sonar 按 ADR-001 属于 05 号站。这里直接拦下并给出正确值。
 */
function selectStations(stations, opts) {
  if (opts.all) {
    if (opts.domain) throw new GenError('--all 与 --domain 不能同时使用');
    return stations;
  }
  if (!opts.ids || opts.ids.length === 0) {
    throw new GenError('未指定要生成的站点：用 --id=07 或 --all');
  }

  const picked = [];
  for (const rawId of opts.ids) {
    const id = rawId.padStart(2, '0');
    const station = stations.find((s) => s.id === id);
    if (!station) {
      throw new GenError(
        `id=${rawId} 不在花名册中。可用 ID：${stations.map((s) => s.id).join(', ')}`,
      );
    }
    picked.push(station);
  }

  if (opts.domain) {
    const given = opts.domain
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/\/.*$/, '');
    const givenAppId = given.replace(/\.matrixos\.edu$/, '');
    const owner = stations.find((s) => s.appId === givenAppId);
    const target = picked[0];

    if (givenAppId !== target.appId) {
      const hint = owner
        ? `「${givenAppId}」按花名册属于 id=${owner.id}（目录 ${owner.dirName}）`
        : `「${givenAppId}」不在花名册的 18 个域名前缀里`;
      throw new GenError(
        [
          `--domain 与 --id 不匹配：id=${target.id} 的域名是 ${target.domain}，收到 --domain=${opts.domain}。`,
          hint + '。',
          '命名只认 ADR-001 命名表，这里不会"就近猜"——请改正参数后重跑。',
        ].join('\n'),
      );
    }
  }

  return picked;
}

// =====================================================================================
// 5. 模板：单站 Next.js 15 App Router 骨架
// =====================================================================================

/** 生成物头部注释（TS/TSX 用）。JSON 文件不能带注释，故不追加。 */
function fileHeader(station, extra) {
  return [
    '/**',
    ' * ⚠️ 自动生成 · scripts/gen-site.mjs',
    ' * 站点：' + station.id + ' ' + station.name,
    ' * 轨道：' + station.orbitName + ' · 域名：' + station.domain,
    ' * 命名依据：docs/01-plan/00-adr-001-microsite-numbering.md（目录名与域名可不一致，刻意）',
    ' * 重新生成：pnpm gen:site --id=' + station.id + ' --force',
    extra ? ' *\n' + extra : '',
    ' */',
  ]
    .filter(Boolean)
    .join('\n');
}

function renderSiteConfig(station) {
  return `${fileHeader(station)}
export interface SiteIdentity {
  readonly id: string;
  readonly name: string;
  readonly domain: string;
  readonly appId: string;
  readonly dirName: string;
  readonly orbitIndex: number;
  readonly orbitKey: string;
  readonly orbitName: string;
  readonly accent: string;
  readonly uiStyle: string;
  readonly ledger: string;
  readonly desc: string;
  readonly source: string;
}

/**
 * 该站的身份卡。字段全部来自 specs/microsites.json（唯一事实源），
 * 不要在这里手改——要改就改花名册，然后重跑生成器。
 */
export const SITE: SiteIdentity = {
  id: ${JSON.stringify(station.id)},
  name: ${JSON.stringify(station.name)},
  domain: ${JSON.stringify(station.domain)},
  appId: ${JSON.stringify(station.appId)},
  dirName: ${JSON.stringify(station.dirName)},
  orbitIndex: ${station.orbitIndex},
  orbitKey: ${JSON.stringify(station.orbitKey)},
  orbitName: ${JSON.stringify(station.orbitName)},
  accent: ${JSON.stringify(station.accent)},
  uiStyle: ${JSON.stringify(station.uiStyle)},
  ledger: ${JSON.stringify(station.ledger)},
  desc: ${JSON.stringify(station.desc)},
  source: ${JSON.stringify(station.source)},
} as const;

/** 站内绝对 URL 助手：嵌入模式（iframe）与独立模式共用同一套路径。 */
export function sitePath(path: string): string {
  const base = 'https://' + SITE.domain;
  if (!path) return base;
  return base + (path.startsWith('/') ? path : '/' + path);
}
`;
}

function renderPackageJson(station, deps) {
  const pkg = {
    name: station.pkgName,
    version: '0.1.0',
    private: true,
    description:
      'MatrixOS 微站 ' +
      station.id +
      ' · ' +
      station.name +
      '（' +
      station.orbitName +
      ' · ' +
      station.domain +
      '）',
    scripts: {
      dev: 'next dev -p ' + station.devPort,
      build: 'next build',
      start: 'next start -p ' + station.devPort,
      typecheck: 'tsc --noEmit',
      clean: 'rimraf .next',
    },
    dependencies: {
      [deps.instrumentUi]: 'workspace:*',
      [deps.sdk]: 'workspace:*',
      next: '^15.5.0',
      react: '^19.0.0',
      'react-dom': '^19.0.0',
    },
    devDependencies: {
      '@types/node': '^22.10.2',
      '@types/react': '^19.0.0',
      '@types/react-dom': '^19.0.0',
      rimraf: '^6.0.1',
      typescript: '^5.7.3',
    },
  };
  return JSON.stringify(pkg, null, 2) + '\n';
}

/**
 * @param station 站点
 * @param extendsPath 到仓库根 tsconfig.base.json 的相对路径。
 *   微站在 apps/micro-sites/<dir>/，所以是 '../../../tsconfig.base.json'
 *   （<dir> → micro-sites → apps → 根）。传参而非硬编码，便于将来换层级。
 */
function renderTsconfig(station, extendsPath) {
  const tsconfig = {
    $schema: 'https://json.schemastore.org/tsconfig',
    extends: extendsPath,
    compilerOptions: {
      target: 'ES2022',
      lib: ['ES2022', 'DOM', 'DOM.Iterable'],
      jsx: 'preserve',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      allowJs: false,
      // Next 不产出声明文件；显式关掉 base 里的 declaration/sourceMap，避免与 noEmit 打架
      declaration: false,
      declarationMap: false,
      sourceMap: false,
      noEmit: true,
      incremental: true,
      plugins: [{ name: 'next' }],
      baseUrl: '.',
      paths: { '@/*': ['./src/*'] },
    },
    include: ['next-env.d.ts', '**/*.ts', '**/*.tsx', '.next/types/**/*.ts'],
    exclude: ['node_modules', '.next'],
  };
  return JSON.stringify(tsconfig, null, 2) + '\n';
}

function renderNextConfig(station, deps) {
  const sdkPkg = JSON.stringify(deps.sdk);
  const uiPkg = JSON.stringify(deps.instrumentUi);
  return `${fileHeader(station)}
import path from 'node:path';
import { createRequire } from 'node:module';
import type { NextConfig } from 'next';

/**
 * workspace 包在脚手架阶段可能尚未落地（由 BE/FE 并行开发）。
 * 这里在配置加载时探测一次：**不可 resolve 就把 specifier（含子路径）别名到本地 shim**，
 * 于是「源码里 import 已写好」与「pnpm dev 立刻能跑」同时成立。
 * 包一旦就位，别名自动失效，本文件与业务源码都不用改。
 *
 * 两个包的最终形态已与 owner 对齐：
 *  - 均源码直出（exports["."] → ./src/index.ts），因此 transpilePackages 是**必需**的；
 *  - instrument-ui 还需显式 import 一次 '@matrixos/instrument-ui/styles.css'。
 */
const WORKSPACE_PACKAGES = [${sdkPkg}, ${uiPkg}] as const;

/** 包 specifier → 本地 shim 相对路径。子路径必须单独列出，否则会被前缀别名吃掉。 */
const SHIM_BY_SPECIFIER: Record<string, string> = {
  [${sdkPkg}]: 'src/lib/shims/matrix-sdk.shim.ts',
  [${uiPkg}]: 'src/lib/shims/instrument-ui.shim.tsx',
  [${uiPkg} + '/styles.css']: 'src/lib/shims/instrument-ui.styles.css',
  [${uiPkg} + '/tokens.css']: 'src/lib/shims/instrument-ui.styles.css',
};

// process.cwd() 在 \`pnpm --filter <pkg> dev\` / turbo run dev 下等于本包根目录
const pkgRoot = process.cwd();
const localRequire = createRequire(path.join(pkgRoot, 'package.json'));

function canResolve(specifier: string): boolean {
  try {
    localRequire.resolve(specifier);
    return true;
  } catch {
    return false;
  }
}

/** 逐个 specifier 打探；缺失的记下来供 webpack 别名使用。 */
function detectMissingSpecifiers(): string[] {
  const missing: string[] = [];
  for (const spec of Object.keys(SHIM_BY_SPECIFIER)) {
    if (!canResolve(spec)) missing.push(spec);
  }
  const missingPkgs = WORKSPACE_PACKAGES.filter((pkg) => !canResolve(pkg));
  if (missingPkgs.length > 0) {
    console.warn(
      '[matrixos] 以下 workspace 包尚未就位，已启用本地 shim（界面会显式标注未就位，' +
        '不会伪造登录态或虫洞投递）：' +
        missingPkgs.join(', '),
    );
  } else {
    for (const spec of missing) {
      if (missingPkgs.every((pkg) => !spec.startsWith(pkg))) {
        console.warn('[matrixos] ' + spec + ' 无法解析，已走本地 shim（包入口/子路径 exports 可能有问题）。');
      }
    }
  }
  return missing;
}

const missingSpecifiers = detectMissingSpecifiers();
const resolvedPackages = WORKSPACE_PACKAGES.filter((pkg) => !missingSpecifiers.includes(pkg));

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // 源码直出的 workspace 包必须由 Next 参与编译（owner 明确要求）
  transpilePackages: [...resolvedPackages],
  poweredByHeader: false,
  /**
   * 微站必须能被 orbital-hub 以 iframe 嵌入（架构 A4 / ADR-08）。
   * 不要设 X-Frame-Options: DENY；用 CSP frame-ancestors 精确放行主控台。
   * 开发期放行 localhost:${HUB_PORT}（hub 端口约定见 docs/02-engineering/01-dev-setup.md）。
   */
  async headers() {
    const frameAncestors = [
      "'self'",
      'https://orbital.matrixos.edu',
      'http://localhost:${HUB_PORT}',
      'http://127.0.0.1:${HUB_PORT}',
    ].join(' ');
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: 'frame-ancestors ' + frameAncestors },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ];
  },
  webpack: (config) => {
    config.resolve = config.resolve ?? {};
    config.resolve.alias = config.resolve.alias ?? {};
    const alias = config.resolve.alias as Record<string, string>;
    for (const spec of missingSpecifiers) {
      const shimRel = SHIM_BY_SPECIFIER[spec];
      // 用 \`spec$\` 精确匹配：既让裸 specifier 命中，又不让 styles.css 子路径串到 .tsx 上
      if (shimRel) alias[spec + '$'] = path.join(pkgRoot, shimRel);
    }
    return config;
  },
};

export default nextConfig;
`;
}

function renderLayout(station, deps) {
  return `${fileHeader(station)}
import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
// workspace 包未就位时，next.config.ts 会把这条 specifier 别名到本地 shim（同样是一次全局样式）
import ${JSON.stringify(deps.instrumentUi + '/styles.css')};
import { SITE } from '../site.config';
import './globals.css';

${renderMetadataBlock()}

export const viewport: Viewport = {
  themeColor: '#050814',
  colorScheme: 'dark',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body data-matrixos-station={SITE.id}>{children}</body>
    </html>
  );
}
`;
}

function renderPage(station) {
  return `${fileHeader(station)}
import { SiteShell } from '../components/site-shell';
import { SITE } from '../site.config';

/**
 * 微站入口页（骨架 / 占位）。
 *
 * 服务端只负责吐静态骨架；身份状态、iframe 握手、虫洞接收器都在
 * <SiteShell />（client component）里挂载。
 */
export default function Page() {
  return (
    <main className="site-root">
      <SiteShell />
      <footer className="site-footer">
        <span className="mono">{SITE.domain}</span>
        <span>骨架由 scripts/gen-site.mjs 生成 · ADR-001</span>
      </footer>
    </main>
  );
}
`;
}

function renderGlobalsCss(station) {
  return `/* ────────────────────────────────────────────────────────────────────────────
 * MatrixOS 微站通用样式（脚手架生成 · ${station.id} ${station.name}）
 *
 * Token 唯一权威源：docs/00-analysis/04-visual-system.md §九
 * 刻意**不引入** Tailwind CDN / Google Fonts / FontAwesome：
 * visual-system §十 V10 指出三者在内网环境全部失效，骨架阶段零外部请求。
 * 字体走本地栈（Inter/JetBrains Mono 由 instrument-ui 自托管后接管）。
 * ──────────────────────────────────────────────────────────────────────────── */

:root {
  /* Surface */
  --color-bg: #050814;
  --color-bg-panel: #0b1124;
  --color-bg-panel-end: #070b18;
  --color-bg-sunken: #020617;
  --color-bg-raised: #0f172a;
  --color-glass: rgba(13, 20, 38, 0.78);

  /* Border */
  --color-border: #1e293b;
  --color-border-strong: #334155;
  --color-border-accent: rgba(99, 102, 241, 0.22);

  /* Text */
  --color-text: #f1f5f9;
  --color-text-strong: #ffffff;
  --color-text-secondary: #cbd5e1;
  --color-text-muted: #94a3b8;
  --color-text-faint: #64748b;

  /* Accent（六色取自 Tailwind 500 档） */
  --color-action: #6366f1;
  --color-action-hover: #4f46e5;
  --color-instrument: #06b6d4;
  --color-instrument-bright: #22d3ee;
  --color-positive: #10b981;
  --color-positive-bright: #34d399;
  --color-warning: #f59e0b;
  --color-danger: #f43f5e;
  --color-ecosystem: #8b5cf6;

  /* 本站强调色（来自花名册轨道） */
  --site-accent: ${station.accent};

  /* Glow / Radius / Motion */
  --glow-spread: 0 0 28px -5px;
  --glow-alpha: 0.45;
  --radius-xs: 4px;
  --radius-sm: 8px;
  --radius-md: 12px;
  --radius-lg: 16px;
  --radius-xl: 24px;
  --radius-pill: 9999px;
  --dur-fast: 150ms;
  --dur-base: 300ms;
  --dur-slow: 500ms;
  --pulse-duration: 2.8s;

  /* Typography —— V3 修正：补 CJK 回退 */
  --font-sans: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC',
    'Microsoft YaHei', 'Noto Sans SC', sans-serif;
  --font-mono: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
  --text-2xs: 10px;
  --text-xs: 12px;
  --text-sm: 14px;
  --text-base: 16px;
  --text-lg: 18px;
  --text-xl: 20px;
  --text-2xl: 24px;
}

* { box-sizing: border-box; }

html, body { margin: 0; padding: 0; }

body {
  background: var(--color-bg);
  color: var(--color-text);
  font-family: var(--font-sans);
  font-size: var(--text-sm);
  line-height: 1.65;
  min-height: 100vh;
  -webkit-font-smoothing: antialiased;
}

/* 仅嵌入模式取消视口高度（ADR-08：iframe 内不滚，高度跟着 hub 走） */
body[data-embedded='true'] { min-height: 0; }

/*
 * 无障碍等价数据表（instrument-ui 的 .iu-sr-only）压制。
 *
 * 为什么必须在这里补：库里的 .iu-sr-only 只给了 width/height: 1px，
 * 而 <table> 的 display 是 table，1px 对表格是「最小宽度」不是上限 ——
 * 表格按内容撑成 196 × 4164 px（CurveLab 180 行数据点），虽然被 clip 掉看不见，
 * 却照样计入文档的可滚动溢出区，把页面顶到 4410 px。
 * 这些表只服务于读屏软件（position: absolute 已脱离文档流），
 * 所以这里把宽高压成硬上限并改用 block，打断表格布局算法；语义不变，读屏照读。
 */
.iu-sr-only {
  display: block;
  max-width: 1px;
  max-height: 1px;
  overflow: hidden;
}

.mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }

/* ── 视觉签名 1：仪器面板（visual-system §5.2，三个细节都不能省） ───────────── */
.instrument-bezel {
  background: linear-gradient(145deg, var(--color-bg-panel) 0%, var(--color-bg-panel-end) 100%);
  border: 1px solid rgba(56, 189, 248, 0.25);
  border-radius: var(--radius-md);
  box-shadow:
    inset 0 1px 0 0 rgba(255, 255, 255, 0.08),
    0 10px 30px -10px rgba(6, 182, 212, 0.25);
}

/* ── 视觉签名 2：玻璃拟态容器（visual-system §5.1） ───────────────────────── */
.glass-panel {
  background: var(--color-glass);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  border: 1px solid var(--color-border-accent);
  border-radius: var(--radius-md);
}

/* ── 视觉签名 3：6px 细滚动条（§5.3，补 Firefox 属性见 V11） ──────────────── */
.custom-scrollbar { scrollbar-width: thin; scrollbar-color: rgba(99, 102, 241, 0.45) rgba(5, 8, 20, 0.8); }
.custom-scrollbar::-webkit-scrollbar { width: 6px; height: 6px; }
.custom-scrollbar::-webkit-scrollbar-track { background: rgba(5, 8, 20, 0.8); }
.custom-scrollbar::-webkit-scrollbar-thumb { background: rgba(99, 102, 241, 0.45); border-radius: 4px; }
.custom-scrollbar::-webkit-scrollbar-thumb:hover { background: rgba(6, 182, 212, 0.8); }

/* ── 布局 ─────────────────────────────────────────────────────────────────── */
.site-root {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 20px 20px 0;
  max-width: 1100px;
  margin: 0 auto;
}

/* iframe 内降级模式（ADR-08）：hub 嵌入式挂载时隐藏大标题/页脚，只留仪器本体 */
body[data-embedded='true'] .site-chrome { display: none; }
body[data-embedded='true'] .site-root { padding: 10px; gap: 10px; }

/* 嵌入模式紧凑布局：不留视口高度、不留 auto 外边距、不收尾留白。
 * 三条都是「按 iframe 高度自适应」的必要项 —— 只要留一条，内容就会被撑出
 * iframe 可视区，从而出现内层滚动条（ADR-08 明令禁止的双滚动条）。 */
body[data-embedded='true'] .site-root { min-height: 0; }
body[data-embedded='true'] .site-root { margin: 0 auto; }
body[data-embedded='true'] .site-footer { margin-top: 8px; padding: 8px 0; }

.site-header {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 10px 16px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--color-border);
}

.site-id {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--color-bg);
  background: var(--site-accent);
  border-radius: var(--radius-xs);
  padding: 2px 7px;
  font-weight: 600;
}

.site-title { font-size: var(--text-xl); font-weight: 600; margin: 0; color: var(--color-text-strong); }
.site-orbit { color: var(--site-accent); font-size: var(--text-xs); }
.site-domain { color: var(--color-text-muted); font-size: var(--text-xs); }

.meta-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 10px;
}

.meta-card {
  padding: 10px 12px;
  border-radius: var(--radius-sm);
  background: var(--color-bg-raised);
  border: 1px solid var(--color-border);
}

.meta-card dt { font-size: var(--text-2xs); color: var(--color-text-faint); letter-spacing: 0.04em; }
.meta-card dd { margin: 2px 0 0; font-size: var(--text-xs); color: var(--color-text-secondary); }

/* ── 占位仪器 ─────────────────────────────────────────────────────────────── */
.instrument-slot {
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-height: 240px;
}

.instrument-slot h2 {
  margin: 0;
  font-size: var(--text-sm);
  font-weight: 600;
  color: var(--color-instrument-bright);
  letter-spacing: 0.02em;
}

.instrument-slot p { margin: 0; color: var(--color-text-muted); font-size: var(--text-xs); }

.placeholder-gauges {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  height: 96px;
  padding: 8px;
  border-radius: var(--radius-sm);
  background: var(--color-bg-sunken);
  border: 1px solid var(--color-border);
}

.placeholder-gauge {
  flex: 1;
  border-radius: 2px 2px 0 0;
  background: linear-gradient(180deg, var(--site-accent) 0%, rgba(6, 182, 212, 0.12) 100%);
  opacity: 0.75;
}

.status-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--text-2xs);
  font-family: var(--font-mono);
  padding: 3px 8px;
  border-radius: var(--radius-pill);
  border: 1px solid var(--color-border-strong);
  color: var(--color-text-muted);
  background: rgba(15, 23, 42, 0.6);
}

.chip[data-tone='ok'] { color: var(--color-positive-bright); border-color: rgba(16, 185, 129, 0.4); }
.chip[data-tone='warn'] { color: var(--color-warning); border-color: rgba(245, 158, 11, 0.4); }
.chip[data-tone='off'] { color: var(--color-text-faint); }

.receipt-list { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 6px; }
.receipt-list li {
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  color: var(--color-text-secondary);
  padding: 6px 8px;
  border-radius: var(--radius-xs);
  background: rgba(6, 182, 212, 0.06);
  border-left: 2px solid var(--color-instrument);
}

.site-footer {
  margin-top: auto;
  padding: 12px 0 16px;
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 8px;
  font-size: var(--text-2xs);
  color: var(--color-text-faint);
  border-top: 1px solid var(--color-border);
}

/* ── V4 修正：原设计缺 prefers-reduced-motion（存在无限循环动画） ─────────── */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
`;
}

function renderSdkFacade(station, deps) {
  return `${fileHeader(station)}
import * as MatrixSDK from ${JSON.stringify(deps.sdk)};

/**
 * SDK 适配层（本站**唯一**允许 import \`${deps.sdk}\` 的地方）
 * ==========================================================================
 * 为什么要有这一层：
 *  1. SDK 与本站并行开发 —— 这里做**可选解析**，包没就位或缺符号时 UI 显式说
 *     「未就位」，绝不伪造登录态，也不假装虫洞投递成功。
 *  2. 未来 SDK 改签名，只改这一个文件。
 *
 * 与 SDK owner 对齐的接口（2026-10-20 定稿）：
 *   initSSO(options): Promise<SSOSession>     —— 异步；双通道（Cookie / mx_idt 交换）
 *   onWormholeDrop(handler): () => void       —— 返回取消订阅函数
 *   emitAsset(asset): Promise<AssetNode>      —— → POST /v1/assets
 *   useHostBridge(): HostBridge               —— 框架无关（不是 React hook）
 *   sendWormhole(...) / getManifest() / createMatrixSDK(...)
 *   注意：SDK **不含** WormholeDropRing —— 环体视觉归 instrument-ui。
 */
type AnyFn = (...args: unknown[]) => unknown;

const rawSdk = MatrixSDK as unknown as Record<string, unknown>;

/** shim 模块会导出这个标记；真实 SDK 不会。 */
export const sdkIsShim = rawSdk.__matrixosShim === true;

function pick(name: string): AnyFn | null {
  const candidate = rawSdk[name];
  return typeof candidate === 'function' ? (candidate as AnyFn) : null;
}

const TRACKED_SYMBOLS = [
  'initSSO',
  'onWormholeDrop',
  'emitAsset',
  'useHostBridge',
  'sendWormhole',
  'getManifest',
] as const;

export interface SdkStatus {
  readonly available: boolean;
  readonly shim: boolean;
  readonly symbols: readonly string[];
}

export function sdkStatus(): SdkStatus {
  const symbols = TRACKED_SYMBOLS.filter((n) => pick(n) !== null);
  return {
    available: !sdkIsShim && symbols.length > 0,
    shim: sdkIsShim,
    symbols,
  };
}

export type SessionPhase = 'booting' | 'ready' | 'offline';

export interface SessionState {
  readonly phase: SessionPhase;
  readonly uid?: string;
  readonly detail: string;
}

export interface InitSSOOptions {
  /** 站点编号，如 '07' */
  readonly stationId: string;
  /** 微站对外标识（域名前缀），作为 /v1/auth/introspect 的 audience */
  readonly audience: string;
  /** 是否运行在 orbital-hub 的 iframe 内 —— 决定走 Cookie 还是 mx_idt 交换（架构 §4.4） */
  readonly embedded: boolean;
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * 初始化 SSO。SDK 的 initSSO 是**异步**的，这里返回一个带 \`dispose\` 的句柄。
 *
 * 注意：调用方拿到的永远是同步句柄，但 ready/offline 状态经 onStateChange 异步回填 ——
 * 这样 React 组件不会因为 "忘记 await" 而卡在 booting。
 */
export interface SsoHandle {
  dispose(): void;
}

export function initSSO(
  options: InitSSOOptions,
  onStateChange: (state: SessionState) => void,
): SsoHandle {
  const fn = pick('initSSO');
  if (!fn) {
    onStateChange({
      phase: 'offline',
      detail: 'MatrixID 未接入：SDK 未就位（骨架态，不伪造登录）',
    });
    return { dispose: () => {} };
  }

  let cancelled = false;
  let disposeFromSdk: (() => void) | undefined;

  const promise = (async () => {
    const result = await (fn({
      stationId: options.stationId,
      audience: options.audience,
      embedded: options.embedded,
    }) as Promise<unknown>);
    if (cancelled) return;

    const session = (result ?? {}) as Record<string, unknown>;
    // SDK 未定时可能返回 { matrix_uid } / { uid } / { session: {...} }
    const uid = String(session.matrix_uid ?? session.uid ?? '') || undefined;
    onStateChange({
      phase: 'ready',
      ...(uid ? { uid } : {}),
      detail:
        (options.embedded ? 'iframe 通道' : 'Cookie 通道') +
        ' · MatrixID 已就绪' +
        (uid ? ' · ' + uid : ''),
    });

    const maybeDispose = (session.dispose ?? session.close) as unknown;
    if (typeof maybeDispose === 'function') disposeFromSdk = maybeDispose as () => void;
  })();

  promise.catch((err: unknown) => {
    if (cancelled) return;
    onStateChange({ phase: 'offline', detail: 'MatrixID 初始化失败：' + describe(err) });
  });

  return {
    dispose: () => {
      cancelled = true;
      disposeFromSdk?.();
    },
  };
}

export interface WormholeReceipt {
  readonly traceId: string;
  readonly payloadType: string;
  readonly evidenceCount: number;
  readonly receivedAt: string;
  readonly sourceApp: string;
  /** 真投递时由 hub 下发的一次性凭证（120s）；shim/骨架态为 undefined */
  readonly receiptId?: string;
}

/**
 * 注册虫洞接收器。契约见 specs/contracts/wormhole-envelope.schema.json：
 * payload.evidence_anchors 至少 1 条，且每条必须带 source_doi_or_url + verification_level。
 */
export function onWormholeDrop(
  handler: (receipt: WormholeReceipt) => void,
): (() => void) | undefined {
  const fn = pick('onWormholeDrop');
  if (!fn) return undefined;

  const wrapped = (envelope: unknown) => {
    handler(toReceipt(envelope));
  };

  try {
    const result = fn(wrapped);
    return typeof result === 'function' ? (result as () => void) : () => {};
  } catch {
    return undefined;
  }
}

/** 把任意 envelope 归一成展示用收据；字段缺失也不抛错（骨架期要能容错）。 */
export function toReceipt(envelope: unknown): WormholeReceipt {
  const env = (envelope ?? {}) as Record<string, unknown>;
  const payload = (env.payload ?? {}) as Record<string, unknown>;
  const anchors = Array.isArray(payload.evidence_anchors) ? payload.evidence_anchors : [];
  const receiptId = env.receipt_id;
  return {
    traceId: String(env.trace_id ?? 'unknown'),
    payloadType: String(env.payload_type ?? 'unknown'),
    evidenceCount: anchors.length,
    receivedAt: new Date().toISOString(),
    sourceApp: String(env.source_app ?? 'unknown'),
    ...(typeof receiptId === 'string' ? { receiptId } : {}),
  };
}
`;
}

function renderInstrumentFacade(station, deps) {
  return `${fileHeader(station)}
'use client';

import type { ComponentType, ReactNode } from 'react';
import * as InstrumentUI from ${JSON.stringify(deps.instrumentUi)};

/**
 * instrument-ui 适配层
 * ==========================================================================
 * 骨架阶段该库可能尚未发布。这里只取一个最稳定的容器组件（面板/边框），
 * 拿不到就用本地同款样式顶替 —— 视觉 token 一致，所以两种实现看起来一样。
 * 组件库里任何新组件要进微站，都从这里暴露，不要在页面里直接 import 包。
 */
export interface BezelProps {
  readonly children?: ReactNode;
  readonly className?: string;
  readonly accent?: string;
}

const rawUi = InstrumentUI as unknown as Record<string, unknown>;

/** 依次尝试库里的候选组件名，命中即用。 */
function resolveComponent(candidates: readonly string[]): ComponentType<BezelProps> | null {
  for (const name of candidates) {
    const candidate = rawUi[name];
    if (candidate) return candidate as ComponentType<BezelProps>;
  }
  return null;
}

const LibraryBezel = resolveComponent(['InstrumentBezel', 'Bezel', 'InstrumentPanel']);

function LocalBezel({ children, className, accent }: BezelProps) {
  const style = accent ? ({ ['--site-accent' as string]: accent } as Record<string, string>) : undefined;
  return (
    <section className={['instrument-bezel', className].filter(Boolean).join(' ')} style={style}>
      {children}
    </section>
  );
}

/**
 * 面板容器：优先 instrument-ui，缺失时用本地实现。
 * \`source\` 供页面显示当前走的是哪条路（诚实标注，便于联调时一眼看出）。
 */
export function Bezel(props: BezelProps) {
  if (LibraryBezel) return <LibraryBezel {...props} />;
  return <LocalBezel {...props} />;
}

export const bezelSource: 'instrument-ui' | 'local' = LibraryBezel ? 'instrument-ui' : 'local';
`;
}

function renderSdkShim(station, deps) {
  return `${fileHeader(station)}
/**
 * 本地 shim：仅在 ${deps.sdk} 尚未发布/未安装时被 next.config.ts 别名到这里。
 * 它**不实现任何真实能力**（不登录、不投递），只让骨架能编译能跑，
 * 并把「未就位」这个事实通过 __matrixosShim 标记暴露给 facade。
 */
export const __matrixosShim = true;

export const SDK_SHIM_REASON =
  'workspace 包 ' + ${JSON.stringify(deps.sdk)} + ' 尚未就位：本 shim 不提供 SSO、不提供虫洞投递。';
`;
}

function renderInstrumentShim(station, deps) {
  return `${fileHeader(station)}
/**
 * 本地 shim：仅在 ${deps.instrumentUi} 尚未发布/未安装时被 next.config.ts 别名到这里。
 * 故意**不导出**任何组件 —— instrument-facade 解析不到就会回退到本地实现。
 */
export const __matrixosShim = true;

/** 与真实库同形的候选导出名探测用表；留空表示"什么都还没提供"。 */
export const __availableComponents: readonly string[] = [];
`;
}

function renderInstrumentStylesShim(station) {
  return `/* ────────────────────────────────────────────────────────────────────────────
 * 本地 shim：@matrixos/instrument-ui/styles.css 的替身
 * 仅在 instrument-ui 未就位时由 next.config.ts 别名到此文件。
 * 承载库的 token 契约（--iu-* 变量），让业务 CSS 在两种状态下都拿得到同名变量。
 * 真实库就位后本文件自动失效。
 * ──────────────────────────────────────────────────────────────────────────── */

:root {
  /* instrument-ui 的对外变量前缀（owner 约定：业务侧统一用 --iu-*） */
  --iu-bg: #050814;
  --iu-bg-panel: #0b1124;
  --iu-bg-panel-end: #070b18;
  --iu-bg-sunken: #020617;
  --iu-bg-raised: #0f172a;
  --iu-glass: rgba(13, 20, 38, 0.78);

  --iu-border: #1e293b;
  --iu-border-strong: #334155;
  --iu-border-accent: rgba(99, 102, 241, 0.22);
  --iu-bezel-border: rgba(56, 189, 248, 0.25);

  --iu-text: #f1f5f9;
  --iu-text-strong: #ffffff;
  --iu-text-secondary: #cbd5e1;
  --iu-text-muted: #94a3b8;
  --iu-text-faint: #64748b;

  --iu-action: #6366f1;
  --iu-instrument: #06b6d4;
  --iu-instrument-bright: #22d3ee;
  --iu-positive: #10b981;
  --iu-warning: #f59e0b;
  --iu-danger: #f43f5e;
  --iu-ecosystem: #8b5cf6;

  --iu-glow-spread: 0 0 28px -5px;
  --iu-glow-alpha: 0.45;

  --iu-radius-xs: 4px;
  --iu-radius-sm: 8px;
  --iu-radius-md: 12px;
  --iu-radius-lg: 16px;
  --iu-radius-pill: 9999px;

  --iu-font-sans: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC',
    'Microsoft YaHei', 'Noto Sans SC', sans-serif;
  --iu-font-mono: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;

  --iu-dur-fast: 150ms;
  --iu-dur-base: 300ms;
  --iu-dur-slow: 500ms;
  --iu-pulse-duration: 2.8s;

  /* 语义缩放标尺（StarOrbit 用；1.0 → 10.0） */
  --iu-zoom: 2.5;
}
`;
}

function renderSiteShell(station) {
  return `${fileHeader(station)}
'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { SITE } from '../site.config';
import { Bezel, bezelSource } from '../lib/instrument-facade';
import {
  initSSO,
  onWormholeDrop,
  sdkStatus,
  type SessionState,
  type WormholeReceipt,
} from '../lib/sdk-facade';

/** 占位仪器的柱状高度：确定性序列（不用随机数，避免 SSR/CSR 不一致）。 */
const GAUGE_HEIGHTS = [38, 62, 47, 81, 55, 70, 44, 92, 66, 51];

export function SiteShell() {
  const [embedded, setEmbedded] = useState(false);
  const [session, setSession] = useState<SessionState>({
    phase: 'booting',
    detail: '正在初始化 MatrixID…',
  });
  const [receipts, setReceipts] = useState<readonly WormholeReceipt[]>([]);

  const status = useMemo(() => sdkStatus(), []);

  useEffect(() => {
    const isEmbedded = typeof window !== 'undefined' && window.parent !== window;
    setEmbedded(isEmbedded);
    if (typeof document !== 'undefined') {
      document.body.dataset.embedded = isEmbedded ? 'true' : 'false';
    }

    const sso = initSSO(
      {
        stationId: SITE.id,
        audience: SITE.appId,
        embedded: isEmbedded,
      },
      (next) => setSession(next),
    );

    const disposeDrop = onWormholeDrop((receipt) => {
      setReceipts((prev) => [receipt, ...prev].slice(0, 5));
    });

    return () => {
      sso.dispose();
      disposeDrop?.();
    };
  }, []);

  const handleManualProbe = useCallback(() => {
    setSession((prev) => ({
      phase: prev.phase,
      uid: prev.uid,
      detail:
        '通道自检 · ' +
        (status.available ? 'SDK 符号可用：' + status.symbols.join(' / ') : 'SDK 未就位'),
    }));
  }, [status]);

  const tone = session.phase === 'ready' ? 'ok' : session.phase === 'booting' ? 'warn' : 'off';

  return (
    <>
      <header className="site-header site-chrome">
        <span className="site-id">{SITE.id}</span>
        <h1 className="site-title">{SITE.name}</h1>
        <span className="site-orbit">{SITE.orbitName}</span>
        <span className="site-domain mono">{SITE.domain}</span>
      </header>

      <dl className="meta-grid">
        <div className="meta-card">
          <dt>UI 形态</dt>
          <dd>{SITE.uiStyle}</dd>
        </div>
        <div className="meta-card">
          <dt>独立台账</dt>
          <dd>{SITE.ledger}</dd>
        </div>
        <div className="meta-card">
          <dt>原型来源</dt>
          <dd>{SITE.source}</dd>
        </div>
      </dl>

      <Bezel className="instrument-slot">
        <h2>{SITE.uiStyle} · 占位仪器</h2>
        <p>{SITE.desc}</p>
        <div className="placeholder-gauges" role="img" aria-label="占位仪器示数">
          {GAUGE_HEIGHTS.map((height, index) => (
            <span className="placeholder-gauge" key={index} style={{ height: height + '%' }} />
          ))}
        </div>
        <div className="status-row">
          <span className="chip" data-tone={tone}>
            MatrixID · {session.phase}
          </span>
          <span className="chip" data-tone={embedded ? 'warn' : 'off'}>
            {embedded ? 'iframe 内嵌' : '独立窗口'}
          </span>
          <span className="chip" data-tone={bezelSource === 'instrument-ui' ? 'ok' : 'off'}>
            面板 · {bezelSource}
          </span>
          <span className="chip" data-tone={status.available ? 'ok' : 'off'}>
            SDK · {status.available ? '已就位' : '未就位'}
          </span>
          <button type="button" className="chip" onClick={handleManualProbe}>
            通道自检
          </button>
        </div>
        <p className="mono" style={{ fontSize: 'var(--text-2xs)' }}>
          {session.detail}
        </p>
        {receipts.length > 0 ? (
          <ul className="receipt-list custom-scrollbar">
            {receipts.map((receipt) => (
              <li key={receipt.traceId + receipt.receivedAt}>
                ← {receipt.sourceApp} · {receipt.payloadType} · 证据锚点 {receipt.evidenceCount} 条 ·
                trace {receipt.traceId.slice(0, 8)}
              </li>
            ))}
          </ul>
        ) : (
          <p style={{ fontSize: 'var(--text-2xs)', color: 'var(--color-text-faint)' }}>
            虫洞接收器已挂载：等待 hub 投送（当前 0 条收据）。
          </p>
        )}
      </Bezel>
    </>
  );
}
`;
}

function renderManifest(station) {
  const permissions = ['matrix_id:read', 'profile:read', 'assets:read', 'assets:write'];
  if (station.emits.length > 0) permissions.push('wormhole:send');
  if (station.accepts.length > 0) permissions.push('wormhole:receive');

  const manifest = {
    manifest_version: '1.0',
    app_id: station.appId,
    name: station.name,
    entry_url: 'https://' + station.domain,
    orbit_station: station.orbitKey,
    accent_color: station.accent,
    accepts: station.accepts,
    emits: station.emits,
    permissions,
    author: { lab_name: 'MatrixOS', university: 'MatrixOS' },
  };
  return JSON.stringify(manifest, null, 2) + '\n';
}

function renderEnvExample(station) {
  return `# ── ${station.id} ${station.name} · ${station.domain} ───────────────────────────
# 复制为 .env.local 后填写。.env* 已在仓库根 .gitignore 中，禁止提交真实密钥。

# MatrixID / 资产服务（matrix-core）
MATRIX_CORE_URL=http://localhost:8000
NEXT_PUBLIC_MATRIX_CORE_URL=http://localhost:8000

# 本站在 iframe 宿主（orbital-hub）里的身份，用于 CSP frame-ancestors 与 mx_idt 交换
NEXT_PUBLIC_SITE_ID=${station.id}
NEXT_PUBLIC_SITE_DOMAIN=${station.domain}

# 开发期是否强制走"独立窗口"路径（true 时忽略 iframe 握手）
NEXT_PUBLIC_FORCE_STANDALONE=false
`;
}

function renderReadme(station) {
  return `# ${station.id} · ${station.name}

> MatrixOS 微站 · ${station.orbitName} · \`${station.domain}\` · 目录 \`apps/micro-sites/${station.dirName}/\`
>
> 目录名由 [ADR-001](../../../../docs/01-plan/00-adr-001-microsite-numbering.md) 裁决：
> **编号与站点归属取花名册，目录词根取描述性命名**。所以目录名与域名可以不一致
> （14 是 \`review-architect\` 但域名是 \`review-lab\`；04 是 \`pat-radar\` 但域名是 \`pat-hot\`），
> 这是刻意的，**不要为了"对齐"改目录名** —— 会引发域名迁移。

| 项 | 值 |
| :--- | :--- |
| UI 形态 | ${station.uiStyle} |
| 独立台账 | ${station.ledger} |
| 原型来源 | ${station.source} |
| 开发端口 | \`${station.devPort}\` |
| 虫洞接收 | ${station.accepts.length ? station.accepts.map((t) => '\`' + t + '\`').join('、') : '（当前不接收）'} |
| 虫洞投送 | ${station.emits.length ? station.emits.map((t) => '\`' + t + '\`').join('、') : '（当前不投送）'} |

${station.desc}

## 跑起来

\`\`\`bash
pnpm --filter ${station.pkgName} dev     # http://localhost:${station.devPort}
pnpm --filter ${station.pkgName} build
\`\`\`

## 这个骨架包含什么

- Next.js 15 App Router + React 19，零 Tailwind、零外部 CDN（内网可用）
- \`src/site.config.ts\`：站点身份，来源是 \`specs/microsites.json\`，不要手改
- \`src/lib/sdk-facade.ts\`：**唯一** import \`@matrixos/sdk\` 的地方（SSO + 虫洞接收器）
- \`src/lib/instrument-facade.tsx\`：**唯一** import \`@matrixos/instrument-ui\` 的地方（面板容器）
- \`matrix-app.manifest.json\`：符合 \`specs/contracts/matrix-app-manifest.schema.json\`，供 hub 星轨注册
- iframe 内降级模式：被 hub 嵌入时自动隐藏站内标题/页脚（ADR-08 的强制能力）

### 两个 package 还没发布也能跑

\`next.config.ts\` 在加载时探测 \`@matrixos/sdk\` / \`@matrixos/instrument-ui\` 能否 resolve，
**解析不到就把 specifier 别名到 \`src/lib/shims/\`**。于是：

- import 已经按最终形态写好（不用等包）
- \`pnpm dev\` 立刻能跑
- 包一旦就位，别名自动失效，源码一行都不用改

界面会**显式**标注「SDK 未就位」「面板 · local」——不伪造登录态，不假装虫洞通了。

## 下一步（S3 功能完备化）

1. 用 \`@matrixos/instrument-ui\` 的仪器族替换占位仪器（旋钮族/图表族/雷达族/天平族）
2. 按台账 \`${station.ledger}\` 落 \`/v1/assets\` 读写
3. 虫洞契约按 \`specs/contracts/wormhole-envelope.schema.json\` 接实现（证据锚点非空是红线）

---

生成器：\`pnpm gen:site --id=${station.id} --force\`（\`scripts/gen-site.mjs\`）
`;
}

function renderNextEnvDts() {
  return `/// <reference types="next" />
/// <reference types="next/image-types/global" />

// 由 Next.js 在 dev/build 时自动维护，此处保留占位以免 tsc 找不到声明。
`;
}

// =====================================================================================
// 6. 单站文件清单
// =====================================================================================

function siteFiles(station, deps) {
  return [
    { rel: 'package.json', content: renderPackageJson(station, deps) },
    { rel: 'tsconfig.json', content: renderTsconfig(station, '../../../tsconfig.base.json') },
    { rel: 'next.config.ts', content: renderNextConfig(station, deps) },
    { rel: 'next-env.d.ts', content: renderNextEnvDts() },
    { rel: 'matrix-app.manifest.json', content: renderManifest(station) },
    { rel: '.env.example', content: renderEnvExample(station) },
    { rel: 'README.md', content: renderReadme(station) },
    { rel: 'src/site.config.ts', content: renderSiteConfig(station) },
    { rel: 'src/app/layout.tsx', content: renderLayout(station, deps) },
    { rel: 'src/app/page.tsx', content: renderPage(station) },
    { rel: 'src/app/globals.css', content: renderGlobalsCss(station) },
    { rel: 'src/components/site-shell.tsx', content: renderSiteShell(station) },
    { rel: 'src/lib/sdk-facade.ts', content: renderSdkFacade(station, deps) },
    { rel: 'src/lib/instrument-facade.tsx', content: renderInstrumentFacade(station, deps) },
    { rel: 'src/lib/shims/matrix-sdk.shim.ts', content: renderSdkShim(station, deps) },
    { rel: 'src/lib/shims/instrument-ui.shim.tsx', content: renderInstrumentShim(station, deps) },
    {
      rel: 'src/lib/shims/instrument-ui.styles.css',
      content: renderInstrumentStylesShim(station),
    },
  ];
}

function writeSite(station, deps, opts) {
  const dir = join(MICRO_ROOT, station.dirName);
  const files = siteFiles(station, deps);
  const written = [];
  const skipped = [];

  for (const file of files) {
    const abs = join(dir, file.rel);
    if (existsSync(abs) && !opts.force) {
      // 已存在且未加 --force：跳过（保护手改过的业务代码）
      if (readFileSync(abs, 'utf8') !== file.content) skipped.push(file.rel);
      continue;
    }
    if (!opts.dryRun) {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, file.content, 'utf8');
    }
    written.push(file.rel);
  }

  return { dir, written, skipped };
}

// =====================================================================================
// 7. orbital-hub 注册表生成（花名册 → TS，单一事实源）
// =====================================================================================

function rosterChecksum() {
  return createHash('sha256').update(readFileSync(ROSTER_PATH)).digest('hex').slice(0, 16);
}

function renderRegistry(stations) {
  const body = stations
    .map((s) => {
      const fields = [
        '    id: ' + JSON.stringify(s.id) + ',',
        '    appId: ' + JSON.stringify(s.appId) + ',',
        '    dirName: ' + JSON.stringify(s.dirName) + ',',
        '    pkgName: ' + JSON.stringify(s.pkgName) + ',',
        '    name: ' + JSON.stringify(s.name) + ',',
        '    domain: ' + JSON.stringify(s.domain) + ',',
        '    devPort: ' + s.devPort + ',',
        '    orbitIndex: ' + s.orbitIndex + ',',
        '    orbitKey: ' + JSON.stringify(s.orbitKey) + ',',
        '    orbitName: ' + JSON.stringify(s.orbitName) + ',',
        '    orbitGroup: ' + JSON.stringify(s.orbitGroup) + ',',
        '    accent: ' + JSON.stringify(s.accent) + ',',
        '    uiStyle: ' + JSON.stringify(s.uiStyle) + ',',
        '    ledger: ' + JSON.stringify(s.ledger) + ',',
        '    desc: ' + JSON.stringify(s.desc) + ',',
        '    source: ' + JSON.stringify(s.source) + ',',
        '    accepts: ' + JSON.stringify(s.accepts) + ',',
        '    emits: ' + JSON.stringify(s.emits) + ',',
      ];
      return '  {\n' + fields.join('\n') + '\n  },';
    })
    .join('\n');

  const orbits = Object.entries(ORBIT_META)
    .map(([index, meta]) => {
      const count = stations.filter((s) => s.orbitIndex === Number(index)).length;
      return (
        '  { index: ' +
        index +
        ', key: ' +
        JSON.stringify(meta.key) +
        ', label: ' +
        JSON.stringify(meta.label) +
        ', accent: ' +
        JSON.stringify(meta.accent) +
        ', stationCount: ' +
        count +
        ' },'
      );
    })
    .join('\n');

  return `/**
 * ⚠️ 自动生成 · 请勿手改
 * 生成命令：pnpm gen:site --emit-registry
 * 唯一事实源：specs/microsites.json（花名册）+ docs/01-plan/00-adr-001-microsite-numbering.md（目录命名）
 * 源文件校验和（sha256 前 16 位）：${rosterChecksum()}
 *
 * 为什么不用 \`import spec from '../../../../specs/microsites.json'\`：
 * Next 的模块图以 app 目录为根，跨出仓库根去引 JSON 会踩 outputFileTracingRoot 与
 * externalDir 的边界；把花名册编译成类型安全的 TS 常量更稳，且能在这里一次性
 * 把 \`orbitName\` 解析成轨道索引/枚举/强调色，hub 侧不再做字符串解析。
 */

export type OrbitKey =
  | 'study'
  | 'spark'
  | 'pat_hot'
  | 'xingmen'
  | 'workshop'
  | 'cloud_balance'
  | 'pre_job';

export type PayloadType =
  | 'paper_doi_bundle'
  | 'comparison_matrix_row'
  | 'curve_fit_parameters'
  | 'mentor_match_card'
  | 'verified_cv_evidence';

export interface MicrositeStation {
  readonly id: string;
  /** 域名前缀，等于 manifest 的 app_id */
  readonly appId: string;
  /** ADR-001 目录名 */
  readonly dirName: string;
  readonly pkgName: string;
  readonly name: string;
  readonly domain: string;
  /** 开发端口：3010 + (id - 1) */
  readonly devPort: number;
  /** 1..7 */
  readonly orbitIndex: number;
  readonly orbitKey: OrbitKey;
  readonly orbitName: string;
  /** 花名册的 orbit 分组：1-2 / 3-4 / 5 / 6-7 */
  readonly orbitGroup: string;
  readonly accent: string;
  readonly uiStyle: string;
  readonly ledger: string;
  readonly desc: string;
  readonly source: string;
  readonly accepts: readonly PayloadType[];
  readonly emits: readonly PayloadType[];
}

export interface OrbitMeta {
  readonly index: number;
  readonly key: OrbitKey;
  readonly label: string;
  readonly accent: string;
  readonly stationCount: number;
}

export const STATIONS: readonly MicrositeStation[] = [
${body}
] as const;

export const ORBITS: readonly OrbitMeta[] = [
${orbits}
] as const;

export const STATION_BY_ID: Readonly<Record<string, MicrositeStation>> = STATIONS.reduce(
  (acc, station) => {
    acc[station.id] = station;
    return acc;
  },
  {} as Record<string, MicrositeStation>,
);

export const STATIONS_BY_ORBIT: Readonly<Record<number, readonly MicrositeStation[]>> = ORBITS.reduce(
  (acc, orbit) => {
    acc[orbit.index] = STATIONS.filter((station) => station.orbitIndex === orbit.index);
    return acc;
  },
  {} as Record<number, readonly MicrositeStation[]>,
);

/** 轨道分布必须是 3 / 5 / 7 / 3（架构 §2.1 落地规则 4）；生成期已校验，这里留一道运行时断言。 */
export const ORBIT_GROUP_DISTRIBUTION: Readonly<Record<string, number>> = STATIONS.reduce(
  (acc, station) => {
    acc[station.orbitGroup] = (acc[station.orbitGroup] ?? 0) + 1;
    return acc;
  },
  {} as Record<string, number>,
);
`;
}

// =====================================================================================
// 8. 语法自检（可选，依赖根目录 typescript）
// =====================================================================================

function listSourceFiles(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.next' || entry.name === '.turbo') continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) listSourceFiles(abs, out);
    else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(abs);
  }
  return out;
}

function verifySyntax(report) {
  let ts;
  try {
    const req = createRequire(join(ROOT, 'package.json'));
    ts = req('typescript');
  } catch {
    report.push({
      ok: false,
      message: '根目录未安装 typescript，跳过语法自检（先 pnpm install 再跑 --verify）',
    });
    return { checked: 0, failures: 0, skipped: true };
  }

  const roots = [join(ROOT, 'apps'), join(ROOT, 'scripts')];
  const files = roots.flatMap((dir) => listSourceFiles(dir)).filter((f) => !f.endsWith('.mjs'));
  const scriptFiles = roots
    .flatMap((dir) => (existsSync(dir) ? [dir] : []))
    .flatMap((dir) => readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.mjs'))
      .map((e) => join(dir, e.name)));

  const all = [...files, ...scriptFiles];
  let failures = 0;

  for (const file of all) {
    const content = readFileSync(file, 'utf8');
    const isTsx = file.endsWith('.tsx');
    const result = ts.transpileModule(content, {
      reportDiagnostics: true,
      fileName: file,
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        jsx: isTsx ? ts.JsxEmit.Preserve : ts.JsxEmit.None,
        isolatedModules: true,
      },
    });
    const errors = (result.diagnostics ?? []).filter(
      (d) => d.category === ts.DiagnosticCategory.Error,
    );
    if (errors.length > 0) {
      failures += 1;
      const first = errors[0];
      const pos = first.file && first.start !== undefined
        ? first.file.getLineAndCharacterOfPosition(first.start)
        : null;
      report.push({
        ok: false,
        file: relative(ROOT, file),
        message:
          ts.flattenDiagnosticMessageText(first.messageText, ' ') +
          (pos ? ' @ ' + (pos.line + 1) + ':' + (pos.character + 1) : ''),
        count: errors.length,
      });
    }
  }

  return { checked: all.length, failures, skipped: false };
}

// =====================================================================================
// 9. 主流程
// =====================================================================================

function printNamingTable(stations) {
  const dirWidth = Math.max(...stations.map((s) => s.dirName.length), 8);
  console.log('\nADR-001 命名表（目录名 ≠ 域名，刻意如此）\n');
  console.log(
    '  ' +
      'ID'.padEnd(4) +
      '目录名'.padEnd(dirWidth + 2) +
      '域名'.padEnd(32) +
      '端口'.padEnd(7) +
      '轨道',
  );
  console.log('  ' + '─'.repeat(4 + dirWidth + 2 + 32 + 7 + 16));
  for (const s of stations) {
    console.log(
      '  ' +
        s.id.padEnd(4) +
        s.dirName.padEnd(dirWidth + 2) +
        s.domain.padEnd(32) +
        String(s.devPort).padEnd(7) +
        s.orbitName,
    );
  }
  console.log('\n  首批 6 站（S1-16）：01 / 04 / 06 / 09 / 11 / 16');
  console.log('  单站生成：pnpm gen:site --id=07 --domain=' + (stations.find((s) => s.id === '07')?.appId ?? '') + '\n');
}

function main() {
  const argv = process.argv.slice(2);
  const { opts, errors: argErrors } = parseArgs(argv);

  if (argErrors.length > 0) {
    console.error('\n✗ 参数错误：\n  - ' + argErrors.join('\n  - ') + '\n');
    console.error(USAGE);
    process.exit(2);
  }
  if (opts.help) {
    console.log(USAGE);
    return 0;
  }

  const stations = loadStations();

  // 无参数 && 非 registry/verify → 打印命名表
  const wantsWork = opts.all || opts.ids?.length || opts.emitRegistry || opts.verify;
  if (!wantsWork) {
    printNamingTable(stations);
    console.log(USAGE + '\n');
    return 0;
  }

  // deps.sdk / deps.instrumentUi 必须是**纯字符串**（模板里直接插进 import 语句与 package.json key）。
  // 来源信息另存，只用于日志，绝不进入生成代码。
  const sdkResolved = resolveWorkspacePackageName('matrix-sdk');
  const uiResolved = resolveWorkspacePackageName('instrument-ui');
  const deps = {
    sdk: sdkResolved.name,
    instrumentUi: uiResolved.name,
  };
  const depSources = {
    sdk: sdkResolved.source,
    instrumentUi: uiResolved.source,
  };

  const result = { generated: [], registry: null, verify: null };

  // ── 微站骨架 ────────────────────────────────────────────────────────────────
  if (opts.all || opts.ids?.length) {
    const targets = selectStations(stations, opts);
    if (!opts.json) {
      console.log(
        '\n生成 ' + targets.length + ' 个微站骨架' + (opts.dryRun ? '（dry-run，不落盘）' : ''),
      );
      console.log(
        '  workspace 依赖：sdk=' +
          deps.sdk +
          '（' +
          depSources.sdk +
          '）、instrument-ui=' +
          deps.instrumentUi +
          '（' +
          depSources.instrumentUi +
          '）\n',
      );
    }

    for (const station of targets) {
      const { dir, written, skipped } = writeSite(station, deps, opts);
      result.generated.push({
        id: station.id,
        dir: relative(ROOT, dir),
        written: written.length,
        skipped: skipped.length,
      });
      if (!opts.json) {
        console.log(
          '  ✓ ' +
            station.id +
            '  ' +
            relative(ROOT, dir).split(sep).join('/') +
            '  → ' +
            written.length +
            ' 文件' +
            (skipped.length ? '（跳过 ' + skipped.length + ' 个已存在）' : ''),
        );
        if (opts.dryRun) {
          for (const rel of written) console.log('      · ' + rel);
        } else if (skipped.length) {
          console.log('      已存在未覆盖：' + skipped.join(', ') + '（要覆盖加 --force）');
        }
      }
    }
  }

  // ── hub 注册表 ──────────────────────────────────────────────────────────────
  if (opts.emitRegistry || opts.all) {
    const content = renderRegistry(stations);
    const exists = existsSync(REGISTRY_PATH);
    const changed = !exists || readFileSync(REGISTRY_PATH, 'utf8') !== content;
    if (!opts.dryRun && changed) {
      mkdirSync(dirname(REGISTRY_PATH), { recursive: true });
      writeFileSync(REGISTRY_PATH, content, 'utf8');
    }
    result.registry = {
      path: relative(ROOT, REGISTRY_PATH),
      changed,
      dryRun: opts.dryRun,
    };
    if (!opts.json) {
      console.log(
        '\n  ' +
          (changed ? '✓' : '·') +
          ' orbital-hub 注册表 ' +
          (changed ? (opts.dryRun ? '待写入（dry-run）' : '已刷新') : '无变化') +
          ' → ' +
          relative(ROOT, REGISTRY_PATH).split(sep).join('/'),
      );
    }
  }

  // ── 语法自检 ────────────────────────────────────────────────────────────────
  if (opts.verify) {
    const report = [];
    const summary = verifySyntax(report);
    result.verify = { ...summary, report: report.slice(0, 40) };
    if (!opts.json) {
      if (summary.skipped) {
        console.log('\n  ! ' + (report[0]?.message ?? 'typescript 不可用，跳过自检'));
      } else if (summary.failures === 0) {
        console.log('\n  ✓ 语法自检通过：' + summary.checked + ' 个 .ts/.tsx/.mjs 文件');
      } else {
        console.log('\n  ✗ 语法自检失败：' + summary.failures + ' / ' + summary.checked + ' 个文件');
        for (const item of report) {
          if (item.ok === false)
            console.log('    - ' + (item.file ?? '') + ': ' + item.message + (item.count > 1 ? '（共 ' + item.count + ' 处）' : ''));
        }
      }
    }
  }

  if (opts.json) {
    console.log(JSON.stringify({ ok: !result.verify || result.verify.failures === 0, ...result }, null, 2));
  } else {
    console.log('\n下一步：');
    if (result.generated.length > 0) {
      const first = result.generated[0];
      const station = stations.find((s) => s.dirName === first?.dir.split('/').pop());
      if (station) {
        console.log('  pnpm --filter ' + station.pkgName + ' dev     # http://localhost:' + station.devPort);
      }
    }
    if (result.generated.length > 0 || result.registry) {
      console.log('  （依赖安装由 Lead 统一执行：本脚本不跑 pnpm install）\n');
    }
  }

  if (result.verify && result.verify.failures > 0) return 1;
  return 0;
}

try {
  process.exitCode = main();
} catch (err) {
  if (err instanceof GenError) {
    console.error('\n✗ ' + err.message + '\n');
    process.exitCode = 1;
  } else {
    console.error('\n✗ 未预期错误：');
    console.error(err);
    process.exitCode = 1;
  }
}
