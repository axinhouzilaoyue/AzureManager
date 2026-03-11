# Azure VM 管理面板

这是一个部署在 Cloudflare Workers 上的 Azure VM 管理面板，用来管理测试订阅下的 Azure 虚拟机。

本项目是对 https://github.com/SIJULY/azure/blob/main/README.md 进行了cf部署的改造。感谢原作者的付出！！


## 安装

安装前请准备：

- Cloudflare 账号
- 一个你自己可访问的 GitHub 或 GitLab 仓库副本
- 一个 Azure 测试订阅
- 一个可用的 Azure Service Principal
- `client_id`
- `client_secret`
- `tenant_id`
- `subscription_id`

### 1. 导入仓库并首次部署

进入 Cloudflare Dashboard：

`Workers & Pages` -> `Create application` -> `Import a repository`

连接 GitHub 或 GitLab，选择当前仓库并完成导入。

本项目的 `wrangler.jsonc` 已声明 `DB` 这个 D1 绑定，首次部署时 Cloudflare 会按 Worker 配置自动创建或链接对应资源。

如果你不想让后续每次 Git push 都自动触发 Cloudflare build/deploy，首次部署成功后进入：

`Settings` -> `Builds` -> `Disconnect`

### 2. 初始化数据库

首次部署成功后，进入：

`Storage & Databases` -> `D1`

找到当前 Worker 自动创建或绑定的数据库，然后在 SQL 控制台执行这个文件里的全部 SQL：

- `database/init.sql`

如果你在 D1 列表里一时无法确认是哪一个数据库，也可以进入 Worker 的：

`Settings` -> `Bindings`

确认 `DB` 绑定指向的具体数据库。

### 3. 配置运行时变量

进入：

`Settings` -> `Variables and Secrets`

添加：

- `SESSION_SECRET`
- `ACCOUNT_ENCRYPTION_KEY`
- `APP_PASSWORD`

这 3 个值都是部署时在 Cloudflare 后台配置，不是在网页登录时输入。
本项目已启用 `keep_vars: true`，后续重新部署时会保留你在 Dashboard 中手动添加的普通 Variables。

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

保存后重新部署。

### 4. 首次使用

打开 Cloudflare 分配的地址。

先使用 `APP_PASSWORD` 登录，然后添加 Azure 账户并填写：

- `client_id`
- `client_secret`
- `tenant_id`
- `subscription_id`

检查通过后保存即可开始使用。
