# 临时邮箱

自行部署的临时收件箱，支持任意邮箱前缀、验证码提取、邮件阅读和 Agent API。邮件保留 24 小时，仅收不发。

## 部署

准备 GitHub 账号、Cloudflare 免费账号和已接入 Cloudflare 的域名。运行只需 **一个 Worker + 一个 D1**。

1. 点击 [部署到 Cloudflare](https://deploy.workers.cloudflare.com/?url=https://github.com/stboata/tempmail)，或先 fork，再在 Cloudflare 的 Workers 中导入自己的仓库。
2. 部署命令保留 **`npx wrangler deploy`**（`npm run deploy` 也可）。Cloudflare 自动创建并绑定一个 D1，首次使用时自动建表；再次部署保留已有邮件。无需填写数据库编号或执行 SQL。构建命令可留空，部署时会自动构建网页。
3. 在部署引导中填写以下配置。直接导入 fork 时，在项目的 **设置 → 变量与机密** 中添加；后续部署保留这些配置。

   | 配置 | 内容 |
   | --- | --- |
   | `MAIL_DOMAIN` | 收件域名，例如 `example.com`，不带 `https://` |
   | `ACCESS_KEY` | 自定义访问密钥，使用不含空格的英文字母、数字或符号，保存为 Secret |

4. 在域名的 **Email Routing（邮件路由）** 中启用收件，按提示添加 DNS 记录。域名已有邮箱服务时，先确认现有 MX 记录是否冲突。
5. 将 **Catch-all rule → Send to a Worker** 指向本项目并启用，即可接收 `任意前缀@收件域名`。
6. 打开 Worker 提供的网址，输入密钥。需要自定义网址时，在 **Settings → Domains & Routes → Add → Custom Domain** 添加，例如 `inbox.example.com`。

部署后，从其他邮箱发一封邮件，检查收件、查询、阅读和删除。

## 使用

- 默认显示全部邮件；“查邮箱”精确查询前缀或完整地址，“搜邮件”查关键词。
- 随机生成地址后，点击“使用此邮箱”筛选收件。
- 页面可见时每分钟刷新；邮件到期后不可读取，每 30 分钟清理。
- 查看不删信。程序应在目标网站确认验证成功后，删除实际使用的邮件。
- 顶部 **API** 在页面内显示接口和调用示例，切回邮箱保留登录与筛选；Agent 可直接读取 `/llms.txt`，完整接口见 [API.md](API.md)。

## 保存上限

| 内容 | 上限 |
| --- | --- |
| 邮件总量 | 5,000 封、约 100 MiB 内容估算量 |
| 单封原始邮件 / 正文 | 2 MiB / 512 KiB；超限只留基本记录 |
| 正文内嵌图片 | PNG、JPEG、GIF、WebP；每封最多 8 张，单张 256 KiB，合计 512 KiB |

支持数字、纯字母及组合验证码，也可打开邮件中的验证链接。外部图片按需显示，普通附件不保存。免费额度以 [Workers](https://developers.cloudflare.com/workers/platform/limits/) 和 [D1](https://developers.cloudflare.com/d1/platform/pricing/) 的实际用量为准。

## 本地运行

Node.js 22.12 或更新版本：

```sh
npm ci
cp .dev.vars.example .dev.vars
```

在 `.dev.vars` 填写域名和密钥，再运行 `npm run dev`，打开 `http://localhost:8787`。`npm run check` 检查部署打包；互联网收件需要完成域名部署。
