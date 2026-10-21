"""External process-tree RSS sampler; no target-process timers or forced GC.

python3 scripts/semantic-profile-process.py TIMELINE.json -- node ...
Only descendants of the launched process are retained; command arguments/env are not.
macOS/Linux ps RSS is KiB. Short-lived children between samples can be missed.
"""
import json
import os
import subprocess
import sys
import time

destination, separator, *command = sys.argv[1:]
if separator != "--" or not command:
    raise SystemExit("TIMELINE.json -- COMMAND required")
# Refuse missing process-list access before launching expensive work.
subprocess.check_output(["ps", "-p", str(os.getpid()), "-o", "pid="], text=True)
started = time.monotonic()
child = subprocess.Popen(command)
rows = []
known = {child.pid}
try:
    while child.poll() is None:
        tick = time.monotonic()
        output = subprocess.check_output(["ps", "-axo", "pid=,ppid=,rss=,time=,comm="], text=True)
        processes = []
        for line in output.splitlines():
            fields = line.strip().split(None, 4)
            if len(fields) == 5:
                pid, ppid, rss = map(int, fields[:3])
                processes.append({"pid": pid, "ppid": ppid, "rssKiB": rss, "cpu": fields[3], "executable": fields[4]})
        descendants = {child.pid}
        for _ in range(len(processes)):
            extra = {p["pid"] for p in processes if p["ppid"] in descendants}
            if extra <= descendants:
                break
            descendants |= extra
        known |= descendants
        rows.append({"elapsedMs": (tick - started) * 1000,
                     "processes": [p for p in processes if p["pid"] in known],
                     "samplerMs": (time.monotonic() - tick) * 1000})
        time.sleep(max(0, 0.1 - (time.monotonic() - tick)))
finally:
    if child.poll() is None:
        child.terminate()
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait(timeout=5)
with open(destination, "w") as stream:
    json.dump({"format": 1, "rootPid": child.pid, "intervalMs": 100,
               "elapsedMs": (time.monotonic() - started) * 1000, "exitCode": child.returncode,
               "samples": rows}, stream)
    stream.write("\n")
raise SystemExit(child.returncode)
