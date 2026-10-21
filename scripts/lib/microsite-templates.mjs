/**
 * 完工层模板的分发清单（单一事实源）
 * =====================================================================================
 *
 * 18 个微站里，有 6 个文件是**同构分发产物**：它们的唯一真身是
 * `apps/micro-sites/shared/templates/` 下的模板，各站那份只是加了站点头的副本。
 *
 * 为什么必须共用一份清单：
 *   - `scripts/gen-site.mjs`（脚手架生成器）与 `scripts/wire-workbench.mjs`（分发器）
 *     都要往站点里写这 6 个文件。曾经两边各持一套模板字符串，结果生成器里还是
 *     骨架期的旧版 sdk-facade（探测 6 个 SDK 顶层符号，全部不存在），
 *     跑一次 `pnpm gen:site --force` 就会把已完工的站点打回不可用状态。
 *   - 抽成一份后，两边写出的字节完全一致，`wire-workbench.mjs --check` 不会误报漂移。
 *
 * 模板本身**不带站点头**；分发时由 `templateHeader()` 生成。
 */

/** 分发清单：模板文件名 → 站点内相对路径 + 一句话作用说明。 */
export const TEMPLATE_FILES = [
  {
    from: 'sdk-facade.ts',
    to: 'src/lib/sdk-facade.ts',
    note: 'SDK 适配层（本站唯一 import @matrixos/sdk 的地方）',
  },
  {
    from: 'matrix-sdk.shim.ts',
    to: 'src/lib/shims/matrix-sdk.shim.ts',
    note: 'SDK 未就位时的编译占位（不提供任何真实能力）',
  },
  {
    from: 'site-shell.tsx',
    to: 'src/components/site-shell.tsx',
    note: '站点外壳（身份 / 元信息 / 仪器面板 / 状态行 / 虫洞接收器）',
  },
  {
    from: 'workbench-impl.tsx',
    to: 'src/components/workbench-impl.tsx',
    note: '完工台实现（台账增删改 / 导出 / 虫洞投送接收），18 站共用',
  },
  {
    from: 'site-workbench-wrapper.tsx',
    to: 'src/components/site-workbench.tsx',
    note: '完工台薄封装（把本站身份 / 业务规格 / SDK 桥接喂给实现）',
  },
  { from: 'page.tsx', to: 'src/app/page.tsx', note: '页面装配（外壳 + 完工台 + 页脚）' },
];

/**
 * 生成分发产物的站点头。
 *
 * @param {{id: string, name: string, domain: string, orbitName: string}} site
 * @param {{from: string, note: string}} file
 * @returns {string} 以换行结尾的文件头
 */
export function templateHeader(site, file) {
  return [
    '/**',
    ' * ⚠️ 由 scripts/wire-workbench.mjs 从 apps/micro-sites/shared/templates/ 分发，请勿直接修改本文件。',
    ` * 模板：apps/micro-sites/shared/templates/${file.from}`,
    ` * 作用：${file.note}`,
    ` * 站点：${site.id} ${site.name}`,
    ` * 轨道：${site.orbitName} · 域名：${site.domain}`,
    ' * 改法：改模板 → 跑 `node scripts/wire-workbench.mjs` 重新分发（18 站会一起更新）。',
    ' */',
    '',
  ].join('\n');
}
