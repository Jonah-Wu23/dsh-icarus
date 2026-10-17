// Template definitions and item-field validation (M4.1).
//
// Pure data plus structural checks. A template states what one deliverable item must
// carry, which sources to watch, how preferences are keyed and how the model must
// express itself. Nothing here touches storage, execution, feedback or investigation.
// Item fields stay open: validation enforces the declared keys and keeps every other
// key exactly as the model wrote it.

export const TEMPLATE_IDS = ['paper', 'application', 'interest', 'generic'] as const
export type TemplateId = (typeof TEMPLATE_IDS)[number]

export interface TemplateField {
  readonly key: string
  readonly type: 'text' | 'number' | 'sources' | 'object'
  readonly required: boolean
  readonly description: string
}

export interface TemplateSourceSuggestion {
  readonly adapter: 'arxiv' | 'rss' | 'search' | 'github' | 'web'
  readonly purpose: string
  readonly locatorHint?: string
  readonly required: boolean
}

export interface TemplateDefinition {
  readonly id: TemplateId
  readonly name: string
  /** Hard cap on selected observations per delivery window; the assessment step enforces it. */
  readonly maxItems?: number
  readonly defaultRequirements: readonly string[]
  readonly fields: readonly TemplateField[]
  readonly preferenceDimensions: readonly { readonly key: string; readonly description: string }[]
  readonly sourceSuggestions: readonly TemplateSourceSuggestion[]
  readonly expressionRules: readonly string[]
}

