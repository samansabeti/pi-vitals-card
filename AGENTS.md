# Pi Vitals card

Public Home Assistant card (Raspberry Pi health) that Sam is preparing to publish on GitHub/HACS. Follow ~/.agents/AGENTS.md and ../AGENTS.md.

## How it works
- `pi-vitals-card.js`: the card, one file, no dependencies. HACS plugin layout (`hacs.json` filename).
- `extras/pi_vitals.py`: optional command_line sensor script (firmware data through /dev/vcio).
- Source of truth is the home-assistant repo (`cards/system-summary-card.js`, `pi-power/pi_vitals.py`), developed against Sam's live Pi. Run `scripts/sync-from-home.sh` to copy them here; never edit the copies directly.

## Before publishing (needs Sam's OK)
- Screenshots in `images/` (light, dark, phone): blur the IP and anything personal. README references `images/pi-vitals-light.png`.
- Replace `<you>` in README with the GitHub username, create the public repo, push, tag a release (`v1.0.0`), check the HACS validation action passes.
- Not yet tested beyond Sam's Pi 5 on Wi-Fi (Pi 4, Ethernet, non-English installs, missing sensors).
- Never copy anything else from home-assistant here (configs, tokens, network details).
