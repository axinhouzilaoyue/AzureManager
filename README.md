# Azure VM Management Panel

Azure 虚拟机管理面板，运行在 Docker 容器中，支持管理多个 Azure 订阅下的虚拟机。

## 快速部署

推送到 `main` 分支后，GitHub Actions 会自动构建并推送镜像到 `ghcr.io`，支持 `amd64` 和 `arm64`。

### 1. 启动

```bash
docker run -d \
  --name azure-manager \
  --restart unless-stopped \
  -p 8080:8080 \
  -v $(pwd)/data:/app/data \
  -e APP_PASSWORD="your-login-password" \
  ghcr.io/axinhouzilaoyue/azure-manager:latest
```

访问 `http://localhost:8080`，使用 `APP_PASSWORD` 登录。

首次启动时，加密密钥会自动生成并保存到 `data/.secret`，无需手动配置。

### 更新镜像

```bash
docker pull ghcr.io/axinhouzilaoyue/azure-manager:latest
docker stop azure-manager && docker rm azure-manager
# 重新执行上面的 docker run 命令
```

## 迁移

复制整个 `data/` 目录到新机器即可，其中包含数据库和自动生成的加密密钥，无需额外配置。

## 功能

- 管理多个 Azure Service Principal 账户
- 常驻账户列表（264px）与全宽 VM 工作台
- 账户行只展示邮箱与剩余天数（不再显示 `VPS:n 台`）；添加账户只有账户栏一个入口
- 「如何获取凭据」是添加账户弹窗的页签，不再单独占一个弹窗
- VM 列表用颜色圆点表示状态，虚拟机操作收进单个「操作」浮窗菜单
- 账户摘要为单行统计条：AI 配额层级、本月消费、累计消费，以及这三个数字的最后查询时间
- 账户摘要条末尾的纯图标按钮一次刷新 **AI 配额 + 本月/累计消费**（不动虚拟机）
- 账户列表头部有「刷新全部账户」按钮：一次刷新所有账户的订阅信息、配额、消费与虚拟机
- 账户头部把身份、指标与操作合并为一张卡片：「刷新全部」「创建虚拟机」「账户详情」
- 消费类提示（如"已沿用上一次成功结果"）只在发生时短暂显示，不会常驻
- 点击“账户详情”后弹窗查看 Client ID、Tenant ID、Subscription ID 和 Client Secret
- 编辑账户可修改**全部**字段：邮箱/展示名、到期日、客户端 ID、租户 ID、订阅 ID、客户端密钥（留空表示不改）
- 账户 JSON 导入、导出、搜索、排序和拖动排序
- 查看订阅成本、累计消费和 AI 配额层级，并对无权限状态给出明确提示
- 查看订阅下的虚拟机列表和系统盘大小
- 创建、启动、停止、重启虚拟机
- 创建 VM 时只列出该订阅**真正可用**的区域：排除地理组（`United States`、`Europe`、`Asia` 等聚合名）与 `Microsoft.Compute` 不可用的区域，
  并应用订阅上 Azure Policy 的「允许位置」限制；`Audit` / `DoNotEnforce` 的赋值不参与过滤。下拉框下方会说明排除了哪些区域、为什么
- 更换虚拟机公网 IP，并保留原 IP 的 SKU 和分配模式
- 删除资源组
- 支持 Ubuntu 24.04/22.04/20.04、Debian 12/11、CentOS 8
- 支持自定义 VM 名称、管理员用户名、密码、磁盘大小和磁盘类型
- 支持全局 SSH 公钥、用户名和加密密码
- 支持自动创建 NSG 和配置端口规则
- 全局默认开机脚本（User Data）
- 后台任务状态跟踪
- 账户切换后只显示该账户的虚拟机（账户身份随请求显式传递，见下）

## 账户切换与并发（重要）

账户身份**只**来自请求路径（`/api/accounts/:accountId/...`），不来自会话 Cookie。
服务端在响应体里回声 `accountId`，前端 `api()` 校验两者一致后才接受数据。

这样做的原因：会话 Cookie 是可变的带外状态，`POST /api/session` 与数据请求是两次独立往返，
并发或重排时会出现「Cookie 已指向 A，但用户在看 B」，从而把 A 的虚拟机画在 B 的标题下。

