# Whisper Studio WebUI

一个本地优先的 Whisper WebUI：在浏览器中导入音视频或媒体链接，调用本机 Python、Whisper、yt-dlp 与 FFmpeg 完成下载、转写、翻译和字幕导出。

数据和模型都留在运行服务的机器上。默认只监听 `127.0.0.1`，不会暴露到局域网或公网。

## 功能

- 支持本地音视频上传和拖放
- 支持 YouTube、Bilibili、抖音等 `yt-dlp` 可处理的媒体链接
- 支持 `faster-whisper`（默认）和可选的 `openai-whisper`
- 并行任务队列、实时追加任务、进度推送、取消、重试和历史记录
- 导出 `TXT`、`SRT`、`VTT` 和 `JSON`
- 可新增多套自定义翻译服务，启用、设为默认、编辑或删除
- 免费匿名接口可以不填 Key；需要密钥的接口按服务独立使用 AES-256-GCM 加密保存
- 本地 WebUI 可打开输出目录、定位文件并下载导出结果

## 架构

```text
React + Vite WebUI
        │ REST + Server-Sent Events
        ▼
Node.js / Express local server
        │ JSON over stdin/stdout
        ▼
并行媒体准备进程 → 显卡转写热进程池 → 并行翻译
        │
        └─ yt-dlp / HTTP 多连接 / FFmpeg / faster-whisper / openai-whisper
```

设置 → 多任务与下载速度可调整流水线：默认同时准备/下载 3 个任务、转写 1 个任务、翻译 2 个任务，每个下载使用最多 8 个连接。下载、转写、翻译独立调度，可以同时推进；转写进程保留模型缓存，取消任务只影响该任务。较多显存的显卡可将同时转写调至 2 个；实际吞吐取决于模型、网络及网站限制。

支持 HTTP Range 的大文件会拆成小段并行下载，逐段续传和重试，验证分段位置与大小后合并。不支持范围读取的网站会自动使用兼容下载方式；HLS/DASH 分片也采用设置的并发数量。B站会在同格式的官方主地址与备用 CDN 间小范围采样选路，失败时切换线路继续已下载的分段；B站请求显式不继承电脑 HTTP/SOCKS 代理，路由器透明代理仍由其分流规则决定。任务进度会显示传输速度、大小与预计剩余时间。并行翻译共享同一服务的请求频率限制。

## 环境与硬件

克隆项目需要 Git 和联网；Linux 引导脚本需要系统自带的 tar、校验工具，以及 curl 或 wget。启动脚本会复用可用的本机工具，缺失时自动下载项目内的 Node.js LTS、Python 3.14、FFmpeg、Python/Node 依赖和所选模型；公开抖音解析需要的 Chromium 也会自动准备。无需提前安装 Node、Python、CUDA Toolkit 或管理员权限。显卡驱动由使用者安装；登录账号、会员权限和翻译 API Key 需要自行配置。

| 系统 / 硬件 | 自动转写方案 | 运行条件 |
| --- | --- | --- |
| Windows x64 / NVIDIA | faster-whisper + CUDA 12 cuBLAS/cuDNN | Windows 10/11，兼容 CUDA 12 的 NVIDIA 驱动；失败时回退 CPU |
| Windows x64 / AMD、Intel | whisper.cpp + Vulkan | 支持 Vulkan 的显卡和驱动；GPU 初始化失败时回退 CPU |
| Windows ARM64 | whisper.cpp CPU | Windows 11 ARM64；浏览器使用系统 Chromium 或 x64 模拟 |
| Linux x64 / AMD、Intel | whisper.cpp + Vulkan | 项目原生包要求 glibc 2.35+；显卡驱动提供 Vulkan ICD |
| Linux ARM64 / AMD、Intel | whisper.cpp + Vulkan | 项目原生包要求 glibc 2.39+；Vulkan 驱动 |
| Linux x64、ARM64 / NVIDIA | faster-whisper + CUDA | glibc 发行版、兼容驱动及对应 Python wheel |
| 无兼容 GPU / 强制 CPU | faster-whisper CPU；Windows ARM64 用原生 CPU | 首次安装自动按内存选择模型 |

自动下载覆盖上述 x64/ARM64 平台。Alpine/musl、32 位及其他架构需要自行提供兼容工具。Linux 的桌面浏览器仍依赖发行版的基础图形库；缺库时显示具体错误，核心转写可以继续。已保存的引擎和模型会保留；新安装才自动选择硬件方案。AMD/Intel 使用 Vulkan，无需安装 PyTorch ROCm。

工具安装在 `.runtime`、Python 包安装在 `.venv`，不会修改全局 PATH 或注册表。首次下载模型可能需要数分钟，并占用数百 MB 至数 GB；后续启动复用本地内容。下载中断后重新启动即可重试。

## 快速开始

Windows 用户可以克隆后直接运行启动脚本：

```powershell
git clone https://github.com/sheno4/whisper-studio-webui.git
cd whisper-studio-webui
.\start-webui.bat
```

