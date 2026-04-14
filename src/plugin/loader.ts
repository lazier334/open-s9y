import type { GatewayPlugin } from "./interface.ts";

/**
 * 简单插件加载器
 * 支持从文件路径动态导入插件实例
 * @param path - 插件模块的文件路径
 * @returns 导出的 GatewayPlugin 实例
 * @throws 若模块未导出合法插件则抛出错误
 */
export async function loadPlugin(path: string): Promise<GatewayPlugin> {
  const mod = await import(path);
  const plugin: GatewayPlugin = mod.default ?? mod.plugin;
  if (!plugin) {
    throw new Error(`未从 ${path} 导出插件`);
  }
  return plugin;
}
