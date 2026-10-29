#!/bin/bash
# Double-click launcher for Pi Lab in /Users/linlu/Desktop/pilab.
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd -P)"
export PORT=3000
export PI_CODING_AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
unset PI_LAB_GPT_WORKER PI_LAB_IMAGE_ROOT
URL="http://127.0.0.1:$PORT"
cd "$PROJECT_DIR"

fail() {
  printf '\n启动失败：%s\n' "$1" >&2
  if [ -t 0 ]; then read -r -p '按回车关闭…' _; fi
  exit 1
}
trap 'fail "命令执行失败，请查看上方错误。"' ERR
command -v node >/dev/null || fail '找不到 Node.js，请先安装 Node.js。'
command -v npm >/dev/null || fail '找不到 npm，请检查 Node.js 安装。'
command -v python3 >/dev/null || fail '找不到 Python 3，无法安全停止旧版 Pi 2 服务。'
command -v curl >/dev/null || fail '找不到 curl，无法检查服务状态。'

is_ready() {
  local health
  health="$(curl -fsS --connect-timeout 1 --max-time 2 "$URL/api/health" 2>/dev/null)" || return 1
  printf '%s' "$health" | node -e '
    let input="";
    process.stdin.on("data", chunk => input += chunk);
    process.stdin.on("end", () => {
      try {
        const h = JSON.parse(input);
        process.exit(h.ok === true && h.engine === "pi-agent-core" && h.workingDirectory === process.cwd() ? 0 : 1);
      } catch { process.exit(1); }
    });
  '
}
open_page() {
  if [ "${PI_LAB_NO_OPEN:-0}" != 1 ]; then /usr/bin/open "$URL" || true; fi
}
if is_ready; then
  printf 'Pi Lab 已在运行，打开 %s\n' "$URL"
  open_page
  exit 0
fi
[ -d node_modules ] || fail '项目依赖尚未安装，请在项目目录运行 npm ci。'
printf '\nπ Pi Lab\n项目：%s\n正在构建…\n\n' "$PROJECT_DIR"
npm run build
if /usr/sbin/lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  printf '检测到 3000 端口仍由旧 pi 2 实例占用，正在尝试温和停止…\n'
  python3 "$PROJECT_DIR/scripts/stop-old-pi2.py" --port "$PORT" --timeout 90 || fail '3000 端口不是可安全识别的 pi 2 实例，或其未能温和退出；未强制终止。'
  # Pi 2 data-sync scripts were retired; Pi Lab starts from its existing workspace.
fi
printf '\n启动后将自动打开 %s\n保持本窗口打开；退出请按 Control+C。\n\n' "$URL"
if [ "${PI_LAB_NO_OPEN:-0}" != 1 ]; then
  (
    for ((i=0; i<60; i++)); do
      if is_ready; then open_page; exit 0; fi
      sleep 1
    done
    printf '\n网页未自动打开，请查看服务日志后手动访问 %s\n' "$URL" >&2
  ) &
fi
exec npm run start