也可以在资源管理器中双击 `start-webui.bat`。首次自动准备环境、模型、构建生产版本，然后打开 [http://127.0.0.1:4317](http://127.0.0.1:4317)。之后会检测依赖是否完整；`git pull` 更新依赖或源码后，自动安装所需变更并重新构建。

Linux：

```bash
git clone https://github.com/sheno4/whisper-studio-webui.git
cd whisper-studio-webui
sh ./start-webui.sh
```

开发模式仍可手动运行：

```powershell
npm install
npm run setup
npm run dev
```

然后打开 [http://127.0.0.1:5173](http://127.0.0.1:5173)。

启动脚本支持以下可选参数；`npm run launch --` 和 `npm run setup --` 也可传入环境参数：

- `--cpu`：本次启动强制 CPU，避免 GPU 库安装；
- `--backend=whisper.cpp`：选择原生后端，也可指定 `faster-whisper`、`whisper`；
- `--model=tiny`：指定并保存模型；不传时保留已有设置或自动选择；
- `--setup-only`：完成环境、模型和构建后退出；
- `--skip-model`：暂不下载模型，首次转写可能需要下载；原生后端需再次 setup；
- `--repair`：重新安装依赖；`--rebuild`：强制重建应用；
- `--no-browser`：启动后不打开界面；
- `--skip-setup`：跳过环境检查，仅适用于已经手动准备完整环境的使用者。

已有虚拟环境无法启动时，安装器先保留到 `.runtime/venv-backups` 再重建。自定义 Python 必须可运行 Python 3.14+；若指定无效路径会提示修正，不覆盖它。可以指定创建虚拟环境的解释器：

```powershell
$env:WHISPER_BOOTSTRAP_PYTHON="C:\Path\To\python.exe"
npm run setup
```

## 生产模式

```powershell
npm run build
npm start
```

生产模式默认访问地址为 [http://127.0.0.1:4317](http://127.0.0.1:4317)。

## 配置

复制环境变量模板是可选的；默认配置已经可以在本机运行：

```powershell
Copy-Item .env.example .env
```

主要环境变量：

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `WHISPER_HOST` | `127.0.0.1` | Web 服务监听地址 |
| `WHISPER_PORT` | `4317` | 生产模式端口 |
| `WHISPER_PYTHON_PATH` | 项目内 `.venv` | 指定 Python 可执行文件 |
| `WHISPER_CHROMIUM_PATH` | 自动检测 | 指定用于抖音公开链接解析的 Chrome、Edge 或 Chromium |
| `WHISPER_OUTPUT_DIR` | `./outputs` | 任务输出目录 |
| `WHISPER_DATA_DIR` | `./.data` | 设置、日志、上传和本地密钥目录 |
| `WHISPER_MAX_UPLOAD_MB` | `10240` | 单个上传文件大小上限（MB） |
| `WHISPER_WEB_TOKEN` | 未设置 | 非本机监听时的访问令牌 |

也可以在 WebUI 的设置页面调整 Python、输出目录、转写引擎、模型与翻译服务。

`WHISPER_PYTHON_PATH` 和 `WHISPER_OUTPUT_DIR` 优先于已保存的设置。移动项目后，如果旧的项目内 Python 路径已失效，应用会自动使用当前同名项目的 `.venv`，并同步迁移原来默认的 `outputs` 路径；自定义输出目录保留。启动脚本会实际检查 Python 能否运行，必要时触发环境重建。

### 自定义翻译服务

项目不提供会员、额度或内置付费套餐。翻译服务全部由使用者自行添加：填写服务名称、API 地址和模型，API Key 可选。设置页支持多套服务、启用开关、默认服务、独立密钥，以及提示词、请求频率、分段长度和 Temperature 等高级参数。

### 使用 openai-whisper

默认安装体积更小、速度更快的 `faster-whisper`。如果需要 `openai-whisper` 后端：

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements-whisper.txt
```

Linux 使用 `.venv/bin/python`。

### NVIDIA 加速

检测到 NVIDIA 时会自动安装 `faster-whisper` 所需的 CUDA 12 cuBLAS 和 cuDNN 9，它们独立于 PyTorch 的 CUDA。也可手动指定安装；worker 会自动发现项目中的运行库：

```powershell
npm run setup -- --with-faster-cuda
```

`openai-whisper` 是可选后端，PyTorch GPU 构建取决于系统和硬件；建议新安装优先使用自动选择的后端。

### AMD 和 Intel

在设置中选择 `whisper.cpp`，然后重新运行启动脚本，或直接传 `--backend=whisper.cpp`。安装器下载项目预编译的原生运行包与经 SHA256 校验的 GGML 模型。模型包括 tiny/base/small/medium、large-v1/v2/v3 和 turbo，支持 `.en` 的模型限英语；distil 模型属于 faster-whisper，不能用于原生后端。

原生包通过本仓库 GitHub Actions 从官方 whisper.cpp 源码构建。当前仓库为私有仓库，克隆及下载这些包需要仓库权限；安装器可复用 Git Credential Manager、`gh` 登录，或读取 `WHISPER_GITHUB_TOKEN`。无法访问项目 GPU 包时，Windows/Linux 尝试官方 CPU 包。显式选择原生后端且没有兼容包时会说明错误。可用 `WHISPER_CPP_PATH` 指定自己的 CLI，`WHISPER_CPP_MODEL_DIR` 指定 GGML 模型目录。

### Cookie

公开抖音视频会优先使用隔离的临时浏览器环境自动解析，不读取现有浏览器资料，也不要求登录。受账号、地区或权限限制的内容仍可能需要 Cookie。

YouTube 会员视频：先在 Firefox 或 Chrome 中登录有对应会员权限的账号，并确认该浏览器能播放视频。设置 → 文件与默认行为 → YouTube 登录来源，默认自动优先读取 Firefox；可指定 Chrome、Firefox 配置目录或项目根目录的 Netscape 格式 `cookies.txt`。Windows 下建议 Firefox，Chrome 的 Cookie 可能被系统加密保护或被浏览器占用。选择“不使用登录状态”可关闭浏览器登录读取。

YouTube 解析和下载复用同一份登录会话，浏览器 Cookie 仅在内存中使用，并限制为 YouTube/Google 域名；不会导出登录信息，也不会在会员权限失败后转发到匿名第三方下载站。只能下载当前账号有权观看的内容，登录过期或会员等级不足时需要先在浏览器解决。自动模式会检查 Firefox 配置、Chrome、已有 cookies.txt，最后尝试未登录的公开访问。

其他需要登录的站点仍可把 Netscape 格式的 `cookies.txt` 放在项目根目录。该文件已加入 `.gitignore`，不要提交到 GitHub。若 Chromium 浏览器安装在非标准位置，可用 `WHISPER_CHROMIUM_PATH` 指定其可执行文件。

## 局域网访问

不要直接无认证监听所有网卡。设置非本机地址时，服务默认要求 `WHISPER_WEB_TOKEN`：

```powershell
$env:WHISPER_HOST="0.0.0.0"
$env:WHISPER_WEB_TOKEN="replace-with-a-long-random-token"
npm start
```

客户端第一次访问：

```text
http://SERVER_IP:4317/?token=replace-with-a-long-random-token
```

令牌会换成本次浏览器会话使用的 HttpOnly Cookie，并从地址栏中移除。若要暴露到公网，请额外使用 HTTPS、反向代理、访问控制和防火墙；不要直接公开本服务端口。

## 项目目录

```text
python/                 Python worker
scripts/setup.mjs       跨平台 Python 环境初始化
src/renderer/           React WebUI
src/server/             HTTP、SSE、上传和静态资源服务
src/main/               与 UI 无关的任务、环境、翻译和存储逻辑
src/shared/             前后端共享类型与链接解析
.data/                  本机配置、日志和上传（不提交）
outputs/                任务输出（不提交）
```

## 常用命令

```powershell
npm run dev       # 同时启动 Vite 和本地 API 服务
npm run launch    # 自动准备环境并启动生产 WebUI
npm test          # 运行接口、队列、翻译、链接解析与 Python worker 回归测试
npm run check     # TypeScript 检查
npm run build     # 构建 WebUI 和 Node 服务
npm start         # 启动构建后的生产服务
npm run setup     # 创建 .venv 并安装默认 Python 依赖
```

## 故障排查

- Python 显示不可用：运行 `npm run setup`，或在设置中填写正确的解释器路径。
- FFmpeg 显示不可用：重新运行启动脚本，自动修复便携工具；自定义环境需同时提供 ffmpeg 和 ffprobe。
- 首次转写较慢：Whisper 模型正在下载和初始化。
- CUDA 启动失败：`faster-whisper` 会尝试其他计算模式；也可以使用 CPU。
- 抖音公开链接解析失败：重新启动以自动准备 Chromium；Linux 若提示缺少共享库，需要按发行版安装浏览器基础库。非标准位置可设置 `WHISPER_CHROMIUM_PATH`。
- 其他链接下载失败：升级 `yt-dlp`，并检查站点是否要求登录或 Cookie。
- 翻译未执行：在设置页添加并启用自定义翻译服务，然后将其设为默认。

## 数据与隐私

- 上传文件会保存在 `.data/uploads`，任务结果保存在 `outputs`。
- 设置和历史记录保存在 `.data/settings.json`。
- 通过 UI 保存的 API Key 使用本机随机密钥加密；`.data/secret.key` 和配置文件必须一起保护。
- `.data`、`outputs`、模型、Cookie、环境变量和临时文件都不会进入 Git。

## 开源许可

[MIT License](LICENSE)

请只下载、转写和发布你有权处理的内容，并遵守目标站点的服务条款和当地法律。
