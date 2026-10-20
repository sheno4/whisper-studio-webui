# Whisper Studio · 前端说明

当前工作台使用 [Lens 原版前端](lens-native-rewrite.md)，保留导入媒体、任务列表和阅读结果三个同页工作区，继续通过现有 REST/SSE 接口调用后端。

| 代码位置 | 职责 |
| --- | --- |
| `src/renderer/main.tsx`、`App.tsx` | 页面入口与工作台组合。 |
| `src/renderer/studio/` | 导入、任务、阅读、设置和系统状态业务界面。 |
| `src/renderer/glass/` | 原版控件的 React 接入、材质偏好和菜单定位。 |
| `src/renderer/lens/` | 单一光学运行时、视口与弹层呈现、手势生命周期、内容过渡及应用布局。 |
| `src/renderer/vendor/lens-native/` | 固定提交的完整原版组件、着色器、弹簧与样式。 |
| `src/renderer/hooks/`、`web-api.ts` | 业务状态、HTTP/SSE、对话框和浏览器行为。 |

样式入口为原版 `tokens.css`、`components.css`、应用 `lens/workspace.css`，进度组件另外引入 `lens/progress.css`。旧混合渲染器、旧 `styles/`、`studio/*.css` 和重复 vendor 已清理。

原版源码保持不改，应用适配集中在原件之外。来源及 MIT 许可见 [Lens 第三方说明](third-party/Lens-NOTICE.md)。

当前任务和历史均可阅读完整结果、搜索、查看分段与时间戳、复制与导出；设置保留页面内草稿并可直接关闭。详见 [历史结果](history-full-results.md)、[设置交互](settings-interaction-repair.md) 与 [阅读控件](reader-controls-repair.md)。

导入参数保留原双列布局，处理方式、语言、规格、翻译与服务控件固定在原位。不适用的选项变灰并禁用，保留已选值，不再条件隐藏或播放整块进入、退出动画。详见 [导入参数稳定布局](import-options-design.md)。

工作区面板固定，可拖动的是分段胶囊、开关和滑块。光学运行时共享一个 WebGL2 context，采样自身场景及已合成的玻璃，正文由浏览器绘制；实色、高对比度、减少动态效果及显卡资源回退继续可用。

`npm run dev` 启动开发环境，`npm run check` 检查类型，`npm run build` 构建前后端。`tests/frontend-lens.test.mjs` 检查当前原版弹簧的可打断性、收敛和变形矩阵边界。业务 hooks、字幕、传输、对话框及服务端测试继续保留；验证结论以各次报告为准，类型、构建与 DOM 数值检查不替代视觉或实际硬件性能验收。
