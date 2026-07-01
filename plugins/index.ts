import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Connection } from "../src/connection.ts";
import type { FunAdapterType, SendParam } from '../src/adapters/fun-adapter.ts';

type Pivot = {
    sp: SendParam,
    filepath: string
    conn?: Connection,
}
// 热重载检测间隔时间
const reloadStepTime = 2000;
const pivotsCache: { [key: string]: Pivot } = {};

/** 扫描并注册支点 */
export default async function scanAndRegister(funAdapter: FunAdapterType): Promise<void> {
    const pivotList = Object.values(await loadFunPivots(funAdapter));
    console.info(`已注册${pivotList.length}个本地支点`);
    if ((process.env.NODE_ENV ?? '').startsWith('dev')) {
        console.warn(`当前为 dev 环境, 已开启fun支点热加载, 检测间隔 ${reloadStepTime}ms`);
        const dingtime = () => {
            setTimeout(async () => {
                await loadFunPivots(funAdapter, undefined, true);
                dingtime();
            }, reloadStepTime);
        };
        dingtime();
    }
}

/** 导入支点 */
async function importFunPivot(filepath: string, funAdapter: FunAdapterType,): Promise<Pivot | undefined> {
    const filename = path.basename(filepath);
    try {
        const importFilepath = pathToFileURL(filepath) + '?ts=' + fs.statSync(filepath).mtimeMs;
        // 如果已存在缓存则直接返回
        if (pivotsCache[filepath]?.filepath == importFilepath) return;
        const factory = (await import(importFilepath)).default;
        let sp = factory;
        if (typeof factory == 'function') {
            sp = await factory(funAdapter);
            if (!sp) return console.warn(`跳过 ${filename}: 该函数没有产出 Pivot`), void 0;
        }

        if (!['function', 'object'].includes(typeof sp)) {
            return console.warn(`跳过 ${filename}: 不是一个 function 或 object `), void 0;
        }
        return { sp, filepath: importFilepath };
    } catch (err) {
        console.error(`加载插件失败: ${filename}`, err);
    }
}

/** 热加载插件支点 */
async function loadFunPivots(
    funAdapter: FunAdapterType,
    pluginDir: string = path.resolve(import.meta.dirname),
    hot: boolean = false
) {
    // 获取支点文件列表
    if (!fs.existsSync(pluginDir) || !fs.statSync(pluginDir).isDirectory()) {
        console.warn(`插件目录不存在: ${pluginDir}`);
        return [];
    }
    // 排除当前文件, 并排除非 `.ts`、`.js` 结尾的文件
    let files = fs.readdirSync(pluginDir).filter(name => ![path.basename(import.meta.filename)]
        .includes(name) && (name.endsWith(".ts") || name.endsWith(".js")));
    // 热更新时排除以 `_` 开头的插件
    if (hot) files = files.filter(name => !name.startsWith('_'));
    files.sort();

    // 加载插件
    const pivots: { [key: string]: Pivot } = {};
    for (const file of files) {
        const filepath = path.resolve(pluginDir, file);
        // 加载插件
        const pivot = await importFunPivot(filepath, funAdapter);
        if (pivot) pivots[filepath] = pivot;
    }

    // 卸载旧支点
    for (const key in pivotsCache) {
        if (!fs.existsSync(key) || !fs.statSync(key).isFile() || pivots[key]) {
            const pivot = pivotsCache[key];
            if (pivot.conn?.pivotId) {
                // 卸载旧支点
                funAdapter.unregister(pivot.conn?.pivotId);
            }
        }
    }

    // 注册新支点
    for (const key in pivots) {
        const pivot = pivots[key];
        pivotsCache[key] = pivot;
        // 注册新支点
        console.log('尝试注册:', pivot.filepath);
        console.log('尝试注册:', pivot.sp.options);
        pivot.conn = await funAdapter.register(pivot.sp);
    }
    return pivots
}
