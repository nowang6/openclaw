# OpenClaw 中文使用指南

本指南将带你从零开始，完成 OpenClaw 的安装、配置，并设置局域网访问。

## 目录

1. [前置条件](#前置条件)
2. [安装 OpenClaw](#安装-openclaw)
3. [初始配置（Onboarding）](#初始配置onboarding)
4. [启动 Gateway](#启动-gateway)
5. [配置局域网访问](#配置局域网访问)
6. [验证和访问](#验证和访问)
7. [故障排查](#故障排查)

---

## 前置条件

在开始之前，请确保满足以下要求：

- **Node.js ≥ 22**：运行 `node --version` 检查版本
- **操作系统**：
  - macOS / Linux：直接支持
  - Windows：需要使用 WSL2（强烈推荐）
- **网络**：能够访问互联网（用于安装和 OAuth 认证）

### 检查 Node.js 版本

```bash
node --version
```

如果版本低于 22，请先升级 Node.js：
- macOS: `brew install node@22` 或从 [nodejs.org](https://nodejs.org/) 下载
- Linux: 使用 nvm 或包管理器安装 Node 22+

---

## 安装 OpenClaw

### 方法 1：使用官方安装脚本（推荐）

```bash
curl -fsSL https://openclaw.bot/install.sh | bash
```

### 方法 2：使用 npm/pnpm 全局安装

```bash
npm install -g openclaw@latest
# 或
pnpm add -g openclaw@latest
```

### 验证安装

```bash
openclaw --version
```

如果显示版本号，说明安装成功。

---

## 初始配置（Onboarding）

运行配置向导，完成初始设置：

```bash
openclaw onboard --install-daemon
```

### 配置向导会引导你完成：

1. **Gateway 模式**：选择 `Local`（本地运行）
2. **认证方式**：
   - **Anthropic（推荐）**：输入 API Key，或使用 `claude setup-token` 生成的 token
   - **OpenAI**：OAuth 或 API Key
3. **Gateway Token**：向导会自动生成一个 token（用于认证）
4. **聊天渠道**（可选）：
   - WhatsApp：需要扫描二维码
   - Telegram：需要 Bot Token
   - Discord：需要 Bot Token
5. **后台服务**：选择安装为系统服务（systemd/launchd）

### 重要提示

- Gateway token 会自动生成并保存在配置中
- 如果选择安装后台服务，Gateway 会在系统启动时自动运行
- 认证信息保存在 `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`

---

## 启动 Gateway

### 检查服务状态

如果已安装后台服务，检查是否运行：

```bash
openclaw gateway status
```

### 如果服务未运行，启动它：

```bash
openclaw gateway start
```

### 手动运行（前台模式，用于调试）

```bash
openclaw gateway --port 18789 --verbose
```

### 验证 Gateway 运行

```bash
openclaw health
openclaw status
```

预期输出应显示 Gateway 正常运行。

---

## 配置局域网访问

默认情况下，Gateway 只监听 `127.0.0.1`（localhost），只能从本机访问。要允许局域网内其他设备访问，需要将绑定模式改为 `lan`。

### 步骤 1：设置绑定模式

```bash
openclaw config set gateway.bind lan
```

### 步骤 2：验证配置

```bash
openclaw config get gateway.bind
```

应该返回 `lan`。

### 步骤 3：确认 Token 已配置

非 loopback 绑定必须使用认证。检查 token 是否已配置：

```bash
openclaw config get gateway.auth.token
```

如果返回为空，需要生成并设置 token：

```bash
# 生成随机 token
TOKEN=$(openssl rand -hex 32)
openclaw config set gateway.auth.token $TOKEN
echo "Gateway token: $TOKEN"
```

### 步骤 4：重启 Gateway 服务

```bash
openclaw gateway restart
```

### 步骤 5：验证服务状态

等待几秒后检查服务是否正常运行：

```bash
sleep 3
openclaw gateway status
lsof -nP -iTCP:18789 -sTCP:LISTEN
```

预期结果：
- `openclaw gateway status` 显示 `bind=lan (0.0.0.0)` 和 `Runtime: running`
- `lsof` 显示监听在 `*:18789` 或 `0.0.0.0:18789`

---

## 验证和访问

### 获取访问链接

运行以下命令获取带 token 的访问链接：

```bash
openclaw dashboard
```

这会输出类似以下的内容：

```
Dashboard URL: http://127.0.0.1:18789/?token=your-token-here
```

### 访问方式

#### 本地访问（本机）

- 直接访问：`http://127.0.0.1:18789/`
- 带 token：`http://127.0.0.1:18789/?token=<your-token>`

#### 局域网访问（其他设备）

1. **获取本机 LAN IP**：

   ```bash
   # Linux/macOS
   ip addr show | grep "inet " | grep -v 127.0.0.1
   # 或
   hostname -I

   # macOS 也可以使用
   ifconfig | grep "inet " | grep -v 127.0.0.1
   ```

2. **访问地址**：
   - 使用 LAN IP：`http://<LAN-IP>:18789/`
   - 带 token：`http://<LAN-IP>:18789/?token=<your-token>`

   例如：`http://192.168.1.100:18789/?token=your-token-here`

3. **在浏览器中打开**：
   - 首次访问时，token 会通过 URL 参数传递
   - 浏览器会自动保存 token 到 localStorage
   - 之后访问时无需再次输入 token

### 在 Control UI 中手动设置 Token

如果 URL 参数方式不工作，可以在页面中手动设置：

1. 打开 Dashboard 页面
2. 找到 "Gateway Access" 或 "Settings" 区域
3. 在 "Gateway Token" 输入框中粘贴 token
4. 点击 "Connect" 按钮

---

## 安全注意事项

⚠️ **重要安全提示**：

1. **认证必须启用**：
   - 非 loopback 绑定（`lan`、`tailnet` 等）必须配置 token 或 password
   - 不要在没有认证的情况下暴露 Gateway 到网络

2. **防火墙配置**：
   - 建议配置防火墙规则，只允许可信网络访问端口 18789
   - Linux 示例（ufw）：
     ```bash
     sudo ufw allow from 192.168.1.0/24 to any port 18789
     ```

3. **不要暴露到公网**：
   - 除非使用 Tailscale 或其他 VPN 方案
   - 不要将 Gateway 直接暴露到互联网

4. **Token 安全**：
   - 不要将 token 提交到版本控制系统
   - 定期轮换 token（生成新 token 并更新配置）

---

## 故障排查

### Gateway 无法启动

1. **检查配置**：
   ```bash
   openclaw gateway status
   openclaw doctor
   ```

2. **查看日志**：
   ```bash
   openclaw logs --follow
   # 或 systemd 服务日志
   journalctl --user -u openclaw-gateway.service -n 50 --no-pager
   ```

3. **常见问题**：
   - `gateway.mode` 未设置：运行 `openclaw config set gateway.mode local`
   - Token 缺失：运行 `openclaw config set gateway.auth.token <token>`
   - 端口被占用：检查 `lsof -nP -iTCP:18789`

### 无法从局域网访问

1. **检查绑定模式**：
   ```bash
   openclaw config get gateway.bind
   ```
   应该返回 `lan`。

2. **检查监听地址**：
   ```bash
   lsof -nP -iTCP:18789 -sTCP:LISTEN
   ```
   应该显示 `*:18789` 或 `0.0.0.0:18789`。

3. **检查防火墙**：
   ```bash
   # Linux (ufw)
   sudo ufw status

   # Linux (firewalld)
   sudo firewall-cmd --list-all
   ```

4. **检查网络连接**：
   - 确认设备在同一局域网
   - 尝试 ping 网关主机的 IP
   - 检查路由表

### 认证失败

1. **检查 token 配置**：
   ```bash
   openclaw config get gateway.auth.token
   ```

2. **重新生成 token**：
   ```bash
   TOKEN=$(openssl rand -hex 32)
   openclaw config set gateway.auth.token $TOKEN
   openclaw gateway restart
   echo "New token: $TOKEN"
   ```

3. **使用带 token 的 URL**：
   ```bash
   openclaw dashboard
   ```

### 其他问题

运行完整诊断：

```bash
openclaw status --all
openclaw health
openclaw security audit --deep
```

---

## 回滚到本地访问

如果需要回退到仅本地访问（loopback 模式）：

```bash
openclaw config set gateway.bind loopback
openclaw gateway restart
```

---

## 其他绑定模式

OpenClaw Gateway 支持以下绑定模式：

- **`loopback`**：仅监听 `127.0.0.1`（本地访问，默认）
- **`lan`**：监听 `0.0.0.0`（所有网络接口，局域网访问）
- **`tailnet`**：监听 Tailscale IP（仅 Tailscale 网络）
- **`auto`**：自动选择（优先 loopback，不可用时使用 lan）
- **`custom`**：自定义 IP 地址（需要设置 `gateway.customBindHost`）

---

## 下一步

配置完成后，你可以：

1. **连接聊天渠道**：
   ```bash
   openclaw channels login  # WhatsApp
   ```

2. **发送测试消息**：
   ```bash
   openclaw message send --target +15555550123 --message "Hello"
   ```

3. **查看状态**：
   ```bash
   openclaw status
   openclaw channels status
   ```

4. **探索更多功能**：
   - [官方文档](https://docs.openclaw.ai)
   - [快速开始指南](https://docs.openclaw.ai/start/getting-started)
   - [Gateway 配置](https://docs.openclaw.ai/gateway/configuration)
   - [故障排查](https://docs.openclaw.ai/gateway/troubleshooting)

---

## 相关资源

- **官方网站**：https://openclaw.ai
- **文档中心**：https://docs.openclaw.ai
- **GitHub**：https://github.com/openclaw/openclaw
- **Discord 社区**：https://discord.gg/clawd

---

## 常见命令速查

```bash
# 安装
npm install -g openclaw@latest

# 初始配置
openclaw onboard --install-daemon

# 服务管理
openclaw gateway status
openclaw gateway start
openclaw gateway stop
openclaw gateway restart

# 配置管理
openclaw config set gateway.bind lan
openclaw config get gateway.bind
openclaw config set gateway.auth.token <token>

# 状态检查
openclaw status
openclaw health
openclaw gateway status

# 诊断
openclaw doctor
openclaw logs --follow

# 访问 Dashboard
openclaw dashboard
```

---
