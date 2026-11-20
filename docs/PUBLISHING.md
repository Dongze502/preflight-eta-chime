# 发布与上架

本文件是**自用清单**，记录把 `preflight-eta-chime` 发出去要做的动作，以及每一步当时的判断。

## 0. 先确认仓库干净

```bash
cd preflight-eta-chime
npm install
npm run verify        # build + 42 个宿主用例 + 2 个 DOM 用例 + 两个渲染 smoke
npm pack --dry-run    # 检查发布内容：lib/ 必须已经构建、node_modules 不能进去
git status            # lib/ 与 node_modules/ 应被 .gitignore 忽略
```

`lib/` 是构建产物、不入库；`npm pack` 之前 `prepublishOnly` 不自动构建，所以**先 `npm run build`**。
提交到 GitHub 的源码需要使用者自己 `npm install && npm run build`，或直接装 Release 里的 tarball。

## 1. 仓库

- 名称：`preflight-eta-chime`（与 `package.json` 的 `name`、插件 id、客户端模块 id 一致）。
- 描述：`Pre-send estimate, live ETA and a completion chime for DeepSeek Harness`。
- Topics：`dsh-plugin`（收录必需）、`deepseek-harness`、`eta`、`cordis`。
- 上传前 `npm run verify` 必须全绿。awesome-dsh-plugin 的 CI 会检查 `dsh.bundle.patch`，
  本仓库已在 `package.json` 的 `dsh.bundle.patch` 与根目录 `cordis.patch.yml` 两处声明。
- **仓库创建满 1 天后**才能投递，早投会被 CI 直接拒。

## 2. GitHub Release（替代 npm 的路径）

npm 上本包还没发；发布 `npm publish` 需要账号配置 2FA/TOTP。不想折腾时用 Release：

```bash
npm run build
npm pack --pack-destination dist          # 得到 preflight-eta-chime-0.1.7.tgz
mv dist/preflight-eta-chime-0.1.7.tgz dist/preflight-eta-chime.tgz   # 文件名不带版本号
```

把 `dist/preflight-eta-chime.tgz` 作为资产挂到 `v0.1.7` 的 Release 上，然后市场条目里加：

```yaml
tarball: https://github.com/Dongze502/preflight-eta-chime/releases/latest/download/preflight-eta-chime.tgz
```

`latest/download/` 的文件名必须固定（不带版本号），否则下次发版会 404。

## 3. 投递到 awesome-dsh-plugin

`docs/market-entry.yml` 是准备好的条目。投稿 = 在
`github.com/awesome-dsh-plugin/awesome-dsh-plugin` 加**一个文件**
`data/plugins/Dongze502__preflight-eta-chime.yml`，不要动别人的条目，也不要手改 README
（README 由 `scripts/generate-readme.mjs` 生成）。一个 PR 最多 3 条。

CI 会依次检查：条目数量、`package.json` 的 `dsh.bundle`、仓库年龄（≥1 天）、awesome-lint + 站点构建。

## 4. 发版流程

```bash
npm version patch --no-git-tag-version
# 更新 README 的测试徽章数字与 docs/market-entry.yml 的说明（如有变更）
npm run verify
git commit -am "release: 0.1.x"
git tag v0.1.x && git push && git push --tags
```

## 5. 已知的取舍

- 不发 npm 也能上架（市场里 3259 条走 `github:` 或 `tarball:`），只是没有下载量、也不能 `dsh plugin add <包名>`。
- `peerDependencies` 写的是 `>=4.1.0` / `>=0.2.2-rc.2`；预发布宿主会被 npm 的 semver 规则排除，
  本插件的 peer 全部 `optional: true`，所以安装不会因为宿主版本报 ERESOLVE。
