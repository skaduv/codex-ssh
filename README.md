# Codex SSH

在 Codex 中直接管理 SSH 主机、执行远程命令和传输文件。

Codex SSH 是一个本地 stdio MCP 插件，支持：

- 首次运行自动导入 `~/.ssh/config`，包括常见 `Include` 文件
- 通过 Codex 添加、删除和重新导入主机
- 使用稳定 `alias` 和中文 `displayName`
- 密码、私钥和口令保存在本地配置中，不进入模型上下文
- 命令执行、目录浏览、文件读写和上传下载
- TOFU/固定指纹主机校验、命令策略、输出和文件大小限制
- 插件内置安全卸载器

## 一键安装

### Windows PowerShell

```powershell
irm https://raw.githubusercontent.com/skaduv/codex-ssh/main/install.ps1 | iex
```

### macOS / Linux

```bash
curl -fsSL https://raw.githubusercontent.com/skaduv/codex-ssh/main/install.sh | bash
```

安装完成后：

1. 新建 Codex 会话。
2. 输入“列出 SSH 主机”，或直接指定 Codex SSH。
3. 如需添加机器，输入“通过 Codex SSH 添加机器 prod”。

要求 Codex 支持插件和本地 stdio MCP，Node.js 版本为 20 或更高。

## 手动安装

```bash
codex plugin marketplace add skaduv/codex-ssh --ref main
codex plugin add codex-ssh@codex-ssh
```

刷新插件市场或重启 Codex 后，从 Plugins 中启用 **Codex SSH**。

## 配置

默认插件配置：

```text
~/.codex-ssh/servers.json
```

默认导入：

```text
~/.ssh/config
```

示例：

```json
{
  "hosts": {
    "prod": {
      "displayName": "生产服务器 A",
      "host": "10.0.0.20",
      "port": 22,
      "username": "deploy",
      "auth": {
        "type": "password",
        "password": "本地保存的密码"
      },
      "defaultCwd": "/srv/app"
    }
  }
}
```

认证凭据只由本地 MCP 进程读取，不会出现在工具结果或主机列表中。但它们仍保存在本地文件中；
如果需要防范 Codex 其他本地文件工具访问，请限制 Codex 的文件系统权限或使用独立系统账户。

完整使用说明见 [插件 README](plugins/codex-ssh/README.md)。

## 卸载

在 Codex 中说：

```text
卸载 Codex SSH 插件
```

或运行独立卸载器：

```powershell
node plugins/codex-ssh/scripts/uninstall.mjs --project-root .
```

卸载器会处理 Windows 下 MCP 原生模块占用导致的 `Access Denied`，并默认保留主机配置。

## 开发

```bash
cd plugins/codex-ssh
npm install
npm run check
npm run build
```

`server/dist/index.cjs` 是提交到仓库的自包含 MCP 服务，因此从 GitHub 安装不需要在插件目录
运行 `npm install`。

## 官方插件目录

本插件使用本地 stdio MCP。根据 OpenAI 官方文档，本地 MCP 插件属于 **Desktop only**
插件，公开提交目前只对获批合作伙伴开放。准备材料见 [PUBLISHING.md](PUBLISHING.md)。

## License

MIT
