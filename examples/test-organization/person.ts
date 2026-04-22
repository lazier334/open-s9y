/**
 * 组织成员（Person）
 * - 不连接网关，只封装 AI 调用能力
 * - 被 Organization 调用来发表内部意见
 * - 每个 Person 有自己独立的 system prompt 和角色设定
 */

export interface PersonOptions {
  /** 成员名称 */
  name: string;
  /** 角色描述 */
  role: string;
  /** AI API 地址 */
  apiUrl?: string;
  /** AI API Key */
  apiKey: string;
  /** AI 模型 */
  model?: string;
  /** AI temperature，默认 0（确定性输出） */
  temperature?: number;
}

/**
 * 组织内成员
 * 不连接网关，由 Organization 内部调用，提供意见。
 */
export class Person {
  readonly name: string;
  readonly role: string;
  private apiUrl: string;
  private apiKey: string;
  private model: string;
  private temperature: number;

  constructor(options: PersonOptions) {
    this.name = options.name;
    this.role = options.role;
    this.apiUrl = options.apiUrl ?? "https://api.deepseek.com/v1";
    this.apiKey = options.apiKey;
    this.model = options.model ?? "deepseek-chat";
    this.temperature = options.temperature ?? 0;
  }

  /**
   * 根据给定上下文发表意见
   * @param context - 上下文描述（如外部消息、当前局势）
   * @returns 该角色的意见/建议
   */
  async think(context: string): Promise<string> {
    const messages = [
      {
        role: "system" as const,
        content: `你是${this.name}，${this.role}。
你的任务是参与组织内部讨论，对当前事件发表专业意见。
请保持简洁（50-100字），直接表达观点即可。`,
      },
      {
        role: "user" as const,
        content: context,
      },
    ];

    const res = await fetch(`${this.apiUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        temperature: this.temperature,
        max_tokens: 200,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`AI API ${res.status}: ${text}`);
    }

    const data = await res.json();
    return data.choices?.[0]?.message?.content ?? "";
  }
}
