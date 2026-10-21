# Codex SSH

一个本地 Codex 插件，通过 MCP 把 SSH 主机操作暴露给 Codex。首次启动会读取
`~/.ssh/config`，把其中具体的 Host 导入 `~/.codex-ssh/servers.json`。Codex
可以在对话中新增、删除或重新导入机器配置，但运行操作仍只允许使用插件中的别名。

## 能力

- 首次运行自动导入 `~/.ssh/config`，支持常见的 `Include` 文件
- 通过 Codex 新增、删除机器配置或重新导入 OpenSSH 配置
- 列出已配置主机并测试 SSH/SFTP 连接
- 在远程 POSIX shell 中执行命令，限制超时和输出大小
- 浏览远程目录，读取 UTF-8 或 base64 文件
- 以临时文件方式写入远程文件，默认禁止覆盖
- 在本地与远程主机之间上传、下载单个文件
- 使用 TOFU、固定指纹或显式 insecure 的主机密钥校验策略
- 按主机禁用命令执行、文件写入，或配置命令正则表达式策略

## 目录

```text
plugins/codex-ssh/
├── plugin.json
├── mcp.json
├── server/                 # MCP 服务实现
├── skills/                 # 安装引导和远程操作规范
├── config/
│   └── servers.example.json
└── scripts/init-config.js
```

当前仓库还包含：

- `.agents/plugins/marketplace.json`：本地插件市场
- `.codex/config.toml`：启用插件并默认要求写操作审批

## 1. 安装依赖

需要 Node.js 20 或更高版本。

```powershell
cd E:\tihu\plugins\codex-ssh
npm install
```

## 2. 首次运行自动导入

MCP 服务第一次启动时，会自动执行以下流程：

1. 创建 `C:\Users\<用户名>\.codex-ssh\servers.json`。
2. 读取 `C:\Users\<用户名>\.ssh\config`。
3. 查找具体的 `Host` 别名，并读取常见 `Include` 文件。
4. 使用本机 `ssh -G` 解析最终的 HostName、User、Port、IdentityFile、
   IdentityAgent 和 ConnectTimeout。
5. 把机器配置写入插件配置，并记录导入时间。

导入只执行一次。之后从 Codex 删除的机器不会在重启时自动重新出现。

以下内容会被跳过：

- `Host *`、`Host *.example.com` 等通配符规则，因为它们不是一台具体机器。
- `Match` 块，因为同一别名可能依赖运行时条件。
- 无法解析或别名不符合安全字符规则的条目。

可以在 Codex 中手动要求重新导入：

```text
重新从 ~/.ssh/config 导入 SSH 主机配置，不覆盖已有机器
```

对应工具为 `ssh_import_ssh_config`。默认保留同名插件配置；只有明确要求时才使用
`overwrite=true`。

高级 OpenSSH 选项 `ProxyJump`、`ProxyCommand` 和 `CertificateFile` 可以被识别，
但当前 ssh2 连接后端不会应用这些选项。导入结果会给出警告。使用这些能力的机器需要
后续改用 OpenSSH CLI 后端或配置可直连的主机。

如果设置了 `CODEX_SSH_CONFIG`，插件配置会使用该变量指定的绝对路径或 `~` 路径。
`CODEX_SSH_OPENSSH_CONFIG` 可以覆盖要导入的 OpenSSH 配置路径。

## 3. 通过 Codex 添加和删除机器

如果别名已经存在于 `~/.ssh/config`，可以直接说：

```text
通过 Codex SSH 添加机器 prod
```

Codex 会调用 `ssh_add_host`，使用 OpenSSH 配置中已有的 HostName、用户名、端口和
密钥/Agent 设置。

每台机器都有一个稳定的 ASCII `alias` 和一个可读的 `displayName`。中文、空格和
常见 Unicode 字符用于 `displayName`：

```text
通过 Codex SSH 把 prod 的名称设置为“生产服务器 A”
```

对应工具为 `ssh_set_display_name`。这不会改变连接配置或后续操作使用的稳定 alias。

如果机器不在 `~/.ssh/config`，可以明确提供非敏感参数：

```text
通过 Codex SSH 添加 lab，主机 10.0.0.30，用户 deploy，使用 ~/.ssh/id_ed25519，
默认目录 /srv/app
```

删除机器配置：

```text
从 Codex SSH 删除机器 lab
```

对应工具为 `ssh_remove_host`。它只删除 `~/.codex-ssh/servers.json` 中的插件配置，
**不会修改 `~/.ssh/config`，也不会撤销服务器上的 SSH 权限**。

密码可以直接保存在本地插件配置中。Codex 调用工具时只需要主机别名；MCP 服务在本地
读取密码并建立连接，不会把密码放入工具结果、主机列表或错误信息。

如果用户明确接受明文密码出现在聊天中，可以直接提供密码。Codex 会把它作为
`ssh_add_host.password` 或 `ssh_set_host_password.password` 写入本地配置。密码会出现在
该工具调用记录中，但不会出现在工具返回值、主机列表或错误信息里。

已有主机可以直接说：

```text
把 lm2 的 SSH 密码设置为下面的明文密码：...
```

## 4. 手动配置

自动导入之外，也可以运行 `npm run init-config` 生成示例配置，或者直接编辑：

```text
C:\Users\<用户名>\.codex-ssh\servers.json
```

最小配置示例：

```json
{
  "hosts": {
    "prod": {
      "displayName": "生产服务器 A",
      "host": "10.0.0.20",
      "port": 22,
      "username": "deploy",
      "auth": {
        "type": "privateKey",
        "privateKeyPath": "~/.ssh/id_ed25519"
      },
      "defaultCwd": "/srv/app"
    }
  }
}
```

