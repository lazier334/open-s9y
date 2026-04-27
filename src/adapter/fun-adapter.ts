import { readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { GatewayServer } from "../server.ts";
import type { BasePivot } from "../../sdk/base-pivot-sdk.ts";

export interface PivotFactory {
  (server: GatewayServer): BasePivot;
}

/**
 * 扫描 plugins/ 目录，动态加载并注册所有本地支点
 *
 * 约定：每个插件文件需导出 `createPivot` 工厂函数
 *   export function createPivot(server: GatewayServer): BasePivot
 */
export async function scanAndRegister(
  server: GatewayServer,
  pluginDir?: string
): Promise<BasePivot[]> {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const dir = pluginDir ?? resolve(__dirname, "../../plugins");

  let files: string[];
  try {
    files = readdirSync(dir).filter(
      (f) => f.endsWith(".ts") || f.endsWith(".js")
    );
  } catch {
    console.warn(`插件目录不存在: ${dir}`);
    return [];
  }

  const pivots: BasePivot[] = [];
  for (const file of files) {
    try {
      const mod = await import(resolve(dir, file));
      const factory = mod.createPivot as PivotFactory | undefined;
      if (typeof factory !== "function") {
        console.warn(`跳过 ${file}: 没有导出 createPivot`);
        continue;
      }
      const pivot = factory(server);
      await pivot.connect();
      server.registerLocalPivot(pivot.options.pivotId, pivot);
      pivots.push(pivot);
      console.log(`已注册插件: ${pivot.options.pivotId}`);
    } catch (err) {
      console.error(`加载插件失败: ${file}`, err);
    }
  }
  console.info(`已注册${pivots.length}个本地支点`);
  return pivots;
}
