# Azure VM 管理面板（Cloudflare Workers）

这是一个运行在 Cloudflare Workers 上的 Azure VM 管理面板，前端静态资源、后端 API、D1、Durable Objects 和 Workflows 都在同一个 Workers 项目里。

项目主要面向测试订阅，不建议直接拿去管理生产 Azure 资源。

## 这个项目为什么不用 Pages？

这个仓库不是“纯静态站点 + 一点点函数”，而是完整的 Worker 应用，当前依赖了：

- D1：保存 Azure 账户、任务、日志和审计信息
- Durable Objects：对同一个 Azure 订阅加锁，避免并发写操作互相打架
- Workflows：执行创建 VM、启停 VM、更换 IP 这类长耗时任务
- Workers Assets：托管前端页面

如果改成 Cloudflare Pages，静态页面虽然能放上去，但 Durable Objects 和 Workflows 仍然需要单独的 Worker。对这个项目来说，Pages 不会更简单，反而会把一套部署拆成两套。

## Cloudflare 里的几个核心组件分别是干嘛的？

### D1

D1 是这个项目的数据库，主要存下面这些内容：

- 已保存的 Azure 账户信息
- 任务状态
- 任务日志
- 审计记录
- 全局默认开机脚本

### Durable Objects

本项目里的 Durable Object 是 `SUBSCRIPTION_LOCK`，它的作用很单一：对同一个 Azure 订阅的写操作做串行化。

例如下面这些操作不能同时对同一个订阅乱跑：

- 创建虚拟机
- 删除资源组
- 更换公网 IP
- 启动 / 停止 / 重启虚拟机

如果没有这层锁，两个写操作同时打到 Azure，状态很容易乱。

### Workflows

Workflows 用来处理“耗时长、可能失败、需要重试、不能让浏览器一直挂着等”的任务。

本项目里主要有 3 个 Workflow：

- `create-vm-workflow`
- `vm-lifecycle-workflow`
- `change-ip-workflow`

它们的作用是把 Azure 写操作拆成可恢复、可重试、可查询状态的后台流程。前端提交任务后，不需要一直卡在一个 HTTP 请求里等 Azure 返回。

## 仓库安全说明

当前仓库文件中不包含：

- Azure 凭据
- Cloudflare secrets
- 本地 `.dev.vars`
- 本地 `.env`

请把敏感信息放到 Cloudflare Secrets 或你本地未跟踪的 `.dev.vars` 里，不要直接写进仓库。

## 目录结构

- `public/`：前端静态资源
- `src/index.ts`：Worker 入口和 API 路由
- `src/durable/`：订阅级锁
- `src/workflows/`：长耗时任务
- `src/lib/azure/`：Azure OAuth 和 ARM REST 调用
- `migrations/`：D1 表结构
- `wrangler.jsonc`：Cloudflare Workers 部署配置

## 部署前准备

你需要准备以下内容：

### 1. Cloudflare 侧

- 一个 Cloudflare 账号
- 一个 Workers 项目
- 一个 D1 数据库

### 2. Azure 侧

- 一个测试用 Azure 订阅
- 一个有权限的 Service Principal

需要的 4 个值：

- `client_id`
- `client_secret`
- `tenant_id`
- `subscription_id`

建议至少在测试订阅上给这个 Service Principal 足够的资源管理权限。按当前实现，`Contributor` 是比较实际的下限。

## 中文详细部署教程

下面这套流程是最确定、最少猜测的部署方式：直接按 Workers 项目部署。

### 第 1 步：安装依赖

```bash
npm install
```

### 第 2 步：创建 D1 数据库

```bash
npx wrangler d1 create azure-panel-cf
```

执行后会返回数据库 ID。把返回值填进 `wrangler.jsonc` 里的这两个字段：

- `database_id`
- `preview_database_id`

对应位置在 `d1_databases` 配置下。

### 第 3 步：检查 `wrangler.jsonc`

当前项目里的关键配置已经基本写好，通常只需要确认这些项目：

