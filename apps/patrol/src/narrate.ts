import { ChatOpenAI } from "@langchain/openai";
import { createDeepAgent } from "deepagents";
import { tool } from "langchain";
import { z } from "zod";
import { DEFAULT_BASE_URL, DEFAULT_MODEL, MODULES, configuredModel } from "./config.js";

interface PatrolReport {
  findings?: { module?: string }[];
  decisions?: { module?: string }[];
}

function messageText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }
      if (part && typeof part === "object" && "text" in part) {
        return String((part as { text?: unknown }).text ?? "");
      }
      return "";
    })
    .join("");
}

export async function narrate(report: PatrolReport, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const name = configuredModel(env) ?? DEFAULT_MODEL;
  const model = new ChatOpenAI({
    model: name,
    apiKey: env.S3DFS_PATROL_API_KEY ?? "lm-studio",
    temperature: 0,
    maxTokens: 1024,
    configuration: { baseURL: env.S3DFS_PATROL_BASE_URL ?? DEFAULT_BASE_URL },
    modelKwargs: name.includes("gemma") ? { reasoning_effort: "none" } : undefined,
  });
  const readModule = tool(
    async ({ name: moduleName }) => {
      if (!MODULES.includes(moduleName as (typeof MODULES)[number])) {
        return JSON.stringify({ error: "unknown module", modules: MODULES });
      }
      return JSON.stringify({
        module: moduleName,
        findings: (report.findings ?? []).filter((item) => item.module === moduleName),
        decisions: (report.decisions ?? []).filter((item) => item.module === moduleName),
      });
    },
    {
      name: "read_module",
      description: "Read one patrol module: index, block, layout, repair, api, scale, or care.",
      schema: z.object({ name: z.string() }),
    },
  );
  const agent = await createDeepAgent({
    model,
    tools: [readModule],
    systemPrompt:
      "你是 S3DFS 的运维助手。必须逐个调用 read_module，顺序为 index、block、layout、repair、api、scale、care。用四段中文写结论：现状、相比上次、已经执行、值班下一步。值班下一步沿用报告里的 watch，不要发明删除对象、重启进程或缩容。严格布局关闭且故障域为 0 时，写成单机未配置故障域，不要说符合生产要求。",
    permissions: [{ operations: ["write"], paths: ["/**"], mode: "deny" }],
  });
  const result = await agent.invoke({
    messages: [{ role: "user", content: "巡检这七个模块，并写出给值班人看的结论。" }],
  });
  const messages = (result as { messages?: { content?: unknown }[] }).messages ?? [];
  const last = messages[messages.length - 1];
  return messageText(last?.content).slice(0, 4000);
}
