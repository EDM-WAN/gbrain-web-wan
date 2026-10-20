#!/usr/bin/env bash
# =============================================================================
# gbrain-web 一键启动/停止脚本
# -----------------------------------------------------------------------------
# 用途：启动 gbrain HTTP serve（主库）+ gbrain-web 前端（Next.js）
#       让浏览器能通过界面真实调用 gbrain（等价于命令行操作）
#
# 用法：
#   ./start-gbrain-web.sh start      # 启动生产模式（serve + next start）
#   ./start-gbrain-web.sh start-dev  # 启动开发模式（serve + next dev）
#   ./start-gbrain-web.sh stop       # 停止（serve + 前端）
#   ./start-gbrain-web.sh status     # 查看状态
#   ./start-gbrain-web.sh restart    # 重启生产模式
#   ./start-gbrain-web.sh restart-dev # 重启开发模式
# =============================================================================
set -u

# ---------- 配置 ----------
GBRAIN_BIN="/home/xirui_wan/workplaces/gbrain/bin/gbrain"
WEB_DIR="/home/xirui_wan/workplaces/gbrain-web"
GBRAIN_HOME="/home/xirui_wan/.gbrain-realgpt-embed"
SERVE_PORT="8788"
WEB_PORT="3000"
PID_DIR="/tmp/gbrain-web"
SERVE_PID_FILE="$PID_DIR/serve.pid"
WEB_PID_FILE="$PID_DIR/web.pid"
SUPERVISOR_PID_FILE="$PID_DIR/supervisor.pid"
SERVE_LOG="/tmp/gbrain-web-serve.log"
WEB_LOG="/tmp/gbrain-web.log"
SUPERVISOR_LOG="/tmp/gbrain-web-supervisor.log"
WEB_MODE="prod"
ENV_FILE="$WEB_DIR/.env"
# 方案D:supervisor 成功运行 → 前端才会把任务提交到 minions 队列。
# 由 start_supervisor 设置为 "GBRAIN_MINIONS_AVAILABLE=1"(或空),注入 next 进程。
MINIONS_ENV_ARGS=""

# ---------- 辅助 ----------
mkdir -p "$PID_DIR"

log()  { echo -e "\033[1;32m[gbrain-web]\033[0m $*"; }
warn() { echo -e "\033[1;33m[gbrain-web]\033[0m $*"; }
err()  { echo -e "\033[1;31m[gbrain-web]\033[0m $*"; }

read_pid() { cat "$1" 2>/dev/null || echo ""; }

load_local_env() {
  if [ ! -f "$ENV_FILE" ]; then
    err "缺少 $ENV_FILE（含本地 Web/GBrain 配置）。"
    exit 1
  fi
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
  export GBRAIN_HOME
  unset GBRAIN_SOURCE
}

check_provider_key() {
  if [ -z "${OPENAI_API_KEY:-}" ]; then
    err "缺少 OPENAI_API_KEY。请把 RealGPT API Key 写入 $ENV_FILE 后再启动。"
    err "当前 OPENAI_BASE_URL=${OPENAI_BASE_URL:-<unset>}（只显示地址变量名，不显示 Key）。"
    exit 1
  fi
}

