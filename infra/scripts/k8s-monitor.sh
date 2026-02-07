#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# Suna EKS Monitor — Terminal Dashboard
# Usage: ./k8s-monitor.sh [namespace] [refresh_seconds]
# ============================================================================

NAMESPACE="${1:-suna}"
REFRESH="${2:-5}"
CLUSTER="suna-eks"
REGION="us-west-2"

# ── Colors ──────────────────────────────────────────────────────────────────
RESET="\033[0m"
BOLD="\033[1m"
DIM="\033[2m"
ITALIC="\033[3m"

# Foreground
BLACK="\033[30m"
RED="\033[31m"
GREEN="\033[32m"
YELLOW="\033[33m"
BLUE="\033[34m"
MAGENTA="\033[35m"
CYAN="\033[36m"
WHITE="\033[37m"

# Bright
BRED="\033[91m"
BGREEN="\033[92m"
BYELLOW="\033[93m"
BBLUE="\033[94m"
BMAGENTA="\033[95m"
BCYAN="\033[96m"
BWHITE="\033[97m"

# Background
BG_RED="\033[41m"
BG_GREEN="\033[42m"
BG_YELLOW="\033[43m"
BG_BLUE="\033[44m"
BG_MAGENTA="\033[45m"
BG_CYAN="\033[46m"
BG_GRAY="\033[100m"

# ── Box Drawing ─────────────────────────────────────────────────────────────
TL="╭" TR="╮" BL="╰" BR="╯" H="─" V="│" T="┬" B="┴" L="├" R="┤" X="┼"

# ── Helpers ─────────────────────────────────────────────────────────────────
cols() { tput cols 2>/dev/null || echo 120; }

hr() {
  local w; w=$(cols)
  local color="${1:-$DIM$CYAN}"
  printf "${color}"
  printf '%*s' "$w" '' | tr ' ' '─'
  printf "${RESET}\n"
}

box_header() {
  local title="$1"
  local color="${2:-$BCYAN}"
  local icon="${3:-}"
  local w; w=$(cols)
  local inner=$((w - 4))

  printf "\n${color}${TL}"
  printf '%*s' "$((inner + 2))" '' | tr ' ' "$H"
  printf "${TR}${RESET}\n"

  printf "${color}${V}${RESET} ${BOLD}${color}${icon} ${title}${RESET}"
  local title_len=$(( ${#icon} + ${#title} + 3 ))
  local pad=$((inner - title_len + 1))
  printf '%*s' "$pad" ''
  printf "${color}${V}${RESET}\n"

  printf "${color}${L}"
  printf '%*s' "$((inner + 2))" '' | tr ' ' "$H"
  printf "${R}${RESET}\n"
}

box_footer() {
  local color="${1:-$BCYAN}"
  local w; w=$(cols)
  local inner=$((w - 4))
  printf "${color}${BL}"
  printf '%*s' "$((inner + 2))" '' | tr ' ' "$H"
  printf "${BR}${RESET}\n"
}

indent() {
  local color="${1:-$BCYAN}"
  while IFS= read -r line; do
    printf "${color}${V}${RESET} %s\n" "$line"
  done
}

status_color() {
  case "$1" in
    Running|Ready|True|Active|Available|AVAILABLE)  echo -e "${BGREEN}" ;;
    Pending|ContainerCreating|Terminating)           echo -e "${BYELLOW}" ;;
    Failed|Error|CrashLoopBackOff|OOMKilled|False)   echo -e "${BRED}" ;;
    *)                                               echo -e "${WHITE}" ;;
  esac
}

bar() {
  local pct="$1"
  local width="${2:-30}"
  local filled=$(( pct * width / 100 ))
  local empty=$(( width - filled ))
  local color

  if   (( pct >= 90 )); then color="${BRED}"
  elif (( pct >= 70 )); then color="${BYELLOW}"
  elif (( pct >= 50 )); then color="${BCYAN}"
  else                       color="${BGREEN}"
  fi

  printf "${color}"
  printf '%*s' "$filled" '' | tr ' ' '█'
  printf "${DIM}"
  printf '%*s' "$empty" '' | tr ' ' '░'
  printf "${RESET}"
  printf " ${BOLD}%3d%%${RESET}" "$pct"
}

