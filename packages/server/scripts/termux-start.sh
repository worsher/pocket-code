#!/bin/bash
# Pocket Code — Termux 启动脚本
cd "$(dirname "$0")/.."
echo "Starting Pocket Code Server..."
echo "Press Ctrl+C to stop"
echo ""
npx tsx src/index.ts
