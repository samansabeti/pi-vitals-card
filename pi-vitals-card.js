// Pi Vitals: one-card health view of the Raspberry Pi running Home Assistant.
// Line-art board whose parts light up by status, status facts, ring gauges, live sparklines with hover,
// storage wear, power and throttling, backups and updates, apps, a collapsed "more details" drawer, and a Settings menu.
// Reads System Monitor sensors plus the optional pi_vitals.py command_line sensor (power, throttle flags, clock,
// Wi-Fi signal, SD writes, database growth). Everything optional hides cleanly when its sensor is missing.
// Sensors are found by integration + translation key, so non-English installs work; `prefix` forces the old English-ID lookup.
// Two styles: Studio (the card's own palette, light and dark) or the viewer's theme; --pv-accent overrides the data hue. No dependencies.
const PV_VERSION = "1.0.0";
const PV_DEFAULTS = {
  vitals_entity: "sensor.pi_board_power", power_status_entity: "binary_sensor.raspberry_pi_power_status",
  cores: 4, fan_max_rpm: 8000, temp_warn_c: 65, temp_bad_c: 80, backup_stale_days: 3,
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
// Info-icon text: one or two plain sentences, no live numbers. A function gets { g: Pi generation (5, 4, 3, or 0 when unknown),
// cores, warn, bad } so the text fits the board in use. {n} and {a-b} are °C values, shown in the viewer's unit.
const PV_SUPPLY = { 5: "the official 27 W (5 V, 5 A) supply", 4: "the official 15 W (5.1 V, 3 A) supply", 3: "the official 12.5 W (5.1 V, 2.5 A) supply" };
const PV_TOP_MHZ = { 5: "2,400 MHz", 4: "1,500–1,800 MHz, depending on the board revision", 3: "1,400 MHz" };
const PV_TIPS = {
  status: "Overall health of the Pi. Green is fine, orange needs a look soon, red needs attention now.",
  cpu: "How busy the processor is. Home Assistant usually idles at a few percent; short spikes are normal, sustained 80%+ is not.",
  mem: "RAM in use by apps, not counting cache Linux hands back instantly. Under 70% is comfortable; 90%+ is tight.",
  disk: "Space used on the boot disk, which holds Home Assistant, its history and backups. Keep it under 80% so updates have room.",
  temp: m => `Processor temperature. Under {${m.warn}} is normal, {${m.warn}-${m.bad}} is warm, and at {${m.bad}} the Pi slows itself down to cool off.`,
  power_g: "Power the board itself is drawing. USB devices and the supply's own losses aren't included, so the wall reading is a bit higher.",
  live: "The last 10 minutes of readings. Slide along a line to read an earlier moment, or click it for longer history.",
  net: "Data moving in and out over the network. A few KB/s is normal; bursts come from updates and backups.",
  ram: "Used is what apps hold. Free includes cache Linux hands back instantly.",
  swap: "Overflow memory on the disk, much slower than RAM. Zero is ideal; steady use means RAM is tight.",
  storage: "How full the boot disk is, what kind of disk it is, and how big the history database has grown.",
  db: "The database behind the history graphs. A large or fast-growing one means more disk writes and wear.",
  writes: "Data written to the boot disk. SD cards wear out from constant writes; SSDs cope far better.",
  load: m => `Tasks wanting the processor, averaged over 1, 5 and 15 minutes. Below ${m.cores} (the core count) means nothing is waiting.`,
  psi_grid: "Share of time tasks were stuck waiting on the processor, memory or disk. 0% is ideal; above 10% means a bottleneck.",
  fan: m => m.g === 5 ? "Cooling fan speed. It stays off while the chip is cool and ramps up from about {50}." : "Cooling fan speed. It ramps up as the processor warms.",
  uptime: "Time since the Pi last started. Home Assistant restarts don't reset it.",
  ip: "The Pi's address on your home network, assigned by your router.",
  uv: m => `Whether the power supply has dipped too low, which causes crashes and SD card damage. Use ${PV_SUPPLY[m.g] || "the official supply for your Pi"}.`,
  throttle: "Whether the Pi has slowed its processor because of heat or weak power. 'Since boot' catches problems you didn't see happen.",
  clock: m => `Processor speed right now. It drops when idle or throttled${PV_TOP_MHZ[m.g] ? "; top speed is " + PV_TOP_MHZ[m.g] : ""}.`,
  wifi: "Wi-Fi signal at the Pi. Above −60 dBm is excellent, −60 to −70 is good, and below −75 expect dropouts.",
  ha: "Versions of Home Assistant OS and Core running on the Pi.",
  apps: "Apps running alongside Home Assistant, with their share of the Pi's processor and memory. Click a row for its history.",
  updates: "Components with a newer version waiting. Install them from Settings → Updates.",
  ha_stats: "What Home Assistant tracks: entities, automations and scripts.",
  backup: "When the last automatic backup finished and when the next one is due.",
  forecast: "When the disk would fill up if it keeps growing at its usual pace.",
  usual: "The typical level over the past week. It turns orange when the reading now is well outside it.",
  events: "Reboots, restarts, throttling, power dips, failed backups and updates from the past week.",
};

// Settings (gear in the header) are saved per user in Home Assistant's frontend user data, so they follow you to every device.
// Other cards can follow them: a chart card can listen for the "pi-vitals-settings" event. If a companion chart (window.shDetailChart) is loaded, readings open in it; otherwise in HA's more-info dialog.
window.piVitals = window.piVitals || {
  settings: null,
  load(hass) {
    return this.loading ||= hass.callWS({ type: "frontend/get_user_data", key: "pi_vitals" })
      .then(r => { this.settings = r?.value || {}; }, () => { this.settings = {}; })
      .then(() => dispatchEvent(new CustomEvent("pi-vitals-settings")));
  },
  save(hass, patch) {
    this.settings = { ...(this.settings || {}), ...patch };
    dispatchEvent(new CustomEvent("pi-vitals-settings"));
    return hass.callWS({ type: "frontend/set_user_data", key: "pi_vitals", value: this.settings }).catch(() => {});
  },
};

class PiVitalsCard extends HTMLElement {
  static getStubConfig() { return {}; }
  // Visual editor (Edit dashboard → card). Everything is optional; blank fields use the defaults or auto-detection.
  static getConfigForm() {
    const num = (min, max, step = 1, unit) => ({ number: { min, max, step, mode: "box", ...(unit ? { unit_of_measurement: unit } : {}) } });
    const L = {
      title: "Title", style: "Style", temperature_unit: "Temperature unit", show_apps: "Show the Apps table", backup_note: "Backup note", footer: "Footer note",
      vitals_entity: "Pi vitals sensor", power_status_entity: "Power supply sensor", interface: "Network interface", prefix: "Entity ID prefix (legacy)",
      temp_warn_c: "Warm from", temp_bad_c: "Hot from", backup_stale_days: "Backups overdue after", cores: "CPU cores", fan_max_rpm: "Fan full speed",
    };
    const H = {
      title: "Blank shows the board model.", style: "Studio is the card's own look (light and dark). My theme uses your dashboard theme's colors. Each person can still switch in the card's Settings.", temperature_unit: "Blank follows your Home Assistant unit system. Each person can still switch in the card's Settings.",
      backup_note: "Added to the backup explanation, e.g. \"Also copied to my NAS.\"", footer: "Small note at the bottom of More details.",
      vitals_entity: "The optional pi_vitals.py sensor. Found automatically when blank.", power_status_entity: "Raspberry Pi Power Supply Checker. Found automatically when blank.",
      interface: "e.g. wlan0, eth0 or end0. Blank picks it automatically.", prefix: "Only if sensors are found wrongly: forces lookup by English entity IDs (e.g. sensor.system_monitor_).",
      temp_warn_c: "Temperature thresholds are in °C whatever unit the card shows.", fan_max_rpm: "Used for the fan % (8000 for the Pi 5 Active Cooler).", cores: "Used for load %.",
    };
    return {
      schema: [
        { name: "title", selector: { text: {} } },
        { name: "style", selector: { select: { mode: "dropdown", options: [{ value: "studio", label: "Studio" }, { value: "theme", label: "My theme" }] } } },
        { type: "grid", name: "", schema: [
          { name: "temperature_unit", selector: { select: { mode: "dropdown", options: [{ value: "F", label: "°F" }, { value: "C", label: "°C" }] } } },
          { name: "show_apps", default: true, selector: { boolean: {} } },
        ] },
        { type: "expandable", name: "", title: "Thresholds", icon: "mdi:thermometer-alert", schema: [
          { type: "grid", name: "", schema: [
            { name: "temp_warn_c", default: PV_DEFAULTS.temp_warn_c, selector: num(40, 90, 1, "°C") },
            { name: "temp_bad_c", default: PV_DEFAULTS.temp_bad_c, selector: num(50, 95, 1, "°C") },
            { name: "backup_stale_days", default: PV_DEFAULTS.backup_stale_days, selector: num(1, 30, 1, "days") },
          ] },
        ] },
        { type: "expandable", name: "", title: "Sensors", icon: "mdi:chip", schema: [
          { name: "vitals_entity", selector: { entity: { domain: "sensor" } } },
          { name: "power_status_entity", selector: { entity: { domain: "binary_sensor" } } },
          { type: "grid", name: "", schema: [
            { name: "interface", selector: { text: {} } },
            { name: "cores", default: PV_DEFAULTS.cores, selector: num(1, 16) },
            { name: "fan_max_rpm", default: PV_DEFAULTS.fan_max_rpm, selector: num(1000, 20000, 100, "rpm") },
          ] },
          { name: "prefix", selector: { text: {} } },
        ] },
        { type: "expandable", name: "", title: "Notes", icon: "mdi:note-text-outline", schema: [
          { name: "backup_note", selector: { text: {} } },
          { name: "footer", selector: { text: { multiline: true } } },
        ] },
      ],
      assertConfig: c => PiVitalsCard.check(c),
      computeLabel: s => L[s.name],
      computeHelper: s => H[s.name],
    };
  }
  constructor() { super(); this.attachShadow({ mode: "open" }); this.buf = {}; this.seen = {}; this.sig = ""; this.boardSig = ""; this.built = false; }
  setConfig(c) {
    PiVitalsCard.check(c || {});
    this.config = { ...PV_DEFAULTS, ...(c || {}) };
    this.legacy = !!this.config.prefix;
    this.P = this.config.prefix || "sensor.system_monitor_";
    this.R = null;
    if (this._hass && this.built) { this.sig = ""; this.boardSig = ""; this.sparkKey = null; this.hass = this._hass; }
  }
  // Bad values are shown by Home Assistant in place of the card (and keep the visual editor from saving them).
  static check(c) {
    const num = (k, min, max) => { if (c[k] != null && !(Number.isFinite(+c[k]) && +c[k] >= min && +c[k] <= max)) throw new Error(`${k} must be a number from ${min} to ${max}`); };
    num("cores", 1, 64); num("fan_max_rpm", 500, 50000); num("temp_warn_c", 30, 100); num("temp_bad_c", 30, 110); num("backup_stale_days", 1, 365);
    if (c.temp_warn_c != null && c.temp_bad_c != null && +c.temp_warn_c >= +c.temp_bad_c) throw new Error("temp_warn_c must be below temp_bad_c");
    if (c.style != null && !["studio", "theme"].includes(c.style)) throw new Error("style must be studio or theme");
    if (c.temperature_unit != null && !/^°?[CF]$/i.test(String(c.temperature_unit))) throw new Error("temperature_unit must be C or F");
  }
  connectedCallback() {
    if (this.onScroll) addEventListener("scroll", this.onScroll, { passive: true, capture: true });
    this.onSet = () => { this.applyLook(); this.render(true); this.renderMenu(); };
    this.onDoc = e => { if (this.tipPin && !e.composedPath().includes(this)) this.hideTip?.(); if (this.menuOpen && !e.composedPath().some(n => n.classList?.contains("menu") || n.classList?.contains("gear"))) this.toggleMenu(false); };
    this.onKey = e => { if (e.key === "Escape") { if (this.tipEl) this.hideTip?.(); else if (this.menuOpen) this.toggleMenu(false); else if (this.pvPart) { this.pvPart = null; this.render(true); } } };
    addEventListener("pi-vitals-settings", this.onSet); addEventListener("click", this.onDoc, true); addEventListener("keydown", this.onKey);
  }
  disconnectedCallback() { if (this.onScroll) removeEventListener("scroll", this.onScroll, { capture: true }); removeEventListener("pi-vitals-settings", this.onSet); removeEventListener("click", this.onDoc, true); removeEventListener("keydown", this.onKey); }
  // viewer's settings, else the card config, else Home Assistant's unit system
  settings() {
    const s = window.piVitals.settings || {}, c = this.config || {};
    const tu = c.temperature_unit ? String(c.temperature_unit).replace("°", "").toUpperCase() : this._hass?.config?.unit_system?.temperature === "°C" ? "C" : "F";
    return { temperature_unit: s.temperature_unit || tu, tips: s.tips ?? true, apps: s.apps ?? c.show_apps !== false, look: s.look || (c.style === "theme" ? "theme" : "studio") };
  }
  // Studio follows Home Assistant's dark mode; "My theme" takes every color from the active theme
  applyLook() {
    const look = this.settings().look, dark = !!this._hass?.themes?.darkMode;
    if (this.getAttribute("look") !== look) this.setAttribute("look", look);
    this.toggleAttribute("dark", dark);
  }
  // °C (what thresholds and the tips are written in) to the display unit
  tC2D(c) { return this.settings().temperature_unit === "F" ? c * 9 / 5 + 32 : c; }
  getCardSize() { return 12; }
  getGridOptions() { return { columns: "full", rows: "auto" }; }
  get C() {
    return {
      accent: "var(--pv-accent, var(--pv-infra))", climate: "var(--pv-climate)", neutral: "var(--pv-neutral)",
      ok: "var(--pv-ok)", warn: "var(--pv-warn)", bad: "var(--pv-bad)", text3: "var(--pv-text-3)",
    };
  }
  tipCtx() { const c = this.config; return { g: this.gen || 0, cores: c.cores, warn: c.temp_warn_c, bad: c.temp_bad_c }; }
  tip(key) { return !this.settings().tips ? "" : ` <span class="i" tabindex="0" data-tip="${key}" aria-label="What is this?"><ha-icon icon="mdi:information-outline"></ha-icon></span>`; }
  wireTips() {
    const r = this.shadowRoot, box = () => r.querySelector(".tipbox");
    const show = el => {
      const b = box(); if (!b) return;
      const u = " °" + this.settings().temperature_unit, t = c => Math.round(this.tC2D(c));
      const raw = PV_TIPS[el.dataset.tip] || "", pt = el.dataset.part && this.partTips?.[el.dataset.part];
      if (pt) b.innerHTML = `<b>${pt[0]}</b><br>${pt[1] || ""}`; // part summaries are built from escaped values
      else b.textContent = (typeof raw === "function" ? raw(this.tipCtx()) : raw).replace(/\{(\d+)(?:-(\d+))?\}/g, (_, a, z) => t(+a) + (z ? "–" + t(+z) : "") + u)
        + (el.dataset.tip === "backup" && this.config.backup_note ? " " + this.config.backup_note : "");
      b.classList.add("show");
      const rc = el.getBoundingClientRect(), w = Math.min(280, innerWidth - 24);
      b.style.maxWidth = w + "px";
      b.style.left = Math.max(12, Math.min(rc.left + rc.width / 2 - w / 2, innerWidth - w - 12)) + "px";
      const h = b.offsetHeight; b.style.top = (rc.bottom + 8 + h < innerHeight ? rc.bottom + 8 : rc.top - h - 8) + "px";
      this.tipEl = el;
    };
    // Hover previews with a mouse only (a tap also fires hover events, which used to open the tip and let the click close it again).
    // A click or tap pins the tip; tapping it again, tapping elsewhere, Escape or scrolling closes it.
    const hide = () => { box()?.classList.remove("show"); this.tipEl = null; this.tipPin = false; };
    this.hideTip = hide;
    // info icons, plus the board parts (a short live summary on hover; tapping opens the part panel instead)
    const tgt = n => n?.closest?.("[data-tip]") || n?.closest?.(".board [data-part]");
    r.addEventListener("pointerover", e => { const el = e.pointerType === "mouse" && !this.tipPin && tgt(e.target); if (el) show(el); });
    r.addEventListener("pointerout", e => { const el = e.pointerType === "mouse" && !this.tipPin && tgt(e.target); if (el && tgt(e.relatedTarget) !== el) hide(); });
    r.addEventListener("focusin", e => { const el = !this.tipPin && e.target.matches?.(":focus-visible") && tgt(e.target); if (el) show(el); });
    r.addEventListener("focusout", () => { if (!this.tipPin) hide(); });
    r.addEventListener("click", e => {
      const el = e.target.closest("[data-tip]");
      if (el) { e.stopPropagation(); if (this.tipPin && this.tipEl?.dataset.tip === el.dataset.tip) hide(); else { show(el); this.tipPin = true; } }
      else if (this.tipPin) hide();
    }, true);
    this.onScroll = () => { if (this.tipEl) hide(); };
    if (this.isConnected) addEventListener("scroll", this.onScroll, { passive: true, capture: true });
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
      if (d.running) R.apps.push({ ...d, name: pvEsc(name) || "App" });
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
    this.applyLook();
    if (this.modal?.isConnected) this.modal.hass = h;
    if (!this.built) { this.build(); window.piVitals.load(h); }
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
    if (this.R.hasSM && now - (this.histT || 0) > 5 * 60e3) { this.histT = now; this.loadHistory(); }
    if (now - (this.usbT || 0) > 60e3) { this.usbT = now; this.loadUsb(); }
    if (!this.hwT) { this.hwT = now; this.loadHw(); }
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
  // Past data for the trend features: 7-day hourly means (the "usual" lines), 15 days of daily disk use (the forecast),
  // and 7 days of history for the event timeline. Refreshed every 5 minutes; failures just hide those lines.
  async loadHistory() {
    const H = this._hass, R = this.R, now = Date.now(), day = 864e5, ws = m => H.callWS(m).catch(() => ({}));
    const ok = id => id && H.states[id], id = { cpu: this.S("processor_use"), mem: this.S("memory_usage"), temp: this.S("processor_temperature"), disk: this.S("disk_use") };
    const hourly = ["cpu", "mem", "temp"].map(k => id[k]).filter(ok);
    const boot = this.S("last_boot"), bEv = R.backup.automatic_backup_event;
    const plain = [R.power, ...R.apps.map(a => a.running)].filter(ok), rich = [boot, bEv, ...Object.keys(H.states).filter(k => k.startsWith("update."))].filter(ok);
    const hist = (ids, attrs) => ids.length ? ws({ type: "history/history_during_period", start_time: new Date(now - 7 * day).toISOString(), entity_ids: ids, minimal_response: !attrs, no_attributes: !attrs, significant_changes_only: false }) : {};
    const [hr, dy, a, b] = await Promise.all([
      hourly.length ? ws({ type: "recorder/statistics_during_period", start_time: new Date(now - 7 * day).toISOString(), end_time: new Date(now - 36e5).toISOString(), statistic_ids: hourly, period: "hour", types: ["mean"] }) : {},
      ok(id.disk) ? ws({ type: "recorder/statistics_during_period", start_time: new Date(now - 16 * day).toISOString(), statistic_ids: [id.disk], period: "day", types: ["mean"] }) : {},
      hist(plain, false), hist(rich, true)]);
    // usual: mean and spread of the hourly means
    const norm = {};
    for (const k of ["cpu", "mem", "temp"]) {
      const xs = (hr[id[k]] || []).map(p => p.mean).filter(Number.isFinite);
      if (xs.length < 24) continue;
      const mu = xs.reduce((x, y) => x + y, 0) / xs.length;
      norm[k] = { mu, sd: Math.sqrt(xs.reduce((x, y) => x + (y - mu) ** 2, 0) / xs.length) };
    }
    // forecast: median daily change of complete days (robust to a one-off install, restore or cleanup)
    const midnight = new Date().setHours(0, 0, 0, 0);
    const d = (dy[id.disk] || []).filter(p => new Date(p.start) < midnight && Number.isFinite(p.mean)).map(p => p.mean);
    const diffs = d.slice(1).map((x, i) => x - d[i]).sort((x, y) => x - y), m = diffs.length >> 1;
    const slope = diffs.length >= 5 ? (diffs.length % 2 ? diffs[m] : (diffs[m - 1] + diffs[m]) / 2) : null;
    this.trend = { norm, slope };
    this.events = this.buildEvents(a, b, now - 7 * day, boot, bEv);
    this.render();
  }
  buildEvents(a, b, start, boot, bEv) {
    const H = this._hass, R = this.R, ev = [], t = p => (p.lu ?? p.lc) * 1000, dead = s => s == null || s === "unavailable" || s === "unknown";
    const push = (time, color, text, sub = "") => ev.push({ t: time, color, text, sub });
    // last boot (full rows: a minimal response drops repeats): a new value is a Pi reboot; the same value written again is Home Assistant starting
    let prev = null;
    for (const p of b[boot] || []) {
      if (dead(p.s)) continue;
      const bt = new Date(p.s).getTime();
      if (prev != null && p.s !== prev) push(bt || t(p), "warn", "Pi rebooted");
      else if (prev != null && !ev.some(e => Math.abs(e.t - t(p)) < 10 * 60e3)) push(t(p), "neutral", "Home Assistant restarted");
      prev = p.s;
    }
    // throttling and power dips: pi_vitals keeps its own log; otherwise the Raspberry Pi power checker
    const tev = H.states[R.vitals]?.attributes?.throttle_events;
    const fname = { under_voltage: "Power dipped (under-voltage)", freq_capped: "CPU speed capped", throttled: "CPU throttled", soft_temp_limit: "Soft temperature limit hit" };
    if (Array.isArray(tev)) {
      const open = {};
      for (const [s, f, kind] of tev) {
        if (s * 1000 < start) continue;
        if (kind === "start") open[f] = push(s * 1000, "bad", fname[f] || f, "Ongoing") - 1;
        else if (kind === "end" && open[f] != null) { const e = ev[open[f]]; e.sub = "Lasted " + this.dur(s * 1000 - e.t); delete open[f]; }
        else if (kind === "brief") push(s * 1000, "warn", fname[f] || f, "Briefly, between checks");
      }
    } else {
      let on = null;
      for (const p of a[R.power] || []) {
        if (p.s === "on" && on == null) on = push(t(p), "bad", fname.under_voltage, "Ongoing") - 1;
        else if (p.s === "off" && on != null) { ev[on].sub = "Lasted " + this.dur(t(p) - ev[on].t); on = null; }
      }
    }
    // apps: stopped / started, a stop and start within 5 minutes is a restart
    for (const app of R.apps) {
      let last = null;
      for (const p of a[app.running] || []) {
        if (dead(p.s)) continue;
        if (last && p.s !== last.s) {
          const prevStop = p.s === "on" && ev.length && ev[ev.length - 1].app === app.name && t(p) - ev[ev.length - 1].t < 5 * 60e3 ? ev[ev.length - 1] : null;
          if (prevStop) Object.assign(prevStop, { text: `${app.name} restarted`, color: "neutral" });
          else ev.push({ t: t(p), color: p.s === "on" ? "neutral" : "warn", text: `${app.name} ${p.s === "on" ? "started" : "stopped"}`, sub: "", app: app.name });
        }
        last = p;
      }
    }
    // backups: failures one by one, successes as one summary row
    const seen = new Set(), done = [];
    for (const p of b[bEv] || []) {
      const et = p.a?.event_type, at = new Date(p.s).getTime();
      if (dead(p.s) || seen.has(p.s) || !at || at < start) continue;
      seen.add(p.s);
      if (et === "failed") push(at, "bad", "Automatic backup failed", pvEsc(p.a?.failed_reason));
      else if (et === "completed") done.push(at);
    }
    if (done.length) push(Math.max(...done), "ok", done.length === 1 ? "Backup completed" : `${done.length} backups completed`, done.length > 1 ? "time of the latest" : "");
    // updates: installed_version changing
    for (const [eid, rows] of Object.entries(b)) {
      if (!eid.startsWith("update.")) continue;
      let v = null;
      for (const p of rows) {
        const iv = p.a?.installed_version;
        if (iv && v && iv !== v) push(t(p), "accent", `Updated ${pvEsc(p.a.title || (p.a.friendly_name || eid).replace(/ update$/i, ""))}`, pvEsc(`${v} → ${iv}`));
        if (iv) v = iv;
      }
    }
    return ev.sort((x, y) => y.t - x.t);
  }
  build() {
    this.built = true;
    // colors come from --pv-* tokens set on :host by the style: Studio (the card's own look, light and dark) or the viewer's theme
    const text = "var(--pv-text)", text2 = "var(--pv-text-2)",
      text3 = "var(--pv-text-3)", line = "var(--pv-border)",
      fill = "var(--pv-fill)", raised = "var(--pv-surface-2)",
      surface = "var(--pv-surface)", accent = "var(--pv-accent, var(--pv-infra))",
      hover = "color-mix(in srgb, var(--pv-text) 4%, transparent)";
    this.shadowRoot.innerHTML = `<style>
      :host{display:block;
        --pv-surface:#FFFFFF;--pv-surface-2:#FAFAFB;--pv-fill:rgba(118,118,128,.12);--pv-border:rgba(0,0,0,.08);
        --pv-text:#1D1D1F;--pv-text-2:#6E6E73;--pv-text-3:#A1A1A6;--pv-infra:#0071E3;--pv-climate:#F27200;
        --pv-neutral:#A1A1A6;--pv-ok:#1F9D45;--pv-warn:#D97706;--pv-bad:#E5302A}
      :host([dark]){--pv-surface:#151517;--pv-surface-2:#1C1C1F;--pv-fill:rgba(118,118,128,.24);--pv-border:rgba(255,255,255,.08);
        --pv-text:#EDEDEF;--pv-text-2:#A1A1A6;--pv-text-3:#6E6E73;--pv-infra:#0A84FF;--pv-climate:#FF9F0A;
        --pv-neutral:#636366;--pv-ok:#30D158;--pv-warn:#FFB020;--pv-bad:#FF453A}
      :host(:not([look=theme])) ha-card{background:var(--pv-surface);border:1px solid var(--pv-border);border-radius:14px;box-shadow:0 1px 2px rgba(0,0,0,.04);
        font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Inter",system-ui,sans-serif}
      :host([look=theme]){--pv-surface:var(--card-background-color, var(--ha-card-background, #fff));
        --pv-surface-2:color-mix(in srgb, var(--primary-text-color, #000) 3%, var(--pv-surface));
        --pv-fill:color-mix(in srgb, var(--primary-text-color, #000) 9%, transparent);--pv-border:var(--divider-color, rgba(127,127,127,.2));
        --pv-text:var(--primary-text-color);--pv-text-2:var(--secondary-text-color);
        --pv-text-3:color-mix(in srgb, var(--secondary-text-color) 75%, transparent);--pv-infra:var(--primary-color);
        --pv-climate:var(--state-climate-heat-color, #FF8100);--pv-neutral:var(--disabled-color, #9E9E9E);
        --pv-ok:var(--success-color, #43A047);--pv-warn:var(--warning-color, #FFA600);--pv-bad:var(--error-color, #DB4437)}
      ha-card{position:relative;container:card/inline-size;padding:16px;font-family:inherit;font-size:13px;line-height:1.4;color:${text};-webkit-font-smoothing:antialiased}
      button{font:inherit;color:inherit}
      .body{display:flex;flex-direction:column;gap:12px;margin-top:12px}
      /* header: icon tile, model and uptime, verdict badge, settings */
      .head{display:flex;align-items:center;gap:10px;min-width:0;margin-bottom:14px}
      .tile{flex:none;width:30px;height:30px;border-radius:8px;display:grid;place-items:center;background:color-mix(in srgb, ${accent} 12%, transparent);color:${accent}}
      .tile ha-icon{--mdc-icon-size:18px}
      .hl{display:contents}
      .ttl{flex:1 0 auto;min-width:0;display:flex;align-items:baseline;gap:8px;white-space:nowrap;overflow:hidden}
      .title{font-size:15px;font-weight:600;letter-spacing:-0.01em}
      .upt{font-size:13px;color:${text3};overflow:hidden;text-overflow:ellipsis;font-variant-numeric:tabular-nums}
      .status .vt{min-width:0;overflow:hidden;text-overflow:ellipsis}
      .status{flex:0 1 auto;min-width:0;display:inline-flex;align-items:center;gap:7px;height:28px;box-sizing:border-box;padding:0 10px;border:1px solid ${line};border-radius:8px;font-size:12px;font-weight:500;white-space:nowrap}
      .status .i{margin-left:-2px}
      .dot{flex:none;width:7px;height:7px;border-radius:50%}
      .gear{flex:none;width:28px;height:28px;padding:0;border:0;border-radius:8px;background:none;display:grid;place-items:center;cursor:pointer;color:${text2};transition:background .12s,color .12s}
      .gear[aria-expanded=true]{background:${fill};color:${text}}
      .gear svg,.chev,summary .cv{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}
      :is(.gear,.ring,.seg button,.sw,summary,.i):focus-visible{outline:2px solid ${accent};outline-offset:2px}
      /* type */
      .k{display:flex;align-items:center;gap:6px;min-width:0;font-size:12px;font-weight:500;color:${text2};white-space:nowrap}
      .num{font-variant-numeric:tabular-nums;line-height:1.1;white-space:nowrap}
      .num b{font-size:26px;font-weight:600;letter-spacing:-0.025em}.num span{font-size:13px;font-weight:500;color:${text2};margin-left:2px}
      .sub{font-size:12px;color:${text3};font-variant-numeric:tabular-nums}
      /* divided grids: one outline, hairlines between cells */
      .cells{display:grid;border:1px solid ${line};border-radius:10px;overflow:hidden}
      .cells>*,.sparks>*{min-width:0;box-shadow:1px 0 0 ${line},0 1px 0 ${line}}
      /* hero: board drawing + status facts */
      .hero{display:grid;grid-template-columns:minmax(0,340px) minmax(0,1fr);gap:12px}
      .hero.solo{grid-template-columns:1fr}
      .board{border:1px solid ${line};border-radius:10px;background:${raised};padding:12px;display:grid;place-items:center}
      .board svg{width:100%;max-width:320px;height:auto;overflow:visible;display:block}
      .board .pcb{fill:${surface};stroke:${text3};stroke-width:1}
      .board .ln{fill:none;stroke:${text3};stroke-width:.9}
      .board .pt{fill:${surface};stroke:${text3};stroke-width:.9}
      .board .pin{fill:${text3};opacity:.55}
      .board .lbl{font-family:inherit;font-size:5.6px;font-weight:600;fill:${text3};letter-spacing:.08em}
      .board{grid-template-rows:1fr auto;gap:8px}
      .blg{display:flex;justify-content:center;gap:14px;font-size:11px;color:${text3}}
      .blg span{display:inline-flex;align-items:center;gap:5px}
      .blg i{width:9px;height:9px;border-radius:2.5px;box-sizing:border-box}
      .blg i.on{border:1.3px solid ${accent};background:color-mix(in srgb, ${accent} 14%, transparent)}
      .blg i.off{border:1.1px dashed ${text3};opacity:.6}
      .board .part.on .pt{stroke:${accent};stroke-width:1.1;fill:color-mix(in srgb, ${accent} 7%, var(--pv-surface))}
      .board .part.on .lbl{fill:${accent}}
      .board .part.off>:not(.hb){opacity:.4}
      .board .part.off .pt{stroke-dasharray:2 1.6}
      .board .lbl.v,.board .lbl .v{font-size:5.6px;font-weight:600;letter-spacing:.02em;font-variant-numeric:tabular-nums}
      .board .part .lbl.v{fill:${text2}}.board .part.on .lbl.v{fill:${accent}}
      .board .sd.w{animation:blink 1.2s ease-in-out infinite}
      .blg ha-icon{--mdc-icon-size:14px;color:${text3};opacity:.7;margin-left:-4px}
      .board .part{cursor:pointer;outline:none}
      .board .hb{fill:transparent;stroke:transparent;stroke-width:1.2;transition:stroke .12s,fill .12s}
      .board .part[data-part=board] .hb{stroke-width:0}
      .board .part.sel .hb{stroke:${accent};fill:color-mix(in srgb, ${accent} 8%, transparent)}
      .board .part[data-part=board].sel .pcb{stroke:${accent}}
      .board .part:focus-visible .hb{stroke:${accent};stroke-dasharray:2 2}
      .board .lbl.val{font-size:5px;font-weight:600}
      .hero>[hidden]{display:none}
      .pd{border:1px solid ${line};border-radius:10px;overflow:hidden;min-width:0;animation:pop .14s ease-out}
      .pdh{display:flex;align-items:center;gap:8px;min-height:40px;box-sizing:border-box;padding:0 6px 0 14px;border-bottom:1px solid ${line};background:${raised}}
      .pdh b{font-size:13px;font-weight:600}.pdh .m{margin-left:auto;font-size:12px;color:${text3};white-space:nowrap}
      .pdx{flex:none;width:28px;height:28px;padding:0;border:0;border-radius:8px;background:none;display:grid;place-items:center;cursor:pointer;color:${text2}}
      .pdx svg{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round}
      .pdx:focus-visible{outline:2px solid ${accent};outline-offset:2px}
      .pdg{display:grid;grid-template-columns:repeat(2,minmax(0,1fr))}
      .pdc{padding:0 14px 6px;min-width:0}.pdc+.pdc{border-left:1px solid ${line}}
      .pdk{font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:${text3};padding:12px 0 2px}
      .pdn{font-size:12px;color:${text3};padding:8px 0;line-height:1.45}
      .qu{font-weight:400;font-size:12px;color:${text3};margin-left:2px}
      .kvr.lk{cursor:pointer;margin:0 -14px;padding-left:14px;padding-right:8px}
      .kvr.lk:focus-visible{outline:2px solid ${accent};outline-offset:-2px}
      .kvr .rc{width:14px;height:14px;margin-left:4px;vertical-align:-2px;fill:none;stroke:${text3};stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}
      .kvr b.sp{font-weight:500;white-space:normal;max-width:62%}
      .board .fan{transform-box:fill-box;transform-origin:center;animation:spin var(--d,1s) linear infinite}
      .board .fan.off{animation:none}
      @keyframes spin{to{transform:rotate(360deg)}}@keyframes blink{50%{opacity:.35}}
      .facts2{grid-template-columns:repeat(3,minmax(0,1fr))}
      .fx{padding:12px 14px}
      .fx .val{font-size:14px;font-weight:600;margin-top:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-variant-numeric:tabular-nums}
      .fx .sub{margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .fx.lk{cursor:pointer;transition:background .12s}.fx.lk:focus-visible{outline:2px solid ${accent};outline-offset:-2px}
      .nrm{font-size:12px;color:${text3};margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-variant-numeric:tabular-nums}
      .evs{margin:0 -14px}
      .ev{display:flex;align-items:center;gap:10px;min-height:40px;box-sizing:border-box;padding:8px 14px;border-top:1px solid ${line}}
      .evs .ev:first-child{border-top:0}
      .ev .et{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .ev .x{color:${text3}}
      .ev .ew{flex:none;font-size:12px;color:${text3};font-variant-numeric:tabular-nums}
      .ev.quiet{border:0;padding:12px 0;color:${text3}}
      .evmore{display:block;width:100%;height:36px;border:0;border-top:1px solid ${line};background:none;cursor:pointer;font-size:12px;font-weight:500;color:${text2};transition:background .12s}
      /* rings */
      .rings{grid-template-columns:repeat(4,minmax(0,1fr))}
      .ring{position:relative;display:flex;align-items:center;gap:12px;padding:14px}
      .ring[data-detail]{cursor:pointer;transition:background .12s}
      .ring:focus-visible{outline-offset:-2px}
      .ring svg{flex:none;width:58px;height:58px;transform:rotate(-90deg)}
      .ring circle{fill:none;stroke-width:7;stroke-linecap:round}
      .ring .trk{stroke:${fill}}
      .ring .val{transition:stroke-dashoffset .6s ease,stroke .3s}
      .ring .rt{min-width:0;padding-right:12px}
      .ring .num{margin-top:4px}
      .ring .sub{margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .chev{position:absolute;top:12px;right:10px;color:${text3};opacity:.55;transition:opacity .12s,transform .12s}
      .ring .chev{width:16px;height:16px;transform:none}
      /* sections */
      .panel{border:1px solid ${line};border-radius:10px;overflow:hidden;min-width:0}
      .ph{display:flex;align-items:center;gap:8px;min-height:40px;box-sizing:border-box;padding:0 14px;border-bottom:1px solid ${line};background:${raised}}
      .ph b{font-size:13px;font-weight:600;white-space:nowrap}
      .ph .m{margin-left:auto;font-size:12px;color:${text3};white-space:nowrap;font-variant-numeric:tabular-nums}
      .pb{padding:0 14px}
      .pulse{flex:none;width:7px;height:7px;border-radius:50%;background:var(--pv-ok);animation:p 2s infinite}
      @keyframes p{0%{box-shadow:0 0 0 0 color-mix(in srgb, var(--pv-ok) 55%, transparent)}70%,100%{box-shadow:0 0 0 6px transparent}}
      @media (prefers-reduced-motion:reduce){.board .fan,.board .sd.w,.pulse{animation:none}}
      .sparks{display:grid;grid-template-columns:repeat(6,minmax(0,1fr))}
      .spark{padding:12px 14px}
      .spark[data-detail]{cursor:pointer;transition:background .12s}
      .spark:focus-visible,.apps tr:focus-visible{outline:2px solid ${accent};outline-offset:-2px}
      .apps tr[data-detail]{cursor:pointer}
      .spark .num{margin-top:6px}.spark .num b{font-size:18px;letter-spacing:-0.015em}
      .spark .lbl{display:flex;align-items:center;gap:6px;font-size:12px;font-weight:500;color:${text2};white-space:nowrap;overflow:hidden}
      .spark .lbl .dot{width:6px;height:6px}
      .sv{position:relative;margin-top:6px;touch-action:pan-y;cursor:crosshair;-webkit-user-select:none;user-select:none}
      .sv svg{display:block;width:100%;height:44px;overflow:visible}
      .scur{position:absolute;top:0;bottom:0;width:1px;background:${text3};pointer-events:none;display:none}
      .sdot{position:absolute;width:9px;height:9px;box-sizing:border-box;border-radius:50%;border:2px solid ${surface};transform:translate(-50%,-50%);pointer-events:none;display:none}
      .sv.on .scur,.sv.on .sdot{display:block}
      .sq{font-style:normal;font-size:12px;font-weight:400;color:${text3};margin-left:6px;white-space:nowrap}.sq.on{color:${text}}
      .grid3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;align-items:start}
      .row{padding:12px 0}
      .row+.row{border-top:1px solid ${line}}
      .rowh{display:flex;justify-content:space-between;align-items:center;gap:8px;color:${text2};white-space:nowrap}
      .rowh>span:first-child{display:flex;align-items:center;gap:6px}
      .rowh b{color:${text};font-weight:600;font-variant-numeric:tabular-nums}
      .bar{display:flex;height:6px;border-radius:999px;overflow:hidden;background:${fill};margin-top:8px}
      .bar span{display:block;height:100%;border-radius:999px;transition:width .6s ease}
      .row+.kvs{border-top:1px solid ${line}}
      .kvr{display:flex;justify-content:space-between;align-items:center;gap:10px;min-height:40px;box-sizing:border-box;padding:8px 0;border-top:1px solid ${line};color:${text2}}
      .kvr:first-child{border-top:0}
      .kvr>span:first-child{display:flex;align-items:center;gap:6px;white-space:nowrap}
      .kvr b{font-weight:500;color:${text};font-variant-numeric:tabular-nums;text-align:right}
      .kvr .x{font-weight:400;color:${text3}}
      .flags{display:flex;flex-wrap:wrap;gap:4px;justify-content:flex-end}
      .loads{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}
      .loads .num{margin-top:4px}.loads .num b,.kv .num b{font-size:20px;letter-spacing:-0.015em}
      .mini{height:4px;border-radius:999px;background:${fill};margin-top:8px;overflow:hidden}.mini span{display:block;height:100%;background:${accent};border-radius:999px}
      .kv{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
      .kv .num{margin-top:4px}
      .facts{grid-template-columns:repeat(4,minmax(0,1fr));margin-top:12px}
      .foot{font-size:12px;color:${text3};margin-top:12px}
      .i{display:inline-grid;place-items:center;cursor:help;color:${text3};border-radius:50%}
      .i ha-icon{--mdc-icon-size:14px}.i:focus-visible{color:${text}}
      .tipbox{position:fixed;z-index:10;max-width:280px;background:${surface};color:${text};border:1px solid ${line};font-size:13px;line-height:1.45;padding:10px 12px;border-radius:10px;box-shadow:0 12px 32px -8px rgba(0,0,0,.25);pointer-events:none;opacity:0;transition:opacity .12s;font-weight:400}
      .tipbox.show{opacity:1}
      table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
      th{font-size:12px;font-weight:500;color:${text3};text-align:right;padding:10px 0 8px 12px;white-space:nowrap}
      th:first-child,td:first-child{text-align:left;padding-left:0}
      td{height:40px;padding:0 0 0 12px;border-top:1px solid ${line};text-align:right;white-space:nowrap}
      td:first-child{white-space:normal}
      td .sub{margin-left:4px}
      .apps{margin:0 -14px;width:calc(100% + 28px)}.apps th:first-child,.apps td:first-child{padding-left:14px}.apps th:last-child,.apps td:last-child{padding-right:14px}
      .pill{display:inline-flex;align-items:center;gap:6px;height:22px;box-sizing:border-box;padding:0 8px;border:1px solid ${line};border-radius:6px;font-size:12px;font-weight:500;color:${text};white-space:nowrap;vertical-align:middle}
      .pill::before{content:"";flex:none;width:6px;height:6px;border-radius:50%;background:var(--pv-neutral)}
      .on::before{background:var(--pv-ok)}.off::before{background:var(--pv-neutral)}.upd::before{background:var(--pv-warn)}.bad::before{background:var(--pv-bad)}
      .pv{display:inline-block;min-width:44px;box-sizing:border-box;text-align:center;font-size:12px;font-weight:500;padding:2px 6px;border-radius:6px;background:${fill}}
      .psi td{height:34px}
      .setup{display:flex;gap:10px;align-items:flex-start;border:1px solid color-mix(in srgb, var(--pv-warn) 35%, transparent);background:color-mix(in srgb, var(--pv-warn) 6%, transparent);border-radius:10px;padding:12px 14px;line-height:1.45}
      .setup ha-icon{--mdc-icon-size:18px;color:var(--pv-warn);flex:none;margin-top:0}
      .setup b{font-weight:600}
      .setup a{color:${accent};cursor:pointer;text-decoration:none;font-weight:500;white-space:nowrap}
      details.more summary{list-style:none;cursor:pointer;display:flex;align-items:center;gap:8px;min-height:40px;box-sizing:border-box;padding:0 12px;border:1px solid ${line};border-radius:10px;color:${text3};user-select:none;transition:background .12s}
      details.more summary::-webkit-details-marker{display:none}
      details.more summary .cv{flex:none;color:${text2};transition:transform .2s}
      details.more[open] summary .cv{transform:rotate(90deg)}
      details.more summary b{color:${text};font-weight:600}
      details.more .grid3{margin-top:12px}
      /* settings menu */
      .menu{position:absolute;top:54px;right:12px;z-index:6;width:300px;max-width:calc(100% - 24px);box-sizing:border-box;padding:6px;background:${surface};border:1px solid ${line};border-radius:12px;box-shadow:0 16px 40px -12px rgba(0,0,0,.3),0 2px 6px rgba(0,0,0,.06);display:none;transform-origin:top right}
      .menu.open{display:block;animation:pop .14s ease-out}
      @keyframes pop{from{opacity:0;transform:translateY(-4px) scale(.98)}}
      .mh{display:flex;align-items:baseline;justify-content:space-between;padding:8px 10px 4px;font-size:13px;font-weight:600}
      .mh span{font-size:12px;font-weight:400;color:${text3}}
      .mr{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 10px}
      .mr b{display:block;font-weight:500}.mr small{display:block;font-size:12px;color:${text3}}
      .sep{height:1px;background:${line};margin:4px 10px}
      .seg{flex:none;display:inline-flex;padding:2px;border-radius:8px;background:${fill}}
      .seg button{border:0;background:none;cursor:pointer;height:24px;min-width:40px;padding:0 10px;border-radius:6px;font-size:12px;font-weight:500;color:${text2}}
      .seg button[aria-pressed=true]{background:${surface};color:${text};box-shadow:0 1px 2px rgba(0,0,0,.14)}
      .sw{flex:none;position:relative;width:34px;height:20px;padding:0;border:0;border-radius:999px;background:${fill};cursor:pointer;transition:background .15s}
      .sw::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.25);transition:transform .15s}
      .sw[aria-checked=true]{background:${accent}}.sw[aria-checked=true]::after{transform:translateX(14px)}
      .mf{padding:6px 10px 8px;font-size:12px;color:${text3}}
      /* hover only where there's a real pointer, so a tap doesn't leave a stuck highlight */
      @media (hover:hover){
        .gear:hover{background:${fill};color:${text}}
        .board .part:hover .hb{stroke:${text3};stroke-width:.6}.board .part[data-part=board]:hover .pcb{stroke:${text2}}
        .kvr.lk:hover{background:${hover}}
        .fx.lk:hover,.evmore:hover,.ring[data-detail]:hover,.spark[data-detail]:hover,details.more summary:hover{background:${hover}}
        .apps tr[data-detail]:hover td{background:${hover}}
        .ring:hover .chev{opacity:1;transform:translateX(2px)}
        .i:hover{color:${text}}
      }
      @container card (max-width:940px){.facts2{grid-template-columns:repeat(2,minmax(0,1fr))}}
      @container card (max-width:860px){.pdg{grid-template-columns:1fr}.pdc+.pdc{border-left:0;border-top:1px solid ${line}}.grid3{grid-template-columns:1fr}.sparks{grid-template-columns:repeat(3,minmax(0,1fr))}.facts{grid-template-columns:repeat(2,minmax(0,1fr))}}
      @container card (max-width:760px){.rings{grid-template-columns:repeat(2,minmax(0,1fr))}}
      @container card (max-width:640px){.hero{grid-template-columns:1fr}}
      @container card (max-width:520px){.sparks{grid-template-columns:repeat(2,minmax(0,1fr))}.apps td:first-child .sub,.apps .pt,.blurb,.upt,.head .tile{display:none}
        .apps .pill{padding:0 6px;gap:0}.apps td,.apps th{padding-left:8px}.ring{flex-direction:column;align-items:flex-start;gap:8px;padding:12px}.ring svg{width:44px;height:44px}.ring .rt{padding-right:0;width:100%}.num b{font-size:22px}}
    </style><ha-card><div class="head"><div class="hl"></div><button class="gear" aria-label="Settings" aria-haspopup="dialog" aria-expanded="false"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 4.5h6M11.5 4.5h2M2.5 11.5h2M7.5 11.5h6"/><circle cx="10" cy="4.5" r="1.5"/><circle cx="6" cy="11.5" r="1.5"/></svg></button></div><div class="hero"><div class="board"></div><div class="facts2 cells"></div><div class="pd" hidden></div></div><div class="body"></div><div class="menu" role="dialog" aria-label="Settings"></div><div class="tipbox"></div></ha-card>`;
    this.wireTips();
    const R1 = this.shadowRoot, release = () => {
      this.pressing = false; this.holdUntil = Date.now() + 400;
      clearTimeout(this.holdT); this.holdT = setTimeout(() => { if (this.pending) { this.pending = false; this.render(); } }, 420);
    };
    R1.addEventListener("pointerdown", e => { this.pressing = true; this.pressT = Date.now(); this.downXY = [e.clientX, e.clientY]; this.dragged = false; }, true);
    R1.addEventListener("pointermove", e => { if (this.pressing && this.downXY && Math.hypot(e.clientX - this.downXY[0], e.clientY - this.downXY[1]) > 10) this.dragged = true; }, true);
    R1.addEventListener("pointerup", release, true);
    R1.addEventListener("pointercancel", release, true);
    const open = el => {
      const [id, title, color, decimals, range, temp] = el.dataset.detail.split("|");
      if (window.shDetailChart) this.modal = window.shDetailChart.open(this._hass, { entity: id, title, icon: "mdi:raspberry-pi", color, decimals: +decimals, range, ...(temp ? { temperature_unit: "pi-vitals" } : {}) });
      else this.dispatchEvent(new CustomEvent("hass-more-info", { bubbles: true, composed: true, detail: { entityId: id } }));
    };
    this.shadowRoot.addEventListener("click", e => {
      if (e.target.closest(".gear")) { this.toggleMenu(!this.menuOpen); return; }
      const set = e.target.closest("[data-set]");
      if (set) { const v = set.dataset.v; window.piVitals.save(this._hass, { [set.dataset.set]: v === "true" ? true : v === "false" ? false : v }); return; }
      const pt = e.target.closest("[data-part]");
      if (pt) { this.pvPart = this.pvPart === pt.dataset.part ? null : pt.dataset.part; this.render(true); return; }
      if (e.target.closest("[data-part-close]")) { this.pvPart = null; this.render(true); return; }
      if (e.target.closest("[data-evall]")) { this.evAll = !this.evAll; this.render(true); return; }
      const s = e.target.closest("summary"); if (s) { this.moreOpen = !s.parentElement.open; return; }
      const a = e.target.closest("[data-nav]"); if (a) { e.preventDefault(); history.pushState(null, "", a.dataset.nav); window.dispatchEvent(new CustomEvent("location-changed")); return; }
      const g = e.target.closest("[data-detail]"); if (g && !e.target.closest("[data-tip]") && !this.dragged) open(g);
    });
    this.shadowRoot.addEventListener("keydown", e => { const l = e.target.closest?.(".fx[data-nav],[data-part]"); if (l && (e.key === "Enter" || (e.key === " " && l.dataset.part))) { e.preventDefault(); l.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true })); return; } const g = e.target.closest?.("[data-detail]"); if (g && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); open(g); } });
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
  toggleMenu(on) {
    this.menuOpen = on;
    this.shadowRoot.querySelector(".gear")?.setAttribute("aria-expanded", on);
    this.renderMenu();
  }
  // Settings for this card, saved to the viewer's profile. New options go here.
  renderMenu() {
    const m = this.shadowRoot?.querySelector(".menu"); if (!m) return;
    m.classList.toggle("open", !!this.menuOpen);
    if (!this.menuOpen) return;
    const s = this.settings();
    const seg = (key, opts) => `<div class="seg" role="group">${opts.map(([v, l]) => `<button data-set="${key}" data-v="${v}" aria-pressed="${s[key] === v}">${l}</button>`).join("")}</div>`;
    const sw = (key, label) => `<button class="sw" role="switch" data-set="${key}" data-v="${!s[key]}" aria-checked="${s[key]}" aria-label="${label}"></button>`;
    m.innerHTML = `<div class="mh">Settings<span>System</span></div>
      <div class="mr"><div><b>Style</b><small>Studio is the card's own look</small></div>${seg("look", [["studio", "Studio"], ["theme", "My theme"]])}</div>
      <div class="sep"></div>
      <div class="mr"><div><b>Temperature</b><small>Readings, tips and charts</small></div>${seg("temperature_unit", [["F", "°F"], ["C", "°C"]])}</div>
      <div class="sep"></div>
      <div class="mr"><div><b>Explanations</b><small>The ⓘ next to each reading</small></div>${sw("tips", "Explanations")}</div>
      <div class="mr"><div><b>Apps</b><small>Status, CPU and RAM per app</small></div>${sw("apps", "Apps")}</div>
      <div class="mf">Saved to your profile, so it applies on every device.</div>`;
  }
  ring(pct, color) {
    const r = 24, c = 2 * Math.PI * r, p = Math.max(0, Math.min(100, pct ?? 0));
    return `<svg viewBox="0 0 58 58"><circle class="trk" cx="29" cy="29" r="${r}"/><circle class="val" cx="29" cy="29" r="${r}" style="stroke:${color}" stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - p / 100)}"/></svg>`;
  }
  // Scrubbing a sparkline: the big number shows the reading under the finger / pointer and "now" turns into its time.
  scrubSpark() {
    const restore = sv => { const nm = sv.closest(".spark")?.querySelector(".num"); if (!nm?.dataset.live) return; const [v, u] = nm.dataset.live.split("|");
      nm.querySelector("b").textContent = v; nm.querySelector("span").textContent = u; const q = nm.querySelector(".sq"); q.textContent = "now"; q.classList.remove("on"); };
    for (const sv of this.shadowRoot.querySelectorAll(".sv.on")) if (sv.dataset.id !== this.sh?.id) { sv.classList.remove("on"); restore(sv); }
    const sv = this.sh && this.shadowRoot.querySelector(`.sv[data-id="${this.sh.id}"]`), g = sv && this.sg?.[this.sh.id];
    if (!sv || !g?.pts.length) return;
    const t = g.t0 + this.sh.f * PV_WINDOW;
    let p = null; for (const q of g.pts) { if (q[0] <= t) p = q; else break; }
    if (!p) { sv.classList.remove("on"); restore(sv); return; }
    const left = this.sh.f * 100 + "%";
    sv.querySelector(".scur").style.left = left;
    Object.assign(sv.querySelector(".sdot").style, { left, top: (g.y(p[1]) / g.H * 100) + "%", background: sv.dataset.c });
    const nm = sv.closest(".spark").querySelector(".num"), q = nm.querySelector(".sq");
    nm.querySelector("b").textContent = g.fmt(p[1]); nm.querySelector("span").textContent = g.unit(p[1]);
    q.textContent = new Date(p[0]).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" }); q.classList.add("on");
    sv.classList.add("on");
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
  // Pi 5 line drawing (85 × 56 mm at 2 px/mm). Every part is a button: it opens that part's live readings and specs.
  // Parts in use are drawn in the accent color with their live reading; empty or unused ones are faded and dashed.
  board(s) {
    const C = this.C, cx = 66, cy = 58, sel = k => s.part === k ? " sel" : "";
    let i = 0;
    // each part: a hit box (also the hover / selected outline) around its drawing; st is "on", "off" or "" (unknown)
    const part = (k, name, st, [x, y, w, h], body) => `<g class="part ${st}${sel(k)}" data-part="${k}" style="--i:${i++}" role="button" tabindex="0" aria-label="${name}">
      <rect class="hb" x="${x}" y="${y}" width="${w}" height="${h}" rx="3"/>${body}</g>`;
    const arcs = s.wifi == null ? [0, 0, 0] : [1, 2, 3].map(n => n <= s.wifi);
    const wifi = `<g transform="translate(28 34)">${[4, 7, 10].map((r, n) =>
      `<path d="M${(-r * .72).toFixed(2)} ${(-r * .69).toFixed(2)}A${r} ${r} 0 0 1 ${(r * .72).toFixed(2)} ${(-r * .69).toFixed(2)}" fill="none" stroke-width="1.4" stroke-linecap="round" style="stroke:${arcs[n] ? C.accent : C.text3};opacity:${arcs[n] ? 1 : .35}"/>`).join("")}
      <circle r="1.3" style="fill:${s.wifi ? C.accent : C.text3}"/></g>${s.dbm != null ? `<text class="lbl v" x="28" y="43.5" text-anchor="middle">${s.dbm} dBm</text>` : ""}`;
    const pins = Array.from({ length: 20 }, (_, n) => `<circle class="pin" cx="${(19.5 + n * 4.85).toFixed(2)}" cy="4.9" r=".95"/><circle class="pin" cx="${(19.5 + n * 4.85).toFixed(2)}" cy="8.3" r=".95"/>`).join("");
    const blades = Array.from({ length: 9 }, (_, n) => `<path d="M${cx + 7} ${cy}Q${cx + 14} ${cy - 5} ${cx + 19.5} ${cy - 1.5}" transform="rotate(${n * 40} ${cx} ${cy})"/>`).join("");
    const fanOn = !!s.fan, usbSt = s.usb == null ? "" : s.usb ? "on" : "off";
    const ramH = s.mem == null ? 0 : Math.max(0, Math.min(1, s.mem / 100)) * 22;
    return `<svg viewBox="-8 -2 192 124" role="group" aria-label="Raspberry Pi board: pick a part">
      ${part("board", "Whole board", "", [0, 0, 170, 112], `<rect class="pcb" x="0" y="0" width="170" height="112" rx="6"/>
        ${[[7, 7], [123, 7], [7, 105], [123, 105]].map(([x, y]) => `<circle class="ln" cx="${x}" cy="${y}" r="2.6"/>`).join("")}`)}
      ${part("gpio", "GPIO header", "off", [13, 0, 104, 13], `<rect class="pt" x="15" y="2" width="100" height="9.4" rx="1.5"/>${pins}`)}
      ${part("eth", "Ethernet port", s.eth ? "on" : "off", [144, 2, 34, 29], `<rect class="pt" x="146" y="4" width="30" height="25" rx="2"/><text class="lbl" x="161" y="18.5" text-anchor="middle">ETH</text>`)}
      ${part("usb", "USB ports", usbSt, [147, 35, 31, 64], `<rect class="pt" x="149" y="37" width="27" height="26" rx="2"/><text class="lbl" x="162.5" y="52" text-anchor="middle">USB</text>
        <rect class="pt" x="149" y="71" width="27" height="26" rx="2"/><text class="lbl" x="162.5" y="86" text-anchor="middle">USB</text>`)}
      ${part("hdmi", "Micro-HDMI ports", "off", [33, 104, 35, 13], `<rect class="pt" x="36" y="107" width="11" height="7" rx="1.5"/><rect class="pt" x="54" y="107" width="11" height="7" rx="1.5"/>`)}
      ${part("power", "Power input", "on", [4, 87, 40, 30], `<rect class="pt" x="12" y="106" width="15" height="9" rx="4"/>
        <circle cx="10" cy="93" r="2.3" style="fill:${s.led};filter:drop-shadow(0 0 1.5px ${s.led})"/><text class="lbl" x="15" y="95">PWR${s.watts ? `<tspan class="v" dx="2.5">${s.watts}</tspan>` : ""}</text>`)}
      ${part("sd", "microSD card", s.sdOn == null ? "" : s.sdOn ? "on" : "off", [-7, 44, 25, 26], `<rect class="pt sd${s.sd ? " w" : ""}" x="-5" y="46" width="9" height="20" rx="1.5"/>
        <text class="lbl" x="7.5" y="55">SD</text>${s.sdPct != null ? `<text class="lbl v" x="7.5" y="63">${s.sdPct}%</text>` : ""}`)}
      ${part("wifi", "Wi-Fi and Bluetooth", s.eth ? "off" : "on", [14, 21, 28, 24], wifi)}
      ${s.fan == null ? "" : part("fan", "Cooling fan", fanOn ? "on" : "", [43, 35, 46, 56], `<circle class="ln" cx="${cx}" cy="${cy}" r="22"/>
        <g class="fan${fanOn ? "" : " off"}" style="--d:${s.fanDur}s" fill="none" stroke-width=".9" stroke-linecap="round"><g style="stroke:${fanOn ? C.accent : C.text3};opacity:${fanOn ? .55 : .4}">${blades}</g></g>
        <text class="lbl v" x="${cx}" y="${cy + 29}" text-anchor="middle">${s.fanTxt}</text>`)}
      ${part("soc", "Processor", "", [52, 44, 28, 28], `<rect x="${cx - 12}" y="${cy - 12}" width="24" height="24" rx="3" stroke-width="1.3" style="fill:color-mix(in srgb, ${s.soc} 16%, var(--pv-surface));stroke:${s.soc}"/>
        <text class="lbl" x="${cx}" y="${cy - 5}" text-anchor="middle" style="fill:${s.soc};font-size:4.4px">${s.chip}</text>
        ${s.temp ? `<text class="lbl" x="${cx}" y="${cy + 2.6}" text-anchor="middle" style="fill:${s.soc};font-size:7.6px;letter-spacing:0">${s.temp}</text>` : ""}
        ${s.cpu != null ? `<text class="lbl" x="${cx}" y="${cy + 8.6}" text-anchor="middle" style="fill:${s.soc};font-size:4.8px;letter-spacing:.02em">CPU ${s.cpu}%</text>` : ""}`)}
      ${part("ram", "Memory", "on", [94, 44, 22, 38], `<rect class="pt" x="96" y="46" width="18" height="24" rx="1.5"/>
        ${ramH ? `<rect x="97" y="${(69 - ramH).toFixed(1)}" width="16" height="${ramH.toFixed(1)}" rx="1" style="fill:${C.accent};opacity:.22"/>` : ""}
        ${s.mem != null ? `<text class="lbl v" x="105" y="60" text-anchor="middle" style="font-size:6.4px">${s.mem}%</text>` : ""}
        <text class="lbl" x="105" y="78" text-anchor="middle">RAM</text>`)}
      ${part("rp1", "RP1 I/O controller", "", [122, 49, 18, 27], `<rect class="pt" x="124" y="51" width="14" height="14" rx="1.5"/><text class="lbl" x="131" y="73" text-anchor="middle">RP1</text>`)}
    </svg>`;
  }
  // Board name from Home Assistant's own hardware info ("Raspberry Pi 5"), so the model is known without the pi_vitals sensor.
  async loadHw() {
    try { const r = await this._hass.callWS({ type: "hardware/info" }); this.hwModel = (r.hardware || []).map(h => h.name).find(n => n) || null; }
    catch (e) { this.hwModel = null; }
    if (this.hwModel) { this.boardSig = ""; this.render(); }
  }
  // Plugged-in USB devices from the Supervisor's hardware list (admins only). Root hubs and hubs are skipped.
  // Unavailable (not an admin, no Supervisor) leaves the USB ports neutral rather than guessing.
  async loadUsb() {
    try {
      const r = await this._hass.callWS({ type: "supervisor/api", endpoint: "/hardware/info", method: "get" });
      this.usb = (r.devices || []).filter(d => d.subsystem === "usb" && d.attributes?.DEVTYPE === "usb_device" && !/^usb\d+$/.test(d.name) && !/^:09/.test(d.attributes?.ID_USB_INTERFACES || ""))
        .map(d => pvEsc((d.attributes.ID_MODEL_FROM_DATABASE || d.attributes.ID_USB_MODEL || d.attributes.ID_MODEL || "USB device").replace(/_/g, " ")));
    } catch (e) { this.usb = null; this.usbT = Infinity; }
    this.render();
  }
  render(force) {
    if (!this._hass || !this.config) return;
    if (!force && (this.holdUntil > Date.now() || (this.pressing && Date.now() - this.pressT < 3000))) { this.pending = true; return; }
    const cfg = this.config, C = this.C, H = this._hass.states, R = this.R, S = this.settings(), tUnit = "°" + S.temperature_unit;
    const n = id => this.n(this.S(id)), v = id => this.v(this.S(id));
    const hn = id => { const x = parseFloat(H[id]?.state); return Number.isFinite(x) ? x : null; };
    const VA = H[R.vitals]?.attributes || {}, watts = hn(R.vitals);
    const cores = cfg.cores;
    const cpu = n("processor_use"), mem = n("memory_usage"), disk = n("disk_usage"), tRaw = n("processor_temperature");
    const tU = H[this.S("processor_temperature")]?.attributes?.unit_of_measurement || "°C", isF = /F/.test(tU);
    const tC = tRaw == null ? null : isF ? (tRaw - 32) * 5 / 9 : tRaw;
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
    const hwm = VA.model || this.hwModel || "";
    const model = pvEsc(cfg.title || (hwm ? hwm.replace(/ Model .*| Rev .*/, "") : R.rpiPower ? "Raspberry Pi" : "Home Assistant host"));
    const isPi = /raspberry/i.test(hwm) || !!R.rpiPower || /raspberry/i.test(cfg.title || "");
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

    // trends: disk forecast and "usual" comparisons (from loadHistory)
    const T = this.trend || { norm: {} }, slope = T.slope;
    const daysLeft = slope != null && dFree != null && slope > 0.02 ? dFree / slope : null;
    const fullIn = d => d < 14 ? `${Math.max(1, Math.round(d))} days` : d < 60 ? `${Math.round(d / 7)} weeks` : d < 730 ? `${Math.round(d / 30.4)} months` : "years";
    const forecast = slope == null ? null : daysLeft == null ? "Not filling up" : `Full in ~${fullIn(daysLeft)}`;
    const fColor = daysLeft == null ? null : daysLeft < 7 ? C.bad : daysLeft < 30 ? C.warn : null;
    const usual = (k, x, min, show) => {
      const u = T.norm[k]; if (!u || x == null) return "";
      const mu = k === "temp" && isF ? (u.mu - 32) * 5 / 9 : u.mu, sd = k === "temp" && isF ? u.sd * 5 / 9 : u.sd, gap = Math.max(1.5 * sd, min);
      const hi = x - mu > gap, lo = mu - x > gap;
      return `<div class="nrm"${hi ? ` style="color:${C.warn}"` : ""}>${hi ? "Above 7-day avg of " : lo ? "Below 7-day avg of " : "7-day avg "}${show(mu)}</div>`;
    };

    // verdict: worst issue wins
    const issues = [];
    if (daysLeft != null && daysLeft < 7) issues.push([2, "Disk nearly full"]);
    else if (daysLeft != null && daysLeft < 30) issues.push([1, "Disk filling up"]);
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
    this.gen = /Pi 5/.test(hwm || model) ? 5 : /Pi 4/.test(hwm || model) ? 4 : /Pi 3/.test(hwm || model) ? 3 : 0;
    const onSd = VA.disk_device ? /^mmcblk/.test(VA.disk_device) : null, dbmTxt = dbm == null ? null : String(dbm).replace("-", "−");
    const bs = { soc: tempColor, chip: /Pi 5/.test(hwm || model) ? "2712" : /Pi 4/.test(hwm || model) ? "2711" : "SoC", fan: fan == null ? null : fan > 0, fanDur: fan ? Math.max(0.25, Math.round(2400 / fan * 4) / 4) : 1,
      fanTxt: fan ? Math.round(fan).toLocaleString() + " RPM" : "IDLE", led: uvNow ? C.bad : C.ok, wifi: wired ? null : wifiBars, dbm: wired ? null : dbmTxt,
      sd: (VA.disk_write_kbs ?? 0) > 50 && onSd, sdOn: onSd, sdPct: onSd === false || disk == null ? null : Math.round(disk), watts: watts != null ? watts.toFixed(1) + " W" : null,
      temp: tC == null ? null : Math.round(this.tC2D(tC)) + "°", cpu: cpu == null ? null : Math.round(cpu), mem: mem == null ? null : Math.round(mem), eth: wired,
      usb: this.usb == null ? null : this.usb.length, part: this.pvPart || null };
    // hover summaries for the board parts (mouse only; a tap opens the part panel)
    const tvNow = tC == null ? null : Math.round(this.tC2D(tC)) + " " + tUnit;
    this.partTips = {
      board: [model, verdict],
      soc: ["Processor", [tvNow, cpu != null && `CPU ${Math.round(cpu)}%`].filter(Boolean).join(" · ") + " now"],
      ram: ["Memory", mem == null ? "" : `${Math.round(mem)}% used now${memUse != null ? ` (${gb(memUse)} of ${gb(memTot)} GB)` : ""}`],
      fan: ["Cooling fan", fan ? `Spinning at ${Math.round(fan).toLocaleString()} rpm now` : "Idle: the chip is cool enough"],
      sd: ["microSD card", onSd === false ? `Empty slot: the Pi boots from its ${devKind(VA.disk_device)}` : disk != null ? `Boot disk, ${Math.round(disk)}% full` : "Boot disk"],
      power: ["Power input", [watts != null && `${watts.toFixed(2)} W now`, uvNow ? "supply dipping" : "supply steady"].filter(Boolean).join(", ")],
      wifi: ["Wi-Fi and Bluetooth", wired ? "Not in use: the Pi is on Ethernet" : dbm != null ? `${dbm > -60 ? "Excellent" : dbm > -70 ? "Good" : dbm > -75 ? "Fair" : "Weak"} signal, ${dbmTxt} dBm now` : "In use"],
      eth: ["Ethernet", wired ? "Connected" : "Nothing plugged in: the Pi is on Wi-Fi"],
      usb: ["USB ports", this.usb == null ? "4 ports" : this.usb.length ? "Plugged in: " + this.usb.join(", ") : "Nothing plugged in"],
      hdmi: ["Micro-HDMI ports", "Not in use: Home Assistant runs without a screen"],
      rp1: ["RP1 I/O controller", "Runs the USB, Ethernet and GPIO connections"],
      gpio: ["GPIO header", "Not in use: nothing is reading these pins"],
    };
    const bsig = JSON.stringify(bs);
    const boardEl = this.shadowRoot.querySelector(".board");
    boardEl.hidden = !isPi; this.shadowRoot.querySelector(".hero").classList.toggle("solo", !isPi);
    if (isPi && bsig !== this.boardSig) { this.boardSig = bsig; boardEl.innerHTML = this.board(bs) + `<div class="blg"><span><i class="on"></i>In use</span><span><i class="off"></i>Not in use</span><ha-icon icon="mdi:gesture-tap" title="Tap a part for details" aria-hidden="true"></ha-icon></div>`; }

    // header (model, uptime, verdict badge, settings) and the status facts beside the board
    const fx = [];
    if (watts != null || ps) fx.push([uvNow ? C.bad : uvBoot ? C.warn : C.ok, "Power", uvNow ? "Under-voltage now" : uvBoot ? "Dipped since boot" : "Stable since boot", watts != null ? `Board ${watts.toFixed(2)} W now` : "Supply checker", "uv"]);
    if (thr) fx.push([slowNow ? C.bad : slowBoot ? C.warn : C.ok, "Throttling", slowNow ? "Active now" : slowBoot ? "Earlier since boot" : "None since boot", VA.arm_mhz ? `CPU ${VA.arm_mhz.toLocaleString()} MHz now` : "", "throttle"]);
    if (disk != null) fx.push([busy(disk, 80, 90) || C.ok, "Storage", `${Math.round(disk)}% used`, [devKind(VA.disk_device), VA.db_mb ? `DB ${VA.db_mb >= 1000 ? (VA.db_mb / 1000).toFixed(1) + " GB" : Math.round(VA.db_mb) + " MB"}` : ""].filter(Boolean).join(" · "), "storage"]);
    if (H[bLast]) fx.push([backupAgeD == null ? C.neutral : backupAgeD > cfg.backup_stale_days ? C.warn : C.ok, "Backups", ago(bLast) || "None yet", ago(bNext) ? `Next ${ago(bNext)}` : "", "backup"]);
    fx.push([pendingU.length ? C.warn : C.ok, "Updates", pendingU.length ? `${pendingU.length} available` : "All current", pendingU.length ? pendingU.map(u => pvEsc((u.attributes.friendly_name || "").replace(/ update$/i, ""))).join(", ") : `${updates.length} tracked`, "updates"]);
    if (wired) fx.push([C.ok, "Network", "Ethernet", ifc, "net"]);
    else if (dbm != null) fx.push([dbm > -67 ? C.ok : dbm > -75 ? C.warn : C.bad, "Wi-Fi", dbm > -60 ? "Excellent" : dbm > -70 ? "Good" : dbm > -75 ? "Fair" : "Weak", `${String(dbm).replace("-", "−")} dBm now`, "wifi"]);
    this.shadowRoot.querySelector(".hl").innerHTML = `<span class="tile"><ha-icon icon="${isPi ? "mdi:raspberry-pi" : "mdi:server"}"></ha-icon></span>
      <div class="ttl"><span class="title">${model}</span>${up ? `<span class="upt">Up ${up}</span>` : ""}</div>
      <span class="status"><i class="dot" style="background:${vColor}"></i><span class="vt">${verdict}</span>${this.tip("status")}</span>`;
    const nav = { backup: "/config/backup", updates: "/config/updates" };
    this.shadowRoot.querySelector(".facts2").innerHTML = fx.map(([c, k, val, sub, t]) =>
      `<div class="fx${nav[t] ? " lk" : ""}"${nav[t] ? ` data-nav="${nav[t]}" role="link" tabindex="0"` : ""}><div class="k"><i class="dot" style="background:${c}"></i>${k}${this.tip(t)}</div><div class="val">${val}</div><div class="sub" title="${sub}">${sub || "&nbsp;"}</div></div>`).join("");

    // gauges
    const gauges = [
      ["CPU", "cpu", cpu == null ? "—" : Math.round(cpu), "%", cpu, busy(cpu, 60, 85) || C.accent, l1 != null ? `Load ${l1.toFixed(2)} · 1-min avg` : `${cores} cores`, `${this.S("processor_use")}|CPU|infra|0|6H`, usual("cpu", cpu, 3, x => Math.round(x) + "%")],
      ["Memory", "mem", mem == null ? "—" : Math.round(mem), "%", mem, busy(mem, 70, 90) || C.accent, memTot ? `${gb(memUse)} of ${gb(memTot)} GB` : "", `${this.S("memory_usage")}|Memory|infra|0|6H`, usual("mem", mem, 3, x => Math.round(x) + "%")],
      ["Disk", "disk", disk == null ? "—" : Math.round(disk), "%", disk, busy(disk, 75, 90) || C.accent, dTot ? `${dUse.toFixed(1)} of ${dTot.toFixed(0)} GB` : "", `${this.S("disk_usage")}|Disk|infra|1|7D`, forecast ? `<div class="nrm"${fColor ? ` style="color:${fColor}"` : ""}>${forecast}</div>` : ""],
      ["Temperature", "temp", tC == null ? "—" : Math.round(this.tC2D(tC)), tUnit, tC == null ? 0 : tC / 85 * 100, tempColor, fan == null ? "" : fan ? `Fan ${Math.round(fan).toLocaleString()} rpm` : "Fan idle", `${this.S("processor_temperature")}|CPU temperature|climate|1|1H|t`, usual("temp", tC, 2, x => Math.round(this.tC2D(x)) + tUnit)],
    ];
    const gaugesHtml = gauges.filter(g => H[g[7].split("|")[0]]).map(([name, t, val, u, pct, col, sub, det, nrm]) => `<div class="ring" data-detail="${det}" role="button" tabindex="0" aria-label="Open ${name} history">${this.ring(pct, col)}
      <div class="rt"><div class="k">${name} <span class="qu">now</span>${this.tip(t)}</div><div class="num"><b>${val}</b><span>${u}</span></div><div class="sub">${sub || "&nbsp;"}</div>${nrm}</div><svg class="chev" viewBox="0 0 16 16" aria-hidden="true"><path d="M6.5 4l4 4-4 4"/></svg></div>`).join("");

    // sparks
    const fmt = (x, u) => x == null ? "—" : u === "MB/s" ? (x < 1 ? (x * 1000).toFixed(0) : x.toFixed(1)) : u === "W" ? x.toFixed(2) : /°/.test(u) ? x.toFixed(0) : u === "" ? x.toFixed(2) : Math.round(x);
    const unit = (x, u) => u === "MB/s" ? (x != null && x < 1 ? "KB/s" : "MB/s") : u;
    const toD = x => x == null ? null : this.tC2D(isF ? (x - 32) * 5 / 9 : x);
    this.sfmt = {}; this.sunit = {};
    const sparks = this.sparkDefs().map(([key, id, name, u]) => {
      const x = this.n(id), col = key === "temp" ? C.climate : C.accent, temp = key === "temp";
      this.sfmt[id] = y => temp ? fmt(toD(y), tUnit) : fmt(y, u); this.sunit[id] = y => temp ? tUnit : unit(y, u);
      const dec = { cpu: 0, mem: 0, temp: 1, power: 2, load: 2, down: 3, up: 3 }[key];
      return `<div class="spark" data-detail="${id}|${name}|${temp ? "climate" : "infra"}|${dec}|6H${temp ? "|t" : ""}" role="button" tabindex="0" aria-label="Open ${name} history"><div class="lbl"><i class="dot" style="background:${col}"></i>${name}${key === "down" ? this.tip("net") : ""}</div>
      <div class="num" data-live="${this.sfmt[id](x)}|${this.sunit[id](x)}"><b>${this.sfmt[id](x)}</b><span>${this.sunit[id](x)}</span><em class="sq">now</em></div>
      <div class="sv" data-id="${id}" data-c="${col}">${this.spark(id, col)}<div class="scur"></div><div class="sdot"></div></div></div>`; }).join("");

    // sections
    const panel = (title, body, meta = "", tip = "") => `<div class="panel"><div class="ph"><b>${title}</b>${tip ? this.tip(tip) : ""}${meta ? `<span class="m">${meta}</span>` : ""}</div><div class="pb">${body}</div></div>`;
    const sz = mib => mib == null ? "—" : mib >= 1024 ? (mib / 1024).toFixed(2) + " GB" : Math.round(mib) + " MB";
    const mb = x => x >= 1000 ? (x / 1000).toFixed(2) + " GB" : Math.round(x) + " MB";
    const kvr = (label, val, tip) => `<div class="kvr"><span>${label}${tip ? this.tip(tip) : ""}</span><b>${val}</b></div>`;
    const storage = panel("Storage", `
      <div class="row"><div class="rowh"><span>Disk${this.tip("storage")}</span><span><b>${dUse != null ? dUse.toFixed(1) : "—"} GB</b> used · ${dFree != null ? dFree.toFixed(1) : "—"} free</span></div>
        <div class="bar"><span style="width:${disk ?? 0}%;background:${busy(disk, 80, 90) || C.accent}"></span></div></div>
      <div class="kvs">
        ${forecast ? kvr("Disk full", daysLeft == null ? "Not filling up" : `<span${fColor ? ` style="color:${fColor}"` : ""}>~${fullIn(daysLeft)}</span> <span class="x">at +${slope.toFixed(2)} GB/day</span>`, "forecast") : ""}
        ${VA.db_mb != null ? kvr("Database", `${mb(VA.db_mb)} <span class="x">now</span>`, "db") + kvr("DB growth", VA.db_mb_per_day != null ? `${VA.db_mb_per_day >= 0 ? "+" : "−"}${Math.abs(VA.db_mb_per_day)} MB/day <span class="x">7-day avg</span>` : `<span class="x">Shows after 1 day</span>`) : ""}
        ${VA.disk_written_gb != null ? kvr("Written", `${VA.disk_written_gb} GB <span class="x">since boot</span>`, "writes") : ""}
        ${VA.disk_write_kbs != null ? kvr("Writing", `${VA.disk_write_kbs} kB/s <span class="x">10-min avg</span>`, "writes") : ""}
        ${kvr("Swap", `${swapUse != null ? Math.round(swapUse) : "—"} MB <span class="x">${swap ?? "—"}% now</span>`, "swap")}
      </div>`, devKind(VA.disk_device) || "");
    const flagName = { under_voltage: "Under-voltage", freq_capped: "Capped", throttled: "Throttled", soft_temp_limit: "Soft temp limit" };
    const flagPills = (list, cls) => list.length ? `<span class="flags">${list.map(f => `<span class="pill ${cls}">${flagName[f] || f}</span>`).join("")}</span>` : `<span class="pill on">None</span>`;
    const perf = panel("Power & performance", `<div class="kvs">
      ${watts != null ? kvr("Board power", `${watts.toFixed(2)} W <span class="x">now</span>`, "power_g") : ""}
      ${VA.arm_mhz ? kvr("CPU clock", `${VA.arm_mhz.toLocaleString()} MHz <span class="x">now${/Pi 5/.test(hwm || model) ? ", of 2,400" : ""}</span>`, "clock") : ""}
      ${thr ? kvr("Throttling now", flagPills(tNow, "bad"), "throttle") + kvr("Since boot", flagPills(tBoot, "upd"), "throttle") : ""}
      ${!thr && ps ? kvr("Power supply", ps === "on" ? `<span class="pill bad">Under-voltage</span>` : `<span class="pill on">OK</span>`, "uv") : ""}
      ${fan != null ? kvr("Fan", fan ? `${Math.round(fan).toLocaleString()} rpm <span class="x">now, ${Math.round(fan / cfg.fan_max_rpm * 100)}% of full</span>` : `Idle <span class="x">now</span>`, "fan") : ""}
      ${!wired && dbm != null ? kvr("Wi-Fi signal", `${String(dbm).replace("-", "−")} dBm <span class="x">now</span>`, "wifi") : ""}
    </div>`);
    const care = panel("Backups & updates", `<div class="kvs">
      ${H[bLast] ? kvr("Last backup", ago(bLast) || "—", "backup") + kvr("Next backup", ago(bNext) || "—") : ""}
      ${pendingU.length ? pendingU.map(u => kvr(pvEsc((u.attributes.friendly_name || u.entity_id).replace(/ update$/i, "")), `<span class="x">${pvEsc(u.attributes.installed_version)} →</span> <span class="pill upd">${pvEsc(u.attributes.latest_version)}</span>`)).join("")
        : kvr("Updates", `<span class="pill on">All ${updates.length} current</span>`, "updates")}
    </div>`, pendingU.length ? `${pendingU.length} pending` : "");

    // recent events
    const EV = this.events, evCol = { ok: C.ok, warn: C.warn, bad: C.bad, neutral: C.neutral, accent: C.accent };
    const when = ms => { const d = new Date(ms), t0 = new Date().setHours(0, 0, 0, 0), tm = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      return ms >= t0 ? tm : ms >= t0 - 864e5 ? "Yesterday " + tm : d.toLocaleDateString([], { weekday: "short" }) + " " + tm; };
    const evShown = EV ? (this.evAll ? EV : EV.slice(0, 6)) : [];
    const eventsHtml = !EV ? "" : panel("Recent events", EV.length ? `<div class="evs">${evShown.map(e => `<div class="ev"><i class="dot" style="background:${evCol[e.color]}"></i>
        <span class="et">${e.text}${e.sub ? `<span class="x"> · ${e.sub}</span>` : ""}</span><span class="ew">${when(e.t)}</span></div>`).join("")}
        ${EV.length > 6 ? `<button class="evmore" data-evall>${this.evAll ? "Show fewer" : `Show all ${EV.length}`}</button>` : ""}</div>`
      : `<div class="ev quiet">A quiet week: no reboots, restarts or problems.</div>`, "Last 7 days", "events");

    // apps
    const pct1 = x => x == null ? "—" : (x < 10 ? x.toFixed(1) : Math.round(x)) + "%";
    const sys = [["Home Assistant Core", R.sys.core], ["Supervisor", R.sys.supervisor]].filter(([, d]) => d);
    const stateOf = id => id ? H[id]?.state : undefined;
    const running = R.apps.filter(a => stateOf(a.running) === "on").length;
    const appsHtml = !S.apps || !(sys.length || R.apps.length) ? "" : panel("Apps", `
      <table class="apps"><tr><th>Name</th><th>Status</th><th>CPU</th><th>RAM</th><th>Version</th></tr>
        ${sys.map(([nm, d]) =>
          `<tr${d.cpu_percent ? ` data-detail="${d.cpu_percent}|${nm} CPU|infra|1|24H" tabindex="0"` : ""}><td>${nm}<span class="sub">System</span></td><td><span class="pill on"><span class="pt">Running</span></span></td><td>${pct1(hn(d.cpu_percent))}</td><td>${pct1(hn(d.memory_percent))}</td><td>${ver(d.update)}</td></tr>`).join("")}
        ${R.apps.map(a => { const run = stateOf(a.running) === "on", upd = stateOf(a.update) === "on";
          return `<tr${a.cpu_percent ? ` data-detail="${a.cpu_percent}|${a.name} CPU|infra|1|24H" tabindex="0"` : ""}><td>${a.name}</td><td><span class="pill ${run ? "on" : "off"}" title="${run ? "Running" : "Stopped"}"><span class="pt">${run ? "Running" : "Stopped"}</span></span></td>
            <td>${run ? pct1(hn(a.cpu_percent)) : "—"}</td><td>${run ? pct1(hn(a.memory_percent)) : "—"}</td>
            <td>${pvEsc(stateOf(a.version)) || "—"}${upd ? ` <span class="pill upd">→ ${pvEsc(stateOf(a.version_latest) || H[a.update]?.attributes?.latest_version)}</span>` : ""}</td></tr>`; }).join("")}</table>`,
      [R.apps.length ? `${running} of ${R.apps.length} running` : "", (() => { const ts = [...sys.map(([, d]) => d.cpu_percent), ...R.apps.map(a => a.cpu_percent)].map(id => H[id]?.last_updated).filter(Boolean).map(x => Date.parse(x));
        return ts.length ? "usage as of " + this.dur(Date.now() - Math.max(...ts)) + " ago" : ""; })()].filter(Boolean).join(" · "), "apps");

    // setup help: System Monitor missing, or some of its sensors still off (it ships with most disabled)
    const smLink = `<a data-nav="/config/integrations/integration/systemmonitor">Open System Monitor ›</a>`;
    const missing = R.hasSM ? PV_NEEDED.filter(([k]) => !R.sm[k]?.length).map(([, nm]) => nm) : [];
    const setup = this.legacy || R.noRegistry ? "" : !R.hasSM
      ? `<div class="setup"><ha-icon icon="mdi:wrench-outline"></ha-icon><div><b>Add the System Monitor integration</b> (Settings → Devices & services → Add integration → System Monitor), then turn on its sensors: most are off by default. <a data-nav="/config/integrations/dashboard">Open integrations ›</a></div></div>`
      : missing.length ? `<div class="setup"><ha-icon icon="mdi:toggle-switch-off-outline"></ha-icon><div><b>${missing.length === 1 ? "1 sensor is" : missing.length + " sensors are"} off:</b> ${missing.join(", ")}. Turn ${missing.length === 1 ? "it" : "them"} on in System Monitor's entity list. ${smLink}</div></div>` : "";
    const vitalsHint = isPi && !H[R.vitals] ? `<div class="foot">Board power, throttling, CPU clock and SD-card wear come from the optional pi_vitals sensor (see the card's README).</div>` : "";
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
    const big = (label, val, u = "") => `<div><div class="sub">${label}</div><div class="num"><b>${val}</b>${u ? `<span>${u}</span>` : ""}</div></div>`;
    const more = `<details class="more"${this.moreOpen ? " open" : ""}><summary><svg class="cv" viewBox="0 0 16 16" aria-hidden="true"><path d="M6.5 4l4 4-4 4"/></svg><b>More details</b><span class="blurb">Memory, load and stall pressure, network counters, platform</span></summary>
      <div class="grid3">
        ${panel("Memory", `
          <div class="row"><div class="rowh"><span>RAM${this.tip("ram")}</span><span><b>${memUse != null ? gb(memUse) : "—"} GB</b> used · ${memFree != null ? gb(memFree) : "—"} free</span></div>
            <div class="bar"><span style="width:${mem ?? 0}%;background:${C.accent}"></span></div></div>
          <div class="row"><div class="rowh"><span>Swap${this.tip("swap")}</span><span><b>${swapUse != null ? Math.round(swapUse) : "—"} MB</b> · ${swap ?? "—"}%</span></div>
            <div class="bar"><span style="width:${swap ?? 0}%;background:${C.accent}"></span></div></div>
          <div class="row kv">${big("Disk total", hn(R.sys.host?.disk_total) ?? (dTot ? dTot.toFixed(0) : "—"), "GB")}${big("RAM total", memTot ? gb(memTot) : "—", "GB")}</div>`)}
        ${panel("Load average", `
          <div class="row loads">${[["1 min", l1], ["5 min", l5], ["15 min", l15]].map(([k, x]) => `<div><div class="sub">${k}</div><div class="num"><b>${x != null ? x.toFixed(2) : "—"}</b></div>${loadBar(x)}</div>`).join("")}</div>
          <div class="row"><div class="k">Stall pressure${this.tip("psi_grid")}</div>
          <table class="psi"><tr><th></th><th>10 s</th><th>1 min</th><th>5 min</th></tr>
            ${psiRows.map(([k, r, w]) => `<tr><td>${k}</td><td>${psiCell(pv(r, w + "_10s"))}</td><td>${psiCell(pv(r, w + "_60s"))}</td><td>${psiCell(pv(r, w + "_300s"))}</td></tr>`).join("")}</table></div>`, `${cores} cores`, "load")}
        ${panel(wired ? "Network" : "Wi-Fi", `
          <div class="row kv">${big("Downloaded", sz(netIn).split(" ")[0], sz(netIn).split(" ")[1] || "")}${big("Uploaded", sz(netOut).split(" ")[0], sz(netOut).split(" ")[1] || "")}
            ${big("Packets in", cnt(pIn))}${big("Packets out", cnt(pOut))}</div>
          <div class="row"><table><tr><th></th><th>In</th><th>Out</th></tr>
            <tr><td>Per day <span class="sub">avg since boot</span></td><td>${days ? sz(netIn / days) : "—"}</td><td>${days ? sz(netOut / days) : "—"}</td></tr>
            <tr><td>Now</td><td>${fmt(n(`network_throughput_in_${ifc}`), "MB/s")} ${unit(n(`network_throughput_in_${ifc}`), "MB/s")}</td><td>${fmt(n(`network_throughput_out_${ifc}`), "MB/s")} ${unit(n(`network_throughput_out_${ifc}`), "MB/s")}</td></tr></table></div>`, "Since boot", "net")}
      </div>
      <div class="facts cells">
        <div class="fx"><div class="k">Uptime${this.tip("uptime")}</div><div class="val">${up || "—"}</div><div class="sub">Booted ${boot ? new Date(boot).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—"}</div></div>
        <div class="fx"><div class="k">Local IP${this.tip("ip")}</div><div class="val">${ipv4 ?? "—"}</div><div class="sub">${ifc}</div></div>
        <div class="fx"><div class="k">Home Assistant${this.tip("ha_stats")}</div><div class="val">${Object.keys(H).length.toLocaleString()} entities</div><div class="sub">${count("automation")} automations · ${count("script")} scripts</div></div>
        <div class="fx"><div class="k">Platform${this.tip("ha")}</div><div class="val">${R.sys.os ? `OS ${stateOf(R.sys.os.version) ?? "—"}` : `Core ${ver(R.sys.core?.update)}`}</div><div class="sub">${R.sys.os ? `Core ${ver(R.sys.core?.update)}` : "&nbsp;"}</div></div>
      </div>
      ${cfg.footer ? `<div class="foot">${pvEsc(cfg.footer)}</div>` : ""}${vitalsHint}
    </details>`;

    // part panel: the board part someone picked, with its live readings (tap one for its history) and its specs
    const pdEl = this.shadowRoot.querySelector(".pd"), f2 = this.shadowRoot.querySelector(".facts2");
    if (this.pvPart && isPi) {
      const det = (sfx, title, dec, range, extra = "") => { const id = sfx && (sfx.includes(".") ? sfx : this.S(sfx)); return id && H[id] ? `${id}|${title}|${extra === "|t" ? "climate" : "infra"}|${dec}|${range}${extra}` : ""; };
      const q = t => `<span class="qu">${t}</span>`, tv = tC == null ? "—" : Math.round(this.tC2D(tC)) + " " + tUnit;
      const flagsTxt = l => l.length ? l.map(f => flagName[f] || f).join(", ") : "None";
      const net = sfx => { const x = n(sfx); return x == null ? "—" : `${fmt(x, "MB/s")} ${unit(x, "MB/s")}`; };
      const pi5 = /Pi 5/.test(hwm || model), ramGb = memTot ? Math.round(memTot / 1024) : null;
      const P = {
        board: { meta: pvEsc(hwm) || model, live: [["Status", verdict, ""], ["Up", up || "—", "since boot"], ["Board power", watts != null ? watts.toFixed(2) + " W" : "—", "now", det(R.vitals, "Pi board power", 2, "6H")], ["CPU", cpu == null ? "—" : Math.round(cpu) + "%", "now", det("processor_use", "CPU", 0, "6H")], ["Temperature", tv, "now", det("processor_temperature", "CPU temperature", 1, "6H", "|t")]],
          specs: pi5 ? [["Processor", "Broadcom BCM2712, 4× Cortex-A76 at 2.4 GHz"], ["Graphics", "VideoCore VII"], ["Memory", (ramGb ? ramGb + " GB " : "") + "LPDDR4X-4267"], ["Wireless", "Wi-Fi 5 (dual band), Bluetooth 5.0"], ["Ethernet", "Gigabit, PoE+ with a HAT"], ["USB", "2× USB 3.0, 2× USB 2.0"], ["Video", "2× micro-HDMI, 4K at 60 Hz"], ["Storage", "microSD; PCIe 2.0 ×1 for an NVMe SSD"], ["Power", "USB-C, 5 V at up to 5 A"], ["Size", "85 × 56 mm"]] : [] },
        soc: { meta: pi5 ? "Broadcom BCM2712" : "Processor", live: [["CPU use", cpu == null ? "—" : Math.round(cpu) + "%", "now", det("processor_use", "CPU", 0, "6H")], ["Temperature", tv, "now", det("processor_temperature", "CPU temperature", 1, "6H", "|t")],
            ["Clock", VA.arm_mhz ? VA.arm_mhz.toLocaleString() + " MHz" : "—", "now"], ["Load", l1 != null ? l1.toFixed(2) : "—", "1-min avg", det("load_1_min", "Load · 1 min", 2, "6H")], ["Throttling", flagsTxt(tNow), "now"], ["Throttled", flagsTxt(tBoot), "since boot"]],
          specs: pi5 ? [["Cores", "4× Arm Cortex-A76, 64-bit"], ["Top speed", "2,400 MHz"], ["Cache", "512 KB L2 per core, 2 MB L3"], ["Graphics", "VideoCore VII, OpenGL ES 3.1, Vulkan 1.2"], ["Throttles", `From ${Math.round(this.tC2D(80))} ${tUnit} (harder at ${Math.round(this.tC2D(85))} ${tUnit})`]] : [] },
        ram: { meta: ramGb ? ramGb + " GB" : "Memory", live: [["Used", memUse != null ? `${gb(memUse)} of ${gb(memTot)} GB · ${Math.round(mem)}%` : "—", "now", det("memory_usage", "Memory", 0, "6H")],
            ...(T.norm.mem ? [["Typical", Math.round(T.norm.mem.mu) + "%", "7-day avg"]] : []), ["Swap", swapUse != null ? Math.round(swapUse) + " MB" : "—", "now", det("swap_usage", "Swap", 0, "24H")]],
          specs: pi5 ? [["Type", "LPDDR4X-4267 SDRAM"], ["Size", ramGb ? ramGb + " GB" : "—"], ["Shared with", "Graphics (VideoCore VII)"]] : [] },
        fan: { meta: fan ? "Spinning" : "Idle", live: [["Speed", fan == null ? "—" : fan ? Math.round(fan).toLocaleString() + " rpm" : "Idle", "now", det(this.S("pwmfan_fan_speed") ? "pwmfan_fan_speed" : "fan_speed", "Fan speed", 0, "6H")], ["Of full speed", fan == null ? "—" : Math.round(fan / cfg.fan_max_rpm * 100) + "%", "now"], ["CPU temperature", tv, "now"]],
          specs: pi5 ? [["Connector", "4-pin PWM fan header"], ["Firmware curve", `Starts at ${Math.round(this.tC2D(50))} ${tUnit}, steps up at ${Math.round(this.tC2D(60))} and ${Math.round(this.tC2D(67.5))}, full speed at ${Math.round(this.tC2D(75))} ${tUnit}`], ["Full speed", "~" + cfg.fan_max_rpm.toLocaleString() + " rpm (card setting)"]] : [] },
        sd: { meta: devKind(VA.disk_device) || "Boot disk", live: [["Used", dUse != null ? `${dUse.toFixed(1)} of ${dTot.toFixed(0)} GB` : "—", "now", det("disk_usage", "Disk", 1, "7D")], ["Disk full", daysLeft == null ? (forecast || "—") : "~" + fullIn(daysLeft), daysLeft == null ? "" : `at +${slope.toFixed(2)} GB/day`],
            ...(VA.db_mb != null ? [["Database", mb(VA.db_mb), "now"], ["Database growth", VA.db_mb_per_day != null ? (VA.db_mb_per_day >= 0 ? "+" : "−") + Math.abs(VA.db_mb_per_day) + " MB/day" : "—", "7-day avg"]] : []),
            ...(VA.disk_written_gb != null ? [["Written", VA.disk_written_gb + " GB", "since boot"], ["Writing", (VA.disk_write_kbs ?? "—") + " kB/s", "10-min avg"]] : [])],
          specs: pi5 ? [["Slot", "microSD, SDR104 (about 100 MB/s)"], ["Device", VA.disk_device || "—"], ["Better option", "An NVMe SSD on the PCIe port lasts far longer under constant writes"]] : [] },
        power: { meta: "USB-C", live: [["Board power", watts != null ? watts.toFixed(2) + " W" : "—", "now", det(R.vitals, "Pi board power", 2, "6H")], ["Supply", uvNow ? "Under-voltage" : "Steady", "now"], ["Dips", uvBoot ? "Yes" : "None", "since boot"]],
          specs: pi5 ? [["Input", "USB-C, 5 V at up to 5 A, USB Power Delivery"], ["Official supply", "27 W (5.1 V, 5 A)"], ["On a 3 A supply", "USB ports are limited to 600 mA total"], ["Power chip", "Renesas DA9091"], ["Measured", "Board rails only; USB devices and supply losses add to wall draw"]] : [] },
        wifi: { meta: wired ? "Not in use" : dbm != null ? (dbm > -60 ? "Excellent" : dbm > -70 ? "Good" : dbm > -75 ? "Fair" : "Weak") : "Wireless", live: wired ? [["Network", "Ethernet in use", ""]] : [["Signal", dbm != null ? String(dbm).replace("-", "−") + " dBm" : "—", "now"], ["Down", net(`network_throughput_in_${ifc}`), "now", det(`network_throughput_in_${ifc}`, "Wi-Fi down", 3, "6H")], ["Up", net(`network_throughput_out_${ifc}`), "now", det(`network_throughput_out_${ifc}`, "Wi-Fi up", 3, "6H")], ["Address", ipv4 ?? "—", ifc]],
          specs: pi5 ? [["Chip", "Infineon CYW43455"], ["Wi-Fi", "802.11ac, 2.4 and 5 GHz"], ["Bluetooth", "5.0 and Bluetooth Low Energy"]] : [] },
        eth: { meta: wired ? "In use" : "Not connected", live: wired ? [["Down", net(`network_throughput_in_${ifc}`), "now", det(`network_throughput_in_${ifc}`, "Network down", 3, "6H")], ["Up", net(`network_throughput_out_${ifc}`), "now", det(`network_throughput_out_${ifc}`, "Network up", 3, "6H")], ["Address", ipv4 ?? "—", ifc]] : [["Network", "The Pi is on Wi-Fi", ""]],
          specs: pi5 ? [["Speed", "Gigabit"], ["Power over Ethernet", "PoE+ with an add-on HAT"], ["Tip", "A cable is the most reliable link for a home hub"]] : [] },
        usb: { meta: "4 ports", live: this.usb ? [["Plugged in", this.usb.length ? this.usb.join(", ") : "Nothing", "now"]] : [], note: this.usb ? "" : "Home Assistant doesn't report what's plugged in or how much power each port draws.",
          specs: pi5 ? [["Blue ports", "2× USB 3.0, 5 Gbps each, at the same time"], ["Black ports", "2× USB 2.0"], ["Power", "1.6 A shared on a 5 A supply, 600 mA on 3 A"], ["Controller", "RP1"]] : [] },
        hdmi: { meta: "2 ports", live: [], note: "Home Assistant OS runs without a screen, so these are unused.", specs: pi5 ? [["Ports", "2× micro-HDMI"], ["Output", "Two 4K displays at 60 Hz, HDR"]] : [] },
        rp1: { meta: "I/O controller", live: [], note: "No sensors of its own; its work shows up in the USB, network and GPIO readings.", specs: pi5 ? [["Made by", "Raspberry Pi (their own chip)"], ["Handles", "USB, Ethernet, GPIO, camera and display links"], ["Link to processor", "PCIe 2.0 ×4"]] : [] },
        gpio: { meta: "40 pins", live: [], note: "Free for add-on boards and sensors. Nothing is reading these pins.", specs: pi5 ? [["Header", "40-pin, 3.3 V logic"], ["Buses", "UART, I²C, SPI, PWM, PCM audio"], ["Power pins", "5 V and 3.3 V"]] : [] },
      }[this.pvPart];
      const row = ([k, v, qq, d]) => `<div class="kvr${d ? " lk" : ""}"${d ? ` data-detail="${d}" role="button" tabindex="0"` : ""}><span>${k}</span><b>${v}${qq ? " " + q(qq) : ""}${d ? `<svg class="rc" viewBox="0 0 16 16" aria-hidden="true"><path d="M6.5 4l4 4-4 4"/></svg>` : ""}</b></div>`;
      pdEl.innerHTML = `<div class="pdh"><b>${PV_PARTS[this.pvPart][0].toUpperCase() + PV_PARTS[this.pvPart].slice(1)}</b><span class="m">${P.meta}</span>
          <button class="pdx" aria-label="Close" data-part-close><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg></button></div>
        <div class="pdg">
          <div class="pdc"><div class="pdk">Live</div>${P.live.length ? `<div class="kvs">${P.live.map(row).join("")}</div>` : ""}${P.note ? `<div class="pdn">${P.note}</div>` : ""}</div>
          ${P.specs.length ? `<div class="pdc"><div class="pdk">Specs</div><div class="kvs">${P.specs.map(([k, v]) => `<div class="kvr"><span>${k}</span><b class="sp">${v}</b></div>`).join("")}</div></div>` : ""}
        </div>`;
      pdEl.hidden = false; f2.hidden = true;
    } else { pdEl.hidden = true; f2.hidden = false; }

    const body = this.shadowRoot.querySelector(".body");
    body.innerHTML = `${setup}
      <div class="rings cells">${gaugesHtml}</div>
      <div class="panel"><div class="ph"><span class="pulse"></span><b>Live</b>${this.tip("live")}<span class="m">Last 10 minutes</span></div><div class="sparks">${sparks}</div></div>
      <div class="grid3">${storage}${perf}${care}</div>
      ${eventsHtml}
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
// escape text that comes from entities, devices or config before it goes into innerHTML
const pvEsc = x => String(x ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// board parts, in the words the part panel uses
const PV_PARTS = { board: "whole board", soc: "processor", ram: "memory", fan: "cooling fan", sd: "boot disk", power: "power input", wifi: "Wi-Fi and Bluetooth",
  eth: "Ethernet port", usb: "USB ports", hdmi: "micro-HDMI ports", rp1: "RP1 I/O controller", gpio: "GPIO header" };
if (!customElements.get("pi-vitals-card")) customElements.define("pi-vitals-card", PiVitalsCard);
window.customCards = window.customCards || [];
if (!window.customCards.some(c => c.type === "pi-vitals-card")) window.customCards.push({ type: "pi-vitals-card", name: "Pi Vitals", description: "Raspberry Pi health at a glance: board status, gauges, live sparklines, storage wear, throttling, backups and updates.", preview: true, documentationURL: "https://github.com/samansabeti/pi-vitals-card",
  // offered in the card picker when someone starts from a Pi or System Monitor sensor
  getEntitySuggestion: (hass, entityId) => ["systemmonitor", "rpi_power", "pi_vitals"].includes(hass?.entities?.[entityId]?.platform) || entityId === "sensor.pi_board_power"
    ? { config: { type: "custom:pi-vitals-card" } } : null });
console.info(`%c PI-VITALS-CARD %c v${PV_VERSION} `, "color:#fff;background:#111;font-weight:600", "color:#111;background:#eee");