# ── Preflight ───────────────────────────────────────────────────────────────
check_deps() {
  for cmd in kubectl awk; do
    if ! command -v "$cmd" &>/dev/null; then
      echo -e "${BRED}Error: '$cmd' not found${RESET}"
      exit 1
    fi
  done
}

# ── Data Collection ─────────────────────────────────────────────────────────
render_header() {
  local w; w=$(cols)
  local now; now=$(date '+%Y-%m-%d %H:%M:%S')
  local ctx; ctx=$(kubectl config current-context 2>/dev/null || echo "unknown")

  printf "\n"
  printf "${BOLD}${BMAGENTA}"
  printf "  ███████╗██╗   ██╗███╗   ██╗ █████╗     ███████╗██╗  ██╗███████╗\n"
  printf "  ██╔════╝██║   ██║████╗  ██║██╔══██╗    ██╔════╝██║ ██╔╝██╔════╝\n"
  printf "  ███████╗██║   ██║██╔██╗ ██║███████║    █████╗  █████╔╝ ███████╗\n"
  printf "  ╚════██║██║   ██║██║╚██╗██║██╔══██║    ██╔══╝  ██╔═██╗ ╚════██║\n"
  printf "  ███████║╚██████╔╝██║ ╚████║██║  ██║    ███████╗██║  ██╗███████║\n"
  printf "  ╚══════╝ ╚═════╝ ╚═╝  ╚═══╝╚═╝  ╚═╝    ╚══════╝╚═╝  ╚═╝╚══════╝\n"
  printf "${RESET}\n"

  printf "  ${DIM}${CYAN}Cluster:${RESET} ${BOLD}${WHITE}${CLUSTER}${RESET}"
  printf "  ${DIM}${CYAN}Namespace:${RESET} ${BOLD}${WHITE}${NAMESPACE}${RESET}"
  printf "  ${DIM}${CYAN}Context:${RESET} ${BOLD}${WHITE}${ctx}${RESET}"
  printf "  ${DIM}${CYAN}Time:${RESET} ${BOLD}${WHITE}${now}${RESET}"
  printf "  ${DIM}${CYAN}Refresh:${RESET} ${BOLD}${WHITE}${REFRESH}s${RESET}\n"
}

render_nodes() {
  box_header "NODES" "$BCYAN" "🖥 "

  local node_data
  node_data=$(kubectl top nodes 2>/dev/null) || {
    echo -e "  ${BYELLOW}Metrics server not available${RESET}" | indent "$BCYAN"
    box_footer "$BCYAN"
    return
  }

  local node_status
  node_status=$(kubectl get nodes -o wide --no-headers 2>/dev/null)

  # Header
  printf "${BCYAN}${V}${RESET} ${BOLD}${BWHITE}  %-28s %-10s %-8s %-34s %-8s %-34s %-14s${RESET}\n" \
    "NODE" "STATUS" "CPU" "CPU BAR" "MEM" "MEM BAR" "VERSION"

  printf "${BCYAN}${V}${RESET} ${DIM}%s${RESET}\n" \
    "$(printf '%*s' $(( $(cols) - 4 )) '' | tr ' ' '·')"

  echo "$node_status" | while read -r name status roles age version internal external os kernel runtime; do
    local sc; sc=$(status_color "$status")

    # Get usage from top
    local cpu_pct=0 mem_pct=0
    local top_line; top_line=$(echo "$node_data" | grep "^${name}" || true)
    if [[ -n "$top_line" ]]; then
      cpu_pct=$(echo "$top_line" | awk '{gsub(/%/,"",$3); print int($3)}')
      mem_pct=$(echo "$top_line" | awk '{gsub(/%/,"",$5); print int($5)}')
    fi

    local cpu_bar; cpu_bar=$(bar "$cpu_pct" 25)
    local mem_bar; mem_bar=$(bar "$mem_pct" 25)

    printf "${BCYAN}${V}${RESET}  ${BOLD}${WHITE}%-28s${RESET} ${sc}%-10s${RESET} ${BOLD}%5s%%${RESET}  %s  ${BOLD}%5s%%${RESET}  %s  ${DIM}%-14s${RESET}\n" \
      "$name" "$status" "$cpu_pct" "$cpu_bar" "$mem_pct" "$mem_bar" "$version"
  done

  box_footer "$BCYAN"
}

