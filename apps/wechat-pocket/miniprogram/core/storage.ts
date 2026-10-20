/**
 * 存储封装。
 *
 * 小程序 `wx.getStorageSync` / `setStorageSync` 是同步 API，直接读写 localStorage
 * 会在冷启动路径上阻塞——所以本层只做三件事：
 *   1. 命名空间前缀统一（`mxs:`），避免与第三方 SDK 撞 key；
 *   2. 读写包 try/catch（存储满 / 隐私模式 / 数据损坏都不该让页面白屏）；
 *   3. 提供 `getJSON` / `setJSON` 的类型化读写与 TTL 支持（早报缓存、名片缓存用）。
 *
 * 注意：**这里不做任何加密**。端侧隐私仓（AES-GCM + PBKDF2）属于 Web 端
 * IndexedDB 的能力（ADR-05），小程序端的内置存储不承载未发表实验原始数据，
 * 只存 UI 状态与公开学术信息，缓存内容均可在服务端复现。
 */

import { log } from './logger';

const NS = 'mxs:';

export function key(name: string): string {
  return NS + name;
}

export function readRaw(name: string): unknown {
  try {
    return wx.getStorageSync(key(name));
  } catch (e) {
    log.warn('storage', `读取失败 ${name}`, e);
    return undefined;
  }
}

export function writeRaw(name: string, value: unknown): void {
  try {
    wx.setStorageSync(key(name), value);
  } catch (e) {
    log.warn('storage', `写入失败 ${name}`, e);
  }
}

export function remove(name: string): void {
  try {
    wx.removeStorageSync(key(name));
  } catch (e) {
    log.warn('storage', `删除失败 ${name}`, e);
  }
}

/** 带 TTL 的 JSON 缓存条目。 */
interface Envelope<T> {
  v: T;
  /** 写入时刻（epoch ms）。 */
  t: number;
  /** TTL，0 表示不过期。 */
  ttl: number;
}

export function readJSON<T>(name: string): T | undefined {
  const raw = readRaw(name);
  if (!raw || typeof raw !== 'object') return undefined;
  const env = raw as Envelope<T>;
  if (typeof env.t !== 'number') return undefined;
  if (env.ttl > 0 && Date.now() - env.t > env.ttl) {
    remove(name);
    return undefined;
  }
  return env.v;
}

/** 读取缓存条目并同时返回其年龄，供 UI 展示「数据可能不是最新」。 */
export function readJSONWithAge<T>(name: string): { value: T; ageMs: number } | undefined {
  const raw = readRaw(name);
  if (!raw || typeof raw !== 'object') return undefined;
  const env = raw as Envelope<T>;
  if (typeof env.t !== 'number') return undefined;
  if (env.ttl > 0 && Date.now() - env.t > env.ttl) {
    remove(name);
    return undefined;
  }
  return { value: env.v, ageMs: Date.now() - env.t };
}

export function writeJSON<T>(name: string, value: T, ttlMs = 0): void {
  const env: Envelope<T> = { v: value, t: Date.now(), ttl: ttlMs };
  writeRaw(name, env);
}

/** 清空本端全部命名空间数据（退出登录用）。 */
export function clearAll(): void {
  try {
    const info = wx.getStorageInfoSync && wx.getStorageInfoSync();
    const keys = info ? info.keys : [];
    for (const k of keys) {
      if (k.indexOf(NS) === 0) {
        wx.removeStorageSync(k);
      }
    }
  } catch (e) {
    log.warn('storage', 'clearAll 失败', e);
  }
}

export const STORAGE_KEYS = {
  tokens: 'auth:tokens',
  profile: 'auth:profile',
  morning: 'cache:morning',
  morningSeen: 'state:morning-seen',
  checkin: 'cache:checkin',
  checkinLocal: 'state:checkin-local',
  mentor: 'cache:mentor',
  card: 'cache:card',
  queue: 'cache:queue',
  queueLocal: 'state:queue-local',
  deviceId: 'device:id',
  reminderAsked: 'state:reminder-asked',
} as const;
