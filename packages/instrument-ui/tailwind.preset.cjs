/**
 * CommonJS 包装 —— 给 `require('@matrixos/instrument-ui/tailwind.preset.cjs')` 用。
 *
 * 为什么同时提供 .js（ESM）与 .cjs：本包 `"type": "module"`，所以 .js 是 ESM。
 * 但 Tailwind 3 的 `tailwind.config.js` 在很多项目里仍是 CJS，
 * `require()` 一个 ESM 文件会抛 ERR_REQUIRE_ESM。这个文件保证两种都能用。
 */
'use strict';

/** @type {import('tailwindcss').Config} */
const preset = {
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        obsidian: '#050814',
        panel: {
          DEFAULT: '#0b1124',
          end: '#070b18',
          sunken: '#020617',
          raised: '#0f172a',
        },
        action: { DEFAULT: '#6366f1', hover: '#4f46e5', bright: '#818cf8', text: '#818cf8' },
        instrument: { DEFAULT: '#06b6d4', bright: '#22d3ee', text: '#22d3ee', dim: '#0e7490' },
        positive: { DEFAULT: '#10b981', bright: '#34d399', text: '#34d399' },
        warning: { DEFAULT: '#f59e0b', bright: '#fbbf24', text: '#fbbf24' },
        danger: { DEFAULT: '#f43f5e', bright: '#fb7185', text: '#fb7185' },
        ecosystem: { DEFAULT: '#8b5cf6', bright: '#a78bfa', text: '#a78bfa' },
        ink: {
          DEFAULT: '#f1f5f9',
          strong: '#ffffff',
          secondary: '#cbd5e1',
          muted: '#94a3b8',
          // 与 tokens.css 的 --iu-text-faint 同步：原 #64748b 仅 3.75:1，不达 AA。
          faint: '#7d8ba1',
        },
        hairline: {
          DEFAULT: '#1e293b',
          strong: '#334155',
          accent: 'rgba(99, 102, 241, 0.22)',
          instrument: 'rgba(56, 189, 248, 0.25)',
        },
      },
      fontFamily: {
        sans: [
          'Inter',
          '-apple-system',
          'BlinkMacSystemFont',
          'Segoe UI',
          'PingFang SC',
          'Hiragino Sans GB',
          'Microsoft YaHei',
          'Noto Sans SC',
          'Source Han Sans SC',
          'sans-serif',
        ],
        mono: [
          'JetBrains Mono',
          'ui-monospace',
          'SFMono-Regular',
          'Menlo',
          'Cascadia Mono',
          'Roboto Mono',
          'Noto Sans Mono CJK SC',
          'monospace',
        ],
      },
      fontSize: {
        '2xs': ['10px', { lineHeight: '1.3' }],
        xs: ['12px', { lineHeight: '1.4' }],
        sm: ['14px', { lineHeight: '1.5' }],
        base: ['16px', { lineHeight: '1.6' }],
        lg: ['18px', { lineHeight: '1.5' }],
        xl: ['20px', { lineHeight: '1.4' }],
        '2xl': ['24px', { lineHeight: '1.3' }],
        '3xl': ['30px', { lineHeight: '1.2' }],
      },
      borderRadius: { xs: '4px', sm: '8px', DEFAULT: '8px', md: '12px', lg: '16px', xl: '24px' },
      boxShadow: {
        glow: '0 0 28px -5px rgb(var(--iu-accent-rgb, 6 182 212) / 0.45)',
        'glow-indigo': '0 0 28px -5px rgb(99 102 241 / 0.45)',
        'glow-cyan': '0 0 28px -5px rgb(6 182 212 / 0.45)',
        'glow-emerald': '0 0 28px -5px rgb(16 185 129 / 0.45)',
        'glow-amber': '0 0 28px -5px rgb(245 158 11 / 0.45)',
        'glow-rose': '0 0 28px -5px rgb(244 63 94 / 0.45)',
        'glow-violet': '0 0 28px -5px rgb(139 92 246 / 0.45)',
        bezel: 'inset 0 1px 0 0 rgba(255,255,255,0.08), 0 10px 30px -10px rgb(6 182 212 / 0.25)',
        'bezel-inset': 'inset 0 2px 8px rgba(0, 0, 0, 0.55), inset 0 -1px 0 rgba(255,255,255,0.04)',
      },
      backgroundImage: {
        'bezel-surface':
          'linear-gradient(145deg, var(--iu-bezel-from, #0b1124) 0%, var(--iu-bezel-to, #070b18) 100%)',
      },
      transitionDuration: { fast: '150ms', base: '300ms', slow: '500ms' },
      transitionTimingFunction: {
        out: 'cubic-bezier(0.16, 1, 0.3, 1)',
        base: 'cubic-bezier(0.4, 0, 0.2, 1)',
      },
      animation: {
        'pulse-soft': 'iu-pulse-soft 2.8s cubic-bezier(0.4, 0, 0.2, 1) infinite',
        'orbit-spin': 'iu-orbit-spin 60s linear infinite',
        'sonar-spin': 'iu-sonar-spin 6s linear infinite',
        'wave-breathe': 'iu-wave-breathe 2.6s cubic-bezier(0.4, 0, 0.2, 1) infinite',
      },
      keyframes: {
        'iu-pulse-soft': {
          '0%, 100%': { opacity: '0.65', transform: 'scale(1)' },
          '50%': { opacity: '1', transform: 'scale(1.04)' },
        },
        'iu-orbit-spin': {
          from: { transform: 'rotate(0deg)' },
          to: { transform: 'rotate(360deg)' },
        },
        'iu-sonar-spin': {
          from: { transform: 'rotate(0deg)' },
          to: { transform: 'rotate(360deg)' },
        },
        'iu-wave-breathe': {
          '0%, 100%': { transform: 'scaleY(0.55)', opacity: '0.45' },
          '50%': { transform: 'scaleY(1)', opacity: '1' },
        },
      },
      zIndex: { panel: '1', overlay: '20', dock: '40', tooltip: '60' },
    },
  },
  plugins: [],
};

module.exports = preset;
module.exports.preset = preset;
module.exports.default = preset;
