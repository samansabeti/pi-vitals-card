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
- disk_*: block-device writes since boot and the write rate since the last run.
- db_mb, db_mb_per_day: recorder database size and its average daily growth (log kept next to this script).
Every part is optional: a part that fails is left out instead of failing the sensor.
"""
import array
import fcntl
import json
import os
import re
import time

MAX = 1024
GET_GENCMD_RESULT = 0x00030080
IOCTL_MBOX_PROPERTY = 0xC0086400  # _IOWR(100, 0, char *) on 64-bit
HERE = os.path.dirname(os.path.abspath(__file__))
DB = "/config/home-assistant_v2.db"
STATE = os.path.join(HERE, ".pi_vitals_state.json")
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


def model():
    return {"model": open("/proc/device-tree/model").read().strip("\0\n ")}


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
        boot = open("/proc/sys/kernel/random/boot_id").read().strip()
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
    for line in open("/proc/net/wireless").read().splitlines()[2:]:
        name, rest = line.split(":", 1)
        return {"wifi_dbm": round(float(rest.split()[2].rstrip("."))), "wifi_iface": name.strip()}
    return {}


def disk(state, now):
    # root device = the disk holding /config; take the whole-disk line (mmcblk0, nvme0n1, sda)
    dev = None
    for line in open("/proc/diskstats"):
        f = line.split()
        if re.fullmatch(r"mmcblk\d+|nvme\d+n\d+|sd[a-z]", f[2]):
            dev, sectors = f[2], int(f[9])
            break
    if not dev:
        return {}
    out = {"disk_device": dev, "disk_written_gb": round(sectors * 512 / 1e9, 2)}
    last = state.get("disk")
    if last and last["dev"] == dev and now > last["t"] and sectors >= last["s"]:
        out["disk_write_kbs"] = round((sectors - last["s"]) * 512 / 1e3 / (now - last["t"]), 1)
    state["disk"] = {"dev": dev, "t": now, "s": sectors}
    return out


def database(state, now):
    size = sum(os.path.getsize(DB + x) for x in ("", "-wal") if os.path.exists(DB + x)) / 1e6
    log = state.setdefault("db_log", {})  # one reading per day, last 8 days
    log[time.strftime("%Y-%m-%d", time.localtime(now))] = round(size, 1)
    for d in sorted(log)[:-8]:
        del log[d]
    out = {"db_mb": round(size, 1)}
    days = sorted(log)
    if len(days) >= 2:
        span = (time.mktime(time.strptime(days[-1], "%Y-%m-%d")) - time.mktime(time.strptime(days[0], "%Y-%m-%d"))) / 86400
        out["db_mb_per_day"] = round((log[days[-1]] - log[days[0]]) / span, 1)
    return out


now = time.time()
try:
    state = json.load(open(STATE))
except (OSError, ValueError):
    state = {}
result = {}
for part in (model, power, throttled, lambda: throttle_events(result, state, now), clock, wifi, lambda: disk(state, now), lambda: database(state, now)):
    try:
        result.update(part())
    except Exception:  # noqa: BLE001 - a missing source just drops that field
        pass
try:
    json.dump(state, open(STATE, "w"))
except OSError:
    pass
print(json.dumps(result))
