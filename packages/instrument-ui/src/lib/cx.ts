/** 极简 classnames：只接受 falsy 或字符串，避免引入 clsx 依赖。 */
export type ClassValue = string | false | null | undefined;

export function cx(...values: ClassValue[]): string {
  let out = '';
  for (const value of values) {
    if (!value) continue;
    out = out ? `${out} ${value}` : value;
  }
  return out;
}
