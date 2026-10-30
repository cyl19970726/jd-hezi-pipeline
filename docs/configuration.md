# 配置

## 状态目录

`--dir` 指定运营状态目录，默认是 `.hezi`。其内容包括：

- `config.json`：浏览器空间、页面标签、店铺全名和本地 URL 模板。
- `state.sqlite`：商品、规则、任务、回执、锁和媒体关系。
- 下载缓存、回执和日志。

这整个目录都是私有运行数据。备份时先停止写入进程，使用项目快照命令或 SQLite 的一致性备份机制。

```sh
node dist/cli.js --dir "$HEZI_DIR" snapshot --out "$HEZI_DIR/backups/manual"
node dist/cli.js verify-snapshot "$HEZI_DIR/backups/manual"
```

## 浏览器配置

`init` 和 `attach` 会写入类似下面的结构。不要手工复制其他店铺的绑定：

```json
{
  "session": {
    "spaceId": 1,
    "hzPage": "p1",
    "jdPage": "p2",
    "profileId": "<ego-profile-id>"
  },
  "shop": "<目标店铺全名>",
  "listUrl": "https://b.csgmall.com.cn/shop-view/#/shop-view/goods/goods-manage",
  "newUrl": "https://b.csgmall.com.cn/shop-view/#/shop-view/goods/publish?new=1",
  "editUrl": "https://b.csgmall.com.cn/shop-view/#/shop-view/goods/publish?itemId={itemId}&status=99",
  "maxPages": 20
}
```

Cookie、密码和浏览器个人资料不写入此文件。每次写入前仍要核验实际店铺，不能只信配置文件。

## 商品与计划

`config/product.example.json` 和 `config/plan.example.json` 只用于演示结构。其中的商品、图片、价格和授权均为合成数据，不能发布。

计划字段必须来自：

- 当前 JD SKU 的明确页面事实；
- 当前店铺目录中的品牌/类目 ID；
- 有效的店铺授权；
- 已保存的类目模板；
- 明确的店铺政策或经操作者确认的业务规则。

不能为了通过校验而编造净含量、包装数量、型号、产地、库存、质保或价格。

## 价格

价格输入必须保留标签和来源 URL。建议遵循：

1. 使用当前页面明确标注的价格口径。
2. 记录采集时间和来源上下文。
3. 竞争价只在其确实是同规格、同购买条件时参与。
4. 任何低价边界都应由店铺策略明确记录。
5. 缺少可靠价格时阻断，不使用“随便取一个最低值”。

具体价格策略属于使用者的业务配置。公开示例不规定任何真实产品的售价。

## 授权

授权至少包含：

```text
shop + brand + category + approval status + effective period + observed_at + source
```

同品牌但不同类目的待审核授权不能视为已批准。授权缓存过期后需要重新观察；不能依据历史成功记录继续发布。

## 类目模板

每个目标类目从实际规格参数页读取模板，并按以下方式维护：

- 保存页面字段名、类型、必填性和来源时间。
- 新增模板先小批验收，再批量使用。
- 页面改版时更新适配器及回归测试。
- 模板只描述“平台要求什么”，不提供“商品值是什么”。

## 本地地址

工作台默认端口是 4317，可通过 `HEZI_PORT` 修改。服务应保持只监听 `127.0.0.1`。
