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

// 完工层的两份单一事实源：虫洞契约 + 分发模板清单。
// 与 scripts/wire-workbench.mjs 共用同一份，保证 `gen:site --force` 与分发器产出一致。
import { CONTRACTS, PAYLOAD_TYPES, permissionsFor } from './lib/microsite-contracts.mjs';
import { TEMPLATE_FILES, templateHeader } from './lib/microsite-templates.mjs';
import { INSTRUMENT_CSS } from './lib/microsite-instrument-css.mjs';
import { FRAME_ANCESTORS } from './lib/pages-headers.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROSTER_PATH = join(ROOT, 'specs', 'microsites.json');
const MICRO_ROOT = join(ROOT, 'apps', 'micro-sites');
const TEMPLATES_DIR = join(MICRO_ROOT, 'shared', 'templates');
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

/**
 * 强调色的「文字档」降级表（只列不达 AA 正文线的色）。
 *
 * 为什么需要：--site-accent 既做描边/填充（图形场景，3:1 即可），
 * 也被当文字色用在 .site-orbit / .gpa-value.accent / td.accent 三处
 * 小字号上（需 4.5:1）。visual-system §2.5 实测 indigo-500 4.00:1、
 * violet-500 4.22:1 双双不达标，故在文字场景降级到 400 档。
 *
 * 未列出的色（amber 8.31 / cyan 7.35 / emerald 7.04 / sky 9.88 / rose 4.86）
 * 本身已过 4.5:1，文字场景原样沿用，不需要双份 token。
 */
const ACCENT_TEXT_FALLBACK = {
  '#6366f1': '#818cf8', // indigo-500 4.00 → indigo-400 5.98
  '#8b5cf6': '#a78bfa', // violet-500 4.22 → violet-400 6.56
};

// 虫洞契约（accepts / emits / 投送目标）的唯一事实源在 scripts/lib/microsite-contracts.mjs。
// 这里只做派生 —— 曾经两处各持一份，生成器那份是骨架期旧值，
// 跑一次 `pnpm gen:site --force` 就会把已完工站点的 manifest 打回 accepts: [] / emits: []。
const HOOKS = Object.fromEntries(
  Object.entries(CONTRACTS).map(([id, contract]) => [
    id,
    { accepts: [...contract.accepts], emits: [...contract.emits] },
  ]),
);

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

    // 逻辑域：<appId>.matrixos.cc.cd（身份 / manifest.entry_url / UI 展示）。
    // 部署域是 mx-<appId>.matrixos.cc.cd，由 layout.tsx 的 SITE_ORIGIN 拼出，不在花名册里。
    // 为什么不是 .matrixos.edu：该域从未存在（NXDOMAIN），见 docs/02-engineering/09-backend-deploy.md。
    const domain = String(raw.domain ?? '');
    if (!/^[a-z0-9-]+\.matrixos\.cc\.cd$/.test(domain)) {
      problems.push(`id=${id} 域名不合规（应为 <appId>.matrixos.cc.cd）：${domain}`);
    }
    const appId = domain.replace(/\.matrixos\.cc\.cd$/, '');
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
      /* 文字专用强调色：原色对最差表面 #0f172a 若 < 4.5:1 则降级到 400 档。
       * 实测（visual-system §2.5）：indigo-500 4.00、violet-500 4.22 不达标
       * → 分别用 indigo-400 #818cf8（5.98）与 violet-400 #a78bfa（6.56）；
       * 其余五色本身已达 AA/AAA，原样沿用。 */
      accentText: ACCENT_TEXT_FALLBACK[meta.accent] ?? meta.accent,
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
    const givenAppId = given.replace(/\.matrixos\.cc\.cd$/, '');
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

/**
 * 读 `apps/micro-sites/shared/templates/<name>`，加站点头后返回。
 *
 * 为什么生成器也走共享模板：这 6 个文件是 18 站同构的分发产物，真身在 shared/templates/。
 * 生成器曾经各持一份模板字符串（sdk-facade 还在探测 6 个根本不存在的 SDK 顶层符号），
 * 跑一次 `pnpm gen:site --force` 就把已完工站点打回骨架态。现在两边读同一份模板、
 * 写同样的头，产出逐字节一致，`wire-workbench.mjs --check` 不会误报漂移。
 */
