#!/usr/bin/env python3
"""Send realistic machine readings to a Factory MIOS device over HTTPS.

Usage:
    python scripts/test_publisher.py --api-key <DEVICE_API_KEY> [--url http://localhost:8000] [--interval 3]
"""
import argparse
import json
import math
import random
import time
import urllib.request

p = argparse.ArgumentParser()
p.add_argument("--api-key", required=True)
p.add_argument("--url", default="http://localhost:8000")
p.add_argument("--interval", type=float, default=3.0)
args = p.parse_args()

endpoint = f"{args.url}/api/v1/ingest/http"
total = good = 0
phase = 0.0
print(f"Publishing to {endpoint} every {args.interval}s. Ctrl-C to stop.")
while True:
    running = random.random() > 0.1
    produced = random.randint(1, 4) if running else 0
    g = sum(1 for _ in range(produced) if random.random() > 0.04)
    total += produced
    good += g
    phase += 0.2
    payload = {
        "total_count": total, "good_count": good, "reject_count": total - good,
        "cycle_time": round(28 + 5 * math.sin(phase) + random.uniform(-1, 1), 2),
        "temperature": round(65 + 6 * math.sin(phase / 2) + random.uniform(-2, 2), 2),
        "rpm": 0 if not running else 1500 + random.randint(-50, 50),
        "energy_kw": 0.5 if not running else round(11 + random.uniform(-1, 1), 2),
        "running": 1 if running else 0,
    }
    req = urllib.request.Request(endpoint, data=json.dumps(payload).encode(),
                                 headers={"X-API-Key": args.api_key, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            print(json.loads(r.read()))
    except Exception as e:  # noqa: BLE001
        print("error:", e)
    time.sleep(args.interval)
