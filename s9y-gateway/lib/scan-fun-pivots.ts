import type { Connection } from "./connection.ts";
import type { FunPivot } from "./fun-pivot-sdk.ts";
import type { FunAdapterType } from '../adapters/fun-adapter.ts';
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

type FunPivotWarp = {
    pivot: FunPivot;
    filepath: string;
    conn?: Connection;
}
// 热重载检测间隔时间
const reloadStepTime = 2000;
const pivotsCache: Record<string, FunPivotWarp> = {};
const devMode = (process.env.NODE_ENV ?? '').startsWith('dev');
const filterSuffix = !devMode ? (name: string) => { return name.endsWith("pivot.ts") || name.endsWith("pivot.js") }
    : (name: string) => { return name.endsWith("pivot.ts") || name.endsWith("pivot.test.ts") || name.endsWith("pivot.js") || name.endsWith("pivot.test.js") };

/** 扫描并注册支点 */
export async function scanAndRegisterPlugins(funAdapter: FunAdapterType, funPivotDir: string): Promise<void> {
    const pivotList = Object.values(await loadFunPivots(funAdapter, funPivotDir));
    console.info(`已注册${pivotList.length}个本地支点`);
    if (devMode) {
        console.warn(`当前为 dev 环境, 已开启fun支点热加载, 检测间隔 ${reloadStepTime}ms`);
        const dingtime = () => {
            setTimeout(async () => {
                await loadFunPivots(funAdapter, funPivotDir, true);
                dingtime();
            }, reloadStepTime);
        };
        dingtime();
    }
}

/** 导入支点 */
async function importFunPivot(filepath: string, funAdapter: FunAdapterType,): Promise<FunPivotWarp | undefined> {
    const filename = path.basename(filepath);
    try {
        const importFilepath = pathToFileURL(filepath) + '?ts=' + fs.statSync(filepath).mtimeMs;
        // 如果已存在缓存则直接返回
        if (pivotsCache[filepath]?.filepath == importFilepath) return;
        let factory = (await import(importFilepath));
        factory = factory.pivot || factory.default;
        let pivot: FunPivot = factory;
        if (typeof factory == 'function') {
            // 把函数适配器 funAdapter 传递给导入的插件作为参数
            pivot = await factory(funAdapter);
        }

        if (typeof pivot != 'object') {
            return console.warn(`跳过 ${filename}: 最终导出的结果不是一个 object ! 而是: ${typeof pivot}`), void 0;
        }
        // 把函数适配器 funAdapter 赋值给当前的 pivot
        pivot.funAdapter = funAdapter;
        return { pivot, filepath: importFilepath };
    } catch (err) {
        console.error(`加载插件失败: ${filename}`, err);
    }
}

/** 热加载插件支点 */
async function loadFunPivots(
    funAdapter: FunAdapterType,
    pluginDir: string = path.resolve(__dirname),
    hot: boolean = false
) {
    // 获取支点文件列表
    if (!fs.existsSync(pluginDir) || !fs.statSync(pluginDir).isDirectory()) {
        console.warn(`插件目录不存在: ${pluginDir}`);
        return [];
    }
    // 排除当前文件, 并排除非 `pivot.ts`、`pivot.js` 结尾的文件
    let files = fs.readdirSync(pluginDir).filter(name => ![path.basename(__filename)]
        .includes(name) && filterSuffix(name));
    // 热更新时排除以 `_` 开头的插件
    if (hot) files = files.filter(name => !name.startsWith('_'));
    files.sort();

    // 加载插件
    const pivots: Record<string, FunPivotWarp> = {};
    for (const file of files) {
        const filepath = path.resolve(pluginDir, file);
        // 加载插件
        const pivotWarp = await importFunPivot(filepath, funAdapter);
        if (pivotWarp) pivots[filepath] = pivotWarp;
    }

    // 卸载旧支点
    for (const key in pivotsCache) {
        if (!fs.existsSync(key) || !fs.statSync(key).isFile() || pivots[key]) {
            const pivotWarp = pivotsCache[key];
            if (pivotWarp.conn?.pivotId) {
                // 卸载旧支点
                funAdapter.unregister(pivotWarp.conn?.pivotId);
                // 触发断开事件
                pivotWarp.pivot.disconnect();
            }
        }
    }

    // 注册新支点
    for (const key in pivots) {
        const pivotWarp = pivotsCache[key] = pivots[key];
        // 注册新支点
        pivotWarp.pivot.connect();
        pivotWarp.conn = pivotWarp.pivot.conn;
    }
    return pivots
}
