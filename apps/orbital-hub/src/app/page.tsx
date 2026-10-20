import { OrbitalHub } from '../components/OrbitalHub';

/**
 * orbital.matrixos.edu 主入口
 *
 * 这里刻意保持为 **server component 且几乎无逻辑**：
 * 整个总控台是重客户端交互（星轨变焦、iframe 挂载、拖拽虫洞），
 * 放到 client 组件里挂载。SSR 只吐一个骨架，避免把 18 站的注册表与
 * 变焦状态也搬进首屏 HTML。
 */
export default function Page() {
  return <OrbitalHub />;
}
