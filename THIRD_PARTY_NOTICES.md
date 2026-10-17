# Third-party notices

截至 2026-10-16，本仓库包含原创插件源码、产品文档及用户提供的研究材料。插件声明宿主 peer 依赖 `@deepseek-ai/cordis` 与搜索、凭据及界面服务，运行依赖见「插件运行依赖」一节，开发依赖包括 TypeScript、esbuild 与类型声明。第三方宿主与 Bot 实现未复制进仓库。M3 已在本机安装 `dsh-mcp-manager@0.6.0` 与 `@anweat/dsh-browser@0.2.1`，并通过 Fetch MCP `2026.10.10` 完成真实网页读取；其余候选扩展保持推荐状态。QQ 协议适配器尚未实现，NapCat 未随项目分发。

## 项目许可证

Icarus 原创内容采用根目录 [Apache License 2.0](LICENSE)，Copyright 2026 Zonghe Wu。第三方材料遵循其各自的权利声明。

## 外部集成与参考项目

| 项目 | 已核对信息 | 本仓库中的使用关系 |
|---|---|---|
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) | 已安装桌面包 `0.2.0-rc.2` 的 manifest 声明 MIT | 插件宿主；未随仓库分发 |
| [DS Bot](https://github.com/Fei2411/DeepSeek-Bot) | 已安装 `ds-bot@0.1.6` 的 manifest 声明 Apache-2.0 | BotBridge 已接入身份与交付；未复制实现 |
| [NapCatQQ](https://github.com/NapNeko/NapCatQQ) | 上游采用混合许可；主 LICENSE 为 Limited Redistribution License，明确禁止商业使用 | 计划由用户独立部署为 QQ 协议服务，Icarus 通过 OneBot 11 连接；未复制、打包或分发 |
| [OneBot 11](https://github.com/botuniverse/onebot-11) | QQ 消息收发与事件协议参考 | 计划实现私聊适配器；协议文档未复制进仓库 |
| DSH experimental voice input bundle | 已安装 `0.2.0-rc.2` 的 manifest 声明 MIT | 计划复用宿主语音服务；未分发模型或运行时 |
| [RSSHub](https://github.com/DIYgod/RSSHub) | 外部订阅源候选 | 尚未引入软件依赖 |
| [changedetection.io](https://github.com/dgtlmoon/changedetection.io) | 外部网页变化服务候选 | 尚未引入软件依赖 |

## 插件运行依赖

| 依赖 | 许可证 | 用途 |
|---|---|---|
| markdown-it 15.0.2 | MIT | 解析成果的 Markdown 标题与链接 |
| rss-parser 3.13.0 | MIT | RSS/Atom 订阅源的请求与条目解析 |
| fast-xml-parser 5.11.2 | MIT | arXiv Atom 响应中的元数据解析 |
| @mozilla/readability 0.6.0 | Apache-2.0 | 公开网页的正文提取 |
| linkedom 0.18.13 | ISC | Readability 所需的 DOM 实现 |
| @anweat/dsh-browser 0.2.1 | MIT | 后台工作区的浏览器工具，见下文「本机已安装并真实调用的扩展」 |
| @deepseek-ai/schemastery 3.18.4 | MIT | 与桌面宿主一致的配置 schema，提供搜索设置的 volatile 字段 |

以上版本由 pnpm lockfile 固定。传递依赖按 `pnpm licenses list --prod` 的实际结果登记：

| 许可证 | 包与版本 |
|---|---|
| MIT | @colors/colors 1.5.0；@nodable/entities 3.1.0；ansi-regex 5.0.1；anynum 1.0.1；cli-table3 0.6.5；commander 14.0.3；cssom 0.5.0；dom-serializer 2.0.0、3.1.1；emoji-regex 8.0.0；fast-xml-builder 1.3.1；html-escaper 3.0.3；htmlparser2 10.1.0；is-fullwidth-code-point 3.0.0；is-unsafe 2.0.2；js-yaml 4.3.2；linkify-it 6.1.0；mdurl 2.1.0；path-expression-matcher 1.6.2；punycode.js 2.3.1；string-width 4.2.3；strip-ansi 6.0.1；strnum 2.5.1；turndown 7.2.4；turndown-plugin-gfm 1.0.2；uc.micro 3.0.0；undici 7.29.0；ws 8.22.0；xml-naming 0.3.0；xml2js 0.5.0；xmlbuilder 11.0.1 |
| Apache-2.0 | playwright 1.64.0、playwright-core 1.64.0、patchright 1.63.0、patchright-core 1.63.0、@jackwener/opencli 1.8.8 |
| BSD-2-Clause | entities 2.2.0、4.5.0、7.0.1、8.1.0；domelementtype 2.3.0、3.0.0；domhandler 5.0.3、6.0.1；domutils 3.2.2、4.0.2；css-select 7.0.0；css-what 8.0.0；nth-check 3.0.1；@mixmark-io/domino 2.2.0 |
| ISC | boolbase 2.0.0；uhyphen 0.2.0 |
| BlueOak-1.0.0 | sax 1.6.1 |
| PSF-2.0、Python-2.0 | argparse 3.0.2、2.0.1 |

TypeScript 5.9.3（Apache-2.0）与 @types/markdown-it 14.2.0、@types/linkify-it 5.0.0、@types/mdurl 2.0.0（MIT）只在构建阶段使用，不进入运行模块。

esbuild 0.25.12（MIT）用于构建浏览器端模块；@types/react 18.3.1（MIT）用于构建期类型检查。React 与宿主界面控件由 DSH 的模块加载器提供。

## 均衡搜索移植

`src/search/clients.ts` 的三家请求参数与响应字段映射参考并移植自 [tianmingwan/dsh-balanced-search](https://github.com/tianmingwan/dsh-balanced-search)，版本 `0.2.0`，提交 `6278313`，上游采用 MIT，Copyright (c) 2026 tianmingwan。凭据读取、持久状态、预算与证据记录由 Icarus 实现，未安装上游插件。

完整 MIT 许可与版权声明保存在 [插件 NOTICE](packages/dsh-icarus/NOTICE)，随插件文件一起分发。Keenable、Exa 和 Tavily 为独立外部服务，查询与正文抽取遵守各自服务条款。

实际引入或分发第三方代码时，登记具体版本、来源与许可证，保留对应版权声明及上游 NOTICE。外部服务、模型权重和内容来源分别遵循其自身条款。

QQ 接入采用外部协议服务与原创适配器分离的方式。NapCat 的具体安装版本及对应许可在 M5 联调时登记；商业托管使用 NapCat 需要取得相应授权。Icarus 的 Apache-2.0 许可不授予 NapCat 的使用或分发权利。依据：[NapCat LICENSE](https://github.com/NapNeko/NapCatQQ/blob/main/LICENSE)与[上游许可说明](https://github.com/NapNeko/NapCatQQ#license)。

## 本机已安装并真实调用的扩展

下表是 M3 实际安装并挂载的扩展。版本取自本机已安装包的 manifest，调用结果保存在 Icarus 数据目录与 `.work/m3-evidence/`。

| 扩展 | 本机版本 | 上游声明 | 使用关系 |
|---|---|---|---|
| [Nichts0v0/dsh-mcp-manager](https://github.com/Nichts0v0/dsh-mcp-manager)，`dsh-mcp-manager` | 0.6.0 | MIT | 由用户安装并挂载到桌面 profile；Icarus 通过其 HTTP 接口登记连接、读取状态，工具经 `mcp__icarus_m3_fetch__fetch` 暴露给工作区会话 |
| [dsh-browser](https://github.com/anweat/dsh-browser)，`@anweat/dsh-browser` | 0.2.1 | MIT | 桌面 profile 持久启用；Icarus 包内 `lib/browser.js` 复用宿主缓存中的 Chromium，提供 `browser_index` 与 `browser_call` |
| [Fetch MCP](https://github.com/modelcontextprotocol/servers/tree/main/src/fetch)，`mcp-server-fetch` | 2026.10.10 | MIT | 包内 `icarus-fetch` 入口通过 uvx 启动，固定 `mcp-server-fetch==2026.10.10` 与 `httpx[socks]==0.28.1`；Python 运行时由 uv 0.7.3 在本机缓存建立，未随仓库分发 |

Fetch 的 Python 环境由 uv 在本机缓存中生成，其中安装的包同样进入运行依赖。许可证取自各自的 `METADATA`：

| 许可证 | 包与版本 |
|---|---|
| MIT | mcp 1.30.0；mcp-server-fetch 2026.10.10；PyJWT 2.15.1；annotated-types 0.8.0；anyio 4.15.1；attrs 26.1.0；beautifulsoup4 4.15.0；cffi 2.1.1；charset-normalizer 3.5.2；h11 0.16.0；html5lib 1.1；httpx-sse 0.4.3；jsonschema 4.26.0；jsonschema-specifications 2025.9.1；pydantic 2.14.1；pydantic-settings 2.16.0；pydantic_core 2.50.1；readabilipy 0.3.0；referencing 0.37.0；rpds-py 2026.9.1；six 1.17.0；soupsieve 3.0.3；typing-inspection 0.4.4；urllib3 2.8.0 |
| BSD-3-Clause | httpx 0.28.1；httpcore 1.0.9；click 8.5.0；idna 3.20；lxml 6.1.3；Protego 0.7.0；pycparser 3.11；python-dotenv 1.2.4；sse-starlette 3.5.0；starlette 1.8.0；uvicorn 0.54.0 |
| Apache-2.0 | python-multipart 0.0.32；requests 2.34.2；regex 2026.9.29（Apache-2.0 AND CNRI-Python） |
| Apache-2.0 或 BSD-3-Clause | cryptography 50.0.2 |
| MPL-2.0 | certifi 2026.7.22 |
| PSF 系列 | pywin32 312（PSF）；typing_extensions 4.16.0（PSF-2.0） |
| 元数据未声明 | markdownify 1.2.3、webencodings 0.6.1、socksio 1.0.0；采用前按上游仓库核对 |

`uv`/`uvx` 由用户自行安装于本机，未随仓库分发。

## M3 推荐的 MCP 与外部服务

以下条目来自 [M3_BEGIN](docs/M3_BEGIN.md) 的扩展建议。使用方式为用户按需连接独立服务；当前仅保存推荐信息及上游链接，未复制其实现。Fetch MCP 已完成接入，登记见上文「本机已安装并真实调用的扩展」；正式接入其余条目时登记选用版本或提交、对应 LICENSE 与真实调用结果，远程托管端登记提供者和核查时间。

| 项目与上游 | 计划用途 | 免费条件与外部依赖 |
|---|---|---|
| [SearXNG MCP](https://github.com/ihor-sokoliuk/mcp-searxng) | 按目标发现公开信息 | MCP 软件免费；需已有或自托管 SearXNG，启用 JSON 搜索 |
| [Fetch MCP](https://github.com/modelcontextprotocol/servers/tree/main/src/fetch) | 网页正文分段读取 | 已接入：本地软件免费；uvx 管理独立 Python 运行时，依赖清单见上文 |
| [Playwright MCP](https://github.com/microsoft/playwright-mcp) | 动态网页与浏览器操作 | 本地软件免费；浏览器与平台账号按具体任务配置 |
| [GitHub MCP](https://github.com/github/github-mcp-server) | 仓库变化、源码与工程操作 | 使用 GitHub API 配额和用户授权；按需要启用读写工具 |
| [Hugging Face MCP](https://github.com/huggingface/hf-mcp-server)、[官方服务说明](https://huggingface.co/docs/hub/agents-mcp) | 模型、数据集与研究资源查询 | 基础查询与计算服务分别登记；Jobs、推理和 Spaces 的费用由实际提供者决定 |
| [arXiv MCP](https://github.com/blazickjp/arxiv-mcp-server) | 论文搜索与章节阅读 | 本地软件免费；PDF 转换依赖单列，arXiv 与引文服务保留其自身访问条件 |
| [Zotero MCP](https://github.com/54yyyu/zotero-mcp) | 个人文献及笔记引用 | MCP server 与 CLI 上游声明 MIT；独立 Zotero Agent 插件声明 AGPL-3.0-or-later，各组件按实际接入情况登记 |
| [MarkItDown MCP](https://github.com/microsoft/markitdown/tree/main/packages/markitdown-mcp) | 个人文档转换与阅读 | 本地基础转换免费；所选格式转换器、OCR 或模型服务单独登记 |
| [Obsidian MCP](https://github.com/MarkusPfundstein/mcp-obsidian) | 个人项目笔记读取与更新 | 本地运行；需要独立的 Obsidian Local REST API 插件及认证 |
| [Google Workspace MCP](https://github.com/taylorwilsdon/google_workspace_mcp) | 日历、邮件与个人材料 | 自托管软件声明 MIT，支持免费 Google 账号；需用户配置 OAuth，托管服务另计 |
| [Bilibili MCP](https://github.com/XZXZZX-Ai/bilibili-mcp) | 视频、字幕与 UP 主动态 | 本地软件免费；账号登录由本人完成，可选本地 ASR 需要模型及本机算力 |
| [Context7](https://github.com/upstash/context7) | 对应版本的库文档查询 | 免费服务有调用限制，凭据与配额按所选提供者登记 |

RSSHub 与 changedetection.io 可作为外部来源服务接入，Icarus 消费订阅流或变化结果；软件版本、服务托管与上游网站内容的权利关系分别登记。候选目录引用的说明属于推荐元数据，外部工具返回的正文、图像或文件保留作者和原站链接。

## M3 推荐的 DSH 插件

下表登记推荐插件的上游许可声明。接入时固定版本，分别保存上游兼容要求和本机桌面 profile 的调用结果。插件由用户独立安装；其中 MCP 管理器与浏览器已完成安装和真实调用，其余保持候选评估。

| 项目与准确包名 | 上游声明 | 计划使用关系 |
|---|---|---|
| [dsh-market](https://github.com/dsh-market/dsh-market)，`dshmarket` | MIT；当前包的宿主范围包含 `0.2.0` 线 | 扩展发现、安装与版本要求展示 |
| [Nichts0v0/dsh-mcp-manager](https://github.com/Nichts0v0/dsh-mcp-manager)，`dsh-mcp-manager` | MIT | 已安装 `0.6.0` 并挂载；管理 stdio、HTTP 与 OAuth 连接，只桥接 MCP Tools |
| [ModSearch](https://github.com/liustack/modsearch)，`@liustack/modsearch` | MIT；默认搜索依赖 Firecrawl 的免 Key 免费额度 | 低门槛搜索和页面获取，真实渠道与额度须显示 |
| [dsh-browser](https://github.com/anweat/dsh-browser)，`@anweat/dsh-browser` | MIT；上游声明在 `0.2.0-rc.2` 验证 | 已安装 `0.2.1` 并在后台工作区真实调用，同时是包内运行依赖 |
| [Vision Toolkit](https://github.com/Anionex/dsh-vision-toolkit)，`@anionex/dsh-vision-toolkit` | MIT；包声明兼容 `0.2.0-rc.2` | 已安装 `0.1.46` 并在兴趣委托后台会话真实调用（`vision_toolkit_activate`、`vision_glance`）；视觉模型使用 DeepSeek API 的 `deepseek-flash`（实测具备图像输入能力），费用随 DeepSeek 账户计量，插件未返回单次用量时记为费用未知 |
| [Better Sidebar](https://github.com/omdsh-dev/DSH-better-sidebar)，`dsh-better-sidebar` | MIT；当前版本以 `0.2.0-rc.2+` 为基线 | 查看成果文件与工程执行状态 |
| [GenUI](https://github.com/omdsh-dev/dsh-genui)，`@changfenhuang/dsh-genui` | MIT；当前宿主声明包含 `0.2.0-rc.2` | 在对话中呈现交互成果；反馈经 Icarus 服务写入 |

软件免费与远程服务免费额度分别登记。插件内部调用的模型和远程计算也进入任务成本；提供者没有返回用量时保存费用未知。用户的 OAuth、Cookie 和令牌留在宿主或扩展的认证存储中，Icarus 的 Mission、快照与成果仅保存引用标识。

## 研究与哲学材料

`docs/GPT/`、`docs/KIMI/`、`docs/Qwen/`、`docs/Alpharxiv/`、`docs/Gemini/` 与 `docs/PHILOSOPHY/` 为用户提供的研究输入。`docs/PRD/` 下两份原产品路线文档也属于该材料集合。包含的第三方文章、图片与引用，其权利归原作者或相应权利人；根目录许可证不重新授予这些材料的权利。

`docs/M3_BEGIN.md` 为用户提供的需求调研及扩展建议，引用外部统计和项目说明；产品决策的采用关系记录在 PRD。MCP 与 DSH 目录用于发现候选，具体功能及许可按对应项目的原始文档和所选版本核对。

`docs/PHILOSOPHY/Claude/` 的文章保留原作者归属；`docs/PHILOSOPHY/Herta/PHILOSOPHY.md` 为提供的设计参考，其独立授权信息未在该文件中给出。策展情报官 PDF 含有自己的权利声明。公开发行包仅应包含具有明确分发权限的材料。

根目录 PHILOSOPHY.md 与最终 PRD 为原创综合表述，列明了参考来源。GNOSIS 实验材料通过文档引用关联，原始数据与代码未复制到本仓库。

DeepSeek、DS Bot 及其他产品名称用于说明兼容关系，商标归各自权利人。
