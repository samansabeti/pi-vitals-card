"""Pi vitals the System Monitor integration can't see: board power, throttling, clock, Wi-Fi signal, storage wear.

Runs inside the HA core container as a command_line sensor (deployed to /config/pi_power/).
Talks to the firmware mailbox (/dev/vcio) directly because HA OS has no vcgencmd.
Prints one JSON object; the sensor's state is `watts`, everything else becomes attributes.
- watts/rails: PMIC rail readings (`vcgencmd pmic_read_adc`). Sums the board's own rails, so it
  leaves out USB devices and PMIC conversion losses: a floor, not wall-plug draw. Pi 5 only.
- model: board name from the device tree ("Raspberry Pi 5 Model B Rev 1.0").
- throttled: `vcgencmd get_throttled` bits, decoded into now / since-boot flags.
- throttle_events: last 7 days of flag changes as [epoch, flag, "start" | "end" | "brief"]. "brief" = a since-boot
  flag appeared between two runs without being seen live. Lets a dashboard show episodes without attribute history.
- arm_mhz: measured CPU clock.
- wifi_dbm: signal from /proc/net/wireless (HA core uses the host network).
- disk_*: writes since boot to the disk that holds the config folder, and the recent write rate.
- db_mb, db_mb_per_day: SQLite recorder database size and its average daily growth (MariaDB/Postgres: left out).
Every part is optional: a part that fails is left out instead of failing the sensor.

Light on the SD card: the small state file next to this script is rewritten only when something worth keeping
changes (a throttle flag, a new day for the database log) or every SAVE_EVERY seconds for the write-rate sample,
not on every run.
"""
import array
import fcntl
import json
import os
import re
import struct
import time

MAX = 1024
GET_GENCMD_RESULT = 0x00030080
IOCTL_MBOX_PROPERTY = 0xC0006400 | struct.calcsize("P") << 16  # _IOWR(100, 0, char *): 0xC0086400 on 64-bit, 0xC0046400 on 32-bit
HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG = os.environ.get("HA_CONFIG") or (os.path.dirname(HERE) if os.path.exists(os.path.join(os.path.dirname(HERE), "configuration.yaml")) else "/config")
DB = os.path.join(CONFIG, "home-assistant_v2.db")
STATE = os.path.join(HERE, ".pi_vitals_state.json")
SAVE_EVERY = 600  # seconds between write-rate samples saved to the state file
FLAGS = {0: "under_voltage", 1: "freq_capped", 2: "throttled", 3: "soft_temp_limit"}


