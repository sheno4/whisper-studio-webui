# 组件名称与展示清单

入口：[`examples/optics.html#component-index`](examples/optics.html#component-index)。展示页有 18 个公共组件及 4 个共享数据的图表 / 表格示例，每处均显示名称、固定标识和使用示例。名称来自 `component-catalog.js`；公共类型见 `index.d.ts`，API 见 [README.md](README.md)。

元素归属、交互透镜与反馈复用要求见 [SCOPE.md](SCOPE.md)。以下名称是用途与 API 清单；各组件仍须拆解为七类核心元素。当前共享材质／物理不等于已全部复用透镜组件，四类数据组合仍是候选扩展；差距与后续准入要求已在 SCOPE 记录。

## 公共组件

均通过 `createComponent('标识', props)` 创建。链接可直接定位，便于后续反馈或复用时引用名称。

| 名称 | 固定标识 | 可检查的行为 |
| --- | --- | --- |
| [玻璃按钮](examples/optics.html#component-button) | `button` | 按下、回弹、禁用、保存反馈 |
| [图标按钮](examples/optics.html#component-icon-button) | `icon-button` | 收藏 / 重置 / 禁用、可访问名称 |
| [滑动开关](examples/optics.html#component-switch) | `switch` | 点击、拖动、键盘、开关状态 |
| [连接开关](examples/optics.html#component-toggle-tile) | `toggle-tile` | Wi-Fi / 蓝牙、文字状态、选中反光 |
| [选项胶囊](examples/optics.html#component-choices) | `choices` | 互斥选择、边缘变色与流光 |
| [分段标签](examples/optics.html#component-tabs) | `tabs` | 点击 / 拖动切换内容、方向键跳过禁用项 |
| [浮动导航](examples/optics.html#component-dock) | `dock` | 图标导航、拖动选中层、当前视图反馈 |
| [光学滑杆](examples/optics.html#component-slider) | `slider` | 连续调节、玻璃滑钮、数值 |
| [数值步进器](examples/optics.html#component-stepper) | `stepper` | 增减、上下界禁用 |
| [玻璃通知](examples/optics.html#component-notification) | `notification` | 收起、恢复、焦点返回 |
| [操作菜单](examples/optics.html#component-menu) | `menu` | 展开 / 收起动画、操作反馈、键盘 / Escape |
| [折射搜索框](examples/optics.html#component-search) | `search` | 原版折射材质、搜索过滤、清空 / Escape |
| [弹性面板](examples/optics.html#component-panel) | `panel` | 拿起、弹性拖动、释放回弹 |
| [自由透镜](examples/optics.html#component-lens) | `lens` | 自由移动、形变、纸面摩擦声 |
| [透镜卡片列表](examples/optics.html#component-card-list) | `card-list` | 横向原生滚动、吸附、前后导航、方向键 / Home / End、嵌套控件与子组件销毁 |
| [光导进度条](examples/optics.html#component-progress) | `progress` | 波动、完成流光、绿色 / 金色 |
| [凹槽吸附选择](examples/optics.html#component-drop-select) | `drop-select` | 最近吸附、透镜 / 胶囊、透明层连续汇入 |
| [二维滤镜滑块](examples/optics.html#component-xy-slider) | `xy-slider` | 两轴调节、普通触点 / 放大透镜 |

## 数据展示组合

| 名称 | 固定标识 |
| --- | --- |
| [玻璃光导折线](examples/optics.html#component-line-chart) | `line-chart` |
| [液体柱状图](examples/optics.html#component-bar-chart) | `bar-chart` |
| [彩色玻璃环图](examples/optics.html#component-ring-chart) | `ring-chart` |
| [光学记录表](examples/optics.html#component-records-table) | `records-table` |

这四项通过 `mountShowcaseCharts(host, {language, initialState})` 一起挂载，共用示例数据、过滤和选择状态；不是四个独立的 `createComponent()` 工厂。复制整个 `design-system/` 后可按各项“使用示例”接入，加载展示 CSS。所有示例只操作本页状态。

## 本次验收 · 2026-09-19

- 正常松手吸附最近可用凹槽，不要求精准落入轮廓；禁用项被跳过。拿起、移动、到达后汇入、原凹槽退下与新凹槽隆起连续发生。重抓不重置姿态，取消沿原选择回位，减弱动态偏好减少形变及光效。
- `node --test --test-isolation=none tests/*.test.mjs`：35 项通过。新增最近落点、空隙 / 外缘、禁用和等距行为，以及公共组件与名称清单一致性校验。
- 浏览器 `tests/optics-browser.html`：15 组通过。包含保持可见的吸附移动、目标延后隆起、逐帧汇入、重抓 / 取消、最后一次指针坐标、新控件键盘 / 禁用 / 卸载，及既有音效、搜索表格和 GPU 光学回归。
- 实际鼠标验证凹槽外缘吸附和标签玻璃层拖动切换；1280 × 900 与 390 × 844 检查布局，窄屏无横向溢出，透镜 / 胶囊与凹槽尺寸一致，搜索及表格字段完整。中英文均为 21 个有名示例，索引无失效锚点、无重复 ID。未声称实机触摸验收。
- 四份单文件 HTML 由 `node build.mjs` 生成。源码和内联模块使用 PowerShell 直接调用 `node --check` / `node --input-type=module --check` 验证，沿用环境中 `scripts/check.mjs` 的 `spawnSync EPERM` 替代方式。浏览器验收使用 HTTP 源码页，单文件未进行 `file:` 浏览器验收。