function renderSharedTemplate(station, templateName) {
  const file = TEMPLATE_FILES.find((item) => item.from === templateName);
  if (!file) throw new GenError('未知模板：' + templateName + '（不在 TEMPLATE_FILES 里）');
  const body = readFileSync(join(TEMPLATES_DIR, templateName), 'utf8');
  return templateHeader(station, file) + body;
}

/**
 * 新站的 site-spec 起始骨架。
 *
 * site-spec 是**每站手写**的唯一业务文件，所以 `writeSite` 给它打了 neverOverwrite，
 * 加 --force 也不会覆盖（否则重新生成骨架会抹掉整站业务数据）。
 * 这里只保证「生成完就能编译、能跑通验收」，真实演示数据由人替换。
 */
function renderSiteSpecStarter(station) {
  const contract = CONTRACTS[station.id] ?? {
    exportName: 'records',
    accepts: [],
    emits: [],
    emitTarget: '',
  };
  const emitType = contract.emits[0] ?? 'verified_cv_evidence';
  const acceptType = contract.accepts[0] ?? emitType;
  // 注意：这里不能拼 fileHeader(station) —— 它自带收尾的 */，再往后接「 * 业务规格…」
  // 会把注释提前闭合，生成的 site-spec 直接语法错（TS1109 / TS1127）。
  const header = [
    '/**',
    ' * ⚠️ 自动生成骨架 · 之后由人（或子代理）接管，scripts/gen-site.mjs 不再覆盖本文件',
    ' * 站点：' + station.id + ' ' + station.name,
    ' * 轨道：' + station.orbitName + ' · 域名：' + station.domain,
    ' *',
    ' * 业务规格 —— **本站唯一需要手写的文件**。',
    ' *',
    ' * 现在只是能编译的占位：把 seed 换成真实演示数据（数值从 @matrixos/microsite-data 算，不要手抄），',
    ' * 再补 payloadOf / rowOfEnvelope，然后跑 node scripts/microsite-verify.mjs --site=<目录名> 验收。',
    ' * 规范见 docs/02-engineering/08-microsite-workbench.md。',
    ' */',
  ].join('\n');
  return `${header}
import { createRowSpec, type RowSpecConfig } from '@matrixos/microsite-data';

const config: RowSpecConfig = {
  exportName: '${contract.exportName}',
  seed: [
    { title: '待补全记录 01', meta: '占位 · 请替换为真实演示数据', detail: '…' },
    { title: '待补全记录 02', meta: '占位 · 请替换为真实演示数据', detail: '…' },
    { title: '待补全记录 03', meta: '占位 · 请替换为真实演示数据', detail: '…' },
  ],
  emit: { targetApp: '${contract.emitTarget}', payloadType: '${emitType}' },
  accept: { payloadType: '${acceptType}', description: '接收上游投递的记录，插入台账顶部。' },
};

export const siteSpec = createRowSpec(config);
`;
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
   *
   * 白名单**不在这里手写**：直接取 scripts/lib/pages-headers.mjs 的 FRAME_ANCESTORS，
   * 与 Cloudflare Pages 的 _headers 同源。曾经这里写死 'https://orbital.matrixos.edu'
   * （NXDOMAIN 愿景域），而 _headers 里早已换成真实宿主 —— 两份清单漂移，
   * 静态导出产物（无 next 运行时，headers() 不生效）与线上行为不一致。
   */
  async headers() {
    const frameAncestors = ${JSON.stringify(FRAME_ANCESTORS)};
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
  return renderSharedTemplate(station, 'page.tsx');
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
  /* V6 修正（visual-system §2.5）：slate-500 #64748b 在 #0f172a 上仅 3.75:1，
   * 连 AA-large 都不达。换成 #7d8ba1（5.17:1 ✓ AA，与 instrument-ui
   * tokens.css 的 --iu-text-faint 同值同步——两套 token 只允许一处权威差异，
   * 对比度结论必须一致）。 */
  --color-text-faint: #7d8ba1;

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
  /* 文字专用强调色 —— 实测缺陷修复（visual-system §2.5）：
   * indigo-500 #6366f1 对深底仅 4.00:1、violet-500 #8b5cf6 仅 4.22:1，
   * 都低于 AA 正文线 4.5:1。而 --site-accent 被当作**文字色**用在
   * .site-orbit / .gpa-value.accent / td.accent 三处小字号上。
   * 处置：品牌色不动（描边/填充/选中态继续用它），只给文字场景派生一档
   * 提亮的 accent-text —— 与 instrument-ui 的 --iu-*-text 分层同一思路。
   * 规则：原色对 #0f172a 是否 ≥4.5:1，不达标则用 400 档，达标则原样。 */
  --site-accent-text: ${station.accentText};

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

  /* Typography —— V3 修正：补 CJK 回退；V8 修正（visual-system §3.2）：字号阶梯
   * 接 calc 缩放，机制与 instrument-ui 的 --iu-type-scale 同构——默认 1×，
   * 渲染逐像素不变；挂 [data-iu-density='presentation'] 即整体 1.25×。 */
  --font-sans: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC',
    'Microsoft YaHei', 'Noto Sans SC', sans-serif;
  --font-mono: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
  --type-scale: 1;
  --text-2xs: calc(10px * var(--type-scale));
  --text-xs: calc(12px * var(--type-scale));
  --text-sm: calc(14px * var(--type-scale));
  --text-base: calc(16px * var(--type-scale));
  --text-lg: calc(18px * var(--type-scale));
  --text-xl: calc(20px * var(--type-scale));
  --text-2xl: calc(24px * var(--type-scale));
}

/* V8 配套：答辩/投屏密度档开关。
 *
 * ⚠️ 2026-10-21 修正：原来这里写死 --type-scale: 1.25，导致**只能 1.25 一档**。
 * hub 下发 xlarge（1.5）时，实测微站外壳文字仍停在 12.5px（= 10 × 1.25）——
 * 因为这条规则把内联设置的更高倍数覆盖掉了。
 *
 * 改成**引用 --iu-type-scale**：那是组件库的档位变量（tokens.css 的
 * [data-iu-density='presentation'] 设它，hub 也可以在 html 上内联覆盖它）。
 * 这样微站外壳（--text-*）与库组件（--iu-text-*）**共用同一个倍数**，
 * 无论 1.25 还是 1.5 都一致 —— 单一事实源，不会再出现「库放大了、外壳没放大」。 */
[data-iu-density='presentation'] { --type-scale: var(--iu-type-scale, 1.25); }

* { box-sizing: border-box; }

html, body { margin: 0; padding: 0; }

body {
  background: var(--color-bg);
  color: var(--color-text);
  font-family: var(--font-sans);
  font-size: var(--text-sm);
  line-height: 1.65;
  min-height: 100vh;
  /* 触屏：关掉系统默认灰色高亮闪层，让 :active 按压态（见 instrument 样式
   * 尾部「触屏按压反馈与命中区」块）成为唯一反馈通道——否则两层反馈叠加。 */
  -webkit-tap-highlight-color: transparent;
  -webkit-font-smoothing: antialiased;
}

/* 仅嵌入模式取消视口高度（ADR-08：iframe 内不滚，高度跟着 hub 走） */
body[data-embedded='true'] { min-height: 0; }

/* ADR-08：iframe 内不滚 —— 必须同时压掉 html 与 body 两层滚动容器。
 * 只写 body{overflow:hidden} 不够：实测 <html> 的 overflow:visible 才是真正的
 * 滚动容器，maxScroll 仍为 142px（虽然滚轮动不了，但可滚空间仍在，
 * 触控/键盘/scrollIntoView 仍能滚）。加上 html 的 overflow 与 height 才彻底归零。 */
html:has(body[data-embedded='true']) { overflow: hidden; height: 100%; }
body[data-embedded='true'] { overflow: hidden; height: 100%; }

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

/* ── 键盘可达性与选择态（V5 的 CSS 底座；组件级 aria 归 instrument-ui） ─────────
 * 此前两处 CSS 源 :focus 样式 0 处——键盘 Tab 聚焦在深底上完全不可见。
 * :focus-visible 只对键盘/AT 导航生效（鼠标点击不打扰）；描边用仪器青
 * #22d3ee（对 #050814 实测 11.05:1，AAA），2px 环 + 2px 偏移。 */
:focus-visible {
  outline: 2px solid var(--color-instrument-bright);
  outline-offset: 2px;
}

/* 文本选区与仪器强调色一致，替代浏览器默认蓝 */
::selection { background: rgba(34, 211, 238, 0.30); }

/* 低视力「提高对比度」系统偏好：弱化档升到说明档（#94a3b8，6.96:1） */
@media (prefers-contrast: more) {
  :root { --color-text-faint: var(--color-text-muted); }
}

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

/* V13 修正（visual-system §7.4）：原设计 0 处 xl 断点，大屏 4 仪器布局留白浪费。
 * ≥1440px 视口放宽容器到 1320px、补 48px 边距 —— 1100px 容器在 2K/4K 屏上
 * 两侧各留 25%+ 纯黑，仪器网格（auto-fit minmax）自动多吃两列。
 * 只动容器宽度不动内网格：仪器布局全部是 auto-fit/1fr 自适应，无需逐类改。 */
@media (min-width: 1440px) {
  .site-root {
    max-width: 1320px;
    padding-left: 48px;
    padding-right: 48px;
  }
}

/* iframe 内降级模式（ADR-08）：hub 嵌入式挂载时隐藏大标题/页脚，只留仪器本体 */
body[data-embedded='true'] .site-chrome { display: none; }
body[data-embedded='true'] .site-root { padding: 10px 10px 0; gap: 10px; }

/* 嵌入模式紧凑布局：不留视口高度、不留 auto 外边距、不收尾留白。
 * 三条都是「按 iframe 高度自适应」的必要项 —— 只要留一条，内容就会被撑出
 * iframe 可视区，从而出现内层滚动条（ADR-08 明令禁止的双滚动条）。 */
body[data-embedded='true'] .site-root { min-height: 0; }
body[data-embedded='true'] .site-root { margin: 0 auto; }
body[data-embedded='true'] .site-footer { margin-top: 8px; padding: 8px 0; }

/* ADR-08 原文要求「iframe 内降级模式（隐藏自身导航，适配紧凑布局）」。
 * 嵌入时对用户无意义的介绍性内容一并收起：
 *   .meta-grid  = 「UI 形态 / 独立台账 / 原型来源」三张身份卡（60px）
 *   .site-footer = 域名 + 生成器署名（34px）
 * 这两块纯说明性质，嵌入态占 94px 却把仪器挤出可视区。
 * 注意：不隐藏 .instrument-slot（那是核心）与 .status-row（那是运行态指示）。 */
body[data-embedded='true'] .meta-grid { display: none; }
body[data-embedded='true'] .site-footer { display: none; }

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
.site-orbit { color: var(--site-accent-text); font-size: var(--text-xs); }
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

/* ── 可点 chip（如「通道自检」）与静态状态 chip 的区分 ─────────────────────
 * 缺陷：status-row 里六个 chip 中五个是只读状态标签，第六个是 <button>，
 * 此前两者样式完全相同 → 用户看不出哪个能点。此处只给 button 型 chip
 * 加交互线索；状态 chip 保持纯展示语义（不加 cursor、无 hover）。
 * 命中区：静态 chip 是标签，19px 高无妨；可点 chip 必须过 WCAG 2.5.8 的
 * 24×24，故单独给 button 型补 min-height（实测原 19px）。 */
button.chip {
  cursor: pointer;
  min-height: 24px;
  transition: color var(--dur-fast) ease, border-color var(--dur-fast) ease,
    background var(--dur-fast) ease;
}
button.chip:hover {
  color: var(--color-instrument-bright);
  border-color: rgba(34, 211, 238, 0.5);
  background: rgba(6, 182, 212, 0.12);
}
button.chip:active {
  background: rgba(6, 182, 212, 0.2);
}

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

${INSTRUMENT_CSS}

/* ── V4 修正：原设计缺 prefers-reduced-motion（存在无限循环动画） ─────────── */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}

