// Pi Vitals: one-card health view of the Raspberry Pi running Home Assistant.
// Line-art board whose parts light up by status, a verdict with its reasons, 270° gauges, live sparklines,
// storage wear, power and throttling, backups and updates, apps, and a collapsed "more details" drawer.
// Reads System Monitor sensors plus the optional pi_vitals.py command_line sensor (power, throttle flags, clock,
// Wi-Fi signal, SD writes, database growth). Everything optional hides cleanly when its sensor is missing.
// Colors read Sabeti Home tokens (--sh-*) when present; --pv-accent overrides the data hue. No dependencies.
const PV_VERSION = "1.0.0";
const PV_DEFAULTS = {
  prefix: "sensor.system_monitor_", vitals_entity: "sensor.pi_board_power", power_status_entity: "binary_sensor.raspberry_pi_power_status",
  cores: 4, fan_max_rpm: 8000, power_max_w: 10, temp_warn_c: 65, temp_bad_c: 80, backup_stale_days: 3,
};
const PV_TIPS = {
  status: "Overall verdict. Orange when the Pi runs warm or busy, dipped on power or throttled earlier since boot, or backups are overdue. Red when it's throttling right now, short on power or low on space.",
  cpu: "How busy the processor cores are, averaged. Home Assistant normally idles at 1–5%. Short spikes are normal; sustained 80%+ means something is working hard.",
  mem: "RAM apps actually hold. Linux also uses spare RAM as a disk cache, which it hands back instantly, so that isn't counted. Under 70% is comfortable.",
  disk: "Space used on the boot disk. It holds HA, its history database and backups. Keep it under ~80% so updates and backups have room.",
  temp: "CPU temperature. A Pi 5 idles around 40–55 °C. The fan ramps from ~50 °C and at 80 °C the firmware slows the chip to cool it ('throttling').",
  power_g: "Board power from the PMIC's own rails, every 30 s. It leaves out USB devices and supply losses, so wall draw is a bit higher.",
  live: "Live readings over the last 10 minutes. Lines step when a sensor reports a new value.",
  net: "Data moving over the Pi's network link. Down is arriving, up is sent. HA is chatty but small: a few KB/s is normal; bursts come from updates, backups and cameras.",
  ram: "Used is memory apps hold. Free includes cache Linux will hand back instantly.",
  swap: "Overflow memory on disk, much slower than RAM. 0 is ideal; steady use means RAM is tight.",
  storage: "Used vs free on the boot disk.",
  db: "The recorder database that powers history graphs. On an SD card, a big fast-growing database means more writes and more wear. Growth is averaged over up to the last week.",
  writes: "Data written to the boot disk since the Pi booted, and the rate right now. SD cards wear out from writes, so steady high numbers shorten their life. SSDs handle it far better.",
  load: "How many tasks wanted a CPU core, averaged over 1, 5 and 15 minutes. Below the core count means nothing waits. Compare the three to see if it's rising or falling.",
  psi_grid: "Pressure stall info: the share of time tasks were stuck waiting on CPU, memory or disk, over 10 s, 1 min and 5 min. 'Full' means every task was stuck at once. 0% is perfect; above ~10% something is bottlenecked.",
  fan: "Cooling fan speed. 0 rpm is normal when the chip is cool; the firmware ramps it with temperature.",
  uptime: "Time since the Pi itself last booted. HA restarts don't reset it.",
  ip: "The Pi's address on your home network, assigned by your router.",
  uv: "Under-voltage: the supply dipped below what the Pi needs. It causes random crashes and SD corruption. 'Since boot' means it happened at least once. Use the official 27 W (Pi 5) or 15 W (Pi 4) supply.",
  throttle: "Firmware throttling flags. 'Capped' or 'throttled' means the CPU was slowed for heat or power. 'Since boot' flags stay set until the next reboot, so they catch problems you didn't see happen.",
  clock: "Measured CPU clock. It drops when idle and when throttled. Pi 5 tops out at 2,400 MHz, Pi 4 at 1,500–1,800.",
  wifi: "Wi-Fi signal at the Pi. Above −60 dBm is excellent, down to −70 is fine, below −75 expect dropouts. Ethernet is still the most reliable link for a hub.",
  ha: "Versions of Home Assistant OS and its host components.",
  apps: "Apps (formerly add-ons) run alongside Home Assistant. Each shows whether it's running, its version, and CPU and RAM as a share of the whole Pi.",
  updates: "Components with a newer version waiting. Install them from Settings → Updates.",
  ha_stats: "What Home Assistant tracks: entities (every sensor, light and switch), automations and scripts.",
  backup: "Home Assistant's automatic backups: when the last one finished and when the next is due.",
  b_soc: "The processor (BCM2712 on a Pi 5). Its outline takes the temperature color.",
  b_fan: "The cooler. It spins here when the real fan is running, faster with higher rpm.",
  b_led: "Power LED: green when the supply is steady, red on under-voltage.",
  b_sd: "The microSD slot (underneath). It lights up while the Pi is writing to it.",
  b_wifi: "Wi-Fi signal: three arcs is excellent, one is weak.",
};

