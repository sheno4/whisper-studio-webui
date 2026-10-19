# 旧混合材质方案记录

> 此方案已于 2026-10-18 被 Lens 原版前端替换，不代表当前运行实现。当前接入、组件来源、能力边界和验证见 [Lens 原版前端](lens-native-rewrite.md)。下文仅保留上一轮方案及检查的历史记录。

当前修正以浏览器原生后景作为固定材质基础，保留真正的 rdev React/SVG 管线。鼠标移动不再切换背景渲染器；Studio 只贡献透明 SDF 光照层。文字、焦点、输入值、任务回调仍由原生 DOM 与现有业务接口负责。

2026-10-17 的 DOM 重画背景与 GPU 接管方案已被用户指出存在错位和闪烁，因此撤回该方案的完成判断。下方区分当前实现、历史检查与未实现能力，不以数值参数代替视觉验收。

## 来源与当前运行范围

所有上游 MIT 许可、固定来源和适配说明保存在 `src/renderer/vendor/`。

| 来源 | 固定版本 / 提交 | 当前用途 |
| --- | --- | --- |
| [rdev/liquid-glass-react](https://github.com/rdev/liquid-glass-react) | v1.1.1 / ac48eab18d1f7f444ae30002d240cae29c863a21 | 实际 React 组件、SVG 三通道位移与浏览器实时后景。滤镜初始化和尺寸适配保留本地改动说明。 |
| [Liquid Glass Studio](https://github.com/iyinchao/liquid-glass-studio) | f7b28c36305a862f5cffed3ddd51511cf1204f56 | 实际 SDF、smooth minimum、法线、Fresnel 和方向高光。当前 GL 输出透明光照，不重画背景。 |
| [liquidGL](https://github.com/naughtyduk/liquidGL) | 88f681ab7035fd55b04f63edff1841e32c4199e9 | 原始实现和 NaughtyDOM 适配保留供溯源；DOM 重画、截图式纹理上传与整页 ticker 不进入当前生产渲染。 |
| [IshiakiZ/liquid-glass-web](https://github.com/IshiakiZ/liquid-glass-web) | ea8b7378c3cfff080ef86a32d808131353f5bac9 | 比例抓取、边界阻尼、菜单 materialize 几何与释放行为；滚动雾边适配源保留，但已退出生产界面。 |
| [shuding/liquid-glass](https://github.com/shuding/liquid-glass) | a2d2e847f793430e3409a52927af815a23f4d372 | 原始 SDF 适配源与 rdev shader-utils 署名保留；当前光照层使用 Studio SDF，不宣称该适配正在执行。 |
| [archisvaze/liquid-glass](https://github.com/archisvaze/liquid-glass) | fbeb99ef5e8dad2cbbc991ffc23e186a28dc01c4 | 原始光学参考与适配源保留；不宣称其背景折射步骤仍在当前光照层执行。 |
| [samasante/liquid-glass](https://github.com/samasante/liquid-glass) | 4e7b769e1df7e5a7d3669fef22417fe3d2f79ade | 分段纵向 cubic rubberBand、光学参数参考；滑块两轴改用同一可逆 IshiakiZ 有理阻尼。 |
| [ruiqichenbiec/design-systems Lens](https://github.com/ruiqichenbiec/design-systems) | 7a424c93b9be13cf835b91ea67495fec2ec0584e | 实际 segmented、switch、slider、progress 工厂、Jelly 和焦点行为。旧第二渲染器不启动。 |

## 固定后景与局部光照

`RdevMaterial` 的 native 材质不再在悬停时卸载或恢复，也不通过 hover/focus 重新排名分配预算。获批的原生 SVG 管线在挂载期间保持身份；未获 SVG 预算的控件保留同色系的浏览器后景模糊路径。动态阴影控制器不依赖 GPU 所有权。

普通鼠标经过只连续改变光照和阴影。局部模式使用按镜片实际宽、高与圆角生成的数学位移场：R/B 是有符号 XY 偏移，alpha 是明确的边缘遮罩，中心保持未位移。它取代了方形演示图的裁切拉伸和不正确的全体边缘遮罩。图仅在结构尺寸/圆角变化时生成，每张不超过 32,768 像素，缓存八项；生成过程不读取页面或图像。原 rdev RGB 分离与中心重组合成仍在，SVG 通过 backdrop-filter 直接处理浏览器真实后景。

分段与菜单文字绘制在镜片之前，因此真实标签可以进入边缘折射；Studio 照明绘制在镜片之后，避免把自己的光照再次折射。按钮仍保持原生语义与命中。阴影只绘制外缘，移除了覆盖镜片中心的灰色实心底板。内联导入是普通容器，由外侧输入面板提供材质，不叠加第二层 frost。本地模式从 0×0 等待真实布局尺寸，不生成无用的 270×69 演示映射。

原生材质按宿主实际四边边框宽度补齐 border box，避免 `inset:0` 相对于 padding box 导致四边缩进 1px。面板 frost 同步对齐外框；语义文字层使用明确的 flex/block 布局，消除输入框和按钮之间的基线行隙。

Studio 光照 canvas 固定在所属局部 host，不跟随悬停在不同 host 之间搬动。光照和 native 阴影读取同一控制器的指针、压力、bend、速度及强度。生产路径没有 DOM 背景重画、背景纹理上传或逐帧 PNG 导出。SVG 预算为六个移动指示器/拇指和两个菜单/高亮，总预留面积不超过 200,000 CSS 像素；普通静态按钮使用浏览器后景与动态光影。Studio 最多四个局部 context、总 backing 不超过 196,608 像素。装饰画布的扩展绘制放在零尺寸布局锚点里，避免把光晕计入表单滚动范围。

背景采样元素不能被外层 filter、半透明 opacity、mask 或 clip-path 再次包住，否则可能切断采样范围。面板和设置使用独立的绘制 frost 兄弟层，正文与交互控件不进入该层。[Filter Effects Level 2 草案](https://drafts.csswg.org/filter-effects-2/#BackdropRoot)

## 控件与布局

Lens 工厂继续生成原生 range、分段、开关和进度组件。滑块的材质 host 是圆形拇指本身，轨道与填充是独立胶囊；指针越过两端时只对拇指做有界阻尼，语义值仍钳制在 min/max。纵向形变、重新抓取与释放连续，键盘、表单重置、禁用和减少动态效果保留原生行为。

导入区、设置、任务/历史列表及阅读区已移除装饰滚动边缘，滚到顶部或底部不会留雾边。对应 hook 不再有生产调用，滚动位置恢复保留。内联导入外壳不再建立额外滚动容器，桌面表单仅在内容确实超高时纵向滚动，窄屏随页面自然展开。真正超宽的阅读内容和窄屏设置导航保留原生横向滚动；不会用全局裁切掩盖溢出。

切换时的横向滚动条来自胶囊欠阻尼回弹及横向 stretch：镜片外盒能短暂越过轨道，仅约束镜片内部 canvas 无法阻止它改变祖先滚动范围。轨道现使用 `contain:layout style; overflow:visible`，邻近镜片/尾部使用零面积装饰锚点，让越界绘制不参与外层滚动宽度，同时保留上下拖动与回弹。[CSS Containment Level 2 的 layout containment 溢出规则](https://drafts.csswg.org/css-contain-2/#layout-containment)

进度外观直接使用 Lens 固定来源的 46px 默认轨道和原有 32px 卡片变体，恢复原填充间距、发射器、纤维与边缘光。任务、Reader 和模型准备条在完成时保持同一工厂实例，显示 100% · 已完成，并允许原有限时完成光束结束；完成后的纤维、隐藏或减少动态效果的动画会停止。

设置统一为一个 GlassSurface 外壳；标题、侧栏、正文和底部操作共享该材质层级。淡入仅作用于 scrim 与绘制层，玻璃控件的祖先不做缩放或半透明动画。历史来源、清空按钮、提示行保留稳定占位；阅读区实例不因记录切换而重挂载，阅读/来源/设置分区分别保存本地滚动位置。窄屏面板高度固定，避免内容长度推动后续面板。

## 能力边界

本方案不宣称完整复制苹果原生 Liquid Glass。Studio 的 SDF 光照融合不等于使用同一融合 SDF 对真实后景折射；按各镜片生成的局部位移场仍未覆盖邻近镜片融合的全部法线。liquidGL 的重画后景路径已停用，不能把保留源码称为正在运行完整引擎。

Chromium 使用原 SVG 位移；其他浏览器、容量不足及不支持光学的环境使用稳定原生后景降级。实色、强制颜色、高对比度及减少动态效果保留可读性与原生输入。软件 GL 的编译、绘制和几何数据不代表硬件帧率或肉眼视觉效果。

## 验证记录

历史报告位于 `.runtime/ios26-integration-verification/`。2026-10-17 的各组报告仅代表旧架构当时的针对性检查，不作为当前架构完成或视觉还原的依据。

2026-10-18 已完成类型检查和前端构建。仅进行 DOM、几何、原生交互与 GL 调用核验，未进行截图、图像识别、像素读取或硬件帧率测试；HTTP/SSE 均为隔离模拟数据，不运行真实下载、模型准备或账号操作。

| 范围 | 结果与报告 |
| --- | --- |
| 固定滤镜/阴影身份、hover 不改基底、局部边缘图、无背景纹理 | S1 通过，`transient-layer-final-2026-10-18.json`。 |
| 按钮同排高度、任务菜单居中与 44px、设置选择路径行 | S6 通过，同上报告。 |
| 链接/文件切换过程的横向溢出 | S7 在 1440、1280、1920、1024、850px 五种窗口宽度逐帧核验，两个切换方向滚动溢出均为 0；任务/历史与阅读区雾边节点总数为 0。同上报告。 |
| 面板/按钮/胶囊/菜单的外框、材质与 SVG warp 对齐；菜单文字→镜片→照明层序 | S8 通过，`local-shell-menu-final-2026-10-18.json`。关闭后定位器隐藏、不可点击且焦点返回；Base UI 为值映射保留的隐藏节点不误判为未关闭。 |
| 历史来源几何、滑块原生值/两轴端点回弹、设置单外壳 | 较早构建的 S2/S3 通过，`stable-native-2026-10-18.json`，不冒充本次最终构建的全量回归。 |
| 设置端点无雾边、尺寸变化后闲置 RAF 停止；原版 32/46px 进度实例完成交接与限时光束 | 较早构建 S4/S5 通过，`edge-progress-layout-2026-10-18.json`。本轮仅复查新改动涉及的风险。 |

本轮最终构建 SHA-256 为 `a9eb7a8399e86945be945c5800c32adcf710f13a8a88743c0950700085110927`。S7 修前基线真实复现桌面表单 13–27px、850px 窗口页面最多 76px 的瞬态横向溢出；修后检查覆盖切换过程，不再以停稳后的尺寸代替动画过程验收。上述检查不代表已经通过肉眼视觉验收或完整复制 iOS 26。