/* ── 打印样式（原管线 0 处 @media print；实测是硬缺陷不是润色） ─────────────
 * 实测证据：print 媒体下 body 仍是深底 #050814 + 浅字 #f1f5f9，但浏览器
 * 默认不打印背景色 → 浅字落在白纸上，正文对比度 **1.10:1**、标题 **1.00:1**
 * （完全不可见）。微站的答辩材料、综测申报附件都要走打印/导出 PDF，
 * 所以这里必须把配色**反转为浅底深字**，而不是靠"记得勾选背景图形"。
 *
 * 三条原则：
 *   1. 反色：纸=白底黑字，对比度回到 AAA，不依赖用户勾任何选项；
 *   2. 去装饰：辉光/渐变/玻璃拟态/动效在纸上无意义且耗墨，一律压平；
 *   3. 保结构：边框保留（改成浅灰实线）以便表格与卡片仍可分辨。 */
@media print {
  :root {
    --color-bg: #ffffff;
    --color-bg-panel: #ffffff;
    --color-bg-panel-end: #ffffff;
    --color-bg-sunken: #ffffff;
    --color-bg-raised: #ffffff;
    --color-glass: #ffffff;
    --color-border: #cbd5e1;
    --color-border-strong: #94a3b8;
    --color-text: #0f172a;
    --color-text-strong: #000000;
    --color-text-secondary: #1e293b;
    --color-text-muted: #334155;
    /* 打印用深灰而非原 #7d8ba1（对白纸仅 2.9:1）；#475569 对白纸 7.5:1 ✓ */
    --color-text-faint: #475569;
  }

  html, body {
    background: #ffffff !important;
    color: #0f172a !important;
  }

  /* 去装饰 */
  .instrument-bezel {
    background: #ffffff !important;
    border: 1px solid var(--color-border-strong) !important;
    box-shadow: none !important;
  }
  .glass-panel {
    background: #ffffff !important;
    backdrop-filter: none !important;
    -webkit-backdrop-filter: none !important;
  }
  *, *::before, *::after {
    box-shadow: none !important;
    text-shadow: none !important;
    animation: none !important;
    transition: none !important;
  }

  /* 卡片/条目：白底 + 可见细边，避免整页糊成一片 */
  .meta-card, .pat-item, .cluster-card, .path-card, .cv-entry,
  .check-item, .email-pane, .sniper-pane, .gpa-stat, .gpa-course,
  .prob-item, .pat-detail, .cluster-claim, .formula-block, .formula-code {
    background: #ffffff !important;
    border: 1px solid var(--color-border) !important;
  }

  /* 站点外壳：打印时隐藏纯交互元素（对纸质材料无意义） */
  .status-row,
  .site-footer,
  button { display: none !important; }

  /* 表格分页不撕裂：表头每页重复 */
  table { break-inside: auto; }
  tr, .meta-card, .pat-item, .cv-entry, .check-item {
    break-inside: avoid;
    page-break-inside: avoid;
  }
  thead { display: table-header-group; }
  h1, h2, h3 { break-after: avoid; }

  /* 窄边距，A4 一页尽量多内容 */
  @page { margin: 14mm 12mm; }

  /* 链接展开为可读文本（纸质无法点击） */
  a[href^='http']::after {
    content: ' (' attr(href) ')';
    font-size: 0.85em;
    color: #475569;
  }

  /* ── 彩色底块在纸上不打印背景 → 白字白纸（逐元素实测 1.00:1） ──────────
   * 受影响的都是"彩色底 + 反白字"的元素。纸上给它们改回白底 + 深字 +
   * 可见边框：既保留"这是个标记"的语义，又不依赖背景是否被打印。 */
  .site-id {
    background: #ffffff !important;
    color: #0f172a !important;
    border: 1px solid var(--color-border-strong);
    font-weight: 700;
  }

  /* 仪器标题/强调文字用的是青色系（#22d3ee 对白纸仅 1.81:1）——
   * 纸上统一压成深色，靠字重与字号维持层级，不靠颜色。 */
  .instrument-head h2,
  .instrument-slot h2,
  .cv-role,
  .mentor-dim-fill,
  .site-orbit,
  td.accent,
  .gpa-value.accent,
  .prob-val {
    color: #0f172a !important;
  }
  /* 进度条填充在纸上变成深灰实心（浅渐变打不出来） */
  .mentor-dim-fill,
  .skill-fill,
  .path-fill {
    background: #475569 !important;
  }
  .mentor-dim-bar,
  .skill-track,
  .path-bar {
    background: #e2e8f0 !important;
    border: 1px solid var(--color-border);
  }
}
`;
}

function renderSdkFacade(station) {
  return renderSharedTemplate(station, 'sdk-facade.ts');
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

function renderSdkShim(station) {
  return renderSharedTemplate(station, 'matrix-sdk.shim.ts');
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
  /* 与 globals.css 的 --color-text-faint 同步（V6 修正，见 renderGlobalsCss 注释） */
  --iu-text-faint: #7d8ba1;

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

  /* 密度档（与真实 tokens.css 同机制同值）：默认 1×，答辩/投屏 1.25× */
  --iu-type-scale: 1;
  --iu-text-2xs: calc(10px * var(--iu-type-scale));
  --iu-text-xs: calc(12px * var(--iu-type-scale));
  --iu-text-sm: calc(14px * var(--iu-type-scale));
  --iu-text-base: calc(16px * var(--iu-type-scale));
  --iu-text-lg: calc(18px * var(--iu-type-scale));
  --iu-text-xl: calc(20px * var(--iu-type-scale));
  --iu-text-2xl: calc(24px * var(--iu-type-scale));
  --iu-text-3xl: calc(30px * var(--iu-type-scale));

  --iu-dur-fast: 150ms;
  --iu-dur-base: 300ms;
  --iu-dur-slow: 500ms;
  --iu-pulse-duration: 2.8s;

  /* 语义缩放标尺（StarOrbit 用；1.0 → 10.0） */
  --iu-zoom: 2.5;
}

/* 答辩/投屏密度档开关（与 globals.css 的 --type-scale 开关同名同效，
 * 真实库就位后由 tokens.css 的同名规则接管，行为不变） */
[data-iu-density='presentation'] { --iu-type-scale: 1.25; }
`;
}

