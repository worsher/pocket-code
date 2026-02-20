#!/bin/bash
set -e

echo "=== Pocket Code 部署脚本 ==="

# 检查 .env 文件
if [ ! -f docker/.env ]; then
  echo "创建 docker/.env 文件..."
  cat > docker/.env << 'EOF'
# 必填 — 生产环境请更换
JWT_SECRET=CHANGE-THIS-TO-A-RANDOM-SECRET

# AI API Keys (至少填一个)
SILICONFLOW_API_KEY=
SILICONFLOW_BASE_URL=https://api.siliconflow.cn/v1
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
GOOGLE_GENERATIVE_AI_API_KEY=
EOF
  echo "请编辑 docker/.env 填入 API Keys 后重新运行此脚本"
  exit 1
fi

# 构建沙箱镜像
echo "构建 sandbox 镜像..."
docker build -t pocket-code-sandbox:latest -f docker/Dockerfile.sandbox .

# 启动服务
echo "启动服务..."
cd docker
docker compose up -d --build

echo ""
echo "=== 部署完成 ==="
echo "WebSocket: ws://$(hostname -I | awk '{print $1}'):3100"
echo "HTTP:      http://$(hostname -I | awk '{print $1}')"
echo ""
echo "SSL 设置步骤:"
echo "1. 将 nginx.conf 中的 server_name 改为你的域名"
echo "2. 运行: docker compose run certbot certonly --webroot -w /var/lib/letsencrypt -d your-domain.com"
echo "3. 取消 nginx.conf 中 SSL 相关的注释"
echo "4. 运行: docker compose restart nginx"
