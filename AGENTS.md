# Pi Vitals card

Home Assistant card (Raspberry Pi health) that Sam is preparing to publish. GitHub: https://github.com/samansabeti/pi-vitals-card (PRIVATE while Sam keeps working on it; `origin`, branch `main`). Follow ~/.agents/AGENTS.md and ../AGENTS.md.

## How it works
- `pi-vitals-card.js`: the card, one file, no dependencies. HACS plugin layout (`hacs.json` filename).
- `extras/pi_vitals.py`: optional command_line sensor script (firmware data through /dev/vcio).
- Source of truth is the home-assistant repo (`cards/system-summary-card.js`, `pi-power/pi_vitals.py`), developed against Sam's live Pi. Run `scripts/sync-from-home.sh` to copy them here; never edit the copies directly.

## Git
- Commits here use the GitHub noreply address (repo-local `user.email`); GitHub blocks pushes that expose Sam's private email. Pushing to the private repo is fine after Sam's go-ahead for that work; making it public needs Sam's explicit OK.

## Before making it public (needs Sam's OK)
- Reviewed against HACS + HA card docs (2026-11-05). Open items: HACS only installs from public repos; publish a full GitHub release (a tag alone isn't enough); README images must exist (`images/`); consider a visual editor (`static getConfigForm()`); HA says `ha-*` elements other than `ha-card` aren't a supported API (the card still uses `ha-icon` in places); HACS is built into HA as the Marketplace from 2026.11; the default HACS list needs a PR to hacs/default and takes months.
- Screenshots in `images/` (light, dark, phone): blur the IP and anything personal. README references `images/pi-vitals-light.png`.
- Switch the repo to public, tag a release (`v1.0.0`), check the HACS validation action passes.
- Hardened 2026-11-03: sensors resolved by integration + translation key; setup banner; simulated German / Pi 4 Ethernet °C / non-Pi / no System Monitor. Still untested on real hardware other than Sam's Pi 5.
- Never copy anything else from home-assistant here (configs, tokens, network details).
