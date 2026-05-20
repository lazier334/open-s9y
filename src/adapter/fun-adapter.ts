import type { BasePivot } from "../../sdk/base-pivot-sdk.ts";
import type { GatewayServer } from "../server.ts";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

type WarpBasePivot = BasePivot & { filepath: string }
// 热重载检测间隔时间
const reloadStepTime = 2000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pivotsCache: { [key: string]: WarpBasePivot } = {};

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
    const pivotList = Object.values(await loadFunPivots(server, pluginDir));
    console.info(`已注册${pivotList.length}个本地支点`);
    if ((process.env.NODE_ENV ?? '').startsWith('dev')) {
        console.info(`当前为 dev 环境，已开启支点热重载，检测间隔 ${reloadStepTime}ms`);
        const dingtime = () => {
            setTimeout(async () => {
                await loadFunPivots(server, pluginDir, true);
                dingtime();
            }, reloadStepTime);
        };
        dingtime();
    }
    return pivotList;
}

/**
 * 验证要导入的目标支点是否已存在缓存
 * @param filepath 
 * @param importFilepath 
 * @returns 
 */
function verifyCache(filepath: string, importFilepath: string): boolean {
    let pivot = pivotsCache[filepath];
    return pivot?.filepath == importFilepath
}
/**
 * 加载支点
 * @param filepath 支点文件路径
 * @param server 
 * @returns 
 */
async function importFunPivot(filepath: string, server: GatewayServer): Promise<WarpBasePivot | undefined> {
    const filename = path.basename(filepath);
    try {
        const importFilepath = pathToFileURL(filepath) + '?ts=' + fs.statSync(filepath).mtimeMs;
        // 如果已存在缓存则直接返回
        if (verifyCache(filepath, importFilepath)) return;
        const mod = await import(importFilepath);
        const factory = mod.createPivot as PivotFactory | undefined;
        if (typeof factory !== "function") {
            console.warn(`跳过 ${filename}: 没有导出 createPivot`);
            return;
        }
        const pivot = factory(server) as WarpBasePivot;
        if (!pivot) {
            console.warn(`跳过 ${filename}: createPivot 没有产出 Pivot`);
            return;
        }
        await pivot.connect();
        pivot.filepath = importFilepath;
        return pivot;
    } catch (err) {
        console.error(`加载插件失败: ${filename}`, err);
    }
}
/**
 * 热加载插件支点  
 * @param server 
 * @param pluginDir 
 */
async function loadFunPivots(
    server: GatewayServer,
    pluginDir?: string,
    hot?: boolean
) {
    // 扫描文件
    const dir = pluginDir ?? path.resolve(__dirname, "../../plugins");
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
        console.warn(`插件目录不存在: ${dir}`);
        return [];
    }
    let files = fs.readdirSync(dir).filter(name => name.endsWith(".ts") || name.endsWith(".js"));
    // 排除以 `_` 开头的插件
    if (hot) files = files.filter(name => !name.startsWith('_'));
    files.sort();

    // 加载插件
    const pivots: { [key: string]: WarpBasePivot } = {};
    for (const file of files) {
        const filepath = path.resolve(dir, file);
        const pivot = await importFunPivot(filepath, server);
        if (pivot) pivots[filepath] = pivot;
    }

    // 检测并注销无效或已经重新注册的支点
    for (const key in pivotsCache) {
        if (!fs.existsSync(key) || !fs.statSync(key).isFile() || pivots[key]) {
            const pivot = pivotsCache[key];
            pivot.disconnect();
            server.connections.removeLocal(pivot.options.pivotId);
        }
    }
    // 把新的支点合并过去
    for (const key in pivots) {
        const pivot = pivots[key];
        pivotsCache[key] = pivot;
        server.registerLocalPivot(pivot.options.pivotId, pivot);
    }

    return pivots
}