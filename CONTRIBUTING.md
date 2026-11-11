# 参与贡献

## 提问 / 报问题

直接开 [Issue](https://github.com/springriver2/dsh-gemini-studio/issues/new/choose)。开之前请先：

1. 翻一遍 [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)，大部分问题里面有
2. 搜一下已有 Issue

报 bug 时请带上：DSH 版本、macOS 版本、Chrome 版本、报错原文（日志或界面提示）、复现步骤。
**不要贴账号 cookie、`accounts.json`、`secrets.json` 或任何密钥**。

## 改代码

1. Fork 本仓库，从 `main` 开分支
2. 改动尽量小、单一；改 Gemini 交互的地方请说明你实测的页面版本
3. 提交 PR 时写清楚：改了什么、为什么、怎么验证的（截图/日志）

PR 我会看，但不保证合并——特别是：

- 引入新的第三方 API key 依赖
- 绕过 Gemini 额度/风控的做法
- 会破坏「一个插件装完即用」的改动

## 开发

```bash
# 本地装到 DSH（在 DSH 里让 agent 执行）
plugin_manager install_bundle /绝对路径/dsh-gemini-studio
```

改完 `index.js` / `client.js` 后，在 DSH 里停用再启用这个插件即可生效；
`client.js` 属于客户端，需要刷新页面（必要时重启 DSH）。
