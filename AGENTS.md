# 依赖和产出物放哪里

1. 发布用的程序、引擎和依赖只放仓库根的 `dist/`。依赖目录是 `dist/node_modules`。发版压缩包从这里打。

2. `apps/` 和 `packages/` 只放源码。这里出现的 `node_modules`、`dist`、`.next`、`build`、`*.tsbuildinfo` 是本机安装或编译的中间结果。

3. `pnpm dist` 把第 2 条里的中间结果复制进根 `dist/` 之后，执行 `pnpm clean` 清掉 `apps/` 和 `packages/` 里的这些目录和文件。`pnpm clean` 留下仓库根的 `dist/`。

4. `node_modules`、`dist`、`.next`、`build`、`*.tsbuildinfo` 不进 git。`apps/web/AGENTS.md` 和 `apps/web/next-env.d.ts` 由 `next dev` 生成，也不进提交。本机再开发前执行 `pnpm install`，工作区里的依赖是开发用的。
