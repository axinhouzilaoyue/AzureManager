# Azure VM 管理面板

这是一个部署在 Cloudflare Workers 上的 Azure VM 管理面板，用来管理测试订阅下的 Azure 虚拟机。

## 安装

安装前请准备：

- Cloudflare 账号
- GitHub 或 GitLab 仓库
- 一个 Azure 测试订阅
- 一个可用的 Azure Service Principal
- `client_id`
- `client_secret`
- `tenant_id`
- `subscription_id`

### 1. 创建 D1 数据库

进入 Cloudflare Dashboard：

`Storage & Databases` -> `D1`

创建一个新的数据库，例如 `azure-panel-cf`。

### 2. 初始化数据库

打开刚创建的 D1 数据库，在 SQL 控制台执行这个文件里的全部 SQL：

- `migrations/dashboard_init.sql`

### 3. 导入仓库

进入 Cloudflare Dashboard：

`Workers & Pages` -> `Create application` -> `Import a repository`

连接 GitHub 或 GitLab，选择当前仓库并完成导入。

### 4. 绑定数据库

进入 Worker：

`Settings` -> `Bindings` -> `Add binding`

添加 D1 绑定：

- Binding name: `DB`
- Database: 选择上一步创建的 D1 数据库

保存后重新部署。

### 5. 配置 Secrets

进入：

`Settings` -> `Variables and Secrets`

添加：

- `SESSION_SECRET`
- `ACCOUNT_ENCRYPTION_KEY`

如果需要项目内置密码登录，再额外添加：

- `APP_PASSWORD`

保存后重新部署。

### 6. 首次使用

打开 Cloudflare 分配的地址。

如果配置了 `APP_PASSWORD`，先登录，然后添加 Azure 账户并填写：

- `client_id`
- `client_secret`
- `tenant_id`
- `subscription_id`

检查通过后保存即可开始使用。