- `name`
- `assets.directory`
- `d1_databases`
- `durable_objects.bindings`
- `migrations`
- `workflows`

你不需要改动 Durable Objects 和 Workflows 的类名，除非你真的在改代码实现。

### 第 4 步：配置 Cloudflare Secrets

必填：

```bash
npx wrangler secret put SESSION_SECRET
npx wrangler secret put ACCOUNT_ENCRYPTION_KEY
```

可选：

```bash
npx wrangler secret put APP_PASSWORD
```

说明：

- `SESSION_SECRET`：用于签名登录态
- `ACCOUNT_ENCRYPTION_KEY`：用于加密保存 Azure `client_secret`
- `APP_PASSWORD`：仅在你要使用项目内置密码登录时才需要

如果你准备用 Cloudflare Access 保护这个面板，那么 `APP_PASSWORD` 可以不配。

### 第 5 步：初始化数据库表

```bash
npx wrangler d1 migrations apply azure-panel-cf --local
npx wrangler d1 migrations apply azure-panel-cf --remote
```

本项目当前 migration 会创建：

- `accounts`
- `tasks`
- `task_logs`
- `audit_events`
- `app_settings`

### 第 6 步：部署 Worker

```bash
npx wrangler deploy
```

部署完成后，Cloudflare 会给你一个 Worker 地址。

### 第 7 步：打开面板并完成首次配置

打开部署地址后：

1. 如果配置了 `APP_PASSWORD`，先用它登录
2. 添加 Azure 账户
3. 填入 `client_id`、`client_secret`、`tenant_id`、`subscription_id`
4. 点击“检查账户”
5. 检查通过后保存
6. 选择账户
7. 再去创建 VM、查询 VM、执行启停或换 IP

### 第 8 步：验证部署是否正常

至少检查这几件事：

- `/health` 能返回成功
- 能正常登录
- 能保存 Azure 账户
- “检查账户”可以通过
- 可以拉到区域列表
- 可以读到现有 VM 或正常创建新 VM

## Azure 信息怎么准备？

### 获取 `subscription_id` 和 `tenant_id`

```bash
az login
az account show --query "{subscriptionId:id, tenantId:tenantId, subscriptionName:name}" --output json
```

### 创建 Service Principal

```bash
SUBSCRIPTION_ID="$(az account show --query id --output tsv)"

az ad sp create-for-rbac \
  --name "azure-panel-cf" \
  --role "Contributor" \
  --scopes "/subscriptions/$SUBSCRIPTION_ID"
```

返回结果里常见字段映射关系：

- `appId` -> `client_id`
- `password` -> `client_secret`
- `tenant` -> `tenant_id`

而 `subscription_id` 就是你当前 Azure 订阅 ID。

### 生成 `ACCOUNT_ENCRYPTION_KEY`

`ACCOUNT_ENCRYPTION_KEY` 需要是一个 base64url 编码的 32 字节密钥。

可直接用下面的命令生成：

```bash
node -e "const bytes=require('node:crypto').randomBytes(32); console.log(bytes.toString('base64url'))"
```

## 本地开发

### 1. 复制本地变量模板

```bash
cp .dev.vars.example .dev.vars
```

### 2. 填入本地变量

`.dev.vars.example` 里已经给了模板字段：

- `SESSION_SECRET`
- `ACCOUNT_ENCRYPTION_KEY`
- `APP_PASSWORD`（可选）

### 3. 启动本地开发

```bash
npm run dev
```

如果你修改了 `wrangler.jsonc` 里的 bindings，再执行一次：

```bash
npm run cf:typegen
```

## 验证命令

```bash
npm run test
npm run typecheck
npx wrangler deploy --dry-run --outdir /tmp/azure-panel-cf-dryrun
```

## 一句话总结

这个项目的正确部署目标是 Cloudflare Workers，不是 Cloudflare Pages。Pages 对这种“前端 + API + D1 + Durable Objects + Workflows”一体项目并不会更简单。