def gencmd(cmd: str) -> str:
    raw = bytearray(array.array("I", [0, 0, GET_GENCMD_RESULT, MAX, 0, 0] + [0] * (MAX // 4) + [0]).tobytes())
    raw[24:24 + len(cmd)] = cmd.encode()
    buf = array.array("I")
    buf.frombytes(bytes(raw))
    buf[0] = len(buf) * 4
    with open("/dev/vcio", "rb") as f:
        fcntl.ioctl(f, IOCTL_MBOX_PROPERTY, buf, True)
    return buf.tobytes()[24:24 + MAX].split(b"\0")[0].decode()


def power():
    out = gencmd("pmic_read_adc")
    amps = {m[1]: float(m[2]) for m in re.finditer(r"(\S+)_A current\(\d+\)=([\d.]+)A", out)}
    volts = {m[1]: float(m[2]) for m in re.finditer(r"(\S+)_V volt\(\d+\)=([\d.]+)V", out)}
    rails = {k: round(amps[k] * volts[k], 3) for k in amps if k in volts}
    return {"watts": round(sum(rails.values()), 2), "rails": rails} if rails else {}


def read(path):
    with open(path) as f:
        return f.read()


def model():
    return {"model": read("/proc/device-tree/model").strip("\0\n ")}


def throttled():
    bits = int(gencmd("get_throttled").split("=")[1], 16)
    return {"throttled": {"raw": hex(bits),
                          "now": [n for b, n in FLAGS.items() if bits >> b & 1],
                          "since_boot": [n for b, n in FLAGS.items() if bits >> (b + 16) & 1]}}


def throttle_events(result, state, now):
    thr = result.get("throttled")
    if not thr:
        return {}
    try:
        boot = read("/proc/sys/kernel/random/boot_id").strip()
    except OSError:
        boot = ""
    prev = state.get("thr")
    log = [e for e in state.get("thr_log", []) if e[0] > now - 7 * 86400][-40:]
    if prev and prev.get("boot") == boot:
        pn, pb, n, b = set(prev["now"]), set(prev["since_boot"]), set(thr["now"]), set(thr["since_boot"])
        log += [[round(now), f, "start"] for f in sorted(n - pn)] + [[round(now), f, "end"] for f in sorted(pn - n)]
        log += [[round(now), f, "brief"] for f in sorted(b - pb - n - pn)]
    state["thr"] = {"boot": boot, "now": thr["now"], "since_boot": thr["since_boot"]}
    state["thr_log"] = log
    return {"throttle_events": log}


def clock():
    return {"arm_mhz": round(int(gencmd("measure_clock arm").split("=")[1]) / 1e6)}


def wifi():
    for line in read("/proc/net/wireless").splitlines()[2:]:
        name, rest = line.split(":", 1)
        return {"wifi_dbm": round(float(rest.split()[2].rstrip("."))), "wifi_iface": name.strip()}
    return {}


def config_disk():
    """Whole disk holding the config folder (mmcblk0, nvme0n1, sda), from the folder's device number."""
    st = os.stat(CONFIG)
    part = os.path.realpath(f"/sys/dev/block/{os.major(st.st_dev)}:{os.minor(st.st_dev)}")
    name = os.path.basename(part)
    return os.path.basename(os.path.dirname(part)) if os.path.exists(os.path.join(part, "partition")) else name


def disk(state, now):
    try:
        want = config_disk()
    except OSError:
        want = None
    stats = {f[2]: int(f[9]) for f in (line.split() for line in read("/proc/diskstats").splitlines())}
    if want not in stats:  # e.g. an overlay or network mount: fall back to the first SD / NVMe / USB disk
        want = next((d for d in stats if re.fullmatch(r"mmcblk\d+|nvme\d+n\d+|sd[a-z]", d)), None)
    if not want:
        return {}
    sectors = stats[want]
    out = {"disk_device": want, "disk_written_gb": round(sectors * 512 / 1e9, 2)}
    last = state.get("disk")
    if last and last["dev"] == want and now > last["t"] and sectors >= last["s"]:
        out["disk_write_kbs"] = round((sectors - last["s"]) * 512 / 1e3 / (now - last["t"]), 1)
    if not last or last["dev"] != want or sectors < last["s"] or now - last["t"] >= SAVE_EVERY:
        state["disk"] = {"dev": want, "t": now, "s": sectors}
    return out


def database(state, now):
    size = sum(os.path.getsize(DB + x) for x in ("", "-wal") if os.path.exists(DB + x)) / 1e6
    log = state.setdefault("db_log", {})  # first reading of each day, last 8 days
    log.setdefault(time.strftime("%Y-%m-%d", time.localtime(now)), round(size, 1))
    for d in sorted(log)[:-8]:
        del log[d]
    out = {"db_mb": round(size, 1)}
    days = sorted(log)
    if len(days) >= 2:
        span = (time.mktime(time.strptime(days[-1], "%Y-%m-%d")) - time.mktime(time.strptime(days[0], "%Y-%m-%d"))) / 86400
        out["db_mb_per_day"] = round((size - log[days[0]]) / (span + (now - time.mktime(time.strptime(days[-1], "%Y-%m-%d"))) / 86400), 1)
    return out


now = time.time()
try:
    state = json.loads(read(STATE))
except (OSError, ValueError):
    state = {}
before = json.dumps(state, sort_keys=True)
result = {}
for part in (model, power, throttled, lambda: throttle_events(result, state, now), clock, wifi, lambda: disk(state, now), lambda: database(state, now)):
    try:
        result.update(part())
    except Exception:  # noqa: BLE001 - a missing source just drops that field
        pass
if json.dumps(state, sort_keys=True) != before:  # skip the write when nothing worth keeping changed
    try:
        with open(STATE + ".tmp", "w") as f:
            json.dump(state, f)
        os.replace(STATE + ".tmp", STATE)
    except OSError:
        pass
print(json.dumps(result))
