# 光学交互 · 1.1.0-optics.1

本文保留光学组件阶段的行为与验证记录。随后完成的展示网页、连续摩擦音和图表，以及当前版本的验证结果，见 [SHOWCASE.md](SHOWCASE.md)。

后续系统范围与复用标准见 [SCOPE.md](SCOPE.md)：所有交互必须由复用的透镜组件承载，材质反馈通过光、反光与液体表达。本文记录当前行为，不能据此认定所有控件已完成该规则要求的统一组件复用。

本版以设计系统 **1.0.0** 为基线，新增进度、拖放选择、二维调节和选项胶囊反馈，以及进度光纤波动、透明拖动层、连续尺寸与弹簧变形。

## 体验入口

运行内层项目的 `node server.mjs`，打开 `http://127.0.0.1:4173/design-system/examples/optics.html`。该页支持中英文、流光 / 深海 / 网格背景。同一组控件也出现在组件目录、材质实验室，以及外层 `lens.html` / `lens-en.html` 离线文件。

## 行为与接口

所有控件通过 `createComponent()` 创建，先插入容器，再 `createGlassSystem(container)`；动态添加时调用 `system.mount()`。卸载时销毁系统和各组件 handle。完整类型见 `index.d.ts`。

| 组件 | 本版行为 | 主要接口 |
| --- | --- | --- |
| `progress` | 已完成区增强真实背景折射，光纤持续轻微起伏，前沿有局部发光源；跨过完成值时流光沿边缘走过，整体光色逐渐变绿或金色 | `value`、`max`、`completionColor:'green'|'gold'`、`completeLabel`、`wave`、`motion:'system'|'on'|'off'`；`setValue(value,{emit,animate})`、`setMotion()`、`setCompletionColor()` |
| `drop-select` | 按住透明透镜或胶囊时可用落点发光；拖动层不重复绘制文字或图标，保留下方图标视线。松手吸附最近可用凹槽，抵达后落点由凹陷变为凸起，带轻微绿色滤色和边缘反光；原落点退回凹陷，拖动层淡出 | `options` 为 2–6 个唯一选项，可带 `icon` / `disabled`；`variant:'lens'|'capsule'`、`selectionColor`、`dragLabel`；`setValue(value,{emit,animate})` 返回是否接受值，`setVariant()`、`setDisabled()` |
| `xy-slider` | 相机滤镜式二维色域调节，向上为正 Y；普通触点与 1.8× 透镜可切换，透镜放大实际绘制的色域网格；切换保留值 | `value:{x,y}`、`min`、`max`、`step`、`xLabel`、`yLabel`、`variant:'point'|'lens'`、`magnification:1..3`、`instruction`；`setValue()`、`setVariant()`、`setDisabled()` |
| `choices` | 保留原互斥选择、勾选、键盘与声音；新选择的边缘变色并流光一次，初次挂载不播放完成反馈 | 新增 `selectionColor:'green'|'gold'`，默认绿色；演示使用金色 |

进度值被限制在 0–max，非有限数值被拒绝。`onComplete` 仅在从未完成跨入完成且 `{emit:true}` 时触发；重复设为完成不重复触发，重置后可再次完成。其他 `setValue()` 默认不触发业务回调，用户操作会触发 `onChange`。二维手势结束另触发 `onCommit`。

拖放使用指针捕获；正常松手按距离选择最近的可用凹槽，空隙和凹槽外缘也可吸附，禁用落点不参与。取消、Escape、页面失焦不更改选择，沿当前姿态回到已选凹槽；页面隐藏时停止动画。也可直接点击落点，或使用方向键 / Home / End，沿用同一移动与汇入过程。二维控件支持方向键、Shift 十倍步进、Home 回到初值，并提供两个可访问的原生 range 输入。选中状态同时保留文字和勾选，不只依赖颜色。

更新后的拖放阶段为 `rest → held → travelling → merging → rest`：拿起时原落点缓慢凹下、同尺寸透明层浮现；松手后透明层保持可见并用原弹簧移动；接近目的地且速度降低后，才在 280 毫秒内汇入，落点由凹变凸并开始流光。点击和键盘切换也移动当前玻璃层，不会提前显示目标。重抓会继承动画中的位置和速度，`setVariant()` 切换透镜 / 胶囊无需销毁组件。完整名称和最新验收见 [COMPONENTS.md](COMPONENTS.md)。

拖动层与落点使用相同实际尺寸，按下不再切换固定缩放。拖放复用原透镜的 `Spring` 与 `jellyMatrix` 底层能力，尚未复用公共 `createComponent('lens')` 工厂：按拖动方向拉伸、垂直方向压缩，边缘滞后同时驱动轮廓和折射，松手用弹簧回到落点。拖到一半重新抓取时从当前姿态继续；减弱动态效果下减小变形、增加阻尼。后续按 SCOPE 收敛为共享透镜组件时须保留这些行为。

## 动效与渲染边界

完成 / 选择流光约 1.1 秒，落点与数值过渡约 280 毫秒。只有进度光纤按用户要求持续波动，且限制在已完成区域。默认 `motion:'system'` 尊重减弱动态效果；演示里的“播放波动”是进度组件的主动选择，`off` 停止波动与完成动画。页面隐藏或阶段离开视口时 WebGL 停止绘制。

透明胶囊的颜色、凹凸法线、进度折射和放大网格均进入原有 WebGL 合成器。DOM 负责文字、图标、焦点和输入；不会自动捕获任意网页文字、视频或第三方 DOM 进行放大。WebGL2 不可用或丢失时降级为 CSS 玻璃、SVG 波动线和边缘光效，输入与键盘继续可用；兼容模式不承诺真实背景折射和网格放大。

## 验证

从内层 `lab/` 执行：

```powershell
node --test --test-isolation=none tests/*.test.mjs
node design-system/build-tokens.mjs
node build.mjs
node scripts/check.mjs
```

2026-09-19 的本次验证：Node.js v24.16.0 下 24 项测试通过；本地浏览器 `tests/optics-browser.html` 的 7 组检查通过。测试覆盖拿起 / 放下 / 重抓时的姿态连续性、不同帧率下弹簧收敛、完成事件、禁用和键盘、透明拖动层与落点尺寸、卸载清理、GPU 填充 / 颜色变化、不同时间帧的光纤波动与静止模式、透镜合成，以及真实 WebGL 上下文丢失后的可用性。

浏览器检查页仅在本页测试过程中模拟普通动态偏好以覆盖动画分支，结束后恢复；不改动系统偏好。视觉检查包含中英文切换、移动窄屏、两种拖动形态、深色背景和正常/放大二维选择。鼠标拖放已实测，未声称实机触摸验收。

本环境中原始 `scripts/check.mjs` 的子进程检查受 `spawnSync EPERM` 限制；使用 PowerShell 直接逐文件调用 `node --check`，并将两个离线内联模块传给 `node --input-type=module --check`。原检查脚本保留。

最终构建成功；31 个源码模块及 2 个离线内联模块通过语法检查。中文离线文件为 222445 字节，英文为 222465 字节。交互与视觉验收使用本地 HTTP 源码预览；内置浏览器的 URL 安全策略拒绝直接访问 `file:` 文件，未进行离线文件的浏览器打开验收。
