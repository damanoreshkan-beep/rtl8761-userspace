#!/data/data/com.termux/files/usr/bin/bash
# btctl — thin front-end over termux-usb for the RTL8761 USB Bluetooth control core (no root).
# Usage:
#   btctl list
#   btctl desc <dev>   # dump device/config/interface/endpoint descriptors
#   btctl hci  <dev>   # claim iface0, send HCI Read_Local_Version, read the event back
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
DENO="${DENO:-/root/.deno/bin/deno}"
CORE="$HERE/bt.ts"
export PATH="/data/data/com.termux/files/usr/bin:$PATH"

run() { # action dev
  local action="$1" dev="$2"
  local cb="$HERE/.cb.sh"
  cat > "$cb" <<EOF
#!/data/data/com.termux/files/usr/bin/bash
HOME=/root BT_ACTION="$action" "$DENO" run -A --no-lock "$CORE" "\$1"
EOF
  chmod +x "$cb"
  timeout 60 termux-usb -r -e "$cb" "$dev"
}

cmd="${1:-list}"; shift || true
case "$cmd" in
  list)  termux-usb -l ;;
  desc)   run desc   "$1" ;;
  hci)    run hci    "$1" ;;
  romver) run romver "$1" ;;
  fwdl)   run fwdl   "$1" ;;
  scan)   run scan   "$1" ;;
  *)     echo "unknown: $cmd"; exit 2 ;;
esac
