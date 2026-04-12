import { spawn, ChildProcess } from 'child_process';
import fs from 'fs';

const logsPath = 'stop.log';

// TODO 需要开发agent以及完整的网关
// 启动 agent 

// 启动程序
runCmd().catch(err => console.log('err=>', err))

/**
 * 运行cmd
 * @param cmd 命令
 * @param stdout 正常运行的输出
 * @param stderr 错误信息输出
 * @returns 运行结束返回最后的50-100条日志
 * @example
 * // 空参数
 * runCmd().catch(err => console.log('err=>', err))
 * // 完整参数
 * runCmd('npx tsx src/gateway.ts', (d) => console.log('--->', '' + d), (d) => console.log('===>', '' + d)).catch(err => console.log('err=>', err))
 */
function runCmd(cmd: string | Array<any> = 'npx tsx src/gateway.ts', stdout: (data: any) => void = () => { }, stderr: (data: any) => void = () => { }) {
    return new Promise((resolve, reject) => {
        let child: ChildProcess | null = null;
        let logs: any[] = [];
        showLog('启动进程...');
        if (typeof cmd == 'string') cmd = cmd.split(' ').filter(e => e.trim() != '');
        child = spawn(cmd[0], cmd.slice(1, cmd.length), {
            stdio: ['ignore', 'pipe', 'pipe']
        });

        child.stdout?.on('data', d => {
            let log = `[OUT] ${d}`;
            addLogs(log);
            process.stdout.write(log)
            stdout(d);
        });
        child.stderr?.on('data', d => {
            let log = `[ERR] ${d}`;
            addLogs(log);
            process.stderr.write(log);
            stderr(d);
        });

        // 进程退出
        if (fs.existsSync(logsPath) && fs.statSync(logsPath).isFile()) fs.rmSync(logsPath);
        child.on('close', code => {
            addLogs('ExitCode:' + code);
            showLog(`进程退出 code: ${code}`);
            if (code == 0) {
                resolve(logs);
            } else {
                fs.writeFileSync(logsPath, JSON.stringify(logs, null, 2));
                reject(logs);
            }
        });

        // 显示日志
        function showLog(...args: any[]) {
            console.log('[Agent]', ...args)
        }
        // 添加日志信息，同时只保留最后的50条数据
        function addLogs(log: any) {
            logs.push(log);
            if (100 < logs.length) {
                logs.splice(logs.length - 50)
            }
        }
    })
}
