# Liquid Glass 组件与性能

当前前端直接导入 [rdev/liquid-glass-react](../src/renderer/vendor/liquid-glass-react/index.tsx) 原始 React 组件。固定来源是 ac48eab18d1f7f444ae30002d240cae29c863a21 / v1.1.1；完整 MIT 许可和最小适配说明保存在同目录。没有将自写 CSS 命名为该库，也没有仅移植一个折射公式。

## 当前使用方式

- 原始 SVG 管线保留位移图、RGB 三通道折射、边缘/中心遮罩、模糊、合成与边缘反光。
- 工作台分段选择器、按钮、开关、紧凑工具条以及自定义 select/menu/选项高亮层使用真实 LiquidGlass React 实例。原生文字、焦点与业务回调在材质层外。
- `glass/live-material.ts` 在同一个已挂载 SVG 上按 pointer、按压、速度、焦点和局部滚动更新实际 `feDisplacementMap.scale`、边缘色散遮罩和独立高光。基准三通道为 `-58/-63.8/-69.6`；交互同时改变折射深度和 RGB 光谱间距，不只写状态标记。React 的恒定鼠标参数只用于关闭上游自己的鼠标重渲染。
- Native backdrop 持续采样当前已绘制后景。静态 `feImage` 是上游形状位移场，并非背景截图；不为交互重新生成 PNG。小控件 native blur 固定 2px，菜单固定 5px，SVG 模糊核保持常量；输入帧不改变模糊半径。
- Lens 仅保留手势和弹簧控制器：选中分段块和开关在 held 时按指针增量 1:1 定位，保留实际抓取位置，释放后才使用带速度的弹簧；取消与外部 controlled 值恢复已提交值。Jelly 独占控件父级 transform，光学不再次移动文字。面板与标题栏固定。
- IshiakiZ 的独立滚动边缘模糊/淡出接入结果、任务、导入和偏好设置，保留原生滚动。
- 大面板不参加 SVG 多通道计算；其 CSS 毛玻璃独立放在内容之前的绝对背景兄弟层。父面板本身没有 `backdrop-filter`，避免把内部控件的采样截断为面板本地空白后景。隔离层级与 transform/z-index 不等于 Backdrop Root；祖先 opacity/filter/mask/clip-path/backdrop-filter 则可能形成采样边界，见 [CSS Filter Effects 2 草案](https://drafts.csswg.org/filter-effects-2/#BackdropRoot)。

## 已移除的瓶颈

活跃前端不再实例化 Lens 的整页 WebGL 合成器，不再逐玻璃复制整屏 framebuffer，不再将 GL 画面转移到逐控件 Canvas2D，不再反复栅格化整个 DOM。这些旧实现不出现在生产 JavaScript 中。

rdev 材质最多 8 层、总 CSS 面积 200,000 px。当前新打开的菜单优先，每个菜单允许到 140,000 px；其余单层上限 80,000 px。选项高亮优先于普通控件，其他控件按 held/focus/hover 排序；屏外与禁用控件不占 SVG 预算。超出部分为无额外 blur 的透明色材质，`data-liquid-glass-budget` 区分 allocated/inactive/capacity，阶段节点记录实际分配层数和面积。

尺寸由 ResizeObserver.contentRect 缓存，几何刷新只针对实际交互源；受影响材料共享一次 RAF 批处理，先读后写。Jelly 只推进 activeBodies，不在动画帧扫描全部控件或读取全页几何。停止、隐藏和销毁后不保留循环；事件、观察器、临时高光和 SVG 属性更新均有清理。减少动态效果保留实时 native 后景，去除额外折射变化、惯性和形变；高对比度、强制颜色及实色材质不创建 SVG 材料。

## 边界

rdev 上游说明 Chromium 能显示 SVG 位移，Firefox / Safari 只能部分支持；这些浏览器报告毛玻璃降级。切换到 rdev 后，原 Studio WebGL SDF 多元素融合管线不再启用，不能宣称三个库的所有 Shader 同时生效。当前保留连续胶囊流动和弹性形变；这不等于原生系统的完整液体融合。

检查只使用类型、构建、静态依赖确认和隔离浏览器 DOM / 输入 / 资源调用统计。遵循用户要求，不做截图、图像识别或像素读取；软件浏览器检查不等于真实硬件帧率评测。
