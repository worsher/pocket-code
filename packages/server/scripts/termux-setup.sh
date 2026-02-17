#!/bin/bash
# Pocket Code — Termux 一键安装脚本
# 在 Termux 中运行此脚本安装 Server 环境

set -e

echo "=== Pocket Code Termux Setup ==="
echo ""

# 1. 安装依赖
echo "[1/4] 安装 Node.js 和 Git..."
pkg update -y
pkg install -y nodejs git

# 2. 安装 pnpm
echo "[2/4] 安装 pnpm..."
npm install -g pnpm

# 3. 克隆项目（如果尚未克隆）
INSTALL_DIR="$HOME/pocket-code"
if [ -d "$INSTALL_DIR" ]; then
    echo "[3/4] 项目已存在，更新代码..."
    cd "$INSTALL_DIR"
    git pull
else
    echo "[3/4] 克隆项目..."
    echo "请输入仓库地址（如 https://github.com/user/pocket-code.git）:"
    read -r REPO_URL
    git clone "$REPO_URL" "$INSTALL_DIR"
    cd "$INSTALL_DIR"
fi

# 4. 安装依赖
echo "[4/4] 安装 Server 依赖..."
cd "$INSTALL_DIR/packages/server"
pnpm install

# 5. 创建 .env（如果不存在）
if [ ! -f .env ]; then
    cp .env.example .env
    echo ""
    echo "已创建 .env 文件，请编辑填入 API Key："
    echo "  nano $INSTALL_DIR/packages/server/.env"
fi

echo ""
echo "=== 安装完成 ==="
echo ""
echo "启动 Server："
echo "  cd $INSTALL_DIR/packages/server && pnpm start"
echo ""
echo "或使用启动脚本："
echo "  bash $INSTALL_DIR/packages/server/scripts/termux-start.sh"
echo ""
echo "App 设置："
echo "  模式：极客模式"
echo "  工作区：Termux / Server"
echo "  Server 地址：ws://localhost:3100"
