# 身份：用户、组、服务账号和临时凭证

日期：2026-11-21。

| | |
| --- | --- |
| 目标 | 把 MinIO 里值得留下的身份账本引进来：用户、组、策略、服务账号，以及用自己的密钥换一把短期凭证 |
| 读者 | 实现和验收这条身份的人 |
| 不进这一期 | LDAP、OIDC、组的嵌套、IP 等条件、把身份同步到另一站点 |
| 不改 | 写成功仍是 3 份里的 2 份。对象 key 仍由调用方指定 |

根密钥仍是 `S3DFS_ACCESS_KEY` 和 `S3DFS_SECRET_KEY`，能做所有事，包括管理身份。`S3DFS_ACCOUNTS` 仍按桶名单生效。索引里的新账本叠在这两条上面，不替换它们。

## 1. 账本

存在索引里，重启还在。秘密密钥要能用来校验 SigV4，所以明文放在索引值里，不写进日志。

| 键 | 值 |
| --- | --- |
| `$iam/policy/<name>` | `{ statements: PolicyStatement[] }`。语句沿用现有的 Allow 和 Deny、动作、资源 |
| `$iam/group/<name>` | `{ members: string[], policies: string[] }`。members 是用户的 accessKeyId |
| `$iam/user/<accessKeyId>` | `{ secretAccessKey, status: 'enabled' \| 'disabled', groups: string[], policies: string[] }` |
| `$iam/session/<accessKeyId>` | `{ secretAccessKey, parent, status, expiresAtMs?, policies?: string[] }`。服务账号和 STS 临时凭证都用这一条。policies 是可选的更窄策略名 |

策略名必须已经存在，才能挂到用户、组或会话上。用户上的 `groups` 和组上的 `members` 一起改：写用户时按新的组名单增减成员，写组时按新的成员名单回写用户。

## 2. 一次请求怎么判

顺序固定。

1. 签名对上根密钥：放行。不再看账本。
2. 签名对上 `S3DFS_ACCOUNTS` 里的一把密钥：沿用现在的桶名单和 `expiresAtMs`。
3. 签名对上用户或会话：停用，或 `expiresAtMs` 已到，返回 403。会话的父用户停用，同样 403。
4. 收集语句：用户自己的策略，加上所属各组的策略。会话再要求自己的策略也放行。会话没有策略名时，只看父用户。
5. 有一条 Deny 的动作和资源都命中：403。没有任何 Allow 命中：403。
6. 身份放行之后，桶上原来的策略仍按现在的 `checkPolicy` 再判一次。桶上没有策略时，不因此拒绝。

动作和资源沿用 `actionFor`：桶级是 `s3:CreateBucket`、`s3:DeleteBucket`、`s3:ListBucket`，对象级是 `s3:GetObject`、`s3:PutObject`、`s3:DeleteObject`。资源是 `bucket` 或 `bucket/key`。

身份策略和桶策略的空名单含义不同。身份上一张策略都没有，就是拒绝。桶上没有策略，保持现在的放行。

## 3. 管理

走现有的管理写鉴权：巡检令牌或根密钥的 SigV4。路径是 `POST /_s3dfs/iam`，正文是 JSON，`op` 决定动作。

| op | 要有的字段 | 结果 |
| --- | --- | --- |
| `putPolicy` | `name`，`statements` | 写入或覆盖策略 |
| `deletePolicy` | `name` | 删掉策略。仍被用户、组或会话挂着时返回 409 |
| `putGroup` | `name`，`members`，`policies` | 写入或覆盖组，并回写用户的 `groups` |
| `deleteGroup` | `name` | 删组，并从成员的 `groups` 里拿掉 |
| `putUser` | `accessKeyId`，`secretAccessKey`，`status`，`groups`，`policies` | 写入或覆盖用户，并回写组的 `members` |
| `deleteUser` | `accessKeyId` | 删用户，并从组里拿掉。它名下的会话一并删掉 |
| `setUserStatus` | `accessKeyId`，`status` | 只改启用或停用 |
| `createServiceAccount` | `parent`，可选 `policies`，可选 `expiresAtMs` | 生成一对新密钥，父用户必须启用且存在。返回 `accessKeyId` 和 `secretAccessKey` |
| `deleteServiceAccount` | `accessKeyId` | 删掉这一条会话 |

未知的策略名、未知的组、未知的父用户，返回 400。

## 4. 临时凭证

`AssumeRole` 也是 `POST /_s3dfs/iam`，`op` 为 `assumeRole`。调用者用自己的用户密钥做 SigV4，不必是根密钥。根密钥也可以代发。

正文可以带 `durationSeconds`，默认 3600，最长 43200。可以带 `policies`，那些策略必须已经存在。会话上挂了策略之后，请求必须同时被父用户和这些策略放行，所以只能更窄，不能更宽。

返回 `accessKeyId`、`secretAccessKey`、`expiresAtMs`。到期之后签名仍能对上，但第 3 步返回 403。

## 5. 验收

| 场景 | 结果 |
| --- | --- |
| 策略只允许 `logs` 上的 `s3:PutObject` | 该用户 Put `logs` 成功，Put 另一个桶 403 |
| 用户自己没有策略，组上有这条策略 | Put `logs` 成功 |
| 同一资源上有一条 Deny | 组里的 Allow 也不放行 |
| 用户被停用 | 原来能写的 Put 变成 403 |
| 服务账号挂了更窄的策略 | 父用户能写的桶，服务账号写不了 |
| `assumeRole` 得到的密钥在到期前可写，到期后 403 | 到期用测试里的 `now` 判断 |
| 根密钥 | 不看账本，仍能写 |
| 只配置 `S3DFS_ACCOUNTS` | 现有的分桶和过期测试仍然通过 |