render_pods() {
  box_header "PODS" "$BBLUE" "🚀"

  local pod_data
  pod_data=$(kubectl top pods -n "$NAMESPACE" 2>/dev/null) || true

  local pods
  pods=$(kubectl get pods -n "$NAMESPACE" --no-headers -o custom-columns=\
'NAME:.metadata.name,STATUS:.status.phase,READY:.status.conditions[?(@.type=="Ready")].status,RESTARTS:.status.containerStatuses[0].restartCount,AGE:.metadata.creationTimestamp,IMAGE:.spec.containers[0].image,NODE:.spec.nodeName' 2>/dev/null)

  # Header
  printf "${BBLUE}${V}${RESET} ${BOLD}${BWHITE}  %-40s %-12s %-8s %-10s %-12s %-12s %-30s${RESET}\n" \
    "POD" "STATUS" "READY" "RESTARTS" "CPU" "MEMORY" "NODE"

  printf "${BBLUE}${V}${RESET} ${DIM}%s${RESET}\n" \
    "$(printf '%*s' $(( $(cols) - 4 )) '' | tr ' ' '·')"

  echo "$pods" | while read -r name status ready restarts age image node; do
    local sc; sc=$(status_color "$status")
    local rc; rc=$(status_color "$ready")

    # Get usage
    local cpu="--" mem="--"
    if [[ -n "$pod_data" ]]; then
      local top_line; top_line=$(echo "$pod_data" | grep "^${name}" || true)
      if [[ -n "$top_line" ]]; then
        cpu=$(echo "$top_line" | awk '{print $2}')
        mem=$(echo "$top_line" | awk '{print $3}')
      fi
    fi

    # Ready indicator
    local ready_icon
    if [[ "$ready" == "True" ]]; then
      ready_icon="${BGREEN}●${RESET}"
    else
      ready_icon="${BRED}○${RESET}"
    fi

    # Restart color
    local restart_color="${BGREEN}"
    if [[ "$restarts" != "<none>" ]] && (( restarts > 5 )); then
      restart_color="${BRED}"
    elif [[ "$restarts" != "<none>" ]] && (( restarts > 0 )); then
      restart_color="${BYELLOW}"
    fi

    # Shorten node name
    local short_node; short_node=$(echo "$node" | sed 's/\..*$//' | tail -c 30)

    printf "${BBLUE}${V}${RESET}  ${BOLD}${WHITE}%-40s${RESET} ${sc}%-12s${RESET} %s %-5s  ${restart_color}%-10s${RESET} ${BCYAN}%-12s${RESET} ${BMAGENTA}%-12s${RESET} ${DIM}%-30s${RESET}\n" \
      "$name" "$status" "$ready_icon" "$ready" "$restarts" "$cpu" "$mem" "$short_node"
  done

  box_footer "$BBLUE"
}

render_deployment() {
  box_header "DEPLOYMENTS" "$BGREEN" "📦"

  local deps
  deps=$(kubectl get deployments -n "$NAMESPACE" --no-headers \
    -o custom-columns='NAME:.metadata.name,READY:.status.readyReplicas,DESIRED:.spec.replicas,UPDATED:.status.updatedReplicas,AVAILABLE:.status.availableReplicas,IMAGE:.spec.template.spec.containers[0].image,STRATEGY:.spec.strategy.type' 2>/dev/null)

  printf "${BGREEN}${V}${RESET} ${BOLD}${BWHITE}  %-30s %-16s %-10s %-10s %-14s %-40s${RESET}\n" \
    "DEPLOYMENT" "REPLICAS" "UPDATED" "AVAIL" "STRATEGY" "IMAGE"

  printf "${BGREEN}${V}${RESET} ${DIM}%s${RESET}\n" \
    "$(printf '%*s' $(( $(cols) - 4 )) '' | tr ' ' '·')"

  echo "$deps" | while read -r name ready desired updated available image strategy; do
    ready="${ready:-0}"
    desired="${desired:-0}"
    updated="${updated:-0}"
    available="${available:-0}"

    local rep_color="${BGREEN}"
    if [[ "$ready" != "$desired" ]]; then
      rep_color="${BRED}"
    fi

    # Shorten image
    local short_image; short_image=$(echo "$image" | sed 's|.*/||' | tail -c 40)

    printf "${BGREEN}${V}${RESET}  ${BOLD}${WHITE}%-30s${RESET} ${rep_color}${BOLD}%s/%s${RESET}%-8s %-10s %-10s ${DIM}%-14s${RESET} ${CYAN}%-40s${RESET}\n" \
      "$name" "$ready" "$desired" "" "$updated" "$available" "$strategy" "$short_image"
  done

  box_footer "$BGREEN"
}

