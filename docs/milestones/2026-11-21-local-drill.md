# 本机演练

| | |
| --- | --- |
| 日期 | 2026-11-21T03:25:48.446Z |
| 机器 | 本机 localhost，三个索引进程、三个 block 进程、两个 API 进程 |
| 效力 | 这不是准备承接流量的集群。上线标准要求同一套步骤在目标机器上再做一遍 |

| 步骤 | 结果 | 记录 |
| --- | --- | --- |
| 0 index ring | 通过 | physical nodes 3,3,3 |
| 1 health | 通过 | status 200 live 3 zones 3 layout.ok true |
| 4 create bucket | 通过 | status 200  |
| 2 stop one block | 通过 | put 200 get 200 repair 201 locators block1,block2 primary yes |
| 2 node back | 通过 | repair 201 locators block1,block2,block3 |
| 2 one block left | 通过 | put 503 health 503 reasons ["live block nodes 1 < configured replicas 3","failure domains 1 < configured replicas 3"] |
| 2 blocks restored | 通过 | health 200 live 3 |
| 3 stop one index | 通过 | put 200，另一台 API get 200，20 字节与写入一致 |
| 3 index caught up | 通过 | get 200 list has key true |
| 4 multipart restart | 通过 | open 200 parts 200/200 complete 200 get 13 range 206 |
| 4 signed delete and unsigned | 通过 | delete 204 empty-bucket 204 unsigned 403 |
| 5 delete drill bucket | 通过 | delete 204 health 200 lost 0 |
| lost object | 通过 | repair 201 health 503 lost 1 |

本机五步和丢失检查都通过。目标集群演练仍然开着。
