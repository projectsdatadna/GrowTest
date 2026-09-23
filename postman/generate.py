import csv
import json
import uuid

OUT = "/Users/projects/GrowTest/postman"

SYMBOLS = ["NSE-ULTRACEMCO", "NSE-VOLTAS", "NSE-INDHOTEL"]

# Corrected spec: every tier is native on Groww and fits in a single request
# (15minute max 90d/req, 1hour/4hour/1day/1week max 180d/req).
TIERS = [
    {"key": "15min_30d", "name": "1 - 15minute (30 day trailing)", "interval": "15minute", "days": 30},
    {"key": "1hour_60d", "name": "2 - 1hour (60 day trailing)", "interval": "1hour", "days": 60},
    {"key": "4hour_90d", "name": "3 - 4hour (90 day trailing)", "interval": "4hour", "days": 90},
    {"key": "1day_180d", "name": "4 - 1day (180 day trailing)", "interval": "1day", "days": 180},
    {"key": "1week_180d", "name": "5 - 1week (180 day trailing)", "interval": "1week", "days": 180},
]


def uid():
    return str(uuid.uuid4())


# ---------- CSV data file (symbol iteration for Collection Runner) ----------
with open(f"{OUT}/symbols.csv", "w", newline="") as f:
    w = csv.writer(f)
    w.writerow(["groww_symbol"])
    for s in SYMBOLS:
        w.writerow([s])


# ---------- Postman environment (unchanged shape) ----------
environment = {
    "id": uid(),
    "name": "Groww Historical Data",
    "values": [
        {"key": "groww_base_url", "value": "https://api.groww.in/v1", "type": "default", "enabled": True},
        {"key": "groww_api_version", "value": "1.0", "type": "default", "enabled": True},
        {"key": "groww_access_token", "value": "", "type": "secret", "enabled": True},
    ],
    "_postman_variable_scope": "environment",
}
with open(f"{OUT}/groww-historical-env.postman_environment.json", "w") as f:
    json.dump(environment, f, indent=2)


# ---------- Postman collection ----------

def make_url(candle_interval):
    query = [
        {"key": "exchange", "value": "NSE"},
        {"key": "segment", "value": "CASH"},
        {"key": "groww_symbol", "value": "{{groww_symbol}}"},
        {"key": "start_time", "value": "{{start_time}}"},
        {"key": "end_time", "value": "{{end_time}}"},
        {"key": "candle_interval", "value": candle_interval},
    ]
    raw = "{{groww_base_url}}/historical/candles?" + "&".join(f"{q['key']}={q['value']}" for q in query)
    return {"raw": raw, "host": ["{{groww_base_url}}"], "path": ["historical", "candles"], "query": query}


def trailing_prerequest_script(days):
    return [
        f"const days = {days};",
        "const pad = (n) => String(n).padStart(2, '0');",
        "const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;",
        "const end = new Date();",
        "const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);",
        "pm.variables.set('start_time', fmt(start));",
        "pm.variables.set('end_time', fmt(end));",
    ]


folders = []
for t in TIERS:
    folders.append({
        "name": t["name"],
        "description": f"Native {t['interval']} candles, trailing {t['days']}-day window computed at run time. Single call per symbol (within Groww's per-request cap). Run with Collection Runner + symbols.csv (3 iterations), or Send once per symbol manually.",
        "event": [{"listen": "prerequest", "script": {"type": "text/javascript", "exec": trailing_prerequest_script(t["days"])}}],
        "item": [{
            "name": f"Get {t['interval']} candles",
            "request": {
                "method": "GET",
                "header": [
                    {"key": "Accept", "value": "application/json"},
                    {"key": "X-API-VERSION", "value": "{{groww_api_version}}"},
                ],
                "url": make_url(t["interval"]),
            },
            "response": [],
        }],
    })

collection = {
    "info": {
        "_postman_id": uid(),
        "name": "Groww Historical Data - ULTRACEMCO, VOLTAS, INDHOTEL",
        "description": (
            "Historical OHLC candles from Groww's current endpoint "
            "GET https://api.groww.in/v1/historical/candles for ULTRACEMCO, VOLTAS and INDHOTEL. "
            "5 native tiers, each a single trailing-window request per symbol: "
            "15minute/30d, 1hour/60d, 4hour/90d, 1day/180d, 1week/180d. "
            "Requires a Groww access token in the 'Groww Historical Data' environment's groww_access_token variable."
        ),
        "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
    },
    "auth": {"type": "bearer", "bearer": [{"key": "token", "value": "{{groww_access_token}}", "type": "string"}]},
    "event": [],
    "variable": [{"key": "groww_symbol", "value": "NSE-ULTRACEMCO"}],
    "item": folders,
}

with open(f"{OUT}/groww-historical-data.postman_collection.json", "w") as f:
    json.dump(collection, f, indent=2)

print("Rebuilt collection with", len(folders), "folders for", len(SYMBOLS), "symbols.")