render_hpa() {
  box_header "AUTOSCALING (HPA)" "$BYELLOW" "📈"

  local hpa
  hpa=$(kubectl get hpa -n "$NAMESPACE" --no-headers 2>/dev/null) || {
    echo "  No HPA found" | indent "$BYELLOW"
    box_footer "$BYELLOW"
    return
  }

  if [[ -z "$hpa" ]]; then
    echo "  No HPA found" | indent "$BYELLOW"
    box_footer "$BYELLOW"
    return
  fi

  printf "${BYELLOW}${V}${RESET} ${BOLD}${BWHITE}  %-30s %-20s %-8s %-8s %-10s %-10s${RESET}\n" \
    "HPA" "TARGETS" "MIN" "MAX" "CURRENT" "STATUS"

  printf "${BYELLOW}${V}${RESET} ${DIM}%s${RESET}\n" \
    "$(printf '%*s' $(( $(cols) - 4 )) '' | tr ' ' '·')"

  echo "$hpa" | while read -r name ref targets minp maxp replicas age; do
    local scale_color="${BGREEN}"
    if [[ "$replicas" == "$maxp" ]]; then
      scale_color="${BRED}"
    elif (( replicas > minp )); then
      scale_color="${BYELLOW}"
    fi

    printf "${BYELLOW}${V}${RESET}  ${BOLD}${WHITE}%-30s${RESET} ${CYAN}%-20s${RESET} %-8s %-8s ${scale_color}${BOLD}%-10s${RESET} ${DIM}%-10s${RESET}\n" \
      "$name" "$targets" "$minp" "$maxp" "$replicas" "$age"
  done

  box_footer "$BYELLOW"
}

render_services() {
  box_header "SERVICES & INGRESS" "$BMAGENTA" "🌐"

  local svcs
  svcs=$(kubectl get svc -n "$NAMESPACE" --no-headers \
    -o custom-columns='NAME:.metadata.name,TYPE:.spec.type,CLUSTER-IP:.spec.clusterIP,PORT:.spec.ports[0].port,TARGET:.spec.ports[0].targetPort' 2>/dev/null)

  printf "${BMAGENTA}${V}${RESET} ${BOLD}${BWHITE}  %-30s %-14s %-18s %-10s %-10s${RESET}\n" \
    "SERVICE" "TYPE" "CLUSTER-IP" "PORT" "TARGET"

  printf "${BMAGENTA}${V}${RESET} ${DIM}%s${RESET}\n" \
    "$(printf '%*s' $(( $(cols) - 4 )) '' | tr ' ' '·')"

  echo "$svcs" | while read -r name type cip port target; do
    printf "${BMAGENTA}${V}${RESET}  ${BOLD}${WHITE}%-30s${RESET} ${CYAN}%-14s${RESET} %-18s %-10s %-10s\n" \
      "$name" "$type" "$cip" "$port" "$target"
  done

  # Ingress
  local ing
  ing=$(kubectl get ingress -n "$NAMESPACE" --no-headers 2>/dev/null) || true
  if [[ -n "$ing" ]]; then
    printf "${BMAGENTA}${V}${RESET}\n"
    printf "${BMAGENTA}${V}${RESET} ${BOLD}${BWHITE}  %-30s %-40s %-20s${RESET}\n" \
      "INGRESS" "HOST" "ADDRESS"

    printf "${BMAGENTA}${V}${RESET} ${DIM}%s${RESET}\n" \
      "$(printf '%*s' $(( $(cols) - 4 )) '' | tr ' ' '·')"

    echo "$ing" | while read -r name class hosts addr ports age; do
      printf "${BMAGENTA}${V}${RESET}  ${BOLD}${WHITE}%-30s${RESET} ${BGREEN}%-40s${RESET} ${DIM}%-20s${RESET}\n" \
        "$name" "$hosts" "$addr"
    done
  fi

  box_footer "$BMAGENTA"
}

