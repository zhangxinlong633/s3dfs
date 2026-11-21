import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachReport, patrolReportName, renderPatrolHtml } from "../src/report.ts";

const at = new Date(2026, 10, 21, 9, 35, 12);

const report = {
  brief: "现状：正常<script>\n相比上次：第一次\n已执行：无\n值班下一步：\n- 无需额外值班动作",
  findings: [{ module: "index", metric: "ok", value: 1, threshold: 1, over: false }],
  decisions: [{ summary: "记下 flush", apply: false, action: "note" }],
  apply: [] as string[],
  changes: [{ module: "api", metric: "latencyP99Ms", previous: 5, current: 80 }],
  watch: ["无需额外值班动作"],
  modelSummary: "结论 <img src=x onerror=alert(1)>",
  modelError: "超时",
  truncated: false,
};

describe("patrol html report", () => {
  test("names the file with local time and no colon", () => {
    expect(patrolReportName(at)).toBe("patrol-2026-11-21T093512.html");
  });

  test("keeps the brief sections and escapes model text", () => {
    const html = renderPatrolHtml(report, at);
    expect(html).toContain("S3DFS 巡检报告");
    expect(html).toContain("2026-11-21 09:35:12");
    expect(html).toContain("现状");
    expect(html).toContain("相比上次");
    expect(html).toContain("已执行");
    expect(html).toContain("值班下一步");
    expect(html).toContain("正常");
    expect(html).toContain("index");
    expect(html).toContain("latencyP99Ms");
    expect(html).toContain("5");
    expect(html).toContain("80");
    expect(html).toContain("超时");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
  });

  test("writes a new file and does not overwrite the same second", async () => {
    const dir = await mkdtemp(join(tmpdir(), "s3dfs-patrol-"));
    const env = { S3DFS_PATROL_REPORT_DIR: dir };
    const first = await attachReport(report, env, at);
    const second = await attachReport(report, env, at);
    expect(first.exitCode).toBe(0);
    expect(first.body.reportPath).toBe(join(dir, "patrol-2026-11-21T093512.html"));
    expect(second.body.reportPath).toBe(join(dir, "patrol-2026-11-21T093512-2.html"));
    const html = await readFile(String(first.body.reportPath), "utf8");
    expect(html).toContain("值班下一步");
    const again = await readFile(String(first.body.reportPath), "utf8");
    expect(again).toBe(html);
  });

  test("returns exit 1 when the report directory cannot be created", async () => {
    const dir = await mkdtemp(join(tmpdir(), "s3dfs-patrol-"));
    const blocker = join(dir, "not-a-dir");
    await writeFile(blocker, "x");
    const result = await attachReport(report, { S3DFS_PATROL_REPORT_DIR: join(blocker, "reports") }, at);
    expect(result.exitCode).toBe(1);
    expect(String(result.body.reportError).length).toBeGreaterThan(0);
    expect(result.body.brief).toBe(report.brief);
    expect(result.body.reportPath).toBeUndefined();
  });
});
