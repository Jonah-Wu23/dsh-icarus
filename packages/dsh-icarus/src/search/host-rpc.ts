import type { IcarusContext } from '../types/host.js'

export function bindConnection(ctx: IcarusContext): IcarusContext['connection'] {
  // 0.2.0-rc.2 的 rpc getter 捕获带 Cordis shadow 的 ctx，注册路由时需要明确绑定调用方。
  // 连接状态与认证对象保持同一引用，路由的 effect 由搜索插件持有。
  return Object.create(Object.getPrototypeOf(ctx.connection), {
    ...Object.getOwnPropertyDescriptors(ctx.connection), ctx: { value: ctx },
  }) as IcarusContext['connection']
}
