import { OrbitalHub } from '../components/OrbitalHub';
import { QueueReceiver } from '../components/QueueReceiver';

/**
 * orbital.matrixos.edu 主入口
 *
 * 这里刻意保持为 **server component 且几乎无逻辑**：
 * 整个总控台是重客户端交互（星轨变焦、iframe 挂载、拖拽虫洞），
 * 放到 client 组件里挂载。SSR 只吐一个骨架，避免把 18 站的注册表与
 * 变焦状态也搬进首屏 HTML。
 *
 * QueueReceiver 作为**兄弟节点**挂在 OrbitalHub 之外（而不是塞进 OrbitalHub 内部）：
 * 它是 fixed 定位的独立浮层，不参与 2.5D 布局，也就不会与别人正在改的
 * OrbitalHub.tsx 的挂载逻辑相互覆盖；S2-19 的「手机推 → 桌面 2s 出现」由它自己完成。
 */
export default function Page() {
  return (
    <>
      <OrbitalHub />
      <QueueReceiver />
    </>
  );
}
