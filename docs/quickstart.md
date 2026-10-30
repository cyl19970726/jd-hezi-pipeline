# 快速开始与安全试运行

## 1. 检查环境

```sh
node --version
npm --version
ego-browser --help
```

要求 Node.js `22.19.0` 或更新版本。Ego Browser 应能在用户自己的已登录个人资料中工作。项目不会读取或提交浏览器 Cookie。

安装并验证离线部分：

```sh
npm ci
npm run check
npm run demo
node scripts/check-repository-policy.mjs
```

`npm run demo` 使用合成商品和临时状态，不访问网站。

## 2. 准备一个隔离状态目录

默认状态目录是仓库内的 `.hezi/`，已被 Git 忽略。也可以显式指定：

```sh
export HEZI_DIR=/absolute/path/to/private-state
mkdir -p "$HEZI_DIR"
```

每个目标店铺建议使用独立状态目录。不要把这个目录放进 GitHub、网盘共享链接或公开备份。

## 3. 绑定浏览器空间

创建新任务空间：

```sh
node dist/cli.js init \
  --dir "$HEZI_DIR" \
  --profile '<ego-profile-id>' \
  --shop '<目标店铺全名>'
```

绑定现有空间：

```sh
node dist/cli.js attach \
  --dir "$HEZI_DIR" \
  --space <space-id> \
  --profile '<ego-profile-id>' \
  --shop '<目标店铺全名>' \
  --hz p1 --jd p2
```

只读检查登录和页面状态：

```sh
node dist/cli.js --dir "$HEZI_DIR" inspect
```

出现登录、验证码或平台提示时由有权限的操作者完成处理。不要使用账号轮换或代理轮换绕过限制。

## 4. 先跑一个受控 SKU

```sh
node dist/cli.js --dir "$HEZI_DIR" collect \
  'https://item.jd.com/<synthetic-or-authorized-sku>.html'
```

使用上一条命令返回的记录 ID：

```sh
node dist/cli.js --dir "$HEZI_DIR" assets '<record-id>'
node dist/cli.js --dir "$HEZI_DIR" plan-auto '<record-id>' \
  --brand-id '<catalog-brand-id>' \
  --category-id '<catalog-category-id>' \
  --policy '<policy-id>' \
  --unit 件 \
  --out "$HEZI_DIR/plan.json"
node dist/cli.js --dir "$HEZI_DIR" plan '<record-id>' --file "$HEZI_DIR/plan.json"
node dist/cli.js --dir "$HEZI_DIR" validate '<record-id>'
```

先只写到草稿：

```sh
node dist/cli.js --dir "$HEZI_DIR" run '<record-id>' --write --through draft
```

重新打开原平台商品并核对。只有当前操作者确认本次试运行允许提交时，才执行：

```sh
node dist/cli.js --dir "$HEZI_DIR" run '<record-id>' --write --through submit
```

`SUBMITTED` 只表示已提交审核。它在售前仍需要平台审核。

## 5. 打开工作台

```sh
HEZI_DIR="$HEZI_DIR" npm run workbench
```

浏览器打开 `http://127.0.0.1:4317`。工作台显示本地任务、阻塞原因、价格对比、阶段耗时和已验证远端状态。它不直接轮询京东或目标平台。

## 6. 推荐的首日边界

- 只处理一个类目和一个 SKU。
- 只使用已经存在且明确有效的品牌/类目授权。
- 先保存到草稿，独立读回后再决定是否提交。
- 出现未知写入结果时停止，先对账；不要重建商品。
- 把本次人工介入和失败阶段记录下来，再决定是否扩到第二批。