- 旧接口 `GET /api/vms`、`POST /api/vm-action`、`POST /api/vm-change-ip`、`POST /api/create-vm`
  返回 **410 Gone**（不再提供按 Cookie 取账户的数据路径）。**升级后需刷新页面**。
- 替代接口：`GET /api/accounts/:accountId/vms`（信封 `{accountId, fetchedAt, items, cached, stale, warning}`）、
  `POST /api/accounts/:accountId/vm-action`、`POST /api/accounts/:accountId/vm-change-ip`、
  `POST /api/accounts/:accountId/create-vm`。
- `POST /api/session` 仍保留，但只用于记住「上次查看的账户」，不参与任何数据归属判断。
- 所有 `/api/**` 响应带 `Cache-Control: no-store` 与 `Vary: Cookie`，防止跨账户复用缓存。

性能：进程级 AAD token 复用 + 按账户的 VM 列表 TTL 缓存（默认 30s，失败时最多回退 120s）+ 同账户请求合并（single-flight）。
写操作（启动/停止/重启/删除/创建/换 IP）在**任务完成后**失效对应账户的缓存。

消费查询：失败不再让整块信息报错。Cost Management 在很多订阅类型上会拒绝"自定义时间段"的累计查询
（HTTP 400），所以：本月查询失败时回退到缓存值或以可读状态显示；若缓存结果来自**本月**则直接用
`累计 = 本月 + 缓存历史` 推算，跳过那次容易失败的第二次查询；累计值单调不回退。
未知的历史消费记为「未获取」而**不是** `0.00`，否则会被当成已知值而永久跳过累计查询。

可调环境变量：`VM_CACHE_TTL_MS`、`VM_CACHE_STALE_MS`、`AZURE_REQUEST_TIMEOUT_MS`、
`AZURE_TOKEN_TIMEOUT_MS`、`OVERVIEW_ACCOUNT_CONCURRENCY`、`BULK_REFRESH_CONCURRENCY`。

## 账户摘要条各字段含义

| 字段 | 含义 |
| --- | --- |
| AI 配额 | 订阅的 Azure OpenAI / Cognitive Services 付费层级（Tier 0 / Tier 1 / 未分配 / 不支持），来自 `Microsoft.CognitiveServices/quotaTiers` |
| 本月 | 当月至今的税前消费（`PreTaxCost` 求和，`timeframe: MonthToDate`） |
| 累计 | 从「订阅到期日往前一年」到今天这段时间的总消费 |
| 消费更新 | **只**表示上面几个金额最后一次成功实时查询的时间（不含配额） |
| 末尾 ⟳ | 一次刷新 AI 配额 + 本月/累计消费 |

> 历史消费（累计 − 本月）不再单独展示：它可以直接由「累计 − 本月」看出，
> 单列一格与累计重复。该值仍在服务端参与 `累计 = 本月 + 缓存历史` 的推算。

## 测试

```bash
bun run typecheck     # 类型检查
bun run test:regions  # 创建 VM 的区域解析：地理组/非 Compute 区域/Policy 限制过滤
bun run test:api      # 接口层回归：竞态复现、归属校验、缓存、single-flight、token 复用
bun run test:ui       # 浏览器端到端（需本机 Chrome；puppeteer-core 未安装则自动跳过）
```

两个测试都用 `tests/mock-azure.ts` 伪造 AAD/ARM，不需要 Azure 凭据：

- `tests/switch-race.ts` 用原始 TCP socket 让账户 A 的 `POST /api/session` 晚于 B 落地，
  **确定性**复现竞态，再断言 B 的数据请求仍返回 B 的虚拟机。
- `tests/switch-ui.ts` 在真实 Chrome 里点击账户卡片复现同样的竞态，
  断言表格只显示当前账户的虚拟机，并检查无前端异常。

## 安全说明

- 加密密钥自动生成并保存在 `data/.secret`，请勿删除此文件，否则已保存的 Azure 凭据将无法解密
- 建议在反向代理（nginx/caddy）后面运行并启用 HTTPS
- `APP_PASSWORD` 修改后需重启容器生效，已有登录会话会失效
