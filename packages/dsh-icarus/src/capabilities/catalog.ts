export interface CapabilityCandidate {
  readonly id: string
  readonly kind: 'mcp' | 'dsh'
  readonly package: string
  readonly source: string
  readonly purpose: string
  readonly authentication: string
  readonly freeConditions: string
  readonly connectionEntry: string
  readonly verifiedVersion: string | null
  readonly status: 'unknown'
}

export const CAPABILITY_CATALOG: readonly CapabilityCandidate[] = [
  { id: 'fetch', kind: 'mcp', package: 'mcp-server-fetch', source: 'https://github.com/modelcontextprotocol/servers/tree/main/src/fetch', purpose: '读取公开网页正文',
    authentication: '公开页面无需账号', freeConditions: '本地运行免费；模型调用按现有模型计费', connectionEntry: '设置 → MCP Server Manager → 添加 stdio，使用本目录 connection 中的 command 与 args；Icarus 补齐 Python 依赖并处理代理环境，需要 uvx', verifiedVersion: '2026.10.10', status: 'unknown' },
  { id: 'markitdown', kind: 'mcp', package: 'markitdown-mcp', source: 'https://github.com/microsoft/markitdown/tree/main/packages/markitdown-mcp', purpose: '将论文和文档转换为可读文本',
    authentication: '本机文件无需账号；远程资料遵守原访问权限', freeConditions: '本地转换免费；可选云端服务单独计费', connectionEntry: '设置 → MCP Server Manager → 添加 stdio：uvx markitdown-mcp', verifiedVersion: null, status: 'unknown' },
  { id: 'browser', kind: 'dsh', package: '@anweat/dsh-browser', source: 'https://github.com/anweat/dsh-browser', purpose: '在真实浏览器读取动态网页和保存页面观察结果',
    authentication: '公开页面无需账号；登录由用户完成', freeConditions: '本地浏览器免费；模型调用按现有模型计费', connectionEntry: 'desktop profile → icarus-browser.config.enabled 设为 true，重启宿主；自动查找现有 Chromium，缺少时下载', verifiedVersion: '0.2.1', status: 'unknown' },
  { id: 'mcp-manager', kind: 'dsh', package: 'dsh-mcp-manager', source: 'https://github.com/Nichts0v0/dsh-mcp-manager', purpose: '管理 stdio、HTTP 与 OAuth MCP 连接，只桥接工具',
    authentication: '按 MCP 服务要求认证', freeConditions: '管理插件免费；连接的服务各自计费', connectionEntry: '设置 → MCP Server Manager', verifiedVersion: null, status: 'unknown' },
  { id: 'market', kind: 'dsh', package: 'dshmarket', source: 'https://github.com/dsh-market/dsh-market', purpose: '发现和安装 DSH 扩展',
    authentication: '公开目录无需账号', freeConditions: '插件目录与本地安装免费；所选扩展单独说明费用', connectionEntry: '设置 → Plugin Market', verifiedVersion: null, status: 'unknown' },
]
