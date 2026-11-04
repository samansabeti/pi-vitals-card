// Pi Vitals: one-card health view of the Raspberry Pi running Home Assistant.
// Line-art board whose parts light up by status, status facts, ring gauges, live sparklines with hover,
// storage wear, power and throttling, backups and updates, apps, and a collapsed "more details" drawer.
// Reads System Monitor sensors plus the optional pi_vitals.py command_line sensor (power, throttle flags, clock,
// Wi-Fi signal, SD writes, database growth). Everything optional hides cleanly when its sensor is missing.
// Sensors are found by integration + translation key, so non-English installs work; `prefix` forces the old English-ID lookup.
// Colors read Sabeti Home tokens (--sh-*) when present; --pv-accent overrides the data hue. No dependencies.
const PV_VERSION = "1.0.0";
const PV_DEFAULTS = {
  vitals_entity: "sensor.pi_board_power", power_status_entity: "binary_sensor.raspberry_pi_power_status",
  cores: 4, fan_max_rpm: 8000, power_max_w: 10, temp_warn_c: 65, temp_bad_c: 80, backup_stale_days: 3,
};
// English System Monitor entity suffixes (what the card was written against) → the integration's translation keys
const PV_KEYS = {
  processor_use: "processor_use", memory_usage: "memory_use_percent", disk_usage: "disk_use_percent", processor_temperature: "processor_temperature",
  memory_use: "memory_use", memory_free: "memory_free", disk_use: "disk_use", disk_free: "disk_free", swap_usage: "swap_use_percent", swap_use: "swap_use",
  pwmfan_fan_speed: "fan_speed", fan_speed: "fan_speed", load_1_min: "load_1m", load_5_min: "load_5m", load_15_min: "load_15m", uptime: "last_boot", last_boot: "last_boot",
  network_throughput_in: "throughput_network_in", network_throughput_out: "throughput_network_out",
};
// sensors the card needs to be useful, with the names System Monitor shows for them
const PV_NEEDED = [["processor_use", "Processor use"], ["memory_use_percent", "Memory usage"], ["disk_use_percent", "Disk usage"],
  ["processor_temperature", "Processor temperature"], ["load_1m", "Load (1 min)"], ["throughput_network_in", "Network throughput in"], ["last_boot", "Last boot"]];
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
    this.legacy = !!this.config.prefix;
    this.P = this.config.prefix || "sensor.system_monitor_";
    this.R = null;
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
  // Index the entity registry once per change: System Monitor by translation key, Supervisor devices (Core, Supervisor, OS, host, apps),
  // backups, the Pi power checker and the pi_vitals sensor. Entity IDs follow the install's language, these don't.
  index(h) {
    if (this.R && h.entities === this._E) return;
    this._E = h.entities;
    const E = Object.values(h.entities || {}), R = { sm: {}, apps: [], sys: {}, backup: {}, devs: {} };
    for (const e of E) {
      if (e.platform === "systemmonitor") {
        const k = e.translation_key || (/^(timestamp|uptime)$/.test(h.states[e.entity_id]?.attributes?.device_class || "") ? "last_boot" : null);
        if (k) (R.sm[k] ||= []).push(e.entity_id);
      } else if (e.platform === "backup" && e.translation_key) R.backup[e.translation_key] = e.entity_id;
      else if (e.platform === "rpi_power") R.rpiPower = e.entity_id;
      else if (e.platform === "hassio" && e.device_id) (R.devs[e.device_id] ||= {})[e.entity_id.startsWith("binary_sensor.") ? "running" : e.translation_key] = e.entity_id;
    }
    for (const k in R.sm) R.sm[k].sort((a, b) => a.length - b.length || a.localeCompare(b));
    for (const e of E) if (e.entity_id.startsWith("update.") && R.devs[e.device_id]) R.devs[e.device_id].update = e.entity_id;
    for (const [id, d] of Object.entries(R.devs)) {
      const dev = h.devices?.[id], name = dev?.name_by_user || dev?.name || "";
      if (d.running) R.apps.push({ ...d, name: name || "App" });
      else if (/core/i.test(name) && d.cpu_percent) R.sys.core = d;
      else if (/supervisor/i.test(name) && d.cpu_percent) R.sys.supervisor = d;
      else if (/operating system/i.test(name)) R.sys.os = d;
      else if (d.disk_total) R.sys.host = d;
    }
    R.apps.sort((a, b) => a.name.localeCompare(b.name));
    R.vitals = h.states[this.config.vitals_entity] ? this.config.vitals_entity
      : Object.keys(h.states).find(k => k.startsWith("sensor.") && h.states[k].attributes?.rails && "throttled" in h.states[k].attributes) || this.config.vitals_entity;
    R.power = h.states[this.config.power_status_entity] ? this.config.power_status_entity : R.rpiPower;
    R.hasSM = !this.legacy && Object.keys(R.sm).length > 0;
    R.noRegistry = !h.entities;
    R.watch = new Set([...Object.values(R.sm).flat(), ...Object.values(R.backup), R.power, R.vitals,
      ...Object.values(R.devs).flatMap(d => Object.values(d))].filter(Boolean));
    this.R = R;
  }
  // System Monitor entity for an English suffix ("processor_use", "network_in_wlan0", "cpu_pressure_some_10s_average")
  S(suffix) {
    if (!this.R?.hasSM) return this.P + suffix;
    const sm = this.R.sm;
    let m = suffix.match(/^(network_throughput_in|network_throughput_out|network_in|network_out|packets_in|packets_out|ipv4_address)_(.+)$/);
    if (m) { const tail = "_" + m[2].toLowerCase().replace(/\W/g, "_"); return (sm[PV_KEYS[m[1]] || m[1]] || []).find(id => id.endsWith(tail)); }
    m = suffix.match(/^(cpu|memory|io)_pressure_(some|full)_(\d+)s_average$/);
    if (m) return sm[`${m[1]}_pressure_${m[2]}_avg${m[3]}`]?.[0];
    return sm[PV_KEYS[suffix] || suffix]?.[0];
  }
  // network interface: config, else the one pi_vitals reports, else first wlan/eth/end with a throughput sensor
  iface() {
    if (this.config.interface) return this.config.interface;
    const va = this._hass.states[this.R.vitals]?.attributes?.wifi_iface;
    const all = this.R.hasSM ? (this.R.sm.throughput_network_in || []).map(id => id.split("_").pop())
      : Object.keys(this._hass.states).filter(k => k.startsWith(this.P + "network_throughput_in_")).map(k => k.slice((this.P + "network_throughput_in_").length));
    if (va && all.includes(va)) return va;
    return ["wlan0", "eth0", "end0"].find(x => all.includes(x)) || all[0] || "wlan0";
  }
  sparkDefs() {
    const ifc = this.iface(), wired = !/^wl/.test(ifc), tU = this._hass.states[this.S("processor_temperature")]?.attributes?.unit_of_measurement || "°C";
    const hasPower = this.n(this.R.vitals) != null;
    return [
      ["cpu", this.S("processor_use"), "CPU", "%"],
      ["temp", this.S("processor_temperature"), "Temperature", tU],
      hasPower ? ["power", this.R.vitals, "Board power", "W"] : ["mem", this.S("memory_usage"), "Memory", "%"],
      ["load", this.S("load_1_min"), "Load · 1 min", ""],
      ["down", this.S(`network_throughput_in_${ifc}`), wired ? "Network down" : "Wi-Fi down", "MB/s"],
      ["up", this.S(`network_throughput_out_${ifc}`), wired ? "Network up" : "Wi-Fi up", "MB/s"],
    ].filter(d => d[1] && this._hass.states[d[1]]);
  }
  set hass(h) {
    this._hass = h;
    if (this.modal?.isConnected) this.modal.hass = h;
    if (!this.built) this.build();
    this.index(h);
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
    const W = this.R.watch, ids = Object.keys(h.states).filter(k => k.startsWith("update.") || W.has(k) || (!this.R.hasSM && k.startsWith(this.P)));
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
      :host{display:block}
      ha-card{container:card/inline-size;padding:16px;font-family:inherit;color:${text};-webkit-font-smoothing:antialiased}
      .body{display:flex;flex-direction:column;gap:16px;margin-top:16px}
      .head{display:flex;align-items:center;gap:6px;margin-bottom:14px;min-width:0}.head ha-icon{--mdc-icon-size:18px;color:var(--pv-accent, var(--sh-infra, #0071E3))}
      .title{font-size:15px;font-weight:600;color:var(--pv-accent, var(--sh-infra, #0071E3));white-space:nowrap}
      .upt{flex:1;min-width:0;font-size:13px;color:${text2};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-variant-numeric:tabular-nums}
      .status{display:inline-flex;align-items:center;gap:6px;height:22px;box-sizing:border-box;padding:0 8px;border-radius:999px;background:${fill};font-size:12px;font-weight:500;color:${text2};white-space:nowrap}
      .status i{flex:none;width:6px;height:6px;border-radius:50%}
      .status .i{color:inherit;margin-left:0}
      .k{font-size:11px;font-weight:500;color:${text3};text-transform:uppercase;letter-spacing:.04em}
      .num{font-variant-numeric:tabular-nums;line-height:1.1}
      .num b{font-size:28px;font-weight:600;letter-spacing:-0.02em;color:${text}}.num span{font-size:13px;font-weight:500;color:${text2};margin-left:2px}
      .sub{font-size:13px;color:${text2};font-variant-numeric:tabular-nums}
      /* hero: board drawing + status facts */
      .hero{display:grid;grid-template-columns:minmax(0,272px) minmax(0,1fr);gap:16px;align-items:stretch}
      .hero.solo{grid-template-columns:1fr}
      .board{background:var(--sh-surface-2, #FAFAFB);border:1px solid ${border};border-radius:10px;padding:10px 12px;display:grid;place-items:center}
      .board svg{width:100%;max-width:248px;height:auto;overflow:visible;display:block}
      .board .pcb{fill:var(--sh-surface, var(--card-background-color, #fff));stroke:${text3};stroke-width:1}
      .board .ln{fill:none;stroke:${text3};stroke-width:.9}
      .board .pt{fill:var(--sh-surface, var(--card-background-color, #fff));stroke:${text3};stroke-width:.9}
      .board .pin{fill:${text3};opacity:.55}
      .board .lbl{font-family:inherit;font-size:5.6px;font-weight:600;fill:${text3};letter-spacing:.08em}
      .board [data-tip]{cursor:help}
      .board .fan{transform-box:fill-box;transform-origin:center;animation:spin var(--d,1s) linear infinite}
      .board .fan.off{animation:none}
      .board .sd.on{animation:blink 1.2s ease-in-out infinite}
      @keyframes spin{to{transform:rotate(360deg)}}@keyframes blink{50%{opacity:.35}}
      @media (prefers-reduced-motion:reduce){.board .fan,.board .sd.on{animation:none}}
      .facts2{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px 16px;align-content:center;min-width:0}
      .fx{min-width:0}
      .fx .k{display:flex;align-items:center;gap:6px}.fx .k i{flex:none;width:6px;height:6px;border-radius:50%}
      .fx .val{font-size:15px;font-weight:600;color:${text};margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-variant-numeric:tabular-nums}
      .fx .sub{margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      /* rings */
      .rings{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;align-items:start}
      .ring{display:flex;align-items:center;gap:10px;min-width:0}
      .ring[data-detail]{cursor:pointer;border-radius:10px;margin:-4px;padding:4px;transition:background .15s}
      .ring[data-detail]:hover,.ring[data-detail]:focus-visible{background:${fill};outline:none}
      .ring svg{flex:none;width:58px;height:58px;transform:rotate(-90deg)}
      .ring circle{fill:none;stroke-width:7;stroke-linecap:round}
      .ring .trk{stroke:${fill}}
      .ring .val{transition:stroke-dashoffset .6s ease,stroke .3s}
      .ring>div{min-width:0}
      /* panels */
      .panel{background:var(--sh-surface-2, #FAFAFB);border:1px solid ${border};border-radius:10px;padding:12px 14px}
      .live-k{display:flex;align-items:center;gap:6px}
      .pulse{width:6px;height:6px;border-radius:50%;background:var(--sh-ok, #1F9D45);box-shadow:0 0 0 0 color-mix(in srgb, var(--sh-ok, #1F9D45) 60%, transparent);animation:p 2s infinite}
      @keyframes p{70%{box-shadow:0 0 0 6px color-mix(in srgb, var(--sh-ok, #1F9D45) 0%, transparent)}100%{box-shadow:0 0 0 0 color-mix(in srgb, var(--sh-ok, #1F9D45) 0%, transparent)}}
      .sparks{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:14px;margin-top:10px}
      .spark{min-width:0}
      .spark .num b{font-size:18px;letter-spacing:-0.01em}
      .spark .lbl{display:flex;align-items:center;gap:5px;font-size:12px;font-weight:500;color:${text2};white-space:nowrap}
      .spark .lbl i{flex:none;width:6px;height:6px;border-radius:50%}
      .sv{position:relative;margin-top:4px;touch-action:pan-y;cursor:crosshair;-webkit-user-select:none;user-select:none}
      .sv svg{display:block;width:100%;height:44px;overflow:visible}
      .scur{position:absolute;top:0;bottom:0;width:1px;background:${text3};pointer-events:none;display:none}
      .sdot{position:absolute;width:9px;height:9px;box-sizing:border-box;border-radius:50%;border:2px solid var(--sh-surface, var(--card-background-color, #fff));transform:translate(-50%,-50%);pointer-events:none;display:none}
      .stip{position:absolute;bottom:100%;margin-bottom:6px;pointer-events:none;background:var(--sh-surface, var(--card-background-color, #fff));border:1px solid ${border};border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.18);padding:6px 10px;white-space:nowrap;display:none;z-index:3}
      .stip b{font-size:17px;font-weight:600;font-variant-numeric:tabular-nums;color:${text}}.stip span{font-size:12px;color:${text2}}
      .stip div{font-size:12px;color:${text2};font-variant-numeric:tabular-nums}
      .sv.on .scur,.sv.on .sdot,.sv.on .stip{display:block}
      .grid3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}
      .row{margin-top:10px}
      .rowh{display:flex;justify-content:space-between;align-items:baseline;gap:8px;font-size:13px;color:${text2}}
      .rowh b{color:${text};font-variant-numeric:tabular-nums;font-weight:600}
      .bar{display:flex;height:6px;border-radius:999px;overflow:hidden;background:${fill};margin-top:6px}
      .bar span{display:block;height:100%;border-radius:999px;transition:width .6s ease}
      .kvs{margin-top:6px}
      .kvr{display:flex;justify-content:space-between;align-items:baseline;gap:10px;padding:8px 0;border-top:1px solid ${border};font-size:13px;color:${text2}}
      .kvr:first-child{border-top:0}
      .kvr>span:first-child{white-space:nowrap}
      .kvr b{font-weight:600;color:${text};font-variant-numeric:tabular-nums;text-align:right}
      .kvr .x{font-weight:400;color:${text2}}
      .flags{display:flex;flex-wrap:wrap;gap:4px;justify-content:flex-end}
      .loads{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-top:8px}
      .loads .num b{font-size:22px}
      .mini{height:6px;border-radius:999px;background:${fill};margin-top:6px;overflow:hidden}.mini span{display:block;height:100%;background:var(--pv-accent, var(--sh-infra, #0071E3));border-radius:999px}
      .facts{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px 16px;margin-top:12px}
      .fact .val{font-size:14px;font-weight:600;color:${text};font-variant-numeric:tabular-nums;margin-top:4px}
      .foot{font-size:12px;color:${text3}}
      .i{display:inline-grid;place-items:center;cursor:help;color:${text3};vertical-align:middle;outline:none;margin-left:2px}
      .i ha-icon{--mdc-icon-size:14px}.i:hover,.i:focus{color:var(--sh-accent, #0071E3)}
      .k .i ha-icon{--mdc-icon-size:13px}
      .tipbox{position:fixed;z-index:10;max-width:280px;background:var(--sh-surface, var(--card-background-color, #FFFFFF));color:${text};border:1px solid ${border};font-size:13px;line-height:1.4;padding:10px 12px;border-radius:10px;box-shadow:var(--sh-overlay-shadow, 0 8px 24px rgba(0,0,0,.14));pointer-events:none;opacity:0;transition:opacity .12s;text-transform:none;letter-spacing:0;font-weight:400;font-family:inherit}
      .tipbox.show{opacity:1}
      table{width:100%;border-collapse:collapse;font-size:13px;font-variant-numeric:tabular-nums;margin-top:8px}
      th{font-size:11px;font-weight:500;color:${text3};text-transform:uppercase;letter-spacing:.04em;text-align:right;padding:0 0 6px 10px}
      th:first-child,td:first-child{text-align:left;padding-left:0}
      td{padding:8px 0 8px 10px;border-top:1px solid ${border};text-align:right;color:${text};white-space:nowrap}
      td:first-child{white-space:normal}
      td .sub{font-size:11px}
      .pill{display:inline-flex;align-items:center;gap:6px;height:22px;box-sizing:border-box;padding:0 8px;border-radius:999px;background:${fill};font-size:12px;font-weight:500;color:${text2};vertical-align:middle;white-space:nowrap}
      .pill::before{content:"";flex:none;width:6px;height:6px;border-radius:50%;background:var(--sh-neutral, #A1A1A6)}
      .on::before{background:var(--sh-ok, #1F9D45)}.off::before{background:var(--sh-neutral, #A1A1A6)}.upd::before{background:var(--sh-warn, #D97706)}.bad::before{background:var(--sh-bad, #E5302A)}
      .pv{display:inline-block;min-width:44px;box-sizing:border-box;text-align:center;font-size:12px;font-weight:500;padding:3px 7px;border-radius:999px;background:${fill}}
      .kv{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-top:8px}
      .kv .num b{font-size:22px}
      .setup{display:flex;gap:10px;align-items:flex-start;border:1px solid color-mix(in srgb, var(--sh-warn, #D97706) 35%, transparent);background:color-mix(in srgb, var(--sh-warn, #D97706) 7%, transparent);border-radius:10px;padding:10px 12px;font-size:13px;line-height:1.45}
      .setup ha-icon{--mdc-icon-size:18px;color:var(--sh-warn, #D97706);flex:none;margin-top:1px}
      .setup b{font-weight:600}
      .setup a{color:var(--sh-accent, #0071E3);cursor:pointer;text-decoration:none;font-weight:500;white-space:nowrap}
      details.more{border-top:1px solid ${border};padding-top:12px}
      details.more summary{list-style:none;cursor:pointer;display:flex;align-items:center;gap:6px;font-size:13px;color:${text2};user-select:none}
      details.more summary::-webkit-details-marker{display:none}
      details.more summary ha-icon{--mdc-icon-size:18px;transition:transform .2s}
      details.more[open] summary ha-icon{transform:rotate(90deg)}
      details.more summary b{color:${text};font-weight:600;margin-right:4px}
      details.more .grid3{margin-top:12px}
      @container card (max-width:940px){.facts2{grid-template-columns:repeat(2,minmax(0,1fr))}}
      @container card (max-width:860px){.grid3{grid-template-columns:1fr}.sparks{grid-template-columns:repeat(3,minmax(0,1fr))}.facts{grid-template-columns:repeat(2,minmax(0,1fr))}}
      @container card (max-width:640px){.hero{grid-template-columns:1fr}.board svg{max-width:240px}.rings{grid-template-columns:repeat(2,minmax(0,1fr))}}
      @container card (max-width:520px){.sparks{grid-template-columns:repeat(2,minmax(0,1fr))}.apps td:first-child .sub,.apps .pt,.blurb{display:none}.apps .pill{padding:0 6px;gap:0}
        .apps td,.apps th{padding-left:6px}.apps td{font-size:12px}.upt{visibility:hidden}.ring{gap:8px}.ring svg{width:50px;height:50px}.num b{font-size:24px}}
    </style><ha-card><div class="head"></div><div class="hero"><div class="board"></div><div class="facts2"></div></div><div class="body"></div><div class="tipbox"></div></ha-card>`;
    this.wireTips();
    const open = el => {
      const [id, title, color, decimals, range] = el.dataset.detail.split("|");
      if (window.shDetailChart) this.modal = window.shDetailChart.open(this._hass, { entity: id, title, icon: "mdi:raspberry-pi", color, decimals: +decimals, range });
      else this.dispatchEvent(new CustomEvent("hass-more-info", { bubbles: true, composed: true, detail: { entityId: id } }));
    };
    this.shadowRoot.addEventListener("click", e => {
      const s = e.target.closest("summary"); if (s) { this.moreOpen = !s.parentElement.open; return; }
      const a = e.target.closest("[data-nav]"); if (a) { e.preventDefault(); history.pushState(null, "", a.dataset.nav); window.dispatchEvent(new CustomEvent("location-changed")); return; }
      const g = e.target.closest("[data-detail]"); if (g && !e.target.closest("[data-tip]")) open(g);
    });
    this.shadowRoot.addEventListener("keydown", e => { const g = e.target.closest?.("[data-detail]"); if (g && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); open(g); } });
    // sparkline scrub: same cursor line, dot and tooltip as the expanded charts (hover with a mouse, drag with a finger)
    const R0 = this.shadowRoot, svAt = e => e.target.closest?.(".sv");
    const move = e => { const sv = svAt(e); if (!sv || (e.pointerType !== "mouse" && !this.sDown)) return; const rc = sv.getBoundingClientRect(); this.sh = { id: sv.dataset.id, f: Math.max(0, Math.min(1, (e.clientX - rc.left) / rc.width)) }; this.scrubSpark(); };
    R0.addEventListener("pointermove", move);
    R0.addEventListener("pointerdown", e => { if (svAt(e) && e.pointerType !== "mouse") { this.sDown = true; move(e); } });
    const end = () => { this.sDown = false; this.sh = null; this.scrubSpark(); };
    R0.addEventListener("pointerup", e => { if (e.pointerType !== "mouse") end(); });
    R0.addEventListener("pointercancel", end);
    R0.addEventListener("pointerout", e => { if (e.pointerType === "mouse" && svAt(e) && !svAt({ target: e.relatedTarget || R0.host })) end(); });
  }
  ring(pct, color) {
    const r = 24, c = 2 * Math.PI * r, p = Math.max(0, Math.min(100, pct ?? 0));
    return `<svg viewBox="0 0 58 58"><circle class="trk" cx="29" cy="29" r="${r}"/><circle class="val" cx="29" cy="29" r="${r}" style="stroke:${color}" stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - p / 100)}"/></svg>`;
  }
  scrubSpark() {
    for (const sv of this.shadowRoot.querySelectorAll(".sv.on")) if (sv.dataset.id !== this.sh?.id) sv.classList.remove("on");
    const sv = this.sh && this.shadowRoot.querySelector(`.sv[data-id="${this.sh.id}"]`), g = sv && this.sg?.[this.sh.id];
    if (!sv || !g?.pts.length) return;
    const t = g.t0 + this.sh.f * PV_WINDOW;
    let p = null; for (const q of g.pts) { if (q[0] <= t) p = q; else break; }
    if (!p) { sv.classList.remove("on"); return; }
    const left = this.sh.f * 100 + "%", tip = sv.querySelector(".stip");
    sv.querySelector(".scur").style.left = left;
    Object.assign(sv.querySelector(".sdot").style, { left, top: (g.y(p[1]) / g.H * 100) + "%", background: sv.dataset.c });
    tip.innerHTML = `<b>${g.fmt(p[1])}</b><span> ${g.unit(p[1])}</span><div>${new Date(p[0]).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}</div>`;
    sv.classList.add("on");
    const w = tip.offsetWidth, W = sv.offsetWidth;
    tip.style.left = Math.max(-12, Math.min(W - w + 12, this.sh.f * W - w / 2)) + "px";
  }
  spark(id, color) {
    const pts = this.buf[id] || [], now = Date.now(), t0 = now - PV_WINDOW, W = 200, H = 44;
    if (!pts.length) return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"></svg>`;
    const vals = pts.map(p => p[1]), lo = Math.min(...vals), hi = Math.max(...vals), pad = (hi - lo) * 0.15 || Math.max(Math.abs(hi) * 0.05, 0.5);
    const y = v => H - 2 - ((v - (lo - pad)) / ((hi + pad) - (lo - pad))) * (H - 4), x = t => Math.max(0, (t - t0) / PV_WINDOW) * W;
    (this.sg ||= {})[id] = { pts, t0, y, H, fmt: this.sfmt[id], unit: this.sunit[id] };
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
    const C = this.C, cx = 66, cy = 58;
    const wifi = s.wifi == null ? "" : `<g data-tip="b_wifi" transform="translate(28 36)">${[[4, 1], [7, 2], [10, 3]].map(([r, i]) =>
      `<path d="M${(-r * .72).toFixed(2)} ${(-r * .69).toFixed(2)}A${r} ${r} 0 0 1 ${(r * .72).toFixed(2)} ${(-r * .69).toFixed(2)}" fill="none" stroke-width="1.4" stroke-linecap="round" style="stroke:${i <= s.wifi ? C.accent : C.text3};opacity:${i <= s.wifi ? 1 : .35}"/>`).join("")}
      <circle r="1.3" style="fill:${s.wifi ? C.accent : C.text3}"/><rect x="-11" y="-11" width="22" height="13" fill="transparent"/></g>`;
    const pins = Array.from({ length: 20 }, (_, i) => `<circle class="pin" cx="${(19.5 + i * 4.85).toFixed(2)}" cy="4.9" r=".95"/><circle class="pin" cx="${(19.5 + i * 4.85).toFixed(2)}" cy="8.3" r=".95"/>`).join("");
    const blades = Array.from({ length: 9 }, (_, i) => `<path d="M${cx + 7} ${cy}Q${cx + 14} ${cy - 5} ${cx + 19.5} ${cy - 1.5}" transform="rotate(${i * 40} ${cx} ${cy})"/>`).join("");
    const fan = s.fan == null ? "" : `<g data-tip="b_fan"><circle class="ln" cx="${cx}" cy="${cy}" r="22"/>
      <g class="fan${s.fan ? "" : " off"}" style="--d:${s.fanDur}s" fill="none" stroke-width=".9" stroke-linecap="round"><g style="stroke:${s.fan ? C.accent : C.text3};opacity:${s.fan ? .55 : .4}">${blades}</g></g></g>`;
    return `<svg viewBox="-8 -2 192 124" role="img" aria-label="Raspberry Pi board status">
      <rect class="pcb" x="0" y="0" width="170" height="112" rx="6"/>
      ${[[7, 7], [123, 7], [7, 105], [123, 105]].map(([x, y]) => `<circle class="ln" cx="${x}" cy="${y}" r="2.6"/>`).join("")}
      <rect class="pt" x="15" y="2" width="100" height="9.4" rx="1.5"/>${pins}
      <rect class="pt" x="146" y="4" width="30" height="25" rx="2"/><text class="lbl" x="161" y="18.5" text-anchor="middle">ETH</text>
      <rect class="pt" x="149" y="37" width="27" height="26" rx="2"/><text class="lbl" x="162.5" y="52" text-anchor="middle">USB</text>
      <rect class="pt" x="149" y="71" width="27" height="26" rx="2"/><text class="lbl" x="162.5" y="86" text-anchor="middle">USB</text>
      <rect class="pt" x="12" y="106" width="15" height="9" rx="4"/><rect class="pt" x="36" y="107" width="11" height="7" rx="1.5"/><rect class="pt" x="54" y="107" width="11" height="7" rx="1.5"/>
      <g data-tip="b_sd"><rect class="sd${s.sd ? " on" : ""}" x="-5" y="46" width="9" height="20" rx="1.5" stroke-width="1" style="fill:var(--sh-surface, #fff);stroke:${s.sd ? C.accent : C.text3}"/>
        <text class="lbl" x="7.5" y="58" style="${s.sd ? `fill:${C.accent}` : ""}">SD</text></g>
      <g data-tip="b_led"><circle cx="10" cy="93" r="2.3" style="fill:${s.led};filter:drop-shadow(0 0 1.5px ${s.led})"/><text class="lbl" x="15" y="95">PWR</text></g>
      ${wifi}
      ${fan}
      <g data-tip="b_soc"><rect x="${cx - 12}" y="${cy - 12}" width="24" height="24" rx="3" stroke-width="1.3" style="fill:color-mix(in srgb, ${s.soc} 16%, var(--sh-surface, #fff));stroke:${s.soc}"/>
        <text class="lbl" x="${cx}" y="${cy + 2}" text-anchor="middle" style="fill:${s.soc}">${s.chip}</text></g>
      <rect class="pt" x="96" y="46" width="18" height="24" rx="1.5"/><text class="lbl" x="105" y="78" text-anchor="middle">RAM</text>
      <rect class="pt" x="124" y="51" width="14" height="14" rx="1.5"/><text class="lbl" x="131" y="73" text-anchor="middle">RP1</text>
    </svg>`;
  }
  render() {
    if (!this._hass || !this.config) return;
    const cfg = this.config, C = this.C, H = this._hass.states, R = this.R;
    const n = id => this.n(this.S(id)), v = id => this.v(this.S(id));
    const hn = id => { const x = parseFloat(H[id]?.state); return Number.isFinite(x) ? x : null; };
    const VA = H[R.vitals]?.attributes || {}, watts = hn(R.vitals);
    const cores = cfg.cores;
    const cpu = n("processor_use"), mem = n("memory_usage"), disk = n("disk_usage"), tRaw = n("processor_temperature");
    const tU = H[this.S("processor_temperature")]?.attributes?.unit_of_measurement || "°C", isF = /F/.test(tU);
    const tC = tRaw == null ? null : isF ? (tRaw - 32) * 5 / 9 : tRaw;
    const tTxt = c => isF ? `${Math.round(c * 9 / 5 + 32)}` : c.toFixed(0);
    const memUse = n("memory_use"), memFree = n("memory_free"), memTot = memUse != null && memFree != null ? memUse + memFree : null;
    const dUse = n("disk_use"), dFree = n("disk_free"), dTot = dUse != null && dFree != null ? dUse + dFree : null;
    const swap = n("swap_usage"), swapUse = n("swap_use"), fan = n("pwmfan_fan_speed") ?? n("fan_speed");
    const l1 = n("load_1_min"), l5 = n("load_5_min"), l15 = n("load_15_min");
    const ps = H[R.power]?.state;
    const thr = VA.throttled, tNow = thr?.now || [], tBoot = thr?.since_boot || [];
    const uvNow = ps === "on" || tNow.includes("under_voltage"), uvBoot = tBoot.includes("under_voltage");
    const slowNow = tNow.some(f => f !== "under_voltage"), slowBoot = tBoot.some(f => f !== "under_voltage");
    const boot = v("uptime") || v("last_boot"), up = boot ? this.dur(Date.now() - new Date(boot)) : null;
    const ver = id => H[id]?.attributes?.installed_version || "—";
    // model from pi_vitals (/proc/device-tree/model), else "Raspberry Pi" when the power checker exists; the board drawing only shows on a Pi
    const model = cfg.title || (VA.model ? VA.model.replace(/ Model .*| Rev .*/, "") : R.rpiPower ? "Raspberry Pi" : "Home Assistant host");
    const isPi = /raspberry/i.test(VA.model || "") || !!R.rpiPower || /raspberry/i.test(cfg.title || "");
    const tempColor = tC == null ? C.neutral : tC >= cfg.temp_bad_c ? C.bad : tC >= cfg.temp_warn_c ? C.warn : C.climate;
    const busy = (x, warn, bad) => x == null ? C.neutral : x >= bad ? C.bad : x >= warn ? C.warn : null;
    const gb = mib => (mib / 1024).toFixed(1);
    const ago = id => { const s = H[id]?.state; if (!s || ["unknown", "unavailable"].includes(s)) return null; const ms = Date.now() - new Date(s); return ms >= 0 ? this.dur(ms) + " ago" : "in " + this.dur(-ms); };
    const bLast = R.backup.last_successful_automatic_backup || "sensor.backup_last_successful_automatic_backup", bNext = R.backup.next_scheduled_automatic_backup || "sensor.backup_next_scheduled_automatic_backup";
    const backupAgeD = (() => { const s = H[bLast]?.state; const t = s && new Date(s); return t && !isNaN(t) ? (Date.now() - t) / 864e5 : null; })();
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
    const worst = issues.reduce((m, i) => Math.max(m, i[0]), 0), noData = cpu == null && mem == null && disk == null && tC == null;
    const verdict = noData ? "Waiting for system sensors" : worst ? issues.find(i => i[0] === worst)[1] : "All systems normal";
    const vColor = noData ? C.neutral : [C.ok, C.warn, C.bad][worst];

    // board, redrawn only when its state changes
    const bs = { soc: tempColor, chip: /Pi 5/.test(model) ? "2712" : /Pi 4/.test(model) ? "2711" : "SoC", fan: fan == null ? null : fan > 0, fanDur: fan ? Math.max(0.25, Math.round(2400 / fan * 4) / 4) : 1,
      led: uvNow ? C.bad : C.ok, wifi: wifiBars, sd: (VA.disk_write_kbs ?? 0) > 50 && /^mmcblk/.test(VA.disk_device || "") };
    const bsig = JSON.stringify(bs);
    const boardEl = this.shadowRoot.querySelector(".board");
    boardEl.hidden = !isPi; this.shadowRoot.querySelector(".hero").classList.toggle("solo", !isPi);
    if (isPi && bsig !== this.boardSig) { this.boardSig = bsig; boardEl.innerHTML = this.board(bs); }

    // header (model, uptime, verdict pill) and the status facts beside the board
    const fx = [];
    if (watts != null || ps) fx.push([uvNow ? C.bad : uvBoot ? C.warn : C.ok, "Power", uvNow ? "Under-voltage now" : uvBoot ? "Dipped since boot" : "Stable since boot", watts != null ? `${watts.toFixed(2)} W board` : "Supply checker", "uv"]);
    if (thr) fx.push([slowNow ? C.bad : slowBoot ? C.warn : C.ok, "Throttling", slowNow ? "Active now" : slowBoot ? "Earlier since boot" : "None since boot", VA.arm_mhz ? `CPU at ${VA.arm_mhz.toLocaleString()} MHz` : "", "throttle"]);
    if (disk != null) fx.push([busy(disk, 80, 90) || C.ok, "Storage", `${Math.round(disk)}% used`, [devKind(VA.disk_device), VA.db_mb ? `DB ${VA.db_mb >= 1000 ? (VA.db_mb / 1000).toFixed(1) + " GB" : Math.round(VA.db_mb) + " MB"}` : ""].filter(Boolean).join(" · "), "storage"]);
    if (H[bLast]) fx.push([backupAgeD == null ? C.neutral : backupAgeD > cfg.backup_stale_days ? C.warn : C.ok, "Backups", ago(bLast) || "None yet", ago(bNext) ? `Next ${ago(bNext)}` : "", "backup"]);
    fx.push([pendingU.length ? C.warn : C.ok, "Updates", pendingU.length ? `${pendingU.length} available` : "All current", pendingU.length ? pendingU.map(u => (u.attributes.friendly_name || "").replace(/ update$/i, "")).join(", ") : `${updates.length} tracked`, "updates"]);
    if (wired) fx.push([C.ok, "Network", "Ethernet", ifc, "net"]);
    else if (dbm != null) fx.push([dbm > -67 ? C.ok : dbm > -75 ? C.warn : C.bad, "Wi-Fi", dbm > -60 ? "Excellent" : dbm > -70 ? "Good" : dbm > -75 ? "Fair" : "Weak", `${String(dbm).replace("-", "−")} dBm`, "wifi"]);
    this.shadowRoot.querySelector(".head").innerHTML = `<ha-icon icon="${isPi ? "mdi:raspberry-pi" : "mdi:server"}"></ha-icon><span class="title">${model}</span>
      <span class="upt">${up ? "· up " + up : ""}</span><span class="status"><i style="background:${vColor}"></i>${verdict}${this.tip("status")}</span>`;
    this.shadowRoot.querySelector(".facts2").innerHTML = fx.map(([c, k, val, sub, t]) =>
      `<div class="fx"><div class="k"><i style="background:${c}"></i>${k} ${this.tip(t)}</div><div class="val">${val}</div><div class="sub" title="${sub}">${sub || "&nbsp;"}</div></div>`).join("");

    // gauges
    const gauges = [
      ["CPU", "cpu", cpu == null ? "—" : Math.round(cpu), "%", cpu, busy(cpu, 60, 85) || C.accent, l1 != null ? `load ${l1.toFixed(2)}` : `${cores} cores`, `${this.S("processor_use")}|CPU|infra|0|6H`],
      ["Memory", "mem", mem == null ? "—" : Math.round(mem), "%", mem, busy(mem, 70, 90) || C.accent, memTot ? `${gb(memUse)} of ${gb(memTot)} GB` : "", `${this.S("memory_usage")}|Memory|infra|0|6H`],
      ["Disk", "disk", disk == null ? "—" : Math.round(disk), "%", disk, busy(disk, 75, 90) || C.accent, dTot ? `${dUse.toFixed(1)} of ${dTot.toFixed(0)} GB` : "", `${this.S("disk_usage")}|Disk|infra|1|7D`],
      ["Temp", "temp", tC == null ? "—" : tTxt(tC), tU, tC == null ? 0 : tC / 85 * 100, tempColor, tC == null ? "" : `${isF ? tC.toFixed(1) + " °C · " : ""}${fan != null ? (fan ? Math.round(fan).toLocaleString() + " rpm" : "fan idle") : ""}`.replace(/ · $/, ""), `${this.S("processor_temperature")}|CPU temperature|climate|1|1H`],
    ];
    const gaugesHtml = gauges.filter(g => H[g[7].split("|")[0]]).map(([name, t, val, u, pct, col, sub, det]) => `<div class="ring" data-detail="${det}" role="button" tabindex="0" aria-label="Open ${name} history">${this.ring(pct, col)}
      <div><div class="k">${name} ${this.tip(t)}</div><div class="num"><b>${val}</b><span>${u}</span></div><div class="sub">${sub}</div></div></div>`).join("");

    // sparks
    const fmt = (x, u) => x == null ? "—" : u === "MB/s" ? (x < 1 ? (x * 1000).toFixed(0) : x.toFixed(1)) : u === "W" ? x.toFixed(2) : /°/.test(u) ? x.toFixed(0) : u === "" ? x.toFixed(2) : Math.round(x);
    const unit = (x, u) => u === "MB/s" ? (x != null && x < 1 ? "KB/s" : "MB/s") : u;
    this.sfmt = {}; this.sunit = {};
    const sparks = this.sparkDefs().map(([key, id, name, u]) => {
      const x = this.n(id), col = key === "temp" ? C.climate : C.accent;
      this.sfmt[id] = y => fmt(y, u); this.sunit[id] = y => unit(y, u);
      return `<div class="spark"><div class="lbl"><i style="background:${col}"></i>${name}${key === "down" ? " " + this.tip("net") : ""}</div>
      <div class="num"><b>${fmt(x, u)}</b><span>${unit(x, u)}</span></div>
      <div class="sv" data-id="${id}" data-c="${col}">${this.spark(id, col)}<div class="scur"></div><div class="sdot"></div><div class="stip"></div></div></div>`; }).join("");

    // storage panel
    const sz = mib => mib == null ? "—" : mib >= 1024 ? (mib / 1024).toFixed(2) + " GB" : Math.round(mib) + " MB";
    const mb = x => x >= 1000 ? (x / 1000).toFixed(2) + " GB" : Math.round(x) + " MB";
    const kvr = (label, val, tip) => `<div class="kvr"><span>${label}${tip ? " " + this.tip(tip) : ""}</span><b>${val}</b></div>`;
    const storage = `<div class="panel"><div class="k">Storage${VA.disk_device ? " · " + devKind(VA.disk_device) : ""}</div>
      <div class="row"><div class="rowh"><span>Disk ${this.tip("storage")}</span><span><b>${dUse != null ? dUse.toFixed(1) : "—"} GB</b> used · ${dFree != null ? dFree.toFixed(1) : "—"} free</span></div>
        <div class="bar"><span style="width:${disk ?? 0}%;background:${busy(disk, 80, 90) || C.accent}"></span></div></div>
      <div class="kvs" style="margin-top:10px">
        ${VA.db_mb != null ? kvr("Database", `${mb(VA.db_mb)} <span class="x">· ${VA.db_mb_per_day != null ? (VA.db_mb_per_day >= 0 ? "+" : "") + VA.db_mb_per_day + " MB/day" : "growth after 1 day"}</span>`, "db") : ""}
        ${VA.disk_written_gb != null ? kvr("Written since boot", `${VA.disk_written_gb} GB`, "writes") : ""}
        ${VA.disk_write_kbs != null ? kvr("Writing now", `${VA.disk_write_kbs} kB/s`) : ""}
        ${kvr("Swap", `${swapUse != null ? Math.round(swapUse) : "—"} MB <span class="x">· ${swap ?? "—"}%</span>`, "swap")}
      </div></div>`;
    // power & performance panel
    const flagName = { under_voltage: "Under-voltage", freq_capped: "Capped", throttled: "Throttled", soft_temp_limit: "Soft temp limit" };
    const flagPills = (list, cls) => list.length ? `<span class="flags">${list.map(f => `<span class="pill ${cls}">${flagName[f] || f}</span>`).join("")}</span>` : `<span class="pill on">None</span>`;
    const perf = `<div class="panel"><div class="k">Power & performance</div><div class="kvs">
      ${watts != null ? kvr("Board power", `${watts.toFixed(2)} W`, "power_g") : ""}
      ${VA.arm_mhz ? kvr("CPU clock", `${VA.arm_mhz.toLocaleString()} MHz${/Pi 5/.test(model) ? ` <span class="x">of 2,400</span>` : ""}`, "clock") : ""}
      ${thr ? kvr("Throttling now", flagPills(tNow, "bad"), "throttle") + kvr("Since boot", flagPills(tBoot, "upd"), "throttle") : ""}
      ${!thr && ps ? kvr("Power supply", ps === "on" ? `<span class="pill bad">Under-voltage</span>` : `<span class="pill on">OK</span>`, "uv") : ""}
      ${fan != null ? kvr("Fan", fan ? `${Math.round(fan).toLocaleString()} rpm <span class="x">· ${Math.round(fan / cfg.fan_max_rpm * 100)}%</span>` : "Idle", "fan") : ""}
      ${!wired && dbm != null ? kvr("Wi-Fi signal", `${String(dbm).replace("-", "−")} dBm`, "wifi") : ""}
    </div></div>`;
    // backups & updates panel
    const care = `<div class="panel"><div class="k">Backups & updates</div><div class="kvs">
      ${H[bLast] ? kvr("Last backup", ago(bLast) || "—", "backup") + kvr("Next backup", ago(bNext) || "—") : ""}
      ${pendingU.length ? pendingU.map(u => kvr((u.attributes.friendly_name || u.entity_id).replace(/ update$/i, ""), `<span class="x">${u.attributes.installed_version ?? ""} →</span> <span class="pill upd">${u.attributes.latest_version}</span>`)).join("")
        : kvr("Updates", `<span class="pill on">All ${updates.length} current</span>`, "updates")}
    </div></div>`;

    // apps
    const pct1 = x => x == null ? "—" : (x < 10 ? x.toFixed(1) : Math.round(x)) + "%";
    const sys = [["Home Assistant Core", R.sys.core], ["Supervisor", R.sys.supervisor]].filter(([, d]) => d);
    const stateOf = id => id ? H[id]?.state : undefined;
    const appsHtml = cfg.show_apps === false || !(sys.length || R.apps.length) ? "" : `<div class="panel"><div class="k">Apps ${this.tip("apps")}</div>
      <table class="apps"><tr><th>App</th><th>Status</th><th>CPU</th><th>RAM</th><th>Version</th></tr>
        ${sys.map(([nm, d]) =>
          `<tr><td>${nm} <span class="sub">system</span></td><td><span class="pill on"><span class="pt">Running</span></span></td><td>${pct1(hn(d.cpu_percent))}</td><td>${pct1(hn(d.memory_percent))}</td><td>${ver(d.update)}</td></tr>`).join("")}
        ${R.apps.map(a => { const run = stateOf(a.running) === "on", upd = stateOf(a.update) === "on";
          return `<tr><td>${a.name}</td><td><span class="pill ${run ? "on" : "off"}" title="${run ? "Running" : "Stopped"}"><span class="pt">${run ? "Running" : "Stopped"}</span></span></td>
            <td>${run ? pct1(hn(a.cpu_percent)) : "—"}</td><td>${run ? pct1(hn(a.memory_percent)) : "—"}</td>
            <td>${stateOf(a.version) || "—"}${upd ? ` <span class="pill upd">→ ${stateOf(a.version_latest) || H[a.update]?.attributes?.latest_version}</span>` : ""}</td></tr>`; }).join("")}</table></div>`;

    // setup help: System Monitor missing, or some of its sensors still off (it ships with most disabled)
    const smLink = `<a data-nav="/config/integrations/integration/systemmonitor">Open System Monitor ›</a>`;
    const missing = R.hasSM ? PV_NEEDED.filter(([k]) => !R.sm[k]?.length).map(([, nm]) => nm) : [];
    const setup = this.legacy || R.noRegistry ? "" : !R.hasSM
      ? `<div class="setup"><ha-icon icon="mdi:wrench-outline"></ha-icon><div><b>Add the System Monitor integration</b> (Settings → Devices & services → Add integration → System Monitor), then turn on its sensors: most are off by default. <a data-nav="/config/integrations/dashboard">Open integrations ›</a></div></div>`
      : missing.length ? `<div class="setup"><ha-icon icon="mdi:toggle-switch-off-outline"></ha-icon><div><b>${missing.length === 1 ? "1 sensor is" : missing.length + " sensors are"} off:</b> ${missing.join(", ")}. Turn ${missing.length === 1 ? "it" : "them"} on in System Monitor's entity list. ${smLink}</div></div>` : "";
    const vitalsHint = isPi && !H[R.vitals] ? `<div class="foot" style="margin-top:12px">Board power, throttling, CPU clock and SD-card wear come from the optional pi_vitals sensor (see the card's README).</div>` : "";
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
          <div class="kv"><div><div class="sub">Disk total</div><div class="num"><b>${hn(R.sys.host?.disk_total) ?? (dTot ? dTot.toFixed(0) : "—")}</b><span>GB</span></div></div>
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
        <div class="fact"><div class="k">Local IP ${this.tip("ip")}</div><div class="val">${ipv4 ?? "—"} <span class="sub">${ifc}</span></div></div>
        <div class="fact"><div class="k">Home Assistant ${this.tip("ha_stats")}</div><div class="val">${Object.keys(H).length.toLocaleString()} entities <span class="sub">· ${count("automation")} automations · ${count("script")} scripts</span></div></div>
        <div class="fact"><div class="k">Platform ${this.tip("ha")}</div><div class="val">${R.sys.os ? `OS ${stateOf(R.sys.os.version) ?? "—"} · ` : ""}<span class="sub">Core ${ver(R.sys.core?.update)}${VA.model ? " · " + VA.model : ""}</span></div></div>
      </div>
      ${cfg.footer ? `<div class="foot" style="margin-top:12px">${cfg.footer}</div>` : ""}${vitalsHint}
    </details>`;

    const body = this.shadowRoot.querySelector(".body");
    body.innerHTML = `${setup}
      <div class="rings">${gaugesHtml}</div>
      <div class="panel"><div class="k live-k"><span class="pulse"></span>Live · last 10 minutes ${this.tip("live")}</div><div class="sparks">${sparks}</div></div>
      <div class="grid3">${storage}${perf}${care}</div>
      ${appsHtml}
      ${more}`;
    if (this.tipEl) { const el = this.shadowRoot.querySelector(`[data-tip="${this.tipEl.dataset.tip}"]`); if (el) this.tipEl = el; }
    if (this.sh) this.scrubSpark();
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
