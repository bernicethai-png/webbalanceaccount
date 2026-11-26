# Webbalance 账务系统

静态网站（index.html），资料存在 Supabase 项目 `webbalance`（新加坡）。

- `index.html`：整个系统（界面 + 逻辑）
- `supabase.js`：@supabase/supabase-js 2.116.0（UMD）
- `logo.png`、`vercel.json`、`robots.txt`

只有 Supabase 表 `app_users` 里的 email 能看到和修改资料（Row Level Security）。
网页里的 publishable key 是公开用的，不是密码。

## Dropbox 发票归档（自动）

每当在 `payments` 表新增一笔收款（包括部分付款），Supabase 数据库 webhook 会调用 `api/archive-invoice.js`：

- 只处理 2026-11-01 起的收款；报价单（quotation）不归档。
- 如果这张发票已经在 `Sales/Income` 任何子文件夹里（按发票号判断），跳过。
- 否则按**收款月份**放进 `/Webbalances/Sales/Income/<MM.Mon>/`，文件名 `发票号_客户名.pdf`。
- PDF 版式与 `index.html` 里的 `buildPdf()` 一致。改发票模板时两边都要改。

### 一次性设置

1. **Dropbox App**：到 https://www.dropbox.com/developers/apps 新建 App，Access type 选 *Full Dropbox*，在 Permissions 勾选 `files.metadata.read`、`files.content.read`、`files.content.write`。拿到 App key 和 App secret。
2. **Refresh token**：用浏览器打开
   `https://www.dropbox.com/oauth2/authorize?client_id=<APP_KEY>&response_type=code&token_access_type=offline`，
   授权后得到 code，再在终端执行
   `curl https://api.dropbox.com/oauth2/token -d code=<CODE> -d grant_type=authorization_code -u <APP_KEY>:<APP_SECRET>`，
   返回值里的 `refresh_token` 就是要的。
3. **Vercel 环境变量**（Project Settings → Environment Variables）：
   - `DROPBOX_APP_KEY`、`DROPBOX_APP_SECRET`、`DROPBOX_REFRESH_TOKEN`
   - `SUPABASE_SERVICE_ROLE_KEY`（Supabase → Project Settings → API 里的 service_role，**不要**放进 index.html）
   - `WEBHOOK_SECRET`（随机字符串，例如 `openssl rand -hex 24`）
   - 可选：`ARCHIVE_FROM`（默认 `2026-11-01`）、`DROPBOX_ROOT`（默认 `/Webbalances/Sales/Income`）
4. **Supabase webhook**：Database → Webhooks → Create。表 `payments`，事件 `Insert`，类型 HTTP Request，方法 `POST`，URL 为 `https://<你的域名>/api/archive-invoice`，HTTP Headers 加 `x-webhook-secret: <WEBHOOK_SECRET 的值>`。
5. 部署后，在 Vercel 的 Logs 里可以看到每次 `archive-invoice` 的结果（archived / skipped / error）。

### 本地测试

`npm install`，然后用 mock 或真实 Supabase/Dropbox 调用 `api/archive-invoice.js` 导出的 `renderInvoicePdf(doc, customer)` 生成 PDF。
`fonts/` 里是 Tinos（Times New Roman 的开源替代，SIL OFL）和 Noto Sans SC 子集（中文字形），服务器上没有系统字体，所以需要随函数一起打包。
