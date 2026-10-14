# Third-party notices

截至 2026-10-15，本仓库包含原创插件源码、产品文档及用户提供的研究材料。插件声明宿主 peer 依赖 `@deepseek-ai/cordis`，运行依赖 `markdown-it`，开发依赖包括 TypeScript 与类型声明。第三方宿主与 Bot 实现未复制进仓库。QQ 协议适配器尚未实现，NapCat 未随项目分发。

## 项目许可证

Icarus 原创内容采用根目录 [Apache License 2.0](LICENSE)，Copyright 2026 Zonghe Wu。第三方材料遵循其各自的权利声明。

## 外部集成与参考项目

| 项目 | 已核对信息 | 本仓库中的使用关系 |
|---|---|---|
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) | 已安装桌面包 `0.2.0-rc.2` 的 manifest 声明 MIT | 插件宿主；未随仓库分发 |
| [DS Bot](https://github.com/Fei2411/DeepSeek-Bot) | 已安装 `ds-bot@0.1.5` 的 manifest 声明 Apache-2.0 | BotBridge 已接入身份与交付；未复制实现 |
| [NapCatQQ](https://github.com/NapNeko/NapCatQQ) | 上游采用混合许可；主 LICENSE 为 Limited Redistribution License，明确禁止商业使用 | 计划由用户独立部署为 QQ 协议服务，Icarus 通过 OneBot 11 连接；未复制、打包或分发 |
| [OneBot 11](https://github.com/botuniverse/onebot-11) | QQ 消息收发与事件协议参考 | 计划实现私聊适配器；协议文档未复制进仓库 |
| DSH experimental voice input bundle | 已安装 `0.2.0-rc.2` 的 manifest 声明 MIT | 计划复用宿主语音服务；未分发模型或运行时 |
| [RSSHub](https://github.com/DIYgod/RSSHub) | 外部订阅源候选 | 尚未引入软件依赖 |
| [changedetection.io](https://github.com/dgtlmoon/changedetection.io) | 外部网页变化服务候选 | 尚未引入软件依赖 |
| markdown-it 15.0.2 | MIT；版本由 pnpm lockfile 固定 | 解析成果的 Markdown 标题与链接 |
| argparse 3.0.2 | PSF-2.0 | markdown-it 的传递依赖 |
| entities 8.1.0 | BSD-2-Clause | markdown-it 的传递依赖 |
| linkify-it 6.1.0、mdurl 2.1.0 | MIT | Markdown 链接解析的传递依赖 |
| punycode.js 2.3.1、uc.micro 3.0.0 | MIT | Markdown 链接与字符处理的传递依赖 |
| TypeScript 5.9.3 | Apache-2.0 | 构建工具；不进入插件运行模块 |
| @types/markdown-it 14.2.0、@types/linkify-it 5.0.0、@types/mdurl 2.0.0 | MIT | 构建期间的类型声明 |

实际引入或分发第三方代码时，登记具体版本、来源与许可证，保留对应版权声明及上游 NOTICE。外部服务、模型权重和内容来源分别遵循其自身条款。

QQ 接入采用外部协议服务与原创适配器分离的方式。NapCat 的具体安装版本及对应许可在 M5 联调时登记；商业托管使用 NapCat 需要取得相应授权。Icarus 的 Apache-2.0 许可不授予 NapCat 的使用或分发权利。依据：[NapCat LICENSE](https://github.com/NapNeko/NapCatQQ/blob/main/LICENSE)与[上游许可说明](https://github.com/NapNeko/NapCatQQ#license)。

## 研究与哲学材料

`docs/GPT/`、`docs/KIMI/`、`docs/Qwen/`、`docs/Alpharxiv/`、`docs/Gemini/` 与 `docs/PHILOSOPHY/` 为用户提供的研究输入。`docs/PRD/` 下两份原产品路线文档也属于该材料集合。包含的第三方文章、图片与引用，其权利归原作者或相应权利人；根目录许可证不重新授予这些材料的权利。

`docs/PHILOSOPHY/Claude/` 的文章保留原作者归属；`docs/PHILOSOPHY/Herta/PHILOSOPHY.md` 为提供的设计参考，其独立授权信息未在该文件中给出。策展情报官 PDF 含有自己的权利声明。公开发行包仅应包含具有明确分发权限的材料。

根目录 PHILOSOPHY.md 与最终 PRD 为原创综合表述，列明了参考来源。GNOSIS 实验材料通过文档引用关联，原始数据与代码未复制到本仓库。

DeepSeek、DS Bot 及其他产品名称用于说明兼容关系，商标归各自权利人。
