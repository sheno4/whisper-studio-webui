# Liquid Glass 组件与性能

当前前端直接导入 [rdev/liquid-glass-react](../src/renderer/vendor/liquid-glass-react/index.tsx) 原始 React 组件。固定来源是 ac48eab18d1f7f444ae30002d240cae29c863a21 / v1.1.1；完整 MIT 许可和最小适配说明保存在同目录。没有将自写 CSS 命名为该库，也没有仅移植一个折射公式。

## 当前使用方式

- 原始 SVG 管线保留位移图、RGB 三通道折射、边缘/中心遮罩、模糊、合成与边缘反光。
- 工作台分段选择器、按钮、开关和紧凑工具条使用真实 LiquidGlass React 实例。原生文字、焦点与业务回调在材质层外。
- Lens 仅保留手势和弹簧控制器：选中块能拖动、释放回弹、取消与中途反向；面板固定。
- IshiakiZ 的独立滚动边缘模糊/淡出接入结果、任务、导入和偏好设置，保留原生滚动。
- 大面板用静态 CSS 材质，不参加 SVG 多通道光学计算。

## 已移除的瓶颈

活跃前端不再实例化 Lens 的整页 WebGL 合成器，不再逐玻璃复制整屏 framebuffer，不再将 GL 画面转移到逐控件 Canvas2D，不再反复栅格化整个 DOM。这些旧实现不出现在生产 JavaScript 中。

rdev 材质限于最多 8 个、总 CSS 面积 200,000 px，每块不超过 80,000 px；超出部分使用轻量 CSS 材质。默认静态 standard 位移图，既不持续生成 Shader PNG，也不为鼠标移动重渲染业务组件。尺寸由 ResizeObserver 缓存；拖动直接写元素 transform，停止后不保留动画循环。减少动态效果立即定位；高对比度和减少透明度保留实色模式。

## 边界

rdev 上游说明 Chromium 能显示 SVG 位移，Firefox / Safari 只能部分支持；这些浏览器报告毛玻璃降级。切换到 rdev 后，原 Studio WebGL SDF 多元素融合管线不再启用，不能宣称三个库的所有 Shader 同时生效。当前保留连续胶囊流动和弹性形变；这不等于原生系统的完整液体融合。

检查只使用类型、构建、静态依赖确认和隔离浏览器 DOM / 输入 / 资源调用统计。遵循用户要求，不做截图、图像识别或像素读取；软件浏览器检查不等于真实硬件帧率评测。