export const TEMPLATES: Readonly<Record<TemplateId, TemplateDefinition>> = {
  paper: {
    id: 'paper',
    name: '论文追踪',
    maxItems: 5,
    defaultRequirements: [
      '默认报告 3-5 项，每项说明方法改变了什么、证据支持到哪里、对当前研究有什么用',
      '逐项声明实际阅读范围（摘要/部分正文/全文），不得把摘要写成全文',
      '给出可打开的来源链接与 arXiv 标识及版本',
    ],
    fields: [
      { key: 'arxivId', type: 'text', required: true, description: 'arXiv 标识，例如 2401.12345' },
      { key: 'version', type: 'text', required: true, description: 'arXiv 版本，例如 v1、v2' },
      { key: 'methodChange', type: 'text', required: true, description: '本版本的方法相对已有工作改变了什么' },
      { key: 'evidenceStrength', type: 'text', required: true, description: '数据、指标与限制能支持到什么程度' },
      { key: 'relevance', type: 'text', required: true, description: '对当前研究的具体用途' },
      { key: 'readingScope', type: 'text', required: true, description: '实际阅读范围：摘要、部分正文或全文' },
    ],
    preferenceDimensions: [
      { key: 'direction', description: '研究方向' },
      { key: 'method', description: '方法类型' },
      { key: 'evidence', description: '证据门槛' },
      { key: 'readingDepth', description: '阅读深度' },
    ],
    sourceSuggestions: [
      { adapter: 'arxiv', purpose: '按研究主题订阅 arXiv 新提交', locatorHint: 'arXiv 查询式，例如 all:"<主题关键词>"', required: true },
      { adapter: 'rss', purpose: '跟踪相关会议或实验室的公开更新', locatorHint: '会议或实验室博客的 RSS 地址', required: false },
      { adapter: 'search', purpose: '按方法关键词补充近期工作', locatorHint: '搜索式：方法关键词；timeRange=week', required: false },
    ],
    expressionRules: [
      '来源与阅读范围如实声明：区分摘要、部分正文与全文，并给出可打开的链接、arXiv 标识与版本。',
      '不得补造事实：方法变化、证据强度与结论只能来自实际读到的内容。',
      '条目正文按序号呈现，每项说明方法改变了什么、证据支持到哪里、对当前研究有什么用。',
    ],
  },
  application: {
    id: 'application',
    name: '申请项目追踪',
    defaultRequirements: [
      '保留项目全名、申请轮次与原始发布时间',
      '转载合并到原始出处，保留全部来源证据并标明来源类型（官方/自报/中介/转载）',
      '阅读范围为摘要时如实声明，不得声称读过全文',
      '说明与本申请目标的具体关系',
    ],
    fields: [
      { key: 'programFullName', type: 'text', required: true, description: '项目全名，含学位、院系与方向' },
      { key: 'round', type: 'text', required: true, description: '申请轮次，例如 2026 Fall 第一轮' },
      { key: 'originalPublishedAt', type: 'number', required: true, description: '原始发布时间，整数毫秒时间戳' },
      { key: 'sourceKind', type: 'text', required: true, description: '主要来源类型：官方、自报、中介或转载' },
      { key: 'applicantBackground', type: 'text', required: true, description: '申请人背景，用于判断相似度' },
      { key: 'relevance', type: 'text', required: true, description: '与当前申请目标的具体关系' },
      { key: 'sources', type: 'sources', required: true, description: '来源记录数组，每条含 url、sourceKind，可选 originalPublishedAt' },
    ],
    preferenceDimensions: [
      { key: 'target', description: '目标项目' },
      { key: 'background', description: '背景相似度' },
      { key: 'sourceTrust', description: '来源可信度' },
    ],
    sourceSuggestions: [
      { adapter: 'search', purpose: '按项目全名与轮次检索申请信息', locatorHint: '搜索式：项目全名 + 轮次 + 录取；timeRange=month', required: true },
      { adapter: 'rss', purpose: '订阅用户提供的论坛或公众号更新', locatorHint: '用户提供的论坛或公众号 RSS 地址', required: false },
    ],
    expressionRules: [
      '来源与阅读范围如实声明：转载合并到原始出处，标明官方、自报、中介或转载，阅读范围按摘要或部分正文声明。',
      '不得补造事实：项目全名、轮次、发布时间与录取信息只能来自实际来源。',
      '条目正文按序号呈现，逐项说明与本申请目标的具体关系。',
    ],
  },
  interest: {
    id: 'interest',
    name: '兴趣作品追踪',
    defaultRequirements: [
      '按真实图像内容解释选择，视觉描述必须来自实际视觉工具返回的阅读证据',
      '保留作者与原站链接',
      '预览是否允许依来源条款或页面声明判断并保存依据；不允许预览时只给原站链接',
    ],
    fields: [
      { key: 'author', type: 'text', required: true, description: '画师或作者名' },
      { key: 'authorUrl', type: 'text', required: true, description: '作者主页链接' },
      { key: 'originalUrl', type: 'text', required: true, description: '作品原站链接' },
      { key: 'previewAllowed', type: 'text', required: true, description: '是否允许预览及来源依据' },
      { key: 'visualDescription', type: 'text', required: true, description: '基于实际视觉阅读证据的作品描述' },
      { key: 'subjectTags', type: 'text', required: true, description: '题材与角色标签，逗号分隔' },
      { key: 'visualEvidenceRefs', type: 'text', required: true, description: '实际视觉工具返回的阅读证据引用，逗号分隔' },
      { key: 'previewBasis', type: 'text', required: true, description: '预览许可判断依据：来源条款或页面声明' },
    ],
    preferenceDimensions: [
      { key: 'character', description: '角色' },
      { key: 'artist', description: '画师' },
      { key: 'composition', description: '构图' },
      { key: 'color', description: '色彩' },
      { key: 'subject', description: '题材' },
    ],
    sourceSuggestions: [
      { adapter: 'rss', purpose: '订阅画师主页与作品站的更新', locatorHint: '画师主页或作品站 RSS 地址', required: true },
      { adapter: 'web', purpose: '没有 RSS 时跟踪作品站页面变化', locatorHint: '作品站列表或主页 URL', required: false },
      { adapter: 'search', purpose: '按角色名与画师名搜索新作品', locatorHint: '搜索式：角色名 + 画师名', required: false },
    ],
    expressionRules: [
      '来源与阅读范围如实声明：逐条给出作者主页、原站链接与实际视觉证据引用。',
      '不得补造事实：视觉描述只能来自实际视觉工具返回的阅读证据。',
      '条目正文按序号呈现，按真实图像内容解释选择。',
      '预览许可依来源条款或页面声明判断并保存依据；不允许预览时只给原站链接。',
    ],
  },
  generic: {
    id: 'generic',
    name: '通用技术追踪',
    defaultRequirements: [
      '说明版本或仓库变化改变了什么',
      '说明对当前项目的影响与集成成本',
      '给出可打开的来源链接与实际阅读范围',
    ],
    fields: [
      { key: 'repo', type: 'text', required: true, description: '仓库或项目标识，例如 owner/name' },
      { key: 'version', type: 'text', required: true, description: '版本、Release 或提交标识' },
      { key: 'change', type: 'text', required: true, description: '版本或仓库变化改变了什么' },
      { key: 'impactOnProject', type: 'text', required: true, description: '对当前项目的影响与集成成本' },
    ],
    preferenceDimensions: [
      { key: 'direction', description: '技术方向' },
      { key: 'cost', description: '集成成本' },
      { key: 'stability', description: '稳定性' },
    ],
    sourceSuggestions: [
      { adapter: 'github', purpose: '订阅 GitHub Release 与 Issue 变化', locatorHint: 'owner/repo 或 releases.atom 地址', required: true },
      { adapter: 'rss', purpose: '跟踪没有 GitHub 仓库的项目更新', locatorHint: '项目博客或 Release 的 RSS 地址', required: false },
      { adapter: 'search', purpose: '搜索社区讨论与集成案例', locatorHint: '搜索式：仓库名 + 集成或迁移', required: false },
    ],
    expressionRules: [
      '来源与阅读范围如实声明：给出可打开的仓库、Release 或 Issue 链接与实际阅读范围。',
      '不得补造事实：版本、变更内容与集成成本只能来自实际读到的发布说明或代码。',
      '条目正文按序号呈现，逐项说明版本变化、对当前项目的影响与集成成本。',
    ],
  },
}

