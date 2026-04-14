/**
 * 任务路由表
 * 轻量级维护 taskId → pivotId 映射
 */
export class TaskRouter {
  private routing = new Map<string, string>();

  /**
   * 记录任务到支点的路由映射
   * @param taskId - 任务唯一标识
   * @param pivotId - 负责处理该任务的支点 ID
   */
  setRoute(taskId: string, pivotId: string): void {
    this.routing.set(taskId, pivotId);
  }

  /**
   * 根据任务 ID 查询负责处理的支点 ID
   * @param taskId - 任务唯一标识
   * @returns 支点 ID 或 undefined
   */
  getPivotId(taskId: string): string | undefined {
    return this.routing.get(taskId);
  }

  /**
   * 删除指定任务的路由记录
   * @param taskId - 任务唯一标识
   * @returns 是否成功删除
   */
  removeRoute(taskId: string): boolean {
    return this.routing.delete(taskId);
  }

  /**
   * 批量删除指定支点负责的所有任务路由
   * @param pivotId - 支点唯一标识
   * @returns 删除的路由数量
   */
  removePivotRoutes(pivotId: string): number {
    let count = 0;
    for (const [taskId, cid] of this.routing.entries()) {
      if (cid === pivotId) {
        this.routing.delete(taskId);
        count++;
      }
    }
    return count;
  }

  /**
   * 检查指定任务是否存在路由记录
   * @param taskId - 任务唯一标识
   * @returns 是否存在
   */
  has(taskId: string): boolean {
    return this.routing.has(taskId);
  }
}
