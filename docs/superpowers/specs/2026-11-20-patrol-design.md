# 模块巡检助手

日期：2026-11-20。

| | |
| --- | --- |
| 目标 | 系统自带巡检 AI。规则按模块状态执行有利的维护；Deep Agents 把发现和已执行的动作写成给值班人看的结论。模型不读对象正文，不删除、不重启、不缩容 |
| 读者 | 配置巡检进程和查看决定的人 |
| 模型 | 本机 LM Studio 的 `google/gemma-4-26b-a4b`，OpenAI 兼容地址 `http://127.0.0.1:1234/v1`。参数量按 260 亿。小于 260 亿的模型不调用 |
| 相关 | [自动扩缩容](2026-11-20-autoscaling-design.md)、[上线之后省心](2026-11-20-care-design.md)、[从自启到巡检结论](../../milestones/2026-11-20-first-patrol.md) |

## 1. 助手能看什么

`GET /_s3dfs/modules` 返回一份模块快照。请求头 `x-s3dfs-patrol-token` 必须等于 `S3DFS_PATROL_TOKEN`。未配置该凭证时接口返回 401。快照不含对象正文。JSON 超过 8KB 时从末尾去掉 block 节点，并带上 `truncated: true`。

| 模块 | 快照里的数 |
| --- | --- |
| 索引 | 是否可达、对象数、写入探测延迟、各地址上的副本是否一致。只配置一个索引地址时视为一致 |
| block | 每台节点的存活、zone、占用、空洞、locator 数、是否排空、未落盘字节 |
| 布局 | 副本数、存活节点、故障域、是否满足严格布局 |
| 修复 | 本进程 `lost`，以及上次修复里补上或失败的份数 |
| API | 在途请求、延迟 p99 |
| 扩缩 | 连续超阈值次数、冷却、是否配置扩容脚本、是否正在排空 |
| 告警 | 未恢复事件条数 |

## 2. 谁做决定

规则在 API 里。每次 `POST /_s3dfs/patrol` 先生成带阈值的发现，再生成决定。

| 条件 | 动作 |
| --- | --- |
| 上次修复仍有缺副本 | 执行现有副本修复 |
| 某台 block 空洞比例达到 `S3DFS_COMPACT_DEAD_RATIO` | 执行 compact |
| 未落盘字节大于 0 | 执行 flush |
| 连续超阈值、冷却已过、且配置了 `S3DFS_SCALE_UP_CMD` | 执行扩容脚本，原因记为 `patrol` |
| 有 `lost`、布局不成立、索引不可达或副本不一致、未恢复事件、负载高但脚本未配置或仍在冷却、以及缩容或排空 | 只写入决定 |

`GET /_s3dfs/decisions` 返回最近一次的发现、决定和执行列表。

## 3. 模型写什么

`apps/patrol` 是 TypeScript 进程，用 `pnpm patrol` 启动。它调用上面的接口。默认用 LM Studio 里的 Gemma 4 26B，并关闭该模型的推理过程（`reasoning_effort: none`），让结论出现在正式回复里。Deep Agents 按七个模块各读一次发现，把中文结论 `POST` 到 `/_s3dfs/patrol/summary`。模型不新增删除、重启或缩容。把 `S3DFS_PATROL_MODEL` 设为 `off` 时，决定里的规则摘要就是给用户看的结论。

| 变量 | 默认 | 含义 |
| --- | --- | --- |
| `S3DFS_PATROL_API_URL` | `http://127.0.0.1:9000` | API 地址 |
| `S3DFS_PATROL_TOKEN` | 未设置 | 查看凭证。与 API 进程相同 |
| `S3DFS_PATROL_INTERVAL_MS` | `86400000` | 巡检间隔。`0` 表示只跑一次 |
| `S3DFS_PATROL_MODEL` | `google/gemma-4-26b-a4b` | LM Studio 中的模型名。`off` 表示只跑规则 |
| `S3DFS_PATROL_BASE_URL` | `http://127.0.0.1:1234/v1` | LM Studio 的 OpenAI 兼容地址 |
| `S3DFS_PATROL_API_KEY` | `lm-studio` | LM Studio 不校验密钥时使用这个占位值 |
| `S3DFS_PATROL_MODEL_PARAMS` | `26000000000` | 小于 260 亿则跳过模型 |

依赖是 npm 包 `deepagents`、`@langchain/openai` 和 `zod`，装在 `@s3dfs/patrol`。`S3DFS_PATROL_MODEL=off` 时不加载这些包。Deep Agents 的写入权限使用绝对路径 `/**`。

block 统计带 `unflushedBytes`，表示写缓冲里尚未落盘的字节。引擎需要重新编译后，运行中的 block 进程才会报出这个字段。
