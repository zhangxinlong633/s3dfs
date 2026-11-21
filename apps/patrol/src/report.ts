import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export interface AttachResult {
  body: Record<string, unknown>;
  exitCode: number;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

export function patrolReportName(at: Date): string {
  return `patrol-${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}.html`;
}

function stamp(at: Date): string {
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
}

function esc(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asList(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(asRecord) : [];
}

function section(brief: string, label: string): string {
  const match = brief.match(new RegExp(`${label}：([\\s\\S]*?)(?=\\n(?:现状|相比上次|已执行|值班下一步)：|$)`));
  return match?.[1]?.trim() ?? "";
}

function rows(items: Record<string, unknown>[], cells: Array<(item: Record<string, unknown>) => unknown>): string {
  return items
    .map((item) => `<tr>${cells.map((cell) => `<td>${esc(cell(item))}</td>`).join("")}</tr>`)
    .join("");
}

export function renderPatrolHtml(report: Record<string, unknown>, at: Date): string {
  const brief = String(report.brief ?? "");
  const findings = asList(report.findings);
  const decisions = asList(report.decisions);
  const changes = asList(report.changes);
  const watch = Array.isArray(report.watch) ? report.watch.map((line) => String(line)) : [];
  const modelError = report.modelError === undefined ? "" : String(report.modelError);
  const findingRows = rows(findings, [
    (item) => item.module,
    (item) => item.metric,
    (item) => item.value,
    (item) => item.threshold,
    (item) => (item.over ? "越过" : "未越线"),
  ]);
  const decisionRows = rows(decisions, [
    (item) => item.action,
    (item) => (item.apply ? "已执行" : "只记录"),
    (item) => item.summary,
  ]);
  const changeRows = rows(changes, [
    (item) => item.module,
    (item) => item.metric,
    (item) => item.previous,
    (item) => item.current,
  ]);
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>S3DFS 巡检报告 ${esc(stamp(at))}</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 880px; margin: 32px auto; padding: 0 16px; color: #1c1c1c; line-height: 1.5; }
  h1 { font-size: 1.4rem; font-weight: 600; }
  h2 { font-size: 1rem; font-weight: 600; margin-top: 1.6rem; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border-bottom: 1px solid #ddd; text-align: left; padding: 6px 8px; vertical-align: top; }
  .meta { color: #555; }
</style>
</head>
<body>
<h1>S3DFS 巡检报告</h1>
<p class="meta">${esc(stamp(at))}${report.truncated ? " · 快照已截断" : ""}</p>
<h2>现状</h2>
<p>${esc(section(brief, "现状"))}</p>
<h2>相比上次</h2>
<p>${esc(section(brief, "相比上次"))}</p>
${changeRows ? `<table><thead><tr><th>模块</th><th>指标</th><th>上次</th><th>这次</th></tr></thead><tbody>${changeRows}</tbody></table>` : ""}
<h2>已执行</h2>
<p>${esc(section(brief, "已执行"))}</p>
${decisionRows ? `<table><thead><tr><th>动作</th><th>结果</th><th>说明</th></tr></thead><tbody>${decisionRows}</tbody></table>` : ""}
<h2>值班下一步</h2>
${watch.length ? `<ul>${watch.map((line) => `<li>${esc(line)}</li>`).join("")}</ul>` : `<p>${esc(section(brief, "值班下一步"))}</p>`}
<h2>模块读数</h2>
<table><thead><tr><th>模块</th><th>指标</th><th>读数</th><th>阈值</th><th>判定</th></tr></thead><tbody>${findingRows}</tbody></table>
<h2>模型结论</h2>
<p>${esc(report.modelSummary ?? "")}</p>
${modelError ? `<h2>模型错误</h2><p>${esc(modelError)}</p>` : ""}
</body>
</html>
`;
}

async function writeUnique(dir: string, at: Date, html: string): Promise<string> {
  const stem = patrolReportName(at).replace(/\.html$/, "");
  for (let n = 1; n < 1000; n++) {
    const path = join(dir, n === 1 ? `${stem}.html` : `${stem}-${n}.html`);
    try {
      await writeFile(path, html, { encoding: "utf8", flag: "wx" });
      return path;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw err;
    }
  }
  throw new Error("too many patrol reports in the same second");
}

export async function attachReport(report: Record<string, unknown>, env: NodeJS.ProcessEnv, at = new Date()): Promise<AttachResult> {
  try {
    const dir = resolve(env.S3DFS_PATROL_REPORT_DIR ?? "reports");
    await mkdir(dir, { recursive: true });
    const reportPath = await writeUnique(dir, at, renderPatrolHtml(report, at));
    return { body: { ...report, reportPath }, exitCode: 0 };
  } catch (err) {
    return {
      body: { ...report, reportError: err instanceof Error ? err.message : String(err) },
      exitCode: 1,
    };
  }
}