function renderSiteShell(station) {
  return renderSharedTemplate(station, 'site-shell.tsx');
}

function renderManifest(station) {
  const contract = CONTRACTS[station.id] ?? { accepts: [], emits: [] };
  const manifest = {
    manifest_version: '1.0',
    app_id: station.appId,
    name: station.name,
    entry_url: 'https://' + station.domain,
    orbit_station: station.orbitKey,
    accent_color: station.accent,
    accepts: [...contract.accepts],
    emits: [...contract.emits],
    permissions: permissionsFor(contract),
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
  const contract = CONTRACTS[station.id] ?? {
    exportName: 'records',
    accepts: [],
    emits: [],
    emitTarget: '',
    acceptFrom: '',
    acceptNote: '',
  };
  const code = (types) =>
    types.length ? types.map((t) => '`' + t + '`').join('、') : '（无）';
  // 虫洞对端链接用**逻辑域**（<appId>.matrixos.cc.cd）：SDK 的 isSameApp() 按主机首段
  // 归一化比较，逻辑域与部署域（mx- 前缀）都能对上；但展示给用户看身份时用逻辑域更干净。
  const peer = (appId) => (appId ? 'https://' + appId + '.matrixos.cc.cd' : '（无）');
  const ledgerKey = 'mx.' + station.appId + '.' + contract.exportName;

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
| 虫洞接收 | ${code(contract.accepts)} ← ${peer(contract.acceptFrom)} |
| 虫洞投送 | ${code(contract.emits)} → ${peer(contract.emitTarget)} |

${station.desc}

## 跑起来

\`\`\`bash
pnpm --filter ${station.pkgName} dev     # http://localhost:${station.devPort}
pnpm --filter ${station.pkgName} build
pnpm --filter ${station.pkgName} typecheck
\`\`\`

## 数据模型

台账落在浏览器 \`localStorage\`，key 是 \`${ledgerKey}\`，值是**版本化信封**：

\`\`\`json
{
  "version": 1,
  "updatedAt": "2026-01-01T00:00:00.000Z",
  "data": { "rows": [] }
}
\`\`\`

- 每行 \`{ id, title, meta, detail, updatedAt, edits?, anchor? }\`，\`anchor\` 是证据锚点
  （\`source_doi_or_url\` / \`verification_level\` / 可选 \`pdf_page\`、\`bbox\`，**不允许别的字段**）
- 版本不符且没有迁移函数时**回落到默认值但不覆盖原盘** —— 不静默销毁用户数据
- 「导出 JSON」导出完整信封；「导出 CSV」导出 5 列：id / 标题 / 摘要 / 详情 / 最后修改

业务演示数据在 \`src/lib/site-spec.ts\`（**本站唯一手写的业务文件**）。

## 虫洞契约

**接收** ${code(contract.accepts)}，来自 ${peer(contract.acceptFrom)}：
${contract.acceptNote}

**投送** ${code(contract.emits)}，目标 ${peer(contract.emitTarget)}。
信封必须满足 \`specs/contracts/wormhole-envelope.schema.json\`：\`payload.evidence_anchors\`
**至少 1 条**（契约红线）。台账为空时退化到站级基线锚点
\`https://${station.domain}/\` + \`Level_B_Preprint\`，并在反馈条里**明示**这是退化锚点。

只有真正嵌在 orbital-hub iframe 里、\`useHostBridge().connected === true\` 时才发起真实投送；
独立窗口里点「虫洞投送」只会显示「本地演示 · 未实际投送」，**不伪造成功**。

## 验收

\`\`\`bash
node scripts/microsite-verify.mjs --site=${station.dirName}
\`\`\`

9 项断言：正文长度 / 6 个 testid 齐全 / 新增后计数 +1 / 刷新后保持 / 导出 JSON 有内容 /
清空后归 0 且刷新仍 0 / 投送后反馈非空 / console 与请求零错误 / 390×844 无横向溢出。

## 结构说明

以下文件是**分发产物**，改它们会被覆盖 —— 要改请改模板再跑
\`node scripts/wire-workbench.mjs\`：

- \`src/lib/sdk-facade.ts\`、\`src/lib/shims/matrix-sdk.shim.ts\`
- \`src/components/site-shell.tsx\`、\`src/components/workbench-impl.tsx\`、\`src/components/site-workbench.tsx\`
- \`src/app/page.tsx\`

手写文件只有 \`src/lib/site-spec.ts\` 与 \`README.md\`。

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
    { rel: 'README.md', content: renderReadme(station), neverOverwrite: true },
    { rel: 'src/site.config.ts', content: renderSiteConfig(station) },
    { rel: 'src/app/layout.tsx', content: renderLayout(station, deps) },
    { rel: 'src/app/page.tsx', content: renderPage(station) },
    { rel: 'src/app/globals.css', content: renderGlobalsCss(station) },
    { rel: 'src/components/site-shell.tsx', content: renderSiteShell(station) },
    { rel: 'src/components/workbench-impl.tsx', content: renderSharedTemplate(station, 'workbench-impl.tsx') },
    { rel: 'src/components/site-workbench.tsx', content: renderSharedTemplate(station, 'site-workbench-wrapper.tsx') },
    { rel: 'src/lib/sdk-facade.ts', content: renderSdkFacade(station, deps) },
    { rel: 'src/lib/site-spec.ts', content: renderSiteSpecStarter(station), neverOverwrite: true },
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
    // neverOverwrite：手写文件（README / site-spec）即便加 --force 也不覆盖，
    // 否则「重新生成骨架」会顺手抹掉一整站的业务数据与说明。
    if (existsSync(abs) && (file.neverOverwrite || !opts.force)) {
      if (readFileSync(abs, "utf8") !== file.content) skipped.push(file.rel);
      continue;
    }
    if (!opts.dryRun) {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, file.content, "utf8");
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
