# Azure VM 管理面板

这是一个部署在 Cloudflare Workers 上的 Azure VM 管理面板，用来管理测试订阅下的 Azure 虚拟机。

本项目是对 https://github.com/SIJULY/azure/blob/main/README.md 进行了cf部署的改造。感谢原作者的付出！！


## 推荐部署方式：Cloudflare Dashboard 手动部署

如果你只是自己用，推荐用 Cloudflare Dashboard 手动导入仓库部署。不要折腾 Deploy Hook，也不用依赖本地 `wrangler deploy`。

部署时只需要记住 4 件事：

| 配置项 | 在哪里配 | 必填值 |
| --- | --- | --- |
| D1 数据库 | `Storage & Databases` -> `D1` | 执行 `database/init.sql` |
| D1 绑定 | Worker `Settings` -> `Bindings` | Binding name: `DB` |
| 运行时变量和机密 | Worker `Settings` -> `Variables and Secrets` | `SESSION_SECRET`、`ACCOUNT_ENCRYPTION_KEY`、`APP_PASSWORD` |
| Git 构建配置 | Worker `Settings` -> `Builds` | Deploy command: `npx wrangler deploy` |

安装前请准备：

- Cloudflare 账号
- 一个你自己可访问的 GitHub 或 GitLab 仓库副本
- 一个 Azure 测试订阅
- 一个可用的 Azure Service Principal
- `client_id`
- `client_secret`
- `tenant_id`
- `subscription_id`

### 1. 创建 D1 数据库

进入 Cloudflare Dashboard：

`Storage & Databases` -> `D1`

创建一个新的数据库，名称可自定义。

建议名称：

- `azure-manager-db`

### 2. 初始化 D1 表结构

打开刚创建的 D1 数据库，在 SQL 控制台执行这个文件里的全部 SQL：

- `database/init.sql`

### 3. 导入仓库并部署 Worker

进入 Cloudflare Dashboard：

`Workers & Pages` -> `Create application` -> `Import a repository`

连接 GitHub 或 GitLab，选择当前仓库并完成导入。

推荐构建配置：

| 字段 | 值 |
| --- | --- |
| Production branch | 你要部署的分支，例如 `codex/ui-refresh` 或 `main` |
| Root directory | `/` |
| Build command | `npm ci` |
| Deploy command | `npx wrangler deploy` |
| Build watch paths | `*` |

如果你不想让后续每次 Git push 都自动部署，首次部署成功后可以进入：

`Settings` -> `Builds` -> `Disconnect`

断开 Git 连接不会删除 Worker、D1、变量或已经部署的代码。

### 4. 手动绑定 D1 数据库

进入刚创建好的 Worker：

`Settings` -> `Bindings`

添加一个 D1 绑定：

- Binding name: `DB`
- Database: 选择你刚才手动创建的 D1 数据库

保存配置即可；如果 Cloudflare 提示 `Save and deploy` 或“保存并部署”，点击确认。

### 5. 配置运行时变量和机密

进入：

`Settings` -> `Variables and Secrets`

添加：

- `SESSION_SECRET`
- `ACCOUNT_ENCRYPTION_KEY`
- `APP_PASSWORD`

这 3 个值都是部署时在 Cloudflare 后台配置，不是在网页登录时输入。
本项目已启用 `keep_vars: true`，后续重新部署时会保留你在 Dashboard 中手动添加的变量和机密。

可按下面方式生成：

- `SESSION_SECRET`

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

- `ACCOUNT_ENCRYPTION_KEY`

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

- `APP_PASSWORD`

自己设置一个登录密码即可，例如一段足够长的随机字符串。这个值就是后续网页登录时输入的密码。

注意：

- `SESSION_SECRET` 用于保持登录态，修改后所有用户都需要重新登录
- `ACCOUNT_ENCRYPTION_KEY` 用于加密保存 Azure `client_secret`，部署后不要随意修改，否则之前保存的账户密钥会无法解密

保存配置即可；如果 Cloudflare 提示 `Save and deploy` 或“保存并部署”，点击确认。

### 6. 检查绑定和部署状态

部署后检查 Worker 的 `Settings`：

- `Bindings` 里有 D1 绑定 `DB`
- `Variables and Secrets` 里有 `SESSION_SECRET`
- `Variables and Secrets` 里有 `ACCOUNT_ENCRYPTION_KEY`
- `Variables and Secrets` 里有 `APP_PASSWORD`
- `Compatibility flags` 里有 `nodejs_compat`

然后打开：

- `/health`

如果返回 `ok: true`，说明 Worker 本体已启动。

### 7. 首次使用

打开 Cloudflare 分配的地址。

先使用 `APP_PASSWORD` 登录，然后添加 Azure 账户并填写：

- `client_id`
- `client_secret`
- `tenant_id`
- `subscription_id`

检查通过后保存即可开始使用。

## 换 Cloudflare 账号部署时的注意事项

- D1 数据不会跨 Cloudflare 账号自动迁移。换账号等于新的空数据库，需要重新执行 `database/init.sql`。
- `ACCOUNT_ENCRYPTION_KEY` 只影响当前 D1 里保存的 Azure 密钥。新账号新 D1 可以生成新的值。
- 如果你要迁移旧 D1 数据，必须同时迁移旧的 `ACCOUNT_ENCRYPTION_KEY`，否则旧账户密钥无法解密。
- Git 自动部署、Deploy Hook、Builds API 都不是必需项。个人使用时，Dashboard 导入仓库并手动配置一次即可。