export function isTemplateId(value: unknown): value is TemplateId {
  return typeof value === 'string' && (TEMPLATE_IDS as readonly string[]).includes(value)
}

export function templateOf(id: unknown): TemplateDefinition | undefined {
  return isTemplateId(id) ? TEMPLATES[id] : undefined
}

export function effectiveRequirements(template: TemplateDefinition | undefined, requirements: readonly string[]): readonly string[] {
  const merged: string[] = []
  const seen = new Set<string>()
  for (const requirement of [...requirements, ...(template?.defaultRequirements ?? [])]) {
    const text = requirement.trim()
    if (text === '' || seen.has(text)) continue
    seen.add(text)
    merged.push(text)
  }
  return merged
}

const SOURCE_KINDS = ['official', 'self', 'agency', 'repost'] as const
const EXPECTED: Readonly<Record<TemplateField['type'], string>> = {
  text: 'a non-empty string or {"unknown":"reason"}',
  number: 'a finite number or {"unknown":"reason"}',
  object: 'a non-array object or {"unknown":"reason"}',
  sources: 'a non-empty array of source records or {"unknown":"reason"}',
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// The only accepted way to declare a missing fact: exactly one key, a non-empty reason.
function isUnknown(value: unknown): value is { readonly unknown: string } {
  return isRecord(value) && Object.keys(value).length === 1 && value.unknown !== undefined
    && typeof value.unknown === 'string' && value.unknown.trim() !== ''
}

function isHttpUrl(value: unknown): boolean {
  if (typeof value !== 'string' || value.trim() === '') return false
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function invalidField(field: TemplateField): TypeError {
  return new TypeError(`icarus: field ${JSON.stringify(field.key)} must be ${EXPECTED[field.type]}`)
}

function validateSources(key: string, value: unknown): void {
  if (!Array.isArray(value) || value.length === 0) throw new TypeError(`icarus: field ${JSON.stringify(key)} must be ${EXPECTED.sources}`)
  value.forEach((entry, index) => {
    const at = `icarus: field ${JSON.stringify(key)} entry ${index + 1}`
    if (!isRecord(entry)) throw new TypeError(`${at} must be a source record`)
    if (typeof entry.url !== 'string' || entry.url.trim() === '') throw new TypeError(`${at} requires a url`)
    if (!isHttpUrl(entry.url)) throw new TypeError(`${at} url must use HTTP or HTTPS`)
    if (typeof entry.sourceKind !== 'string' || entry.sourceKind === '') throw new TypeError(`${at} requires a sourceKind`)
    if (!(SOURCE_KINDS as readonly string[]).includes(entry.sourceKind)) throw new TypeError(`${at} sourceKind must be one of ${SOURCE_KINDS.join(', ')}`)
    const publishedAt = entry.originalPublishedAt
    if (publishedAt !== undefined && publishedAt !== null && (typeof publishedAt !== 'number' || !Number.isSafeInteger(publishedAt))) throw new TypeError(`${at} originalPublishedAt must be an integer millisecond timestamp or null`)
  })
}

export function validateItemFields(template: TemplateDefinition | undefined, fields: unknown): Record<string, unknown> {
  if (!isRecord(fields)) throw new TypeError('icarus: item fields must be an object')
  for (const field of template?.fields ?? []) {
    const value = fields[field.key]
    if (value === undefined) {
      if (field.required) throw new TypeError(`icarus: missing required field ${JSON.stringify(field.key)}`)
      continue
    }
    if (isUnknown(value)) continue
    if (field.type === 'text') {
      if (typeof value !== 'string' || value.trim() === '') throw invalidField(field)
    } else if (field.type === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)) throw invalidField(field)
    } else if (field.type === 'object') {
      if (!isRecord(value)) throw invalidField(field)
    } else validateSources(field.key, value)
  }
  return { ...fields }
}

export function unknownField(reason: string): { readonly unknown: string } {
  return { unknown: reason }
}

const FIELD_TYPE_LABELS: Readonly<Record<TemplateField['type'], string>> = {
  text: '文本',
  number: '数字',
  object: '对象',
  sources: '来源数组',
}

export function promptFragment(template: TemplateDefinition): string {
  const dimensions = template.preferenceDimensions.map(dimension => `${dimension.key}（${dimension.description}）`).join('、')
  return [
    `条目模板：${template.name}（${template.id}）`,
    '条目字段：',
    ...template.fields.map(field => `- ${field.key}（${FIELD_TYPE_LABELS[field.type]}，${field.required ? '必填' : '可选'}）：${field.description}`),
    '事实缺失时字段值写 {"unknown":"原因"}，原因要具体可核对；可选字段没有内容时省略，不得用推测填补事实。',
    '表达规则：',
    ...template.expressionRules.map((rule, index) => `${index + 1}. ${rule}`),
    `偏好维度：${dimensions}`,
  ].join('\n')
}

export function preferenceDimensions(template: TemplateDefinition | undefined): readonly { readonly key: string; readonly description: string }[] {
  return template?.preferenceDimensions ?? []
}