is_running() {
  local pid; pid="$(read_pid "$1")"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

find_existing_serve_pid() {
  local pid
  while read -r pid; do
    [ -n "$pid" ] || continue
    if tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -Fq "$GBRAIN_BIN serve --http --port $SERVE_PORT"; then
      printf '%s\n' "$pid"
      return 0
    fi
  done < <(pgrep -f "gbrain serve --http --port $SERVE_PORT" 2>/dev/null || true)
  return 1
}

find_existing_web_pid() {
  local pattern pid cwd
  for pattern in "next dev" "next start" "next-server"; do
    while read -r pid; do
      [ -n "$pid" ] || continue
      [ "$pid" = "$$" ] && continue
      cwd="$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)"
      if [ "$cwd" = "$WEB_DIR" ]; then
        printf '%s\n' "$pid"
        return 0
      fi
    done < <(pgrep -f "$pattern" 2>/dev/null || true)
  done
  return 1
}

# 方案D:minions 独立 worker(supervisor)常驻,消费持久化任务队列。
# 用 gbrain 自带的 supervisor status 检测是否已在跑(避免重复启动),保留 PID 便于 stop。
SUPERVISOR_BIN="$GBRAIN_BIN"
find_existing_supervisor_pid() {
  local pid
  # supervisor 以 "gbrain jobs supervisor" 进程运行;从 DB 锁 + 命令行双重判断。
  pid="$(pgrep -f "gbrain jobs supervisor" 2>/dev/null | head -1 || true)"
  printf '%s\n' "$pid"
  [ -n "$pid" ]
}

supervisor_is_up() {
  GBRAIN_HOME="$GBRAIN_HOME" timeout 25 "$SUPERVISOR_BIN" jobs supervisor status --json 2>/dev/null \
    | grep -q '"running": true'
}

start_supervisor() {
  # 先假设不可用;只有确认 supervisor running 才置位,前端才走 minions 队列。
  MINIONS_ENV_ARGS=""
  local existing_pid
  existing_pid="$(find_existing_supervisor_pid)"
  if [ -n "$existing_pid" ]; then
    echo "$existing_pid" > "$SUPERVISOR_PID_FILE"
    warn "minions supervisor 已在运行（PID $existing_pid），跳过启动。"
    if supervisor_is_up; then
      MINIONS_ENV_ARGS="GBRAIN_MINIONS_AVAILABLE=1"
    fi
    return 0
  fi
  log "启动 minions supervisor（独立 worker，消费持久化任务队列）..."
  # 注意:不能用 `jobs supervisor start --detach` —— bun 编译二进制里 process.execPath
  # 解析为内部挂载 /$bunfs/root/gbrain,detach 重新 spawn 会以错误路径启动 worker,
  # 报 "Unknown command: /$bunfs/root/gbrain" 后 supervisor 即退。改用前台模式并在
  # setsid 独立会话中后台运行(已验证稳定;worker `gbrain jobs work` 正常起)。
  # 同时注入 GBRAIN_JOB_CHILD_CLI 让 supervisor spawn 的 worker 用真实二进制路径。
  setsid --fork bash -c "exec nohup env GBRAIN_HOME='$GBRAIN_HOME' PATH=\"$WEB_DIR/../gbrain/bin:$PATH\" GBRAIN_JOB_CHILD_CLI='$GBRAIN_BIN' '$SUPERVISOR_BIN' jobs supervisor > '$SUPERVISOR_LOG' 2>&1 < /dev/null" &
  sleep 4
  if supervisor_is_up; then
    local spid; spid="$(find_existing_supervisor_pid)"
    [ -n "$spid" ] && echo "$spid" > "$SUPERVISOR_PID_FILE"
    MINIONS_ENV_ARGS="GBRAIN_MINIONS_AVAILABLE=1"
    log "minions supervisor 已启动（PID $spid / $(read_pid "$SUPERVISOR_PID_FILE")）,前端将走 minions 队列。"
  else
    warn "supervisor 启动未确认，日志见 $SUPERVISOR_LOG（前端将回退到进程内执行；任务不会卡队列）。"
  fi
}

stop_supervisor() {
  # gbrain 自带优雅停止;不依赖 PID 文件(进程可能由 gbrain DB 锁管理)。
  GBRAIN_HOME="$GBRAIN_HOME" timeout 50 "$SUPERVISOR_BIN" jobs supervisor stop >/dev/null 2>&1
  # 兜底:kill 命令行匹配的残留。
  local pid; pid="$(find_existing_supervisor_pid)"
  if [ -n "$pid" ]; then
    kill "$pid" 2>/dev/null
    sleep 2
    kill -9 "$pid" 2>/dev/null
  fi
  rm -f "$SUPERVISOR_PID_FILE"
  log "minions supervisor 已停止。"
}

# ---------- 关键前置检查 ----------
check_db_lock() {
  # 若主库被其他 gbrain 进程锁着，serve 无法启动；给出明确提示
  pgrep -f "gbrain serve" >/dev/null 2>&1
  if [ $? -eq 0 ]; then
    warn "检测到已有 gbrain serve 进程在运行。"
    warn "若它不是本脚本启动的(例如当前 Claude/Codex 会话的 MCP server)，"
    warn "则 PGLite 主库被占用，无法再启动新 serve。"
    warn "请先退出对应会话(释放锁)，或用 status 查看本脚本管理的进程。"
    return 1
  fi
  return 0
}

# ---------- 子命令 ----------
start() {
  # 1. Load the same local environment for both Next.js and gbrain serve.
  load_local_env
  check_provider_key

  # 2. serve 已起则跳过
  existing_serve_pid=""
  if is_running "$SERVE_PID_FILE"; then
    existing_serve_pid="$(read_pid "$SERVE_PID_FILE")"
  else
    existing_serve_pid="$(find_existing_serve_pid || true)"
  fi
  if [ -n "$existing_serve_pid" ]; then
    echo "$existing_serve_pid" > "$SERVE_PID_FILE"
    warn "serve 已在运行（PID $existing_serve_pid），跳过启动。"
  else
    check_db_lock || { err "因已有 gbrain serve 进程未能启动。"; exit 1; }
    log "启动 gbrain HTTP serve（主库, 端口 $SERVE_PORT）..."
    nohup env -u GBRAIN_SOURCE GBRAIN_HOME="$GBRAIN_HOME" "$GBRAIN_BIN" serve --http --port "$SERVE_PORT" --bind 127.0.0.1 > "$SERVE_LOG" 2>&1 &
    echo $! > "$SERVE_PID_FILE"
    sleep 5
    if is_running "$SERVE_PID_FILE"; then
      log "serve 已启动（PID $(read_pid "$SERVE_PID_FILE")）"
    else
      err "serve 启动失败，日志见 $SERVE_LOG"
      exit 1
    fi
  fi

  # 2.5 方案D:minions supervisor(独立 worker)随 serve 常驻,消费持久化任务队列。
  #      它依赖 serve(共 DB),但与前端无关——放在 serve 就绪后、前端之前启动。
  start_supervisor

  # 3. 前端已起则跳过. Reconcile processes not started by this script too,
  # otherwise an orphaned Next process makes the new launcher choose port 3001
  # and then fail on Next's own .next/dev lock.
  existing_web_pid=""
  if is_running "$WEB_PID_FILE"; then
    existing_web_pid="$(read_pid "$WEB_PID_FILE")"
  else
    existing_web_pid="$(find_existing_web_pid || true)"
  fi
  if [ -n "$existing_web_pid" ]; then
    echo "$existing_web_pid" > "$WEB_PID_FILE"
    warn "前端已在运行（PID $existing_web_pid），跳过启动。"
  else
    cd "$WEB_DIR"
    if [ "$WEB_MODE" = "dev" ]; then
      log "启动 gbrain-web 前端（开发模式，端口 $WEB_PORT）..."
      nohup env GBRAIN_HOME="$GBRAIN_HOME" $MINIONS_ENV_ARGS node node_modules/next/dist/bin/next dev --port "$WEB_PORT" > "$WEB_LOG" 2>&1 &
    else
      log "启动 gbrain-web 前端（生产模式，端口 $WEB_PORT）..."
      if [ ! -f "$WEB_DIR/.next/BUILD_ID" ]; then
        log "未找到生产构建产物，先执行 next build..."
        if ! npm run build > "$WEB_LOG" 2>&1; then
          err "前端生产构建失败，日志见 $WEB_LOG"
          exit 1
        fi
      fi
      nohup env GBRAIN_HOME="$GBRAIN_HOME" $MINIONS_ENV_ARGS node node_modules/next/dist/bin/next start --port "$WEB_PORT" > "$WEB_LOG" 2>&1 &
    fi
    echo $! > "$WEB_PID_FILE"
    sleep 6
    if is_running "$WEB_PID_FILE" && { [ "$WEB_MODE" = "dev" ] || grep -q "started server\|Ready" "$WEB_LOG"; }; then
      log "前端已启动（${WEB_MODE}模式，PID $(read_pid "$WEB_PID_FILE")）"
    else
      err "前端启动失败，日志见 $WEB_LOG"
      exit 1
    fi
  fi

  # 4. 健康探测
  log "健康探测中..."
  sleep 2
  serve_ok=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$SERVE_PORT/health" 2>/dev/null)
  web_ok=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:$WEB_PORT" 2>/dev/null)
  [ "$serve_ok" = "200" ] && log "serve OK  (http://127.0.0.1:$SERVE_PORT/health)" || warn "serve 探测异常 (http=$serve_ok)"
  [ "$web_ok" = "200" ]   && log "web  OK   (http://localhost:$WEB_PORT)" || warn "web  探测异常 (http=$web_ok)"

  log "───────────────────────────────────────────"
  log " 打开浏览器访问:  http://localhost:$WEB_PORT"
  log " 停止:  $0 stop     状态: $0 status"
  log "───────────────────────────────────────────"
}

stop() {
  # 先停 supervisor(优雅停止 worker,让已认领任务先落地),再停 web/serve。
  stop_supervisor
  for name in WEB SERVE; do
    case $name in
      WEB)   pidfile="$WEB_PID_FILE";   label="前端" ;;
      SERVE) pidfile="$SERVE_PID_FILE"; label="serve" ;;
    esac
    if is_running "$pidfile"; then
      pid="$(read_pid "$pidfile")"
      kill "$pid" 2>/dev/null
      sleep 2
      kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null
      rm -f "$pidfile"
      log "已停止 $label (PID $pid)"
    else
      rm -f "$pidfile"
      warn "$label 未在运行，跳过"
    fi
  done
  log "全部停止完成。"
}

