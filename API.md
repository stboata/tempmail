# 程序与 Agent 接口

这是自行部署的临时收件服务。调用方只需网站 URL 和该实例的访问密钥；邮箱域名从状态接口取得。无需注册、建邮箱或建立等待任务。所有时间均为 Unix **毫秒**，所有接口禁止缓存。

所有接口请求都带以下请求头，密钥不要放进 URL：

```http
Authorization: Bearer 你的访问密钥
```

## 接口

| 方法与路径 | 功能 |
| --- | --- |
| `GET /api/status` | 验证密钥，返回 `domain`、`serverTime`、`retentionMs` 和 `limits` |
| `GET /api/messages` | 最新邮件优先的列表；参数见下表 |
| `GET /api/messages/{id}` | 详情，增加 `text`、`html`、`images`、`omittedImages` |
| `GET /api/messages/{id}/images/{imageId}` | 带相同鉴权头取得图片二进制；受所属邮件的有效期限制 |
| `DELETE /api/messages/{id}` | 删除指定邮件及内嵌图片，成功返回 **204、无正文**；重复删除也成功 |

列表参数可组合：

| 参数 | 含义 |
| --- | --- |
| `address` | 本实例下的完整收件地址，忽略大小写；不填表示全部邮箱。程序任务应填写 |
| `since` | 接收时间大于或等于此毫秒时间戳；仍受 24 小时保留期限制 |
| `q` | 在地址、发件人、主题、验证码和纯文本中搜索；最多 200 字、6 个空格分隔的关键词，需同时匹配 |
| `limit` | 每页 1～100 封，默认 30 |
| `cursor` | 原样传回上次的 `nextCursor`，取得更早一页；其他筛选条件保持不变 |

```http
GET /api/messages?address=task7%40example.com&since=1794750000000&limit=30
```

```json
{
  "messages": [{
    "id": "ccf80d8a-2a93-4753-a4ec-4b404b29d1c5",
    "address": "task7@example.com",
    "from": "security@example.net",
    "fromName": "Example",
    "subject": "Your verification code",
    "code": "482619",
    "preview": "Your verification code is 482619.",
    "status": "received",
    "receivedAt": 1794750001000,
    "expiresAt": 1794836401000
  }],
  "nextCursor": null,
  "serverTime": 1794750002000
}
```

空列表是 `200` 和 `messages:[]`。`code:""` 表示有邮件、没有可靠提取结果，可查看正文或验证链接。`status:"too_large"` 表示仅保存了基本记录，正文未保存。没有总数统计请求；界面上的数量是当前已加载数量。

按指定邮箱取信应使用 `address`，不要把邮箱前缀作为 `q`。`address` 精确匹配并使用地址索引；`q` 需要检查邮件内容，可能读取更多行。网页的“查邮箱”会自动补齐当前域名并只传 `address`；“搜邮件”才传 `q`，选定邮箱后可组合两者。

详情的 `images` 每项包含 `id`、`contentId`、`contentType`、`size` 和受保护的相对 `url`。HTML 的 `cid:xxx` 对应 `contentId:"xxx"`。`omittedImages` 是未保存的内嵌资源数量。正文是发件方内容；自建阅读界面时要隔离渲染，不能直接插入主页面执行。

## 自动验证的调用顺序

1. 请求 `/api/status`，取得邮箱域名和服务端时间。
2. 每个独立任务生成不同的随机前缀。**在触发目标网站发信之前**，保存本次 `since=serverTime` 和完整邮箱地址；中断恢复时沿用它们。
3. 到目标网站提交邮箱、触发验证，然后查询 `/api/messages?address=...&since=...`。
4. 无邮件时等待后再查询。建议从 3 秒逐步退到 10 秒，一次等待最多 2 分钟；这是客户端建议，可按任务调整。超时后报告尚未收到，是否重发由目标网站流程决定，不能无限循环。
5. 按发件人、主题和任务上下文选择邮件；需要时翻页或读详情。验证码未提取到、邮件使用链接时，从详情继续处理。
6. **目标网站确认验证成功后**，才删除实际使用的邮件。失败时保留，避免删除后无法重试。删除失败只重试删除，不重新执行已成功的注册。

可用以下 JavaScript 写请求；Node.js 使用内置 `fetch`，不需额外安装依赖：

```js
const base = process.env.MAIL_URL.replace(/\/$/, '');
const key = process.env.MAIL_KEY;
async function mail(path, method = 'GET') {
  const response = await fetch(base + path, {
    method,
    headers: { Authorization: 'Bearer ' + key },
    signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) {
    const error = new Error(`邮箱请求失败：${response.status}`);
    error.status = response.status;
    error.retryAfter = Number(response.headers.get('Retry-After')) || 0;
    throw error;
  }
  return response.status === 204 ? null : response.json();
}
const { domain, serverTime: since } = await mail('/api/status');
const address = 'task-' + crypto.randomUUID().slice(0, 12) + '@' + domain;
// 先在目标网站使用 address 发起验证，再执行下面的查询。
const params = new URLSearchParams({ address, since: String(since) });
const { messages } = await mail('/api/messages?' + params);
// 按上面的步骤处理空列表与多封邮件。外部验证成功后：
// await mail('/api/messages/' + 实际使用的邮件编号, 'DELETE');
```

## 错误与重试

| HTTP 状态 | 处理 |
| --- | --- |
| `400` | 参数不正确，修正后再请求 |
| `401` | 密钥不正确，停止轮询并修正配置 |
| `404` | 邮件或图片已删除、到期或不存在，不反复提交相同结果 |
| `405` | 请求方法错误，使用 `Allow` 响应头列出的 GET 或 DELETE |
| `429` | 错误密钥尝试过多，等待 `Retry-After` 指定的秒数并检查密钥 |
| `503` | 配置、数据库或运行服务不可用；可在本次等待上限内退避重试，不能当成无邮件 |

JSON 错误格式为 `{"error":{"code":"...","message":"..."}}`。网络失败、超时和 Cloudflare 自身错误也应算作故障；平台返回的内容未必是 JSON。

24 小时是邮件保存期，**不是验证码有效期**，也没有额外强制的五分钟取码窗口。同一地址重发或旧邮件晚到时，接收时间不能证明哪一个码仍有效，最终以目标网站结果为准。多个任务优先使用不同地址。持有同一密钥的程序共享整个实例的数据，没有按程序或用户隔离。