class PiVitalsCard extends HTMLElement {
  static getStubConfig() { return {}; }
  constructor() { super(); this.attachShadow({ mode: "open" }); this.buf = {}; this.seen = {}; this.sig = ""; this.boardSig = ""; this.built = false; }
  setConfig(c) {
    this.config = { ...PV_DEFAULTS, ...(c || {}) };
    this.P = this.config.prefix;
  }
  getCardSize() { return 12; }
  getGridOptions() { return { columns: "full", rows: "auto" }; }
  get C() {
    return {
      accent: "var(--pv-accent, var(--sh-infra, #2563EB))", climate: "var(--sh-climate, #F27200)", neutral: "var(--sh-neutral, #A1A1A6)",
      ok: "var(--sh-ok, #1F9D45)", warn: "var(--sh-warn, #D97706)", bad: "var(--sh-bad, #E5302A)", text3: "var(--sh-text-3, var(--secondary-text-color))",
    };
  }
  tip(key) { return `<span class="i" tabindex="0" data-tip="${key}" aria-label="What is this?"><ha-icon icon="mdi:information-outline"></ha-icon></span>`; }
  wireTips() {
    const r = this.shadowRoot, box = () => r.querySelector(".tipbox");
    const show = el => {
      const b = box(); if (!b) return;
      b.textContent = (PV_TIPS[el.dataset.tip] || "") + (el.dataset.tip === "backup" && this.config.backup_note ? " " + this.config.backup_note : "");
      b.classList.add("show");
      const rc = el.getBoundingClientRect(), w = Math.min(280, innerWidth - 24);
      b.style.maxWidth = w + "px";
      b.style.left = Math.max(12, Math.min(rc.left + rc.width / 2 - w / 2, innerWidth - w - 12)) + "px";
      const h = b.offsetHeight; b.style.top = (rc.bottom + 8 + h < innerHeight ? rc.bottom + 8 : rc.top - h - 8) + "px";
      this.tipEl = el;
    };
    const hide = () => { box()?.classList.remove("show"); this.tipEl = null; };
    r.addEventListener("mouseover", e => { const el = e.target.closest("[data-tip]"); if (el) show(el); });
    r.addEventListener("mouseout", e => { if (e.target.closest("[data-tip]")) hide(); });
    r.addEventListener("focusin", e => { const el = e.target.closest("[data-tip]"); if (el) show(el); });
    r.addEventListener("focusout", hide);
    r.addEventListener("click", e => { const el = e.target.closest("[data-tip]"); if (el) { e.stopPropagation(); this.tipEl === el ? hide() : show(el); } }, true);
    addEventListener("scroll", hide, { passive: true, capture: true });
  }
  v(id) { const s = this._hass.states[id]; return s && !["unknown", "unavailable"].includes(s.state) ? s.state : null; }
  n(id) { const x = parseFloat(this.v(id)); return Number.isFinite(x) ? x : null; }
  // network interface: config, else the one pi_vitals reports, else first wlan/eth/end with a throughput sensor
  iface() {
    if (this.config.interface) return this.config.interface;
    const va = this._hass.states[this.config.vitals_entity]?.attributes?.wifi_iface;
    const all = Object.keys(this._hass.states).filter(k => k.startsWith(this.P + "network_throughput_in_")).map(k => k.slice((this.P + "network_throughput_in_").length));
    if (va && all.includes(va)) return va;
    return ["wlan0", "eth0", "end0"].find(x => all.includes(x)) || all[0] || "wlan0";
  }
  sparkDefs() {
    const P = this.P, ifc = this.iface(), wired = !/^wl/.test(ifc), tU = this._hass.states[P + "processor_temperature"]?.attributes?.unit_of_measurement || "°C";
    const hasPower = this.n(this.config.vitals_entity) != null;
    return [
      ["cpu", P + "processor_use", "CPU", "%"],
      ["temp", P + "processor_temperature", "Temperature", tU],
      hasPower ? ["power", this.config.vitals_entity, "Board power", "W"] : ["mem", P + "memory_usage", "Memory", "%"],
      ["load", P + "load_1_min", "Load · 1 min", ""],
      ["down", P + `network_throughput_in_${ifc}`, wired ? "Network down" : "Wi-Fi down", "MB/s"],
      ["up", P + `network_throughput_out_${ifc}`, wired ? "Network up" : "Wi-Fi up", "MB/s"],
    ];
  }
  set hass(h) {
    this._hass = h;
    if (this.modal?.isConnected) this.modal.hass = h;
    if (!this.built) this.build();
    const defs = this.sparkDefs(), key = defs.map(d => d[1]).join();
    if (key !== this.sparkKey) { this.sparkKey = key; this.seed(defs); }
    const now = Date.now();
    for (const [, id] of defs) {
      const s = h.states[id], x = s ? parseFloat(s.state) : NaN;
      if (s && Number.isFinite(x) && this.seen[id] !== s.last_updated) {
        this.seen[id] = s.last_updated;
        (this.buf[id] ||= []).push([new Date(s.last_updated).getTime(), x]);
      }
      if (this.buf[id]) this.buf[id] = this.buf[id].filter((p, i, a) => p[0] >= now - PV_WINDOW || (a[i + 1] && a[i + 1][0] >= now - PV_WINDOW));
    }
    const ids = Object.keys(h.states).filter(k => k.startsWith(this.P) || k.startsWith("update.") || k.startsWith("sensor.backup_") || /_(cpu|memory)_percent$|_running$|_version$/.test(k)
      || k === this.config.vitals_entity || k === this.config.power_status_entity);
    const sig = ids.map(k => h.states[k].last_updated).join() + ids.length;
    if (sig !== this.sig) { this.sig = sig; this.render(); }
  }
  async seed(defs) {
    try {
      const start = new Date(Date.now() - PV_WINDOW).toISOString(), ids = defs.map(s => s[1]);
      const res = await this._hass.callWS({ type: "history/history_during_period", start_time: start, entity_ids: ids, minimal_response: true, no_attributes: true, significant_changes_only: false });
      for (const id of ids) {
        const pts = (res[id] || []).map(p => [(p.lu || p.lc) * 1000, parseFloat(p.s)]).filter(p => Number.isFinite(p[1]));
        this.buf[id] = [...pts, ...(this.buf[id] || []).filter(p => !pts.length || p[0] > pts[pts.length - 1][0])];
      }
      this.render();
    } catch (e) { /* live points still accumulate */ }
  }
  build() {
    this.built = true;
    const fill = "var(--sh-fill, rgba(118,118,128,.12))", border = "var(--sh-border, rgba(0,0,0,.08))", text = "var(--sh-text, var(--primary-text-color))",
      text2 = "var(--sh-text-2, var(--secondary-text-color))", text3 = "var(--sh-text-3, var(--secondary-text-color))";
    this.shadowRoot.innerHTML = `<style>
      :host{display:block;--pv-mono:ui-monospace,"SF Mono","JetBrains Mono","Cascadia Mono",Menlo,Consolas,monospace}
      ha-card{container:card/inline-size;padding:16px;font-family:inherit;color:${text};-webkit-font-smoothing:antialiased}
      .body{display:flex;flex-direction:column;gap:16px;margin-top:16px}
      .k{font-family:var(--pv-mono);font-size:10.5px;font-weight:500;color:${text3};text-transform:uppercase;letter-spacing:.07em}
      .num{font-variant-numeric:tabular-nums;line-height:1.1}
      .num b{font-family:var(--pv-mono);font-size:24px;font-weight:600;letter-spacing:-0.03em;color:${text}}.num span{font-size:12px;font-weight:500;color:${text2};margin-left:3px}
      .sub{font-size:12.5px;color:${text2};font-variant-numeric:tabular-nums}
      .mono{font-family:var(--pv-mono);font-variant-numeric:tabular-nums}
      /* hero: board drawing on graph paper + verdict */
      .hero{display:grid;grid-template-columns:minmax(0,300px) minmax(0,1fr);gap:20px;align-items:start}
      .board{border-radius:6px;border:1px solid ${border};padding:14px 12px;display:grid;place-items:center;
        background:radial-gradient(color-mix(in srgb, ${text3} 30%, transparent) .8px, transparent .9px) 0 0/12px 12px, var(--sh-surface-2, #FAFAFB)}
      .board svg{width:100%;max-width:280px;height:auto;overflow:visible}
      .board .pcb{fill:var(--sh-surface, var(--card-background-color, #fff));stroke:${text3};stroke-width:1.2}
      .board .ln{fill:none;stroke:${text3};stroke-width:1.1}
      .board .pt{fill:var(--sh-surface, #fff);stroke:${text3};stroke-width:1.1}
      .board .pin{fill:${text3};opacity:.55}
      .board .lbl{font-family:var(--pv-mono);font-size:6.5px;fill:${text3};letter-spacing:.06em}
      .board [data-tip]{cursor:help}
      .board .fan{transform-box:fill-box;transform-origin:center;animation:spin var(--d,1s) linear infinite}
      .board .fan.off{animation:none}
      .board .sd.on{animation:blink 1.2s ease-in-out infinite}
      .board .led{filter:drop-shadow(0 0 2px currentColor)}
      @keyframes spin{to{transform:rotate(360deg)}}@keyframes blink{50%{opacity:.35}}
      @media (prefers-reduced-motion:reduce){.board .fan,.board .sd.on{animation:none}}
      .verdict{container:verdict/inline-size;display:flex;flex-direction:column;gap:10px;min-width:0}
      .vhead{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
      .model{font-family:var(--pv-mono);font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--pv-accent, var(--sh-infra, #2563EB))}
      .upt{margin-left:auto;font-family:var(--pv-mono);font-size:11px;color:${text3}}
      .vtitle{display:flex;align-items:center;gap:10px;font-size:20px;font-weight:600;letter-spacing:-0.01em}
      .vtitle i{flex:none;width:10px;height:10px;border-radius:50%;box-shadow:0 0 0 4px color-mix(in srgb, currentColor 0%, transparent)}
      .checks{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 18px}
      .check{display:grid;grid-template-columns:8px 84px minmax(0,1fr) auto;align-items:baseline;gap:8px;padding:7px 0;border-top:1px solid ${border};font-size:13px}
      .check i{width:6px;height:6px;border-radius:50%;transform:translateY(-1px)}
      .check .ck{font-family:var(--pv-mono);font-size:10.5px;text-transform:uppercase;letter-spacing:.07em;color:${text3}}
      .check .cv{color:${text};font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis}
      .check .cv span{color:${text2}}
      /* gauges */
      .gauges{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px}
      .gauge{display:flex;flex-direction:column;align-items:center;text-align:center;gap:2px;padding:6px 4px;border-radius:6px}
      .gauge[data-detail]{cursor:pointer;transition:background .15s}
      .gauge[data-detail]:hover,.gauge[data-detail]:focus-visible{background:${fill};outline:none}
      .gauge .g{position:relative;width:96px;height:84px}
      .gauge svg{width:96px;height:96px;position:absolute;top:0;left:0}
      .gauge circle{fill:none;stroke-width:6;stroke-linecap:round}
      .gauge .trk{stroke:${fill}}.gauge .val{transition:stroke-dasharray .6s ease,stroke .3s}
      .gauge .tick{stroke:${text3};stroke-width:1;opacity:.6}.gauge .tick.maj{stroke-width:1.4;opacity:.9}
      .gauge .gv{position:absolute;inset:0 0 6px;display:flex;flex-direction:column;align-items:center;justify-content:center}
      .gauge .gv b{font-family:var(--pv-mono);font-size:21px;font-weight:600;letter-spacing:-0.04em;font-variant-numeric:tabular-nums}
      .gauge .gv span{font-family:var(--pv-mono);font-size:10px;color:${text2};margin-top:1px}
      .gauge .sub{font-size:12px;line-height:1.3}
      /* panels */
      .panel{background:var(--sh-surface-2, #FAFAFB);border:1px solid ${border};border-radius:6px;padding:12px 14px}
      .live-k{display:flex;align-items:center;gap:6px}
      .pulse{width:6px;height:6px;border-radius:50%;background:var(--sh-ok, #1F9D45);box-shadow:0 0 0 0 color-mix(in srgb, var(--sh-ok, #1F9D45) 60%, transparent);animation:p 2s infinite}
      @keyframes p{70%{box-shadow:0 0 0 6px color-mix(in srgb, var(--sh-ok, #1F9D45) 0%, transparent)}100%{box-shadow:0 0 0 0 color-mix(in srgb, var(--sh-ok, #1F9D45) 0%, transparent)}}
      .sparks{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:14px;margin-top:10px}
      .spark .num b{font-size:17px;letter-spacing:-0.02em}
      .spark svg{display:block;width:100%;height:40px;margin-top:4px;overflow:visible}
      .spark .lbl{font-size:12px;font-weight:500;color:${text2};white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .grid3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}
      .row{margin-top:10px}
      .rowh{display:flex;justify-content:space-between;align-items:baseline;gap:8px;font-size:13px;color:${text2}}
      .rowh b{color:${text};font-variant-numeric:tabular-nums;font-weight:600}
      .bar{display:flex;height:6px;border-radius:999px;overflow:hidden;background:${fill};margin-top:6px}
      .bar span{display:block;height:100%;border-radius:999px;transition:width .6s ease}
      .kvs{margin-top:6px}
      .kvr{display:flex;justify-content:space-between;align-items:baseline;gap:10px;padding:7px 0;border-top:1px solid ${border};font-size:13px;color:${text2}}
      .kvr:first-child{border-top:0}
      .kvr>span:first-child{white-space:nowrap}
      .kvr b{font-weight:600;color:${text};font-variant-numeric:tabular-nums;text-align:right}
      .kvr .x{font-weight:400;color:${text3}}
      .flags{display:flex;flex-wrap:wrap;gap:4px;justify-content:flex-end}
      .loads{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-top:8px}
      .loads .num b{font-size:19px}
      .mini{height:6px;border-radius:999px;background:${fill};margin-top:6px;overflow:hidden}.mini span{display:block;height:100%;background:var(--pv-accent, var(--sh-infra, #2563EB));border-radius:999px}
      .facts{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px 16px;margin-top:12px}
      .fact .val{font-size:13.5px;font-weight:600;color:${text};font-variant-numeric:tabular-nums;margin-top:4px}
      .foot{font-size:12px;color:${text3}}
      .i{display:inline-grid;place-items:center;cursor:help;color:${text3};vertical-align:middle;outline:none;margin-left:2px}
      .i ha-icon{--mdc-icon-size:14px}.i:hover,.i:focus{color:var(--sh-accent, #2563EB)}
      .k .i ha-icon{--mdc-icon-size:13px}
      .tipbox{position:fixed;z-index:10;max-width:280px;background:var(--sh-surface, var(--card-background-color, #FFFFFF));color:${text};border:1px solid ${border};font-size:13px;line-height:1.4;padding:10px 12px;border-radius:8px;box-shadow:var(--sh-overlay-shadow, 0 8px 24px rgba(0,0,0,.14));pointer-events:none;opacity:0;transition:opacity .12s;text-transform:none;letter-spacing:0;font-weight:400;font-family:inherit}
      .tipbox.show{opacity:1}
      table{width:100%;border-collapse:collapse;font-size:13px;font-variant-numeric:tabular-nums;margin-top:8px}
      th{font-family:var(--pv-mono);font-size:10.5px;font-weight:500;color:${text3};text-transform:uppercase;letter-spacing:.07em;text-align:right;padding:0 0 6px 10px}
      th:first-child,td:first-child{text-align:left;padding-left:0}
      td{padding:8px 0 8px 10px;border-top:1px solid ${border};text-align:right;color:${text};white-space:nowrap}
      td:first-child{white-space:normal}
      td .sub{font-size:11px}
      .pill{display:inline-flex;align-items:center;gap:6px;height:22px;box-sizing:border-box;padding:0 8px;border-radius:999px;background:${fill};font-size:12px;font-weight:500;color:${text2};vertical-align:middle;white-space:nowrap}
      .pill::before{content:"";flex:none;width:6px;height:6px;border-radius:50%;background:var(--sh-neutral, #A1A1A6)}
      .on::before{background:var(--sh-ok, #1F9D45)}.off::before{background:var(--sh-neutral, #A1A1A6)}.upd::before{background:var(--sh-warn, #D97706)}.bad::before{background:var(--sh-bad, #E5302A)}
      .pv{display:inline-block;min-width:44px;box-sizing:border-box;text-align:center;font-family:var(--pv-mono);font-size:11.5px;font-weight:500;padding:3px 7px;border-radius:999px;background:${fill}}
      .kv{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-top:8px}
      .kv .num b{font-size:19px}
      details.more{border-top:1px solid ${border};padding-top:12px}
      details.more summary{list-style:none;cursor:pointer;display:flex;align-items:center;gap:8px;font-size:13px;color:${text2};user-select:none}
      details.more summary::-webkit-details-marker{display:none}
      details.more summary ha-icon{--mdc-icon-size:18px;transition:transform .2s}
      details.more[open] summary ha-icon{transform:rotate(90deg)}
      details.more summary b{color:${text};font-weight:600}
      details.more .grid3{margin-top:12px}
      @container verdict (max-width:560px){.checks{grid-template-columns:1fr}}
      @container card (max-width:860px){.grid3{grid-template-columns:1fr}.sparks{grid-template-columns:repeat(3,minmax(0,1fr))}.facts{grid-template-columns:repeat(2,minmax(0,1fr))}}
      @container card (max-width:700px){.hero{grid-template-columns:1fr}.board svg{max-width:260px}}
      @container card (max-width:520px){.apps td:first-child .sub,.apps .pt,.blurb{display:none}.apps .pill{padding:0 6px;gap:0}.apps td,.apps th{padding-left:6px}.apps td{font-size:12px}.sparks{grid-template-columns:repeat(2,minmax(0,1fr))}.gauges{grid-template-columns:repeat(3,minmax(0,1fr))}}
    </style><ha-card><div class="hero"><div class="board"></div><div class="verdict"></div></div><div class="body"></div><div class="tipbox"></div></ha-card>`;
    this.wireTips();
    const open = el => {
      const [id, title, color, decimals, range] = el.dataset.detail.split("|");
      if (window.shDetailChart) this.modal = window.shDetailChart.open(this._hass, { entity: id, title, icon: "mdi:raspberry-pi", color, decimals: +decimals, range });
      else this.dispatchEvent(new CustomEvent("hass-more-info", { bubbles: true, composed: true, detail: { entityId: id } }));
    };
    this.shadowRoot.addEventListener("click", e => {
      const s = e.target.closest("summary"); if (s) { this.moreOpen = !s.parentElement.open; return; }
      const g = e.target.closest("[data-detail]"); if (g && !e.target.closest("[data-tip]")) open(g);
    });
    this.shadowRoot.addEventListener("keydown", e => { const g = e.target.closest?.("[data-detail]"); if (g && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); open(g); } });
  }
  // 270° gauge with a tick ring; gap at the bottom
  gauge(pct, color) {
    const r = 34, cx = 48, cy = 48, c = 2 * Math.PI * r, arc = c * 0.75, p = Math.max(0, Math.min(100, pct ?? 0)) / 100;
    let ticks = "";
    for (let i = 0; i <= 10; i++) {
      const a = (135 + 27 * i) * Math.PI / 180, maj = i % 5 === 0, r1 = 40.5, r2 = maj ? 45 : 43.5;
      ticks += `<line class="tick${maj ? " maj" : ""}" x1="${(cx + r1 * Math.cos(a)).toFixed(1)}" y1="${(cy + r1 * Math.sin(a)).toFixed(1)}" x2="${(cx + r2 * Math.cos(a)).toFixed(1)}" y2="${(cy + r2 * Math.sin(a)).toFixed(1)}"/>`;
    }
    return `<svg viewBox="0 0 96 96"><g transform="rotate(135 ${cx} ${cy})"><circle class="trk" cx="${cx}" cy="${cy}" r="${r}" stroke-dasharray="${arc.toFixed(1)} ${c.toFixed(1)}"/>
      <circle class="val" cx="${cx}" cy="${cy}" r="${r}" style="stroke:${color}" stroke-dasharray="${(arc * p).toFixed(1)} ${c.toFixed(1)}"/></g>${ticks}</svg>`;
  }
  spark(id, color) {
    const pts = this.buf[id] || [], now = Date.now(), t0 = now - PV_WINDOW, W = 200, H = 40;
    if (!pts.length) return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"></svg>`;
    const vals = pts.map(p => p[1]), lo = Math.min(...vals), hi = Math.max(...vals), pad = (hi - lo) * 0.15 || Math.max(Math.abs(hi) * 0.05, 0.5);
    const y = v => H - 2 - ((v - (lo - pad)) / ((hi + pad) - (lo - pad))) * (H - 4), x = t => Math.max(0, (t - t0) / PV_WINDOW) * W;
    let d = "", last = null;
    for (const [t, v] of pts) { const X = x(t).toFixed(1), Y = y(v).toFixed(1); d += d ? `H${X}V${Y}` : `M${X} ${Y}`; last = Y; }
    d += `H${W}`;
    const gid = "g" + id.replace(/\W/g, "");
    return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:${color};stop-opacity:.22"/><stop offset="1" style="stop-color:${color};stop-opacity:0"/></linearGradient></defs>
      <path d="${d}V${H}H${x(pts[0][0]).toFixed(1)}Z" fill="url(#${gid})"/><path d="${d}" fill="none" style="stroke:${color}" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>
      <circle cx="${W}" cy="${last}" r="2.6" style="fill:${color}"/></svg>`;
  }
  // Pi 5 line drawing (85 × 56 mm at 2 px/mm). Parts carry live state; redrawn only when that state changes.
  board(s) {
    const C = this.C, arcs = [[6, 1], [10, 2], [14, 3]];
    const wifi = s.wifi == null ? "" : `<g data-tip="b_wifi" transform="translate(28 50)">${arcs.map(([r, i]) =>
      `<path d="M${-r * .7} ${-r * .7}A${r} ${r} 0 0 1 ${r * .7} ${-r * .7}" fill="none" stroke-width="2" stroke-linecap="round" style="stroke:${i <= s.wifi ? C.accent : C.text3};opacity:${i <= s.wifi ? 1 : .35}"/>`).join("")}
      <circle r="1.8" style="fill:${s.wifi ? C.accent : C.text3}"/><rect x="-16" y="-16" width="32" height="20" fill="transparent"/></g>`;
    const pins = Array.from({ length: 20 }, (_, i) => `<rect class="pin" x="${17 + i * 5}" y="4.5" width="2.4" height="2.4"/><rect class="pin" x="${17 + i * 5}" y="9.5" width="2.4" height="2.4"/>`).join("");
    const fan = s.fan == null ? "" : `<g data-tip="b_fan"><circle class="ln" cx="68" cy="58" r="27" stroke-dasharray="2 3"/>
      <g class="fan${s.fan ? "" : " off"}" style="--d:${s.fanDur}s">${Array.from({ length: 7 }, (_, i) =>
        `<path d="M68 58 q 4 -12 0 -22" class="ln" transform="rotate(${i * 360 / 7} 68 58)" style="stroke:${s.fan ? C.accent : C.text3};opacity:.7"/>`).join("")}</g></g>`;
    return `<svg viewBox="-10 -6 196 126" role="img" aria-label="Raspberry Pi board status">
      <rect class="pcb" x="0" y="0" width="170" height="112" rx="7"/>
      ${[[7, 7], [123, 7], [7, 105], [123, 105]].map(([x, y]) => `<circle class="ln" cx="${x}" cy="${y}" r="3.2"/>`).join("")}
      <rect class="ln" x="14" y="2" width="102" height="12" rx="1.5"/>${pins}
      <rect class="pt" x="150" y="5" width="30" height="27" rx="2"/><text class="lbl" x="165" y="21" text-anchor="middle">ETH</text>
      <rect class="pt" x="152" y="40" width="28" height="26" rx="2"/><rect class="pt" x="152" y="73" width="28" height="26" rx="2"/>
      <text class="lbl" x="166" y="56" text-anchor="middle">USB</text><text class="lbl" x="166" y="89" text-anchor="middle">USB</text>
      <rect class="pt" x="14" y="104" width="16" height="11" rx="4"/><rect class="pt" x="44" y="106" width="13" height="8" rx="1.5"/><rect class="pt" x="66" y="106" width="13" height="8" rx="1.5"/>
      <g data-tip="b_sd"><rect class="sd${s.sd ? " on" : ""}" x="-8" y="44" width="11" height="24" rx="2" fill="none" stroke-width="1.4" stroke-dasharray="${s.sd ? "none" : "2 2"}" style="stroke:${s.sd ? C.accent : C.text3}"/>
        <text class="lbl" x="-2.5" y="77" text-anchor="middle">SD</text></g>
      <g data-tip="b_led"><circle class="led" cx="10" cy="92" r="2.8" style="fill:${s.led};color:${s.led}"/><text class="lbl" x="16" y="94.5">PWR</text></g>
      ${wifi}
      <rect class="pt" x="94" y="44" width="20" height="26" rx="2"/><text class="lbl" x="104" y="80" text-anchor="middle">RAM</text>
      <rect class="pt" x="124" y="48" width="16" height="16" rx="1.5"/><text class="lbl" x="132" y="74" text-anchor="middle">RP1</text>
      ${fan}
      <g data-tip="b_soc"><rect x="53" y="43" width="30" height="30" rx="3" stroke-width="1.6" style="fill:color-mix(in srgb, ${s.soc} 16%, var(--sh-surface, #fff));stroke:${s.soc}"/>
        <text class="lbl" x="68" y="60.5" text-anchor="middle" style="fill:${s.soc}">${s.chip}</text></g>
    </svg>`;
  }
  render() {
    if (!this._hass || !this.config) return;
    const cfg = this.config, C = this.C, H = this._hass.states, P = this.P;
    const n = id => this.n(P + id), v = id => this.v(P + id);
    const hn = id => { const x = parseFloat(H[id]?.state); return Number.isFinite(x) ? x : null; };
    const VA = H[cfg.vitals_entity]?.attributes || {}, watts = hn(cfg.vitals_entity);
    const cores = cfg.cores;
    const cpu = n("processor_use"), mem = n("memory_usage"), disk = n("disk_usage"), tRaw = n("processor_temperature");
    const tU = H[P + "processor_temperature"]?.attributes?.unit_of_measurement || "°C", isF = /F/.test(tU);
    const tC = tRaw == null ? null : isF ? (tRaw - 32) * 5 / 9 : tRaw;
    const tTxt = c => isF ? `${Math.round(c * 9 / 5 + 32)}` : c.toFixed(0);
    const memUse = n("memory_use"), memFree = n("memory_free"), memTot = memUse != null && memFree != null ? memUse + memFree : null;
    const dUse = n("disk_use"), dFree = n("disk_free"), dTot = dUse != null && dFree != null ? dUse + dFree : null;
    const swap = n("swap_usage"), swapUse = n("swap_use"), fan = n("pwmfan_fan_speed") ?? n("fan_speed");
    const l1 = n("load_1_min"), l5 = n("load_5_min"), l15 = n("load_15_min");
    const ps = H[cfg.power_status_entity]?.state;
    const thr = VA.throttled, tNow = thr?.now || [], tBoot = thr?.since_boot || [];
    const uvNow = ps === "on" || tNow.includes("under_voltage"), uvBoot = tBoot.includes("under_voltage");
    const slowNow = tNow.some(f => f !== "under_voltage"), slowBoot = tBoot.some(f => f !== "under_voltage");
    const boot = v("uptime") || v("last_boot"), up = boot ? this.dur(Date.now() - new Date(boot)) : null;
    const ver = id => H[id]?.attributes?.installed_version || "—";
    const model = cfg.title || (H["update.raspberry_pi_5_firmware"] ? "Raspberry Pi 5" : Object.keys(H).some(k => /raspberry_pi_4/.test(k)) ? "Raspberry Pi 4" : "Raspberry Pi");
    const tempColor = tC == null ? C.neutral : tC >= cfg.temp_bad_c ? C.bad : tC >= cfg.temp_warn_c ? C.warn : C.climate;
    const busy = (x, warn, bad) => x == null ? C.neutral : x >= bad ? C.bad : x >= warn ? C.warn : null;
    const gb = mib => (mib / 1024).toFixed(1);
    const ago = id => { const s = H[id]?.state; if (!s || ["unknown", "unavailable"].includes(s)) return null; const ms = Date.now() - new Date(s); return ms >= 0 ? this.dur(ms) + " ago" : "in " + this.dur(-ms); };
    const backupAgeD = (() => { const s = H["sensor.backup_last_successful_automatic_backup"]?.state; const t = s && new Date(s); return t && !isNaN(t) ? (Date.now() - t) / 864e5 : null; })();
    const updates = Object.values(H).filter(e => e.entity_id.startsWith("update."));
    const pendingU = updates.filter(u => u.state === "on").sort((a, b) => (a.attributes.friendly_name || "").localeCompare(b.attributes.friendly_name || ""));
    const ifc = this.iface(), wired = !/^wl/.test(ifc);
    const dbm = VA.wifi_dbm, wifiBars = wired || dbm == null ? null : dbm > -60 ? 3 : dbm > -70 ? 2 : 1;
    const devKind = d => !d ? null : /^mmcblk/.test(d) ? "SD card" : /^nvme/.test(d) ? "NVMe SSD" : "USB drive";

    // verdict: worst issue wins
    const issues = [];
    if (uvNow) issues.push([2, "Power supply problem"]);
    if (slowNow) issues.push([2, "Throttling right now"]);
    if (tC != null && tC >= cfg.temp_bad_c) issues.push([2, "Running too hot"]);
    if ((mem ?? 0) >= 90 || (disk ?? 0) >= 90) issues.push([2, "Running low on space"]);
    if (uvBoot && !uvNow) issues.push([1, "Power dipped since boot"]);
    if (slowBoot && !slowNow) issues.push([1, "Throttled earlier since boot"]);
    if ((tC ?? 0) >= cfg.temp_warn_c || (cpu ?? 0) >= 80 || (mem ?? 0) >= 75 || (disk ?? 0) >= 80) issues.push([1, "Working hard"]);
    if (backupAgeD != null && backupAgeD > cfg.backup_stale_days) issues.push([1, "Backups overdue"]);
    const worst = issues.reduce((m, i) => Math.max(m, i[0]), 0);
    const verdict = worst ? issues.find(i => i[0] === worst)[1] : "All systems normal";
    const vColor = [C.ok, C.warn, C.bad][worst];

    // board, redrawn only when its state changes
    const bs = { soc: tempColor, chip: model.includes("5") ? "BCM2712" : "SoC", fan: fan == null ? null : fan > 0, fanDur: fan ? Math.max(0.25, Math.round(2400 / fan * 4) / 4) : 1,
      led: uvNow ? C.bad : C.ok, wifi: wifiBars, sd: (VA.disk_write_kbs ?? 0) > 50 && /^mmcblk/.test(VA.disk_device || "") };
    const bsig = JSON.stringify(bs);
    if (bsig !== this.boardSig) { this.boardSig = bsig; this.shadowRoot.querySelector(".board").innerHTML = this.board(bs); }

    // checklist rows
    const dot = c => `<i style="background:${c}"></i>`;
    const checks = [];
    if (watts != null || ps) checks.push([uvNow ? C.bad : uvBoot ? C.warn : C.ok, "Power", `${uvNow ? "Under-voltage now" : uvBoot ? "Dipped since boot" : "Stable since boot"}${watts != null ? ` <span>· ${watts.toFixed(2)} W</span>` : ""}`, "uv"]);
    if (thr) checks.push([slowNow ? C.bad : slowBoot ? C.warn : C.ok, "Throttling", `${slowNow ? "Active now" : slowBoot ? "Earlier since boot" : "None since boot"}${VA.arm_mhz ? ` <span>· ${VA.arm_mhz.toLocaleString()} MHz</span>` : ""}`, "throttle"]);
    if (disk != null) checks.push([busy(disk, 80, 90) || C.ok, "Storage", `${devKind(VA.disk_device) || "Disk"} · ${Math.round(disk)}% used${VA.db_mb ? ` <span>· DB ${VA.db_mb >= 1000 ? (VA.db_mb / 1000).toFixed(1) + " GB" : Math.round(VA.db_mb) + " MB"}</span>` : ""}`, "storage"]);
    if (H["sensor.backup_last_successful_automatic_backup"]) checks.push([backupAgeD == null ? C.neutral : backupAgeD > cfg.backup_stale_days ? C.warn : C.ok, "Backups", `${ago("sensor.backup_last_successful_automatic_backup") || "None yet"}${ago("sensor.backup_next_scheduled_automatic_backup") ? ` <span>· next ${ago("sensor.backup_next_scheduled_automatic_backup")}</span>` : ""}`, "backup"]);
    checks.push([pendingU.length ? C.warn : C.ok, "Updates", pendingU.length ? `${pendingU.length} available <span>· ${pendingU.slice(0, 2).map(u => (u.attributes.friendly_name || "").replace(/ update$/i, "")).join(", ")}${pendingU.length > 2 ? "…" : ""}</span>` : `All current <span>· ${updates.length} tracked</span>`, "updates"]);
    if (wired) checks.push([C.ok, "Network", `Ethernet <span>· ${ifc}</span>`, "net"]);
    else if (dbm != null) checks.push([dbm > -67 ? C.ok : dbm > -75 ? C.warn : C.bad, "Wi-Fi", `${dbm > -60 ? "Excellent" : dbm > -70 ? "Good" : dbm > -75 ? "Fair" : "Weak"} <span>· ${dbm} dBm</span>`, "wifi"]);

    this.shadowRoot.querySelector(".verdict").innerHTML = `
      <div class="vhead"><span class="model">${model}</span><span class="upt">${up ? "UP " + up.toUpperCase() : ""}</span></div>
      <div class="vtitle" style="color:${vColor}"><i style="background:${vColor}"></i><span style="color:var(--sh-text, var(--primary-text-color))">${verdict}</span>${this.tip("status")}</div>
      <div class="checks">${checks.map(([c, k, val, t]) => `<div class="check">${dot(c)}<span class="ck">${k}</span><span class="cv">${val}</span>${this.tip(t)}</div>`).join("")}</div>`;

    // gauges
    const gauges = [
      ["CPU", "cpu", cpu == null ? "—" : Math.round(cpu), "%", cpu, busy(cpu, 60, 85) || C.accent, cpu == null ? "" : `load ${l1 ?? "—"} · ${cores} cores`, `${P}processor_use|CPU|infra|0|6H`],
      ["Memory", "mem", mem == null ? "—" : Math.round(mem), "%", mem, busy(mem, 70, 90) || C.accent, memTot ? `${gb(memUse)} of ${gb(memTot)} GB` : "", `${P}memory_usage|Memory|infra|0|6H`],
      ["Disk", "disk", disk == null ? "—" : Math.round(disk), "%", disk, busy(disk, 75, 90) || C.accent, dTot ? `${dUse.toFixed(1)} of ${dTot.toFixed(0)} GB` : "", `${P}disk_usage|Disk|infra|1|7D`],
      ["Temp", "temp", tC == null ? "—" : tTxt(tC), tU, tC == null ? 0 : tC / 85 * 100, tempColor, tC == null ? "" : `${isF ? tC.toFixed(1) + " °C · " : ""}${fan != null ? (fan ? Math.round(fan).toLocaleString() + " rpm" : "fan idle") : ""}`.replace(/ · $/, ""), `${P}processor_temperature|CPU temperature|climate|1|1H`],
    ];
    if (watts != null) gauges.push(["Power", "power_g", watts.toFixed(2), "W", watts / cfg.power_max_w * 100, C.accent, "board · USB excluded", `${cfg.vitals_entity}|Pi board power|infra|2|6H`]);
    const gaugesHtml = gauges.map(([name, t, val, u, pct, col, sub, det]) => `<div class="gauge" data-detail="${det}" role="button" tabindex="0" aria-label="Open ${name} history">
      <div class="g">${this.gauge(pct, col)}<div class="gv"><b>${val}</b><span>${u}</span></div></div>
      <div class="k">${name} ${this.tip(t)}</div><div class="sub">${sub}</div></div>`).join("");

    // sparks
    const fmt = (x, u) => x == null ? "—" : u === "MB/s" ? (x < 1 ? (x * 1000).toFixed(0) : x.toFixed(1)) : u === "W" ? x.toFixed(2) : /°/.test(u) ? x.toFixed(0) : u === "" ? x.toFixed(2) : Math.round(x);
    const unit = (x, u) => u === "MB/s" ? (x != null && x < 1 ? "KB/s" : "MB/s") : u;
    const sparks = this.sparkDefs().map(([key, id, name, u]) => { const x = this.n(id), col = key === "temp" ? C.climate : C.accent; return `<div class="spark">
      <div class="lbl">${name}${key === "down" ? " " + this.tip("net") : ""}</div>
      <div class="num"><b>${fmt(x, u)}</b><span>${unit(x, u)}</span></div>${this.spark(id, col)}</div>`; }).join("");

    // storage panel
    const sz = mib => mib == null ? "—" : mib >= 1024 ? (mib / 1024).toFixed(2) + " GB" : Math.round(mib) + " MB";
    const mb = x => x >= 1000 ? (x / 1000).toFixed(2) + " GB" : Math.round(x) + " MB";
    const kvr = (label, val, tip) => `<div class="kvr"><span>${label}${tip ? " " + this.tip(tip) : ""}</span><b>${val}</b></div>`;
    const storage = `<div class="panel"><div class="k">Storage${VA.disk_device ? " · " + devKind(VA.disk_device) : ""}</div>
      <div class="row"><div class="rowh"><span>Disk ${this.tip("storage")}</span><span><b>${dUse != null ? dUse.toFixed(1) : "—"} GB</b> used · ${dFree != null ? dFree.toFixed(1) : "—"} free</span></div>
        <div class="bar"><span style="width:${disk ?? 0}%;background:${busy(disk, 80, 90) || C.accent}"></span></div></div>
      <div class="kvs" style="margin-top:10px">
        ${VA.db_mb != null ? kvr("Database", `${mb(VA.db_mb)} <span class="x">· ${VA.db_mb_per_day != null ? (VA.db_mb_per_day >= 0 ? "+" : "") + VA.db_mb_per_day + " MB/day" : "growth after 1 day"}</span>`, "db") : ""}
        ${VA.disk_written_gb != null ? kvr("Written since boot", `${VA.disk_written_gb} GB${VA.disk_write_kbs != null ? ` <span class="x">· ${VA.disk_write_kbs} kB/s now</span>` : ""}`, "writes") : ""}
        ${kvr("Swap", `${swapUse != null ? Math.round(swapUse) : "—"} MB <span class="x">· ${swap ?? "—"}%</span>`, "swap")}
      </div></div>`;
    // power & performance panel
    const flagName = { under_voltage: "Under-voltage", freq_capped: "Capped", throttled: "Throttled", soft_temp_limit: "Soft temp limit" };
    const flagPills = (list, cls) => list.length ? `<span class="flags">${list.map(f => `<span class="pill ${cls}">${flagName[f] || f}</span>`).join("")}</span>` : `<span class="pill on">None</span>`;
    const perf = `<div class="panel"><div class="k">Power & performance</div><div class="kvs">
      ${watts != null ? kvr("Board power", `${watts.toFixed(2)} W`, "power_g") : ""}
      ${VA.arm_mhz ? kvr("CPU clock", `${VA.arm_mhz.toLocaleString()} MHz${model.includes("5") ? ` <span class="x">of 2,400</span>` : ""}`, "clock") : ""}
      ${thr ? kvr("Throttling now", flagPills(tNow, "bad"), "throttle") + kvr("Since boot", flagPills(tBoot, "upd"), "throttle") : ""}
      ${!thr && ps ? kvr("Power supply", ps === "on" ? `<span class="pill bad">Under-voltage</span>` : `<span class="pill on">OK</span>`, "uv") : ""}
      ${fan != null ? kvr("Fan", fan ? `${Math.round(fan).toLocaleString()} rpm <span class="x">· ${Math.round(fan / cfg.fan_max_rpm * 100)}%</span>` : "Idle", "fan") : ""}
      ${!wired && dbm != null ? kvr("Wi-Fi signal", `${dbm} dBm`, "wifi") : ""}
    </div></div>`;
    // backups & updates panel
    const care = `<div class="panel"><div class="k">Backups & updates</div><div class="kvs">
      ${H["sensor.backup_last_successful_automatic_backup"] ? kvr("Last backup", ago("sensor.backup_last_successful_automatic_backup") || "—", "backup") + kvr("Next backup", ago("sensor.backup_next_scheduled_automatic_backup") || "—") : ""}
      ${pendingU.length ? pendingU.map(u => kvr((u.attributes.friendly_name || u.entity_id).replace(/ update$/i, ""), `<span class="x">${u.attributes.installed_version ?? ""} →</span> <span class="pill upd">${u.attributes.latest_version}</span>`)).join("")
        : kvr("Updates", `<span class="pill on">All ${updates.length} current</span>`, "updates")}
    </div></div>`;

    // apps
    const pct1 = x => x == null ? "—" : (x < 10 ? x.toFixed(1) : Math.round(x)) + "%";
    const coreC = hn("sensor.home_assistant_core_cpu_percent"), coreM = hn("sensor.home_assistant_core_memory_percent");
    const supC = hn("sensor.home_assistant_supervisor_cpu_percent"), supM = hn("sensor.home_assistant_supervisor_memory_percent");
    const apps = Object.keys(H).map(k => k.match(/^binary_sensor\.(.+)_running$/)).filter(m => m && H[`sensor.${m[1]}_version`]).map(m => m[1]);
    const appName = slug => (H[`switch.${slug}`]?.attributes?.friendly_name || H[`update.${slug}_update`]?.attributes?.title || slug.replace(/_/g, " ")).replace(/^\w/, c => c.toUpperCase());
    const appsHtml = cfg.show_apps === false ? "" : `<div class="panel"><div class="k">Apps ${this.tip("apps")}</div>
      <table class="apps"><tr><th>App</th><th>Status</th><th>CPU</th><th>RAM</th><th>Version</th></tr>
        ${coreC != null || coreM != null ? [["Home Assistant Core", coreC, coreM, ver("update.home_assistant_core_update")], ["Supervisor", supC, supM, ver("update.home_assistant_supervisor_update")]].map(([nm, c, m, vv]) =>
          `<tr><td>${nm} <span class="sub">system</span></td><td><span class="pill on"><span class="pt">Running</span></span></td><td>${pct1(c)}</td><td>${pct1(m)}</td><td>${vv}</td></tr>`).join("") : ""}
        ${apps.map(a => { const run = H[`binary_sensor.${a}_running`]?.state === "on", upd = H[`update.${a}_update`]?.state === "on";
          return `<tr><td>${appName(a)}</td><td><span class="pill ${run ? "on" : "off"}" title="${run ? "Running" : "Stopped"}"><span class="pt">${run ? "Running" : "Stopped"}</span></span></td>
            <td>${run ? pct1(hn(`sensor.${a}_cpu_percent`)) : "—"}</td><td>${run ? pct1(hn(`sensor.${a}_memory_percent`)) : "—"}</td>
            <td>${H[`sensor.${a}_version`]?.state || "—"}${upd ? ` <span class="pill upd">→ ${H[`sensor.${a}_newest_version`]?.state}</span>` : ""}</td></tr>`; }).join("")}</table></div>`;

    // more details drawer
    const psiChip = x => x == null ? ["—", C.text3] : x >= 10 ? [x.toFixed(1) + "%", C.bad] : x >= 1 ? [x.toFixed(1) + "%", C.warn] : [x.toFixed(1) + "%", C.ok];
    const pv = (r, w) => n(`${r}_pressure_${w}_average`);
    const psiCell = x => { const [t, fg] = psiChip(x); return `<span class="pv" style="color:${fg}">${t}</span>`; };
    const psiRows = [["CPU", "cpu", "some"], ["RAM", "memory", "some"], ["RAM <span class=\"sub\">full</span>", "memory", "full"], ["Disk", "io", "some"], ["Disk <span class=\"sub\">full</span>", "io", "full"]];
    const loadBar = x => `<div class="mini"><span style="width:${Math.min(100, (x ?? 0) / cores * 100)}%"></span></div>`;
    const netIn = n(`network_in_${ifc}`), netOut = n(`network_out_${ifc}`), pIn = n(`packets_in_${ifc}`), pOut = n(`packets_out_${ifc}`);
    const cnt = x => x == null ? "—" : x >= 1e6 ? (x / 1e6).toFixed(2) + "M" : x >= 1e3 ? (x / 1e3).toFixed(1) + "K" : x;
    const days = boot ? (Date.now() - new Date(boot)) / 864e5 : null;
    const count = d => Object.keys(H).filter(k => k.startsWith(d + ".")).length;
    const ipv4 = v(`ipv4_address_${ifc}`);
    const more = `<details class="more"${this.moreOpen ? " open" : ""}><summary><ha-icon icon="mdi:chevron-right"></ha-icon><b>More details</b><span class="blurb">memory, load and stall pressure, network counters, platform</span></summary>
      <div class="grid3">
        <div class="panel"><div class="k">Memory</div>
          <div class="row"><div class="rowh"><span>RAM ${this.tip("ram")}</span><span><b>${memUse != null ? gb(memUse) : "—"} GB</b> used · ${memFree != null ? gb(memFree) : "—"} free</span></div>
            <div class="bar"><span style="width:${mem ?? 0}%;background:${C.accent}"></span></div></div>
          <div class="row"><div class="rowh"><span>Swap ${this.tip("swap")}</span><span><b>${swapUse != null ? Math.round(swapUse) : "—"} MB</b> · ${swap ?? "—"}%</span></div>
            <div class="bar"><span style="width:${swap ?? 0}%;background:${C.accent}"></span></div></div>
          <div class="kv"><div><div class="sub">Disk total</div><div class="num"><b>${hn("sensor.home_assistant_host_disk_total") ?? (dTot ? dTot.toFixed(0) : "—")}</b><span>GB</span></div></div>
            <div><div class="sub">RAM total</div><div class="num"><b>${memTot ? gb(memTot) : "—"}</b><span>GB</span></div></div></div></div>
        <div class="panel"><div class="k">Load average ${this.tip("load")}</div>
          <div class="loads">${[["1 min", l1], ["5 min", l5], ["15 min", l15]].map(([k, x]) => `<div><div class="sub">${k}</div><div class="num"><b>${x != null ? x.toFixed(2) : "—"}</b></div>${loadBar(x)}</div>`).join("")}</div>
          <div class="k" style="margin-top:14px">Stall pressure ${this.tip("psi_grid")}</div>
          <table><tr><th></th><th>10 s</th><th>1 min</th><th>5 min</th></tr>
            ${psiRows.map(([k, r, w]) => `<tr><td>${k}</td><td>${psiCell(pv(r, w + "_10s"))}</td><td>${psiCell(pv(r, w + "_60s"))}</td><td>${psiCell(pv(r, w + "_300s"))}</td></tr>`).join("")}</table></div>
        <div class="panel"><div class="k">${wired ? "Network" : "Wi-Fi"} · since boot ${this.tip("net")}</div>
          <div class="kv"><div><div class="sub">Downloaded</div><div class="num"><b>${sz(netIn).split(" ")[0]}</b><span>${sz(netIn).split(" ")[1] || ""}</span></div></div>
            <div><div class="sub">Uploaded</div><div class="num"><b>${sz(netOut).split(" ")[0]}</b><span>${sz(netOut).split(" ")[1] || ""}</span></div></div>
            <div><div class="sub">Packets in</div><div class="num"><b>${cnt(pIn)}</b></div></div>
            <div><div class="sub">Packets out</div><div class="num"><b>${cnt(pOut)}</b></div></div></div>
          <table><tr><th></th><th>In</th><th>Out</th></tr>
            <tr><td>Per day</td><td>${days ? sz(netIn / days) : "—"}</td><td>${days ? sz(netOut / days) : "—"}</td></tr>
            <tr><td>Now</td><td>${fmt(n(`network_throughput_in_${ifc}`), "MB/s")} ${unit(n(`network_throughput_in_${ifc}`), "MB/s")}</td><td>${fmt(n(`network_throughput_out_${ifc}`), "MB/s")} ${unit(n(`network_throughput_out_${ifc}`), "MB/s")}</td></tr></table></div>
      </div>
      <div class="facts">
        <div class="fact"><div class="k">Uptime ${this.tip("uptime")}</div><div class="val">${up || "—"} <span class="sub">· booted ${boot ? new Date(boot).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—"}</span></div></div>
        <div class="fact"><div class="k">Local IP ${this.tip("ip")}</div><div class="val mono">${ipv4 ?? "—"} <span class="sub">${ifc}</span></div></div>
        <div class="fact"><div class="k">Home Assistant ${this.tip("ha_stats")}</div><div class="val">${Object.keys(H).length.toLocaleString()} entities <span class="sub">· ${count("automation")} automations · ${count("script")} scripts</span></div></div>
        <div class="fact"><div class="k">Platform ${this.tip("ha")}</div><div class="val">OS ${H["sensor.home_assistant_operating_system_version"]?.state ?? "—"} <span class="sub">· Core ${ver("update.home_assistant_core_update")}${H["update.raspberry_pi_5_firmware"] ? " · FW " + ver("update.raspberry_pi_5_firmware") : ""}</span></div></div>
      </div>
      ${cfg.footer ? `<div class="foot" style="margin-top:12px">${cfg.footer}</div>` : ""}
    </details>`;

    const body = this.shadowRoot.querySelector(".body");
    body.innerHTML = `
      <div class="gauges">${gaugesHtml}</div>
      <div class="panel"><div class="k live-k"><span class="pulse"></span>Live · last 10 minutes ${this.tip("live")}</div><div class="sparks">${sparks}</div></div>
      <div class="grid3">${storage}${perf}${care}</div>
      ${appsHtml}
      ${more}`;
    if (this.tipEl) { const el = this.shadowRoot.querySelector(`[data-tip="${this.tipEl.dataset.tip}"]`); if (el) this.tipEl = el; }
  }
  dur(ms) {
    const m = Math.floor(ms / 60000), d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60);
    return d ? `${d}d ${h}h` : h ? `${h}h ${m % 60}m` : `${m}m`;
  }
}
const PV_WINDOW = 10 * 60e3;
if (!customElements.get("pi-vitals-card")) customElements.define("pi-vitals-card", PiVitalsCard);
window.customCards = window.customCards || [];
if (!window.customCards.some(c => c.type === "pi-vitals-card")) window.customCards.push({ type: "pi-vitals-card", name: "Pi Vitals", description: "Raspberry Pi health at a glance: board status, gauges, live sparklines, storage wear, throttling, backups and updates.", preview: true });
console.info(`%c PI-VITALS-CARD %c v${PV_VERSION} `, "color:#fff;background:#111;font-weight:600", "color:#111;background:#eee");
