# Azure VM Management Panel

Azure VM Management Panel 是一个运行在 Cloudflare Workers 上的轻量级 Azure 虚拟机管理面板，适用于个人或小规模测试订阅的虚拟机创建、状态查看和生命周期操作。

本项目基于 [SIJULY/azure](https://github.com/SIJULY/azure/blob/main/README.md) 的思路改造为 Cloudflare Workers 部署形态。

## 功能概览

- 管理多组 Azure Service Principal 凭据
- 检查订阅状态和可用区域
- 查询订阅下的虚拟机列表
- 创建虚拟机
- 启动、停止、重启虚拟机
- 更换虚拟机公网 IP
- 删除资源组
- 保存全局默认开机脚本
- 记录任务状态和任务日志

## 架构说明

| 组件 | 用途 |
| --- | --- |
| Cloudflare Worker | 提供 Web UI、API 路由和 Azure ARM API 调用 |
| Cloudflare Static Assets | 托管 `public/` 下的前端页面 |
| Cloudflare D1 | 保存账户、设置、任务状态和任务日志 |
| Cloudflare Workflows | 执行创建 VM、更换 IP、删除资源组等长任务 |
| Durable Object | 对同一 Azure 订阅下的长任务进行互斥控制 |

## 前置条件

部署前请准备：

- 一个 Cloudflare 账号
- 一个可导入 Cloudflare 的 GitHub 或 GitLab 仓库
- 一个 Azure 订阅
- 一个可访问该订阅的 Azure Service Principal

Azure 账户需要准备以下字段：

| 字段 | 说明 |
| --- | --- |
| `client_id` | Azure App / Service Principal 的应用 ID |
| `client_secret` | Service Principal 密钥 |
| `tenant_id` | Azure 租户 ID |
| `subscription_id` | Azure 订阅 ID |

## 部署方式

推荐使用 Cloudflare Dashboard 导入仓库部署。该方式不要求本地安装 Wrangler，也不需要配置 Deploy Hook 或 Builds API。

### 1. 创建 D1 数据库

进入 Cloudflare Dashboard：

`Storage & Databases` -> `D1` -> `Create database`

建议数据库名称：

```text
azure-manager-db
```

创建完成后，打开该 D1 数据库的 SQL 控制台，执行：

```text
database/init.sql
```

该 SQL 文件会创建账户、任务、任务日志、审计事件和应用设置相关表。

### 2. 导入仓库部署 Worker

进入 Cloudflare Dashboard：

`Workers & Pages` -> `Create application` -> `Import a repository`

选择当前仓库后，使用以下构建配置：

| 配置项 | 建议值 |
| --- | --- |
| Production branch | `main`，或当前需要部署的分支 |
| Root directory | `/` |
| Build command | `npm ci` |
| Deploy command | `npx wrangler deploy` |
| Build watch paths | `*` |

Worker 名称由 `wrangler.jsonc` 中的 `name` 字段控制，当前为：

```text
azure-manager
```

### 3. 绑定 D1 数据库

首次部署完成后，进入 Worker 设置：

`Settings` -> `Bindings`

添加 D1 绑定：

| 字段 | 值 |
| --- | --- |
| Binding name | `DB` |
| Database | 第 1 步创建的 D1 数据库 |

保存配置。如果 Cloudflare 提示 `Save and deploy`，确认保存并部署。

### 4. 配置运行时变量和机密

进入 Worker 设置：

`Settings` -> `Variables and Secrets`

添加以下运行时变量或机密：

| 名称 | 类型 | 说明 |
| --- | --- | --- |
| `SESSION_SECRET` | Secret | 用于签名登录会话 |
| `ACCOUNT_ENCRYPTION_KEY` | Secret | 用于加密保存 Azure `client_secret` |
| `APP_PASSWORD` | Secret | 管理面板登录密码 |

生成示例：

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

用于生成 `ACCOUNT_ENCRYPTION_KEY` 的值必须是 32 字节：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

`APP_PASSWORD` 可自行设置为一段足够长的随机字符串。

注意：

- `SESSION_SECRET` 修改后，已有登录会话会失效。
- `ACCOUNT_ENCRYPTION_KEY` 部署后不要随意修改；修改后，D1 中已保存的 Azure 密钥将无法解密。
- 这些是 Worker 运行时变量，不需要配置到 Builds 的构建时变量中。

### 5. 检查部署状态

部署完成后，检查 Worker 设置：

- `Bindings` 中存在 D1 绑定 `DB`
- `Variables and Secrets` 中存在 `SESSION_SECRET`
- `Variables and Secrets` 中存在 `ACCOUNT_ENCRYPTION_KEY`
- `Variables and Secrets` 中存在 `APP_PASSWORD`
- `Compatibility flags` 中存在 `nodejs_compat`

然后访问：

```text
/health
```

如果返回 `ok: true`，说明 Worker 已正常启动。

## 首次使用

打开 Worker 分配的访问地址。

1. 使用 `APP_PASSWORD` 登录管理面板。
2. 添加 Azure 账户。
3. 填写 `client_id`、`client_secret`、`tenant_id`、`subscription_id`。
4. 点击检查账户。
5. 检查通过后保存账户。
6. 选择账户后即可查询区域、查看虚拟机和执行操作。

## 重新部署

如需更新代码，有两种方式：

| 方式 | 说明 |
| --- | --- |
| Dashboard Git 部署 | 在 Cloudflare Dashboard 中保持仓库连接，推送代码后由 Cloudflare 构建部署 |
| 手动重新导入 | 在新 Cloudflare 账号中重新按部署步骤导入仓库 |

本项目已在 `wrangler.jsonc` 中启用：

```jsonc
"keep_vars": true
```

因此，后续通过 `wrangler deploy` 或 Cloudflare Builds 部署时，会尽量保留 Dashboard 中已配置的运行时变量和机密。

## 更换 Cloudflare 账号

更换 Cloudflare 账号时，建议按全新环境处理：

1. 在新账号中创建新的 D1 数据库。
2. 执行 `database/init.sql` 初始化表结构。
3. 导入仓库部署 Worker。
4. 重新绑定 D1。
5. 重新配置 `SESSION_SECRET`、`ACCOUNT_ENCRYPTION_KEY`、`APP_PASSWORD`。
6. 登录后重新添加 Azure 账户。

如果需要迁移旧 D1 数据，必须同时迁移旧的 `ACCOUNT_ENCRYPTION_KEY`。否则旧数据中的 Azure `client_secret` 无法解密。

## 安全说明

- 不要将 `SESSION_SECRET`、`ACCOUNT_ENCRYPTION_KEY`、`APP_PASSWORD` 写入 Git 仓库。
- 不要公开 Cloudflare Deploy Hook URL；URL 本身具有触发部署的权限。
- Azure Service Principal 建议只授予目标测试订阅所需权限。
- 删除资源组是高风险操作，请确认当前选择的 Azure 账户和资源组无误后再执行。

## 本地开发

安装依赖：

```bash
npm ci
```

类型检查：

```bash
npm run typecheck
```

本地开发：

```bash
npm run dev
```

部署：

```bash
npm run deploy
```
