# Webbalance 账务系统

静态网站（index.html），资料存在 Supabase 项目 `webbalance`（新加坡）。

- `index.html`：整个系统（界面 + 逻辑）
- `supabase.js`：@supabase/supabase-js 2.116.0（UMD）
- `logo.png`、`vercel.json`、`robots.txt`

只有 Supabase 表 `app_users` 里的 email 能看到和修改资料（Row Level Security）。
网页里的 publishable key 是公开用的，不是密码。
