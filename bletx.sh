#!/data/data/com.termux/files/usr/bin/bash
# bletx — BLE advertisement runner for the RTL8761 dongle. FOR OWN-DEVICE TESTING ONLY.
# Ported presets from the M5/ESP32 app_spam.h.
#   bletx [preset] [secs] [txpower_dBm]
# txpower (optional): switches to Extended Advertising (legacy PDUs) with that TX power in dBm,
#   e.g. 9 for +9 dBm. The controller clamps to its max and prints the value it actually used.
#   Omit to use plain legacy advertising at the controller default.
# presets (rotating random address, ~20ms interval):
#   apple    Apple Proximity Pairing (AirPods-style sheet on iOS)
#   samsung  Galaxy Buds / Watch EasySetup popup
#   google   Fast Pair half-sheet on Android
#   windows  Swift Pair "Connect" toast on Windows (rotating names)
#   all      cycle a random brand each send
# single-shot presets (no rotation): swiftpair | fastpair | ibeacon | eddystone
set -u
export PATH="/data/data/com.termux/files/usr/bin:$PATH"
T=/root/rtl8761-bt; cd "$T" || exit 1
PRESET="${1:-all}"; SECS="${2:-30}"; TXP="${3:-}"
CACHE="$T/.btdev"

list() { termux-usb -l 2>/dev/null | grep -oE '/dev/bus/usb/[0-9]+/[0-9]+'; }

# find the RTL8761 BT dongle (2550:8761); reuse the cached path only if it is still that dongle
DEV=""
if [ -f "$CACHE" ] && list | grep -qx "$(cat "$CACHE")" \
   && ./btctl.sh desc "$(cat "$CACHE")" 2>/dev/null | grep -q 'vid=2550 pid=8761'; then
  DEV="$(cat "$CACHE")"
else
  echo "bletx: locating RTL8761 dongle (tap the USB popup for each probe)..."
  for d in $(list); do
    if ./btctl.sh desc "$d" 2>/dev/null | grep -q 'vid=2550 pid=8761'; then DEV="$d"; echo "$d" > "$CACHE"; break; fi
  done
fi
[ -z "$DEV" ] && { echo "bletx: RTL8761 dongle (2550:8761) not found in: $(list | tr '\n' ' ')"; exit 1; }

echo "bletx: preset=$PRESET secs=$SECS txpower=${TXP:-default} dev=$DEV"
[ -n "$TXP" ] && export BT_TX_POWER="$TXP"
BT_ADV_PRESET="$PRESET" BT_ADV_SECS="$SECS" exec ./btctl.sh adv "$DEV"
