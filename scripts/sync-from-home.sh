#!/bin/sh
# Copy the card and script from Sam's Home Assistant repo (where they're developed against the live Pi),
# dropping the legacy tag that only that dashboard uses.
set -e
HOME_REPO="$(cd "$(dirname "$0")/../../home-assistant" && pwd)"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
grep -v -e 'legacy tag used by the Sabeti Home dashboard' -e 'customElements.define("system-summary-card"' \
  "$HOME_REPO/cards/system-summary-card.js" > "$ROOT/pi-vitals-card.js"
cp "$HOME_REPO/pi-power/pi_vitals.py" "$ROOT/extras/pi_vitals.py"
node --check "$ROOT/pi-vitals-card.js" && echo "synced"
