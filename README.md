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
- 查看订阅下的虚拟机列表
- 创建、启动、停止、重启虚拟机
- 更换虚拟机公网 IP
- 删除资源组
- 全局默认开机脚本（User Data）
- 后台任务状态跟踪

## 安全说明

- `ACCOUNT_ENCRYPTION_KEY` 用于加密存储 Azure `client_secret`，请妥善保管，**修改后已有数据无法解密**
- 建议在反向代理（nginx/caddy）后面运行并启用 HTTPS
- `SESSION_SECRET` 修改后，已有登录会话会失效