status() {
  local serve_pid web_pid supervisor_pid
  serve_pid="$(read_pid "$SERVE_PID_FILE")"
  web_pid="$(read_pid "$WEB_PID_FILE")"
  supervisor_pid="$(read_pid "$SUPERVISOR_PID_FILE")"
  echo "──── 服务状态 ────────────────"
  if is_running "$SERVE_PID_FILE"; then
    log "serve : 运行中 (PID $serve_pid)   http://127.0.0.1:$SERVE_PORT/health"
  else
    warn "serve : 未运行"
  fi
  if is_running "$WEB_PID_FILE"; then
    log "web   : 运行中 (PID $web_pid)    http://localhost:$WEB_PORT"
  else
    warn "web   : 未运行"
  fi
  if is_running "$SUPERVISOR_PID_FILE"; then
    log "supervisor : 运行中 (PID $supervisor_pid)   minions 独立 worker"
  elif [ -n "$supervisor_pid" ] && kill -0 "$supervisor_pid" 2>/dev/null; then
    log "supervisor : 运行中 (PID $supervisor_pid)   minions 独立 worker"
  else
    warn "supervisor : 未运行（方案D worker 未启动，任务会在队列中排队）"
  fi
  echo "──── 日志 ────────────────────"
  echo "  serve日志: $SERVE_LOG"
  echo "  web日志  : $WEB_LOG"
  echo "  supervisor日志: $SUPERVISOR_LOG"
}

# ---------- 主入口 ----------
case "${1:-}" in
  start|start-prod) start ;;
  start-dev) WEB_MODE="dev"; WEB_LOG="/tmp/gbrain-web-dev.log"; start ;;
  stop)    stop ;;
  restart|restart-prod) stop; sleep 1; start ;;
  restart-dev) stop; sleep 1; WEB_MODE="dev"; WEB_LOG="/tmp/gbrain-web-dev.log"; start ;;
  status)  status ;;
  *)
    echo "用法: $0 {start|stop|restart|status}"
    exit 1
    ;;
esac
