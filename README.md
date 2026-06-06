# Torn War Dashboard

Real-time war dashboard for Torn City factions. Shows member statuses (OK, Hospital, Abroad) with Fair Fight scores and one-click attack links. Auto-refreshes every 2 seconds.
All data stored locally

## Files

```
torn-war-dashboard/
├── index.html   — page structure and module layout
├── style.css    — dark theme styling
├── app.js       — API calls, polling, sorting logic
└── README.md    — this file
```

## Setup

### 1. Register your Torn API key with FFScouter

FF scores come from [FFScouter](https://ffscouter.com). You use your **existing Torn API key** — no separate key needed — but you must register it first:
**Limited Access**
1. Go to **[ffscouter.com](https://ffscouter.com)**
2. Sign up / log in using your Torn account
3. Register your Torn API key with their service

This is free and takes about 30 seconds. Without it, the FF column will show `—` for all members.


**serve locally **

Download and run index.html in a browser
```


## How it works

| Feature | API | Endpoint |
|---|---|---|
| Member statuses | Torn API v2 | `api.torn.com/v2/faction?selections=members,basic` |
| FF scores | FFScouter | `ffscouter.com/api/v1/get-stats?key=KEY&targets=ID1,ID2,...` |
| Attack links | No API | Direct link to `torn.com/loader.php?sid=attack&user2ID=ID` |

**Refresh rates:**
- Member statuses: every **2 seconds**
- FF scores: every **60 seconds** (FFScouter caches data for ~5 minutes, so more frequent calls would be wasted)

**FF score thresholds** (standard Torn definitions):
- ≥ 3.0 — favourable (green)
- 2.0–2.99 — neutral (amber)
- < 2.0 — risky (red)

**Torn API rate limit:** 100 requests/minute per key. At 2-second polling that's 30 requests/minute, well within the limit.

---

## Sorting

Click any column header to sort. Click again to reverse. All columns are sortable:
- **Name** — alphabetical
- **Lvl** — numeric
- **FF** — numeric, defaults to highest first
- **Last active / Out in / Location** — by time or alphabetical
