#!/data/data/com.termux/files/usr/bin/bash
# btctl — thin front-end over termux-usb for the RTL8761 USB Bluetooth control core (no root).
# Usage:
#   btctl list
#   btctl desc   <dev>   # dump device/config/interface/endpoint descriptors
#   btctl hci    <dev>   # claim iface0, send HCI Read_Local_Version, read the event back
#   btctl romver <dev>   # vendor Read_ROM_Version (0xFC6D)
#   btctl fwdl   <dev>   # download rtl8761bu fw+config, HCI_Reset, verify patched subver
#   btctl scan   <dev>   # LE active scan (auto-downloads fw first). BT_SCAN_SECS=5
#   btctl adv    <dev>   # LE advertise as a named device. BT_ADV_NAME, BT_ADV_SECS=20
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
  adv)    run adv    "$1" ;;
  *)     echo "unknown: $cmd"; exit 2 ;;
esac