支持三种认证方式：

```json
{
  "auth": {
    "type": "privateKey",
    "privateKeyPath": "~/.ssh/id_ed25519",
    "passphrase": "本地保存的私钥口令"
  }
}
```

```json
{
  "auth": {
    "type": "password",
    "password": "本地保存的服务器密码"
  }
}
```

```json
{
  "auth": {
    "type": "agent",
    "agentSocket": "~/.1password/agent.sock"
  }
}
```

私钥内容本身也可以直接保存在配置中，此时不需要 `privateKeyPath`：

```json
{
  "auth": {
    "type": "privateKey",
    "privateKey": "-----BEGIN OPENSSH PRIVATE KEY-----\n...\n-----END OPENSSH PRIVATE KEY-----",
    "passphrase": "本地保存的私钥口令"
  }
}
```

仍然兼容环境变量方式，使用 `passwordEnv` 或 `passphraseEnv` 即可。若同时配置内联值和
环境变量名，内联值优先。

`agentSocket` 可省略。Windows 默认使用 OpenSSH Agent 的命名管道，其他平台默认读取
`SSH_AUTH_SOCK`。

插件写入 `servers.json` 时会使用 `0600` 权限；Windows 上则依赖用户配置目录的 NTFS
继承权限。不要把该文件提交到 Git、云盘共享目录或插件源码目录。

插件工具不会返回认证字段，但这不是操作系统级隔离。如果 Codex 的其他本地文件或终端
工具拥有用户目录读取权限，理论上仍能读取该文件。需要更强隔离时，应限制 Codex 的本地
文件系统访问，或使用独立操作系统账户和系统凭据存储。

## 5. 主机密钥

默认 `hostKeyPolicy` 为 `tofu`：首次连接时把 SHA256 指纹写入
`~/.codex-ssh/known_hosts.json`，后续连接必须匹配同一指纹。

固定已知指纹：

```json
{
  "hostKeyPolicy": "pinned",
  "hostFingerprint": "SHA256:xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
}
```

只有明确接受风险时才使用：

```json
{
  "hostKeyPolicy": "insecure"
}
```

服务器重装或更换主机密钥后，先独立核实新指纹，再修改 known-host 记录或固定指纹。

## 6. 命令与权限限制

每个主机可以设置：

```json
{
  "allowExec": true,
  "allowWrite": true,
  "commandPolicy": {
    "allowedPatterns": ["^(pwd|uptime|df -h)$"],
    "deniedPatterns": ["(^|\\s)rm\\s+-rf\\s+/(\\s|$)"]
  },
  "connectTimeoutMs": 15000,
  "commandTimeoutMs": 60000,
  "maxOutputBytes": 262144,
  "maxFileBytes": 8388608
}
```

`allowedPatterns` 非空时，命令必须匹配其中一个正则。`deniedPatterns` 命中时拒绝执行。
这些正则只做输入防护，不能替代系统权限、SSH 账号权限或 Codex 审批机制。

项目 `.codex/config.toml` 已把该插件工具设为 `prompt`：

```toml
[plugins."codex-ssh@skaduv".mcp_servers.ssh]
enabled = true
default_tools_approval_mode = "prompt"
```

## 7. 在 Codex 中启用

1. 完成 `npm install`。
2. 重启 Codex 桌面应用，使其重新扫描仓库市场 `.agents/plugins/marketplace.json`。
3. 在 Plugins 中打开 `Codex SSH` 市场，安装或启用同名插件。
4. 新建对话，输入“列出 SSH 主机并测试 prod 连接”，或明确要求 Codex 使用
   Codex SSH。首次启动会自动导入 OpenSSH 配置。

也可以在 Codex CLI 中检查：

```powershell
codex mcp list
codex plugin marketplace list
```

若通过仓库市场安装，Codex 会把本地插件放入其插件缓存。修改当前开发目录后，需要
刷新市场或重新安装，再开始新会话。

如果命令行安装返回 Windows `Access Denied (os error 5)`，通常是 Codex 桌面应用
正在占用插件状态。可以先重启应用后从 Plugins 页面安装；或者完全退出 Codex 后运行：

```powershell
codex plugin add codex-ssh@skaduv
```

再重新打开 Codex。公开仓库市场名称为 `skaduv`。

## 8. 卸载插件

直接在 Codex 中说：

```text
卸载 Codex SSH 插件
```

插件会调用 `ssh_uninstall_plugin`，由独立临时进程完成清理：

1. 等待当前 MCP 调用返回。
2. 只结束加载了 Codex SSH 缓存的 Node/MCP 进程。
3. 调用官方 `codex plugin remove codex-ssh@skaduv` 命令。
4. Windows 文件仍被占用时自动重试。
5. 删除当前项目中仅用于启用 Codex SSH 的 TOML 配置。
6. 默认保留 `~/.codex-ssh/servers.json` 和主机指纹。

也可以从本地源码执行：

```powershell
cd E:\tihu
node E:\tihu\plugins\codex-ssh\scripts\uninstall.mjs --project-root E:\tihu
```

如果明确要同时删除全部主机配置和 known-host 记录：

```powershell
node E:\tihu\plugins\codex-ssh\scripts\uninstall.mjs --project-root E:\tihu --delete-host-config
```

卸载日志：

```text
%TEMP%\codex-ssh-uninstall.log
```

卸载只会移除插件安装缓存。源码目录 `E:\tihu\plugins\codex-ssh` 和本地市场条目仍会保留。

## 开发验证

```powershell
npm run check
```

测试会启动真正的 MCP stdio 服务，验证初始化、工具目录和未知主机错误；不会连接外部
SSH 服务器。
