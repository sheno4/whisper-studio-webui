# Lens · Design contract

系统范围、七类元素及透镜复用的约束见 [SCOPE.md](SCOPE.md)，统一术语见 [CONTEXT.md](CONTEXT.md)。本页补充视觉参数；旧实现与新规范的差距以 SCOPE 的记录为准。

## Identity / 视觉身份

以彩色的玻璃、液体和光源为核心。所有视觉层归于背景、图标（文字）、透镜、凹槽、发光效果、液体、反光变体之一；组件由这些元素组合。默认 Thick：折射 .90、雾化 .24、色散 .65；弹性 .70。玻璃中央保留透光，边缘是细窄、有方向的反光，宽而弱的环境反射支撑厚度。避免环绕一圈的高亮白边和持续晃动。

System sans for Latin and Chinese. Body 16px, control 14px, caption 12px. Page ink and quiet metadata are semantic tokens. Pastel cyan, blue and peach belong to the sampled environment, not success/error status. Panel radius 34px; the smaller chrome radius is 14px. Lens radius may vary with the composition.

## Composition / 组合

- 先用语义 HTML 表达动作，再加玻璃材质。不要让画布替代文本或焦点。
- 所有可交互部分由复用的透镜组件承载。胶囊、圆形、输入框和交互面板是透镜的形态或用途变体，共享透镜材质与流动感；布局容器不要全部套成玻璃卡片。
- 交互的材质反馈通过发光、改变反光、加入或改变液体表达；选择同时保留勾选或文字状态。键盘操作时清晰显示焦点框，鼠标 / 触控板移动、点击、滚动或触摸操作立即隐藏焦点框；保留实际焦点和输入光标。禁用态同时禁用交互与声音。
- Keep primary controls at least 44px high where possible. A switch's hit area includes its whole native button.
- Custom content and status copy belong to the application; pass stable values separately from translated labels.

## Motion / 动态

按住时有轻微抬起和顺着运动方向的变形，松手回弹并停止。自由透镜保留落点。拿起、吸附、汇入、抽出与取消从当前姿态连续变化，不闪现、不突然换尺寸。父容器透镜不得抢夺内部按钮、输入、开关等子透镜控件的手势。切换、滑杆和键盘反馈表达同一个状态。

Reduced motion dampens gesture feedback and disables nonessential continuous movement. No idle jiggle. Keep WebGL geometry and DOM transforms synchronized; a smooth mathematical path is not enough when exporting to video. The separate showcase project contains its frame presentation barrier and pixel regression checks.

## Sound / 声音

声音是增强提示，不是唯一信息来源。默认安静、首次操作后启动，音量和静音在界面可找到。不给 hover、滚动或程序化初始化配音。取消不是完成；持续拖动不要密集叠加音效。保存/成功更清晰，输入和滑杆更短更轻。所有音效均本地合成，不使用系统音频资产。

## Extension / 扩展规则

共享设计决策改 `tokens.js` 并生成 CSS / JSON；局部项目用 CSS 变量覆盖。新材质用光学参数，新语义动作注册 cue；新控件先按 SCOPE 拆解元素并复用透镜组件，再注册 factory，复杂应用状态留给使用方。不得复制内部渲染器、手势物理或散落新的材质常量；只共享着色器或添加 `.lg-surface` 不等于完成透镜组件复用。只抽取真正共享的模式，保留页面布局的局部性。

Check new components in light, dark, grid, CSS fallback, keyboard, muted audio and reduced motion. Every component needs a meaningful accessible name, state, teardown and usage example. WebGL and audio failure must leave the semantic controls usable.
