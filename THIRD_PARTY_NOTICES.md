# Third-party notices

截至 2026-10-14，本仓库包含原创产品文档及用户提供的研究材料。尚未引入、复制或分发第三方运行时代码，尚无运行时依赖清单。

## 项目许可证

Icarus 原创内容采用根目录 [Apache License 2.0](LICENSE)，Copyright 2026 Zonghe Wu。第三方材料遵循其各自的权利声明。

## 外部集成与参考项目

| 项目 | 已核对信息 | 本仓库中的使用关系 |
|---|---|---|
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) | 已安装桌面包 `0.2.0-rc.2` 的 manifest 声明 MIT | 计划宿主；未随仓库分发 |
| [DS Bot](https://github.com/Fei2411/DeepSeek-Bot) | 已安装 `ds-bot@0.1.5` 的 manifest 声明 Apache-2.0 | 计划集成；核对源码接口，未复制实现 |
| DSH experimental voice input bundle | 已安装 `0.2.0-rc.2` 的 manifest 声明 MIT | 计划复用宿主语音服务；未分发模型或运行时 |
| [RSSHub](https://github.com/DIYgod/RSSHub) | 外部订阅源候选 | 尚未引入软件依赖 |
| [changedetection.io](https://github.com/dgtlmoon/changedetection.io) | 外部网页变化服务候选 | 尚未引入软件依赖 |

实际引入或分发第三方代码时，登记具体版本、来源与许可证，保留对应版权声明及上游 NOTICE。外部服务、模型权重和内容来源分别遵循其自身条款。

## 研究与哲学材料

`docs/GPT/`、`docs/KIMI/`、`docs/Qwen/`、`docs/Alpharxiv/`、`docs/Gemini/` 与 `docs/PHILOSOPHY/` 为用户提供的研究输入。两份原产品路线文档也属于该材料集合。包含的第三方文章、图片与引用，其权利归原作者或相应权利人；根目录许可证不重新授予这些材料的权利。

`docs/PHILOSOPHY/Claude/` 的文章保留原作者归属；`docs/PHILOSOPHY/Herta/PHILOSOPHY.md` 为提供的设计参考，其独立授权信息未在该文件中给出。策展情报官 PDF 含有自己的权利声明。公开发行包仅应包含具有明确分发权限的材料。

根目录 PHILOSOPHY.md 与最终 PRD 为原创综合表述，列明了参考来源。GNOSIS 实验材料通过文档引用关联，原始数据与代码未复制到本仓库。

DeepSeek、DS Bot 及其他产品名称用于说明兼容关系，商标归各自权利人。
