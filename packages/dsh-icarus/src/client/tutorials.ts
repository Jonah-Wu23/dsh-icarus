import type { Provider } from '../search/types.js'

export const TUTORIALS: Record<Provider, { zh: string; en: string }> = {
  keenable: {
    zh: '1. 打开 [Keenable](https://app.keenable.ai/login) 注册登录。\n2. 在 [Console](https://app.keenable.ai/console) 创建 Icarus 专用 API key。\n3. 复制以 `keen_` 开头的 key，粘贴到输入框并保存。\n\n每月 100,000 次免费请求，自动重置。无需安装命令行工具。[官方文档](https://docs.keenable.ai)',
    en: '1. Sign up at [Keenable](https://app.keenable.ai/login).\n2. Create a dedicated Icarus API key in the [Console](https://app.keenable.ai/console).\n3. Paste the key beginning with `keen_` and save.\n\n100,000 free requests per month. No CLI installation needed. [Official documentation](https://docs.keenable.ai)',
  },
  exa: {
    zh: '1. 用邮箱注册 [Exa](https://dashboard.exa.ai)，免费档无需绑卡。\n2. 打开 API Keys，生成新 key，命名为 Icarus。\n3. 复制到输入框并保存。\n\n适合语义搜索与技术资料。每月赠送 10 美元，另有 10 美元注册奖励；Icarus 每月按 10 美元控制额度。[官方价格](https://exa.ai/pricing)',
    en: '1. Sign up at [Exa](https://dashboard.exa.ai). No card is required for the free plan.\n2. Open API Keys and create a key named Icarus.\n3. Paste it and save.\n\nUseful for semantic search and technical articles. USD 10 in monthly credits plus a USD 10 onboarding bonus; Icarus applies a USD 10 monthly allowance. [Official pricing](https://exa.ai/pricing)',
  },
  tavily: {
    zh: '1. 注册 [Tavily](https://app.tavily.com)，无需信用卡。\n2. 在 API Keys 点 + 新建，Key Type 选择 Development，Monthly Limit 填 1000。\n3. 复制以 `tvly-` 开头的 key，粘贴并保存。\n\n每月 1 日重置 1,000 credits；基础搜索每次 1 credit，深入搜索每次 2 credits。基础抽取每 5 个成功 URL 消耗 1 credit。[官方额度说明](https://docs.tavily.com/documentation/api-credits)',
    en: '1. Sign up at [Tavily](https://app.tavily.com). No credit card needed.\n2. Add a key in API Keys, choose Development and set Monthly Limit to 1000.\n3. Paste the key beginning with `tvly-` and save.\n\n1,000 credits reset on the first of each month. Basic search uses 1 credit; advanced uses 2. Basic extraction uses 1 credit per 5 successful URLs. [Official credits](https://docs.tavily.com/documentation/api-credits)',
  },
}