render_events() {
  box_header "RECENT EVENTS (last 10)" "$BRED" "⚡"

  local events
  events=$(kubectl get events -n "$NAMESPACE" --sort-by='.lastTimestamp' \
    --no-headers -o custom-columns=\
'TIME:.lastTimestamp,TYPE:.type,REASON:.reason,OBJECT:.involvedObject.name,MESSAGE:.message' \
    2>/dev/null | tail -10)

  if [[ -z "$events" ]]; then
    echo "  No recent events" | indent "$BRED"
    box_footer "$BRED"
    return
  fi

  printf "${BRED}${V}${RESET} ${BOLD}${BWHITE}  %-22s %-10s %-18s %-30s %-50s${RESET}\n" \
    "TIME" "TYPE" "REASON" "OBJECT" "MESSAGE"

  printf "${BRED}${V}${RESET} ${DIM}%s${RESET}\n" \
    "$(printf '%*s' $(( $(cols) - 4 )) '' | tr ' ' '·')"

  echo "$events" | while IFS= read -r line; do
    local time type reason obj msg
    time=$(echo "$line" | awk '{print $1}')
    type=$(echo "$line" | awk '{print $2}')
    reason=$(echo "$line" | awk '{print $3}')
    obj=$(echo "$line" | awk '{print $4}')
    msg=$(echo "$line" | awk '{for(i=5;i<=NF;i++) printf "%s ",$i; print ""}' | head -c 50)

    local tc
    case "$type" in
      Normal)  tc="${BGREEN}" ;;
      Warning) tc="${BYELLOW}" ;;
      *)       tc="${BRED}" ;;
    esac

    printf "${BRED}${V}${RESET}  ${DIM}%-22s${RESET} ${tc}%-10s${RESET} %-18s ${WHITE}%-30s${RESET} ${DIM}%-50s${RESET}\n" \
      "$time" "$type" "$reason" "$obj" "$msg"
  done

  box_footer "$BRED"
}

render_summary() {
  local total_pods ready_pods restarts
  total_pods=$(kubectl get pods -n "$NAMESPACE" --no-headers 2>/dev/null | wc -l | tr -d ' ')
  ready_pods=$(kubectl get pods -n "$NAMESPACE" --no-headers 2>/dev/null | awk '$3=="Running"{c++}END{print c+0}')
  restarts=$(kubectl get pods -n "$NAMESPACE" --no-headers 2>/dev/null \
    -o custom-columns='RESTARTS:.status.containerStatuses[0].restartCount' | \
    awk '{s+=$1}END{print s+0}')
  local total_nodes
  total_nodes=$(kubectl get nodes --no-headers 2>/dev/null | wc -l | tr -d ' ')

  local health_color="${BGREEN}"
  local health_icon="✅"
  if (( ready_pods < total_pods )); then
    health_color="${BRED}"
    health_icon="🔴"
  fi

  printf "\n  ${health_icon} ${BOLD}${health_color}CLUSTER HEALTH${RESET}  "
  printf "${DIM}│${RESET}  "
  printf "${BCYAN}Nodes:${RESET} ${BOLD}${total_nodes}${RESET}  "
  printf "${DIM}│${RESET}  "
  printf "${BBLUE}Pods:${RESET} ${BOLD}${ready_pods}/${total_pods}${RESET}  "
  printf "${DIM}│${RESET}  "
  printf "${BYELLOW}Total Restarts:${RESET} ${BOLD}${restarts}${RESET}  "
  printf "${DIM}│${RESET}  "
  printf "${DIM}Press Ctrl+C to exit${RESET}\n"
}

# ── Main Loop ───────────────────────────────────────────────────────────────
main() {
  check_deps

  trap 'printf "\n${BOLD}${BMAGENTA}Goodbye!${RESET}\n"; exit 0' INT TERM

  while true; do
    clear
    render_header
    render_summary
    render_nodes
    render_pods
    render_deployment
    render_hpa
    render_services
    render_events
    sleep "$REFRESH"
  done
}

main
