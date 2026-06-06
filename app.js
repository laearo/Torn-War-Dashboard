// ── State ──────────────────────────────────────────────────────────────────
const sortState = {
  ok:     { col: 'ff',    dir: -1 },
  hosp:   { col: 'until', dir:  1 },
  abroad: { col: 'name',  dir:  1 },
};
const mySortState = { col: 'state', dir: 1 };

// State sort order for my faction: ok < travelling < abroad < hospital < abroad_hosp
const STATE_ORDER = { ok: 0, travelling: 1, abroad: 2, hospital: 3, abroad_hosp: 4 };

let enemyData  = { ok: [], hosp: [], abroad: [] };
let myMembers  = [];
let ffScores   = {};
let chainData  = null;   // latest chain response
let attackData = [];     // latest attacks array (sorted newest-first)
let warScores  = null;   // { myScore, enemyScore, target }
let pollCount  = 0;
let tornKey    = '';
let myFactionId   = null;
let enemyFactionId = null;
let paused     = false;
let refreshTimer = null;
let ffTimer      = null;

// ── Status bar ─────────────────────────────────────────────────────────────
function setStatus(type, msg) {
  document.getElementById('status-dot').className =
    'status-dot' + (type === 'live' ? ' live' : type === 'error' ? ' error' : '');
  document.getElementById('status-msg').textContent = msg;
}

// ── Time helpers ───────────────────────────────────────────────────────────
function timeAgo(ts) {
  if (!ts) return '—';
  const d = Math.floor(Date.now() / 1000) - ts;
  if (d < 60)    return d + 's ago';
  if (d < 3600)  return Math.floor(d / 60) + 'm ago';
  if (d < 86400) return Math.floor(d / 3600) + 'h ago';
  return Math.floor(d / 86400) + 'd ago';
}

function timeUntil(ts) {
  if (!ts) return '—';
  const d = ts - Math.floor(Date.now() / 1000);
  if (d <= 0)   return 'now';
  if (d < 60)   return d + 's';
  if (d < 3600) return Math.floor(d / 60) + 'm ' + Math.floor(d % 60) + 's';
  return Math.floor(d / 3600) + 'h ' + Math.floor((d % 3600) / 60) + 'm';
}

// ── Chain bonus thresholds ─────────────────────────────────────────────────
const BONUS_HITS = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 25000, 50000, 100000];
function nextBonus(current) {
  return BONUS_HITS.find(b => b > current) ?? null;
}

// ── Render war score box ───────────────────────────────────────────────────
function renderWarScore() {
  const el = document.getElementById('war-score-box');
  if (!el || !warScores) return;
  const { myScore, enemyScore, target } = warScores;
  const myAhead = (myScore || 0) >= (enemyScore || 0);
  el.style.display = '';
  el.innerHTML = `
    <div class="war-score-label">War score</div>
    <div class="war-score-vals">
      <span class="war-score-num ${myAhead ? 'war-score-winning' : ''}">${(myScore||0).toLocaleString()}</span>
      <span class="war-score-sep">–</span>
      <span class="war-score-num ${!myAhead ? 'war-score-winning' : ''}">${(enemyScore||0).toLocaleString()}</span>
    </div>
    <div class="war-score-target">target ${(target||0).toLocaleString()}</div>`;
}

// ── Render chain box ───────────────────────────────────────────────────────
let lastChainCurrent = -1;

function renderChain() {
  const box = document.getElementById('chain-box');
  if (chainData === null) { box.style.display = 'none'; return; }
  box.style.display = '';

  const c = chainData;
  const current  = c.current || 0;
  const max      = c.max || 0;
  const timeout  = c.timeout || 0;
  const cooldown = c.cooldown || 0;
  const modifier = c.modifier || 1;

  // Status badge
  const badge = document.getElementById('chain-status-badge');
  if (current > 0 && !cooldown) {
    badge.textContent = 'Active';
    badge.className = 'chain-status-badge active';
  } else if (cooldown) {
    badge.textContent = 'Cooldown';
    badge.className = 'chain-status-badge cooldown';
  } else {
    badge.textContent = 'Inactive';
    badge.className = 'chain-status-badge inactive';
  }

  document.getElementById('chain-current').textContent =
    current > 0 ? `${current.toLocaleString()} / ${max.toLocaleString()}` : '—';

  const nb = nextBonus(current);
  document.getElementById('chain-bonus').textContent =
    nb ? `${nb.toLocaleString()} (${nb - current} away)` : current > 0 ? 'Max bonus reached' : '—';

  document.getElementById('chain-modifier').textContent =
    modifier ? `×${modifier.toFixed(2)}` : '—';

  // Only reset the absolute timeout when the chain count increases (a hit landed)
  // or when first loading. Otherwise leave the running countdown alone so it
  // doesn't flash back to ~5 mins every 2s poll.
  if (current !== lastChainCurrent) {
    lastChainCurrent = current;
    const timeoutAbs = timeout > 0 ? Math.floor(Date.now() / 1000) + timeout : 0;
    box.dataset.chainTimeout = timeoutAbs;
  }
  box.dataset.chainCooldown = cooldown ? '1' : '0';
  tickChainTimer();
}

function tickChainTimer() {
  const box = document.getElementById('chain-box');
  if (!box || !box.dataset.chainTimeout) return;
  const ts       = parseInt(box.dataset.chainTimeout, 10);
  const isCooldown = box.dataset.chainCooldown === '1';
  const el       = document.getElementById('chain-timer');
  if (!ts) { el.textContent = '—'; return; }
  const left = ts - Math.floor(Date.now() / 1000);
  el.textContent = left > 0 ? timeUntil(ts) : (isCooldown ? 'Cooled' : 'Expired');
  el.className = 'chain-stat-val chain-timer-val' + (left < 60 && left > 0 ? ' urgent' : '');
}

// ── Render active fights & recent attacks ──────────────────────────────────
function renderAttacks() {
  if (!attackData.length) {
    document.getElementById('active-fights-section').style.display = 'none';
    document.getElementById('recent-attacks-section').style.display = 'none';
    return;
  }

  const now = Math.floor(Date.now() / 1000);

  // Active = timestamp_ended is 0 or missing, and started within last 120s
  const active = attackData.filter(a =>
    (!a.timestamp_ended || a.timestamp_ended === 0) &&
    a.timestamp_started && (now - a.timestamp_started) < 120
  );

  const activeSec = document.getElementById('active-fights-section');
  const fightBox  = document.getElementById('active-fights');
  if (active.length) {
    activeSec.style.display = '';
    fightBox.innerHTML = active.map(a => {
      const joinHref = `https://www.torn.com/loader.php?sid=attack&user2ID=${a.defender_id}`;
      return `<div class="fight-row">
        <span class="fight-attacker">${a.attacker_name || 'Unknown'}</span>
        <span class="fight-vs">vs</span>
        <span class="fight-defender">${a.defender_name || 'Unknown'}</span>
        <a class="fight-join" href="${joinHref}" target="_blank" rel="noopener">
          <i class="ti ti-bolt" style="font-size:11px" aria-hidden="true"></i> Join
        </a>
      </div>`;
    }).join('');
  } else {
    activeSec.style.display = 'none';
  }

  // Recent = last 5 completed attacks (have timestamp_ended > 0)
  const completed = attackData
    .filter(a => a.timestamp_ended > 0)
    .sort((a, b) => b.timestamp_ended - a.timestamp_ended)
    .slice(0, 5);

  const recentSec  = document.getElementById('recent-attacks-section');
  const recentBody = document.getElementById('recent-attacks-body');
  if (completed.length) {
    recentSec.style.display = '';
    recentBody.innerHTML = completed.map(a => {
      const result   = a.result || '—';
      const rClass   = result === 'Hospitalized' ? 'result-hosp'
                     : result === 'Mugged'       ? 'result-mug'
                     : (result === 'Lost' || result === 'Escape') ? 'result-loss'
                     : 'result-other';
      const respect  = a.respect_gain ?? a.respect ?? 0;
      const rSpan    = respect > 0 ? `<span class="respect-val">+${respect.toFixed(2)}</span>` : '—';
      return `<tr>
        <td><a class="player-link" href="https://www.torn.com/profiles.php?XID=${a.attacker_id}" target="_blank" rel="noopener">${a.attacker_name || a.attacker_id || '—'}</a></td>
        <td><a class="player-link" href="https://www.torn.com/profiles.php?XID=${a.defender_id}" target="_blank" rel="noopener">${a.defender_name || a.defender_id || '—'}</a></td>
        <td><span class="${rClass}">${result}</span></td>
        <td>${rSpan}</td>
        <td>${a.chain || 0}</td>
        <td class="last-seen">${timeAgo(a.timestamp_ended)}</td>
      </tr>`;
    }).join('');
  } else {
    recentSec.style.display = 'none';
  }
}


function ffClass(score) {
  if (score == null) return 'ff-na';
  if (score >= 5.0)  return 'ff-purple';
  if (score >= 4.0)  return 'ff-red';
  if (score >= 2.0)  return 'ff-green';
  if (score >= 1.0)  return 'ff-teal';
  return 'ff-blue';
}

function onlineDot(status) {
  if (status === 'online') return '<span class="online-dot dot-online" title="Online"></span>';
  if (status === 'idle')   return '<span class="online-dot dot-idle" title="Idle"></span>';
  return '';
}


function classifyState(m) {
  const statusObj = m.status || {};
  const state = (typeof statusObj === 'string' ? statusObj : statusObj.state || '').toLowerCase();
  const desc  = (statusObj.description || '').toLowerCase();
  const until = statusObj.until || 0;
  if (state === 'hospital' || state === 'hospitalized') {
    const now = Math.floor(Date.now() / 1000);
    if (until > 0 && until <= now) return 'ok';
    return desc.includes('foreign') || desc.includes('abroad') ? 'abroad_hosp' : 'hospital';
  }
  if (state === 'abroad') return 'abroad';
  if (state === 'traveling' || state === 'travelling') return 'travelling';
  return 'ok';
}

function stateBadge(stateKey) {
  const labels = { ok: 'OK', travelling: 'Travelling', abroad: 'Abroad', hospital: 'Hospital', abroad_hosp: 'Abroad Hosp' };
  const classes = { ok: 'state-ok', travelling: 'state-travel', abroad: 'state-abroad', hospital: 'state-hosp', abroad_hosp: 'state-hosp' };
  return `<span class="state-badge ${classes[stateKey]}">${labels[stateKey]}</span>`;
}

// ── Render enemy tables ────────────────────────────────────────────────────
function renderTable(key) {
  const { col, dir } = sortState[key];

  const data = [...enemyData[key]].sort((a, b) => {
    let av = col === 'ff' ? (ffScores[a.id] ?? -999) : a[col];
    let bv = col === 'ff' ? (ffScores[b.id] ?? -999) : b[col];
    let primary;
    if (typeof av === 'string') primary = dir * av.localeCompare(bv);
    else primary = dir * ((av || 0) - (bv || 0));
    if (primary !== 0 || col === 'ff') return primary;
    // FF tiebreaker — higher FF first
    return (ffScores[b.id] ?? -999) - (ffScores[a.id] ?? -999);
  });

  const colMap = {
    ok:     ['name', 'level', 'ff', 'last_action'],
    hosp:   ['name', 'level', 'ff', 'until'],
    abroad: ['name', 'level', 'ff', 'desc'],
  };
  colMap[key].forEach(h => {
    const el = document.getElementById(`${key}-h-${h}`);
    if (!el) return;
    el.querySelector('.sa').textContent = col === h ? (dir === 1 ? '↑' : '↓') : '↕';
    el.classList.toggle('sorted', col === h);
  });

  const tbody = document.getElementById(`${key}-body`);
  if (!data.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty-state">None</td></tr>';
    return;
  }

  tbody.innerHTML = data.map(m => {
    const score  = ffScores[m.id];
    const ffCell = `<span class="ff-pill ${ffClass(score)}">${score != null ? score.toFixed(2) : '—'}</span>`;
    const name   = `<span class="name-cell">${onlineDot(m.online)}<a class="player-link" href="https://www.torn.com/profiles.php?XID=${m.id}" target="_blank" rel="noopener">${m.name}</a></span>`;
    const atk    = `<a class="atk-btn" href="https://www.torn.com/loader.php?sid=attack&user2ID=${m.id}" target="_blank" rel="noopener"><i class="ti ti-sword" style="font-size:11px" aria-hidden="true"></i> Attack</a>`;
    let info;
    if (key === 'ok')        info = `<span class="last-seen">${timeAgo(m.last_action)}</span>`;
    else if (key === 'hosp') info = `<span class="timer">${timeUntil(m.until) === 'now' ? '<span style="color:var(--green)">Out!</span>' : timeUntil(m.until)}</span>`;
    else                     info = m.desc || 'Travelling';
    const untilAttr = key === 'hosp' ? ` data-until="${m.until}"` : '';
    return `<tr${untilAttr}><td>${name}</td><td>${m.level}</td><td>${ffCell}</td><td>${info}</td><td>${atk}</td></tr>`;
  }).join('');
}

function sortTable(key, col) {
  const prev = sortState[key];
  sortState[key] = { col, dir: prev.col === col ? prev.dir * -1 : (col === 'ff' ? -1 : 1) };
  renderTable(key);
}

// ── Render my faction sidebar ──────────────────────────────────────────────
function renderMyTable() {
  const { col, dir } = mySortState;

  const data = [...myMembers].sort((a, b) => {
    if (col === 'state') {
      const ao = STATE_ORDER[a.stateKey] ?? 99;
      const bo = STATE_ORDER[b.stateKey] ?? 99;
      const primary = dir * (ao - bo);
      if (primary !== 0) return primary;
      return (ffScores[b.id] ?? -999) - (ffScores[a.id] ?? -999);
    }
    if (col === 'ff') {
      const av = ffScores[a.id] ?? -999;
      const bv = ffScores[b.id] ?? -999;
      return dir * (av - bv);
    }
    if (col === 'info') {
      const av = a.until || a.infoText || '';
      const bv = b.until || b.infoText || '';
      if (typeof av === 'number' && typeof bv === 'number') {
        const primary = dir * (av - bv);
        if (primary !== 0) return primary;
        return (ffScores[b.id] ?? -999) - (ffScores[a.id] ?? -999);
      }
      const primary = dir * String(av).localeCompare(String(bv));
      if (primary !== 0) return primary;
      return (ffScores[b.id] ?? -999) - (ffScores[a.id] ?? -999);
    }
    let av = a[col], bv = b[col];
    let primary;
    if (typeof av === 'string') primary = dir * av.localeCompare(bv);
    else primary = dir * ((av || 0) - (bv || 0));
    if (primary !== 0) return primary;
    return (ffScores[b.id] ?? -999) - (ffScores[a.id] ?? -999);
  });

  ['name', 'level', 'ff', 'state', 'info'].forEach(h => {
    const el = document.getElementById(`my-h-${h}`);
    if (!el) return;
    el.querySelector('.sa').textContent = col === h ? (dir === 1 ? '↑' : '↓') : '↕';
    el.classList.toggle('sorted', col === h);
  });

  const tbody = document.getElementById('my-body');
  if (!data.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty-state">No data</td></tr>';
    return;
  }

  tbody.innerHTML = data.map(m => {
    const name = `<span class="name-cell">${onlineDot(m.online)}<a class="player-link" href="https://www.torn.com/profiles.php?XID=${m.id}" target="_blank" rel="noopener">${m.name}</a></span>`;
    const score = ffScores[m.id];
    const ffCell = `<span class="ff-pill ${ffClass(score)}">${score != null ? score.toFixed(2) : '—'}</span>`;
    let detail;
    if (m.stateKey === 'hospital' || m.stateKey === 'abroad_hosp') {
      const t = timeUntil(m.until);
      detail = `<span class="timer">${t === 'now' ? '<span style="color:var(--green)">Out!</span>' : t}</span>`;
    } else if (m.stateKey === 'abroad' || m.stateKey === 'travelling') {
      detail = `<span class="last-seen">${m.infoText || '—'}</span>`;
    } else {
      detail = `<span class="last-seen">${timeAgo(m.last_action)}</span>`;
    }
    const untilAttr = (m.stateKey === 'hospital' || m.stateKey === 'abroad_hosp') ? ` data-until="${m.until}"` : '';
    return `<tr${untilAttr}><td>${name}</td><td>${m.level}</td><td>${ffCell}</td><td>${stateBadge(m.stateKey)}</td><td>${detail}</td></tr>`;
  }).join('');
}

function sortMyTable(col) {
  mySortState.dir = mySortState.col === col ? mySortState.dir * -1 : 1;
  mySortState.col = col;
  renderMyTable();
}

// ── Parse members into enemy buckets ──────────────────────────────────────
function parseEnemyMembers(members) {
  const ok = [], hosp = [], abroad = [];
  Object.entries(members).forEach(([key, m]) => {
    // Prefer the id field inside the object (v2 includes it); fall back to object key
    const id = String(m.id ?? key);

    const base  = { id, name: m.name, level: m.level || 0, last_action: m.last_action?.timestamp || 0, online: (m.last_action?.status || '').toLowerCase() };

    // v2 status is { state, description, until, ... }
    // v1 status is a plain string
    const statusObj = m.status || {};
    const state = (typeof statusObj === 'string' ? statusObj : statusObj.state || '').toLowerCase();
    const until = statusObj.until || 0;
    const desc  = statusObj.description || '';

    if (state === 'hospital' || state === 'hospitalized') {
      const now = Math.floor(Date.now() / 1000);
      if (until > 0 && until <= now) {
        ok.push(base);
      } else if (desc.toLowerCase().includes('foreign') || desc.toLowerCase().includes('abroad')) {
        abroad.push({ ...base, desc });
      } else {
        hosp.push({ ...base, until });
      }
    } else if (state === 'abroad' || state === 'traveling' || state === 'travelling') {
      abroad.push({ ...base, desc });
    } else {
      // Catch-all: check description before putting in OK
      const dl = desc.toLowerCase();
      if (dl.includes('abroad') || dl.includes('traveling') || dl.includes('travelling') || dl.includes('foreign')) {
        abroad.push({ ...base, desc });
      } else if (dl.includes('hospital')) {
        const now = Math.floor(Date.now() / 1000);
        if (until > 0 && until <= now) ok.push(base);
        else hosp.push({ ...base, until });
      } else {
        ok.push(base);
      }
    }
  });
  return { ok, hosp, abroad };
}

// ── Parse my faction members into flat list ────────────────────────────────
function parseMyMembers(members) {
  return Object.entries(members).map(([key, m]) => {
    const id = String(m.id ?? key);
    const stateKey = classifyState(m);
    return {
      id,
      name: m.name,
      level: m.level || 0,
      stateKey,
      last_action: m.last_action?.timestamp || 0,
      online: (m.last_action?.status || '').toLowerCase(),
      until: m.status?.until || 0,
      infoText: m.status?.description || '',
    };
  });
}

// ── Update enemy summary chips ─────────────────────────────────────────────
function updateEnemySummary(name, parsed) {
  document.getElementById('enemy-faction-name').textContent = name;
  document.getElementById('e-s-ok').textContent     = parsed.ok.length;
  document.getElementById('e-s-hosp').textContent   = parsed.hosp.length;
  document.getElementById('e-s-abroad').textContent = parsed.abroad.length;
  document.getElementById('ok-count').textContent     = parsed.ok.length;
  document.getElementById('hosp-count').textContent   = parsed.hosp.length;
  document.getElementById('abroad-count').textContent = parsed.abroad.length;
}

// ── Update my faction summary chips ───────────────────────────────────────
function updateMySummary(name, members) {
  document.getElementById('my-faction-name').textContent = name;
  const okCount   = members.filter(m => m.stateKey === 'ok').length;
  const hospCount = members.filter(m => m.stateKey === 'hospital' || m.stateKey === 'abroad_hosp').length;
  document.getElementById('m-s-ok').textContent   = okCount;
  document.getElementById('m-s-hosp').textContent = hospCount;
  document.getElementById('my-total-count').textContent = members.length;
}

// ── Fetch FF scores from FFScouter ─────────────────────────────────────────
async function fetchFF(ids) {
  if (!ids.length) return;
  const CHUNK = 205;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const targets = ids.slice(i, i + CHUNK).join(',');
    try {
      const r = await fetch(`https://ffscouter.com/api/v1/get-stats?key=${tornKey}&targets=${targets}`);
      if (!r.ok) return;
      const data = await r.json();
      if (Array.isArray(data)) {
        data.forEach(p => {
          if (p.player_id != null) ffScores[String(p.player_id)] = p.fair_fight;
        });
        ['ok', 'hosp', 'abroad'].forEach(renderTable);
      }
    } catch (_) { /* FF unavailable — tables still work */ }
  }
}

// ── Resolve enemy faction ID from active ranked war ────────────────────────
async function resolveEnemyFactionId() {
  const r = await fetch(`https://api.torn.com/v2/faction?selections=rankedwars&key=${tornKey}`);
  const d = await r.json();
  if (d.error) throw new Error(d.error.error || 'error ' + d.error.code);

  const wars = d.rankedwars || [];
  const warEntries = Array.isArray(wars) ? wars : Object.values(wars);
  if (!warEntries.length) throw new Error('No ranked wars found');

  // Active war = end is 0 or null; fall back to most recent
  const active = warEntries.find(w => !w.end || w.end === 0) ?? warEntries[0];
  const war = active.war ?? active;

  const ourId = String(myFactionId);

  // Factions is an array: [{ id, name, score, chain }, ...]
  if (Array.isArray(war.factions)) {
    const myF = war.factions.find(f => String(f.id) === ourId);
    const ef  = war.factions.find(f => String(f.id) !== ourId);
    if (ef) return {
      enemyId:    String(ef.id),
      enemyName:  ef.name || `Faction #${ef.id}`,
      myScore:    myF?.score ?? 0,
      enemyScore: ef.score  ?? 0,
      target:     war.target || 0,
    };
  }

  // Fallback: object keyed by faction id
  if (war.factions && typeof war.factions === 'object') {
    const eId = Object.keys(war.factions).find(id => id !== ourId);
    if (eId) return {
      enemyId:    eId,
      enemyName:  war.factions[eId]?.name || `Faction #${eId}`,
      myScore:    war.factions[ourId]?.score ?? 0,
      enemyScore: war.factions[eId]?.score  ?? 0,
      target:     war.target || 0,
    };
  }

  showDebug(d);
  throw new Error('Could not find enemy faction ID — see debug panel');
}

// ── Debug panel — shown only when war parsing fails ────────────────────────
function showDebug(data) {
  let panel = document.getElementById('debug-panel');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'debug-panel';
    panel.style.cssText = 'margin-top:1rem;padding:1rem;background:#1e1a10;border:0.5px solid #f0a030;border-radius:8px;font-size:11px;color:#f0a030';
    document.querySelector('.container').appendChild(panel);
  }
  panel.innerHTML = `<strong>Debug — rankedwars raw response</strong> (open browser console for full log)<br>
    <pre style="margin-top:8px;white-space:pre-wrap;word-break:break-all;color:#e8eaf0;font-size:10px">${JSON.stringify(data, null, 2).slice(0, 3000)}</pre>`;
}

// ── Main poll ──────────────────────────────────────────────────────────────
async function poll() {
  if (paused || !tornKey) return;

  try {
    // Fetch my faction members + chain + attacks in parallel
    const [myR, chainR, attacksR] = await Promise.all([
      fetch(`https://api.torn.com/v2/faction?selections=members,basic&key=${tornKey}`),
      fetch(`https://api.torn.com/faction/?selections=chain&key=${tornKey}`),
      fetch(`https://api.torn.com/faction/?selections=attacks&key=${tornKey}`),
    ]);
    const myD      = await myR.json();
    const chainRaw = await chainR.json();
    const attacksRaw = await attacksR.json();
    if (myD.error) throw new Error(myD.error.error || 'error ' + myD.error.code);

    if (!myFactionId) myFactionId = myD.basic?.id;
    const myName = myD.basic?.name || 'My faction';
    const parsedMy = parseMyMembers(myD.members || {});
    myMembers = parsedMy;
    updateMySummary(myName, parsedMy);
    renderMyTable();

    // Chain — requires Limited Access key + AA faction permission
    if (chainRaw && !chainRaw.error) {
      chainData = chainRaw.chain ?? chainRaw ?? {};
      renderChain();
    } else if (chainRaw?.error) {
      // Silently hide — likely insufficient key access level
      document.getElementById('chain-box').style.display = 'none';
    }

    // Attacks — requires AA permission; hide section gracefully if unavailable
    if (attacksRaw && !attacksRaw.error && attacksRaw.attacks) {
      attackData = Object.values(attacksRaw.attacks);
      renderAttacks();
    } else {
      document.getElementById('active-fights-section').style.display = 'none';
      document.getElementById('recent-attacks-section').style.display = 'none';
    }

    // Fetch enemy faction members (requires enemyFactionId to be set)
    if (enemyFactionId) {
      const enR = await fetch(`https://api.torn.com/v2/faction/${enemyFactionId}?selections=members,basic&key=${tornKey}`);
      const enD = await enR.json();
      if (!enD.error) {
        const parsed = parseEnemyMembers(enD.members || {});
        enemyData = parsed;
        const enName = enD.basic?.name || `Faction #${enemyFactionId}`;
        updateEnemySummary(enName, parsed);
        ['ok', 'hosp', 'abroad'].forEach(renderTable);

        // Update page title
        document.getElementById('page-title').textContent = `${myName} vs ${enName}`;
      }
    }

    // Refresh war scores every ~10s (every 5th poll) to avoid rate limit
    pollCount++;
    if (pollCount % 5 === 0 && myFactionId && enemyFactionId) {
      try {
        const wr = await fetch(`https://api.torn.com/v2/faction?selections=rankedwars&key=${tornKey}`);
        const wd = await wr.json();
        if (!wd.error) {
          const entries = Array.isArray(wd.rankedwars) ? wd.rankedwars : Object.values(wd.rankedwars || {});
          const active  = entries.find(w => !w.end || w.end === 0) ?? entries[0];
          if (active) {
            const war   = active.war ?? active;
            const ourId = String(myFactionId);
            if (Array.isArray(war.factions)) {
              const myF = war.factions.find(f => String(f.id) === ourId);
              const enF = war.factions.find(f => String(f.id) !== ourId);
              if (myF && enF) {
                warScores = { ...warScores, myScore: myF.score ?? 0, enemyScore: enF.score ?? 0, target: war.target || 0 };
                renderWarScore();
              }
            }
          }
        }
      } catch(_) {}
    }

    const now = new Date();
    const ts  = [now.getHours(), now.getMinutes(), now.getSeconds()]
      .map(n => String(n).padStart(2, '0')).join(':');
    setStatus('live', `Live · updated ${ts}`);

  } catch (e) {
    setStatus('error', 'Error: ' + e.message);
  }
}

// ── Pause / resume ─────────────────────────────────────────────────────────
function togglePause() {
  paused = !paused;
  const btn = document.getElementById('pause-btn');
  btn.innerHTML = paused
    ? '<i class="ti ti-player-play" aria-hidden="true"></i> Resume'
    : '<i class="ti ti-player-pause" aria-hidden="true"></i> Pause';
  if (!paused) poll();
}

// ── Connect ────────────────────────────────────────────────────────────────
async function initConnect() {
  const key = document.getElementById('torn-key').value.trim();
  if (!key) { setStatus('error', 'Please enter your Torn API key'); return; }

  tornKey = key;
  try { localStorage.setItem('torn-dash-apikey', key); } catch(_) {}
  paused  = false;
  enemyFactionId = null;
  myFactionId    = null;
  document.getElementById('load-btn').disabled = true;
  setStatus('', 'Connecting…');

  // Step 1: get my faction info to determine our ID
  try {
    const r = await fetch(`https://api.torn.com/v2/faction?selections=basic&key=${tornKey}`);
    const d = await r.json();
    if (d.error) throw new Error(d.error.error || 'error ' + d.error.code);
    myFactionId = d.basic?.id;
  } catch (e) {
    setStatus('error', 'Could not load faction: ' + e.message);
    document.getElementById('load-btn').disabled = false;
    return;
  }

  // Step 2: find enemy faction from active ranked war
  setStatus('', 'Finding active war…');
  try {
    const result = await resolveEnemyFactionId();
    enemyFactionId = result.enemyId;
    document.getElementById('enemy-faction-name').textContent = result.enemyName;
    warScores = result;
    renderWarScore();
  } catch (e) {
    setStatus('error', e.message + ' — showing my faction only');
    // Still continue — sidebar will show my faction even with no war
  }

  // Step 3: initial full poll
  await poll();
  // Restore saved column widths after tables are populated
  const savedLayout = loadSizes();
  if (savedLayout?.columns) restoreColumnWidths(savedLayout.columns);
  const allEnemyIds = [...enemyData.ok, ...enemyData.hosp, ...enemyData.abroad].map(m => m.id);
  const allMyIds    = myMembers.map(m => m.id);
  const allIds      = [...new Set([...allEnemyIds, ...allMyIds])];
  if (allIds.length) fetchFF(allIds);

  // Step 4: start timers
  clearInterval(refreshTimer);
  clearInterval(ffTimer);
  clearInterval(timerTickInterval);
  refreshTimer      = setInterval(poll, 2000);
  timerTickInterval = setInterval(tickTimers, 1000);
  ffTimer = setInterval(() => {
    const eIds = [...enemyData.ok, ...enemyData.hosp, ...enemyData.abroad].map(m => m.id);
    const mIds = myMembers.map(m => m.id);
    const ids  = [...new Set([...eIds, ...mIds])];
    if (ids.length) fetchFF(ids);
  }, 60_000);

  document.getElementById('pause-btn').disabled = false;
  document.getElementById('refresh-label').textContent = 'Auto-refresh: 2s';
  document.getElementById('ff-note').style.display = 'flex';
  document.getElementById('load-btn').disabled = false;
}

// ── 1-second timer tick — no API call, just recalculates from stored timestamps ──
// Enemy hosp rows have data-until on their <tr>; my faction rows too.
// We stamp data-until onto rows during renderTable / renderMyTable so the tick
// can update them without a full re-render.
function tickTimers() {
  document.querySelectorAll('tr[data-until]').forEach(row => {
    const ts   = parseInt(row.dataset.until, 10);
    const cell = row.querySelector('.timer');
    if (cell) {
      const t = timeUntil(ts);
      cell.innerHTML = t === 'now' ? '<span style="color:var(--green)">Out!</span>' : t;
    }
  });
  tickChainTimer();
}
let timerTickInterval = null;

// ── Column resizer ─────────────────────────────────────────────────────────
// Injects a drag handle into every <th> and lets users resize columns.
// Widths are stored in px on the <th> so they survive re-renders.
function initResizableTable(table) {
  const ths = Array.from(table.querySelectorAll('thead th'));

  ths.forEach((th, i) => {
    // Don't add a resizer to the last column
    if (i === ths.length - 1) return;

    const handle = document.createElement('span');
    handle.className = 'col-resizer';
    th.appendChild(handle);

    let startX, startW, nextTh, startNextW;

    handle.addEventListener('mousedown', e => {
      e.preventDefault();
      startX    = e.clientX;
      startW    = th.offsetWidth;
      nextTh    = ths[i + 1];
      startNextW = nextTh ? nextTh.offsetWidth : 0;
      handle.classList.add('dragging');

      // Fix all column widths in px so resizing one doesn't reflow others
      ths.forEach(t => { t.style.width = t.offsetWidth + 'px'; });
      table.style.tableLayout = 'fixed';

      function onMove(e) {
        const dx = e.clientX - startX;
        const newW = Math.max(40, startW + dx);
        th.style.width = newW + 'px';
        if (nextTh) {
          const newNextW = Math.max(40, startNextW - dx);
          nextTh.style.width = newNextW + 'px';
        }
      }

      function onUp() {
        handle.classList.remove('dragging');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      }

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  });
}

// Call once the page loads — tables exist in the DOM already
// ── Modules grid resizer ───────────────────────────────────────────────────
// Makes the three enemy faction module columns draggable.
function initModulesGridResizer() {
  const grid = document.querySelector('.modules-grid');
  if (!grid) return;

  // Switch to explicit pixel columns
  const totalW = grid.offsetWidth;
  const colW   = Math.floor(totalW / 3);
  grid.style.gridTemplateColumns = `${colW}px ${colW}px 1fr`;
  grid.style.gap = '0';

  const modules = Array.from(grid.querySelectorAll('.module'));
  if (modules.length < 3) return;

  // Insert drag handles between modules in the DOM as grid items
  function makeHandle(colIndex) {
    const h = document.createElement('div');
    h.className = 'grid-resizer';
    h.style.cssText = 'grid-row:1;align-self:stretch;';

    let startX, startCols;
    h.addEventListener('mousedown', e => {
      e.preventDefault();
      startX    = e.clientX;
      const tpl = grid.style.gridTemplateColumns.split(' ');
      startCols = tpl.map(v => parseFloat(v));
      h.classList.add('dragging');

      function onMove(e) {
        const dx  = e.clientX - startX;
        const newA = Math.max(80, startCols[colIndex] + dx);
        const newB = Math.max(80, startCols[colIndex + 1] - dx);
        const tpl  = [...startCols];
        tpl[colIndex]     = newA;
        tpl[colIndex + 1] = newB;
        grid.style.gridTemplateColumns = tpl.map((v, i) => i === tpl.length - 1 ? '1fr' : v + 'px').join(' ');
      }
      function onUp() {
        h.classList.remove('dragging');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
    return h;
  }

  // Re-order DOM: module0, handle, module1, handle, module2
  grid.innerHTML = '';
  modules[0].style.margin = '0';
  modules[1].style.margin = '0';
  modules[2].style.margin = '0';
  grid.appendChild(modules[0]);
  grid.appendChild(makeHandle(0));
  grid.appendChild(modules[1]);
  grid.appendChild(makeHandle(1));
  grid.appendChild(modules[2]);

  // Update column count to include handle columns (1px each)
  grid.style.gridTemplateColumns = `${colW}px 10px ${colW}px 10px 1fr`;
  // Re-do handle colIndex to account for gap columns
  grid.innerHTML = '';
  grid.appendChild(modules[0]);

  const h1 = document.createElement('div');
  h1.className = 'grid-resizer';
  let sx1, sc1;
  h1.addEventListener('mousedown', e => {
    e.preventDefault(); sx1 = e.clientX;
    const tpl = grid.style.gridTemplateColumns.split(' ');
    sc1 = tpl.map(v => parseFloat(v));
    h1.classList.add('dragging');
    const onMove = e => {
      const dx = e.clientX - sx1;
      const a  = Math.max(80, sc1[0] + dx);
      const c  = Math.max(80, sc1[2] - dx);
      grid.style.gridTemplateColumns = `${a}px 10px ${c}px 10px 1fr`;
    };
    const onUp = () => { h1.classList.remove('dragging'); document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
  grid.appendChild(h1);
  grid.appendChild(modules[1]);

  const h2 = document.createElement('div');
  h2.className = 'grid-resizer';
  let sx2, sc2;
  h2.addEventListener('mousedown', e => {
    e.preventDefault(); sx2 = e.clientX;
    const tpl = grid.style.gridTemplateColumns.split(' ');
    sc2 = tpl.map(v => parseFloat(v));
    h2.classList.add('dragging');
    const onMove = e => {
      const dx = e.clientX - sx2;
      const c  = Math.max(80, sc2[2] + dx);
      grid.style.gridTemplateColumns = `${sc2[0]}px 10px ${c}px 10px 1fr`;
    };
    const onUp = () => { h2.classList.remove('dragging'); document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
  grid.appendChild(h2);
  grid.appendChild(modules[2]);
}

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('table').forEach(initResizableTable);
  initModulesGridResizer();
  initSidebarResizer();
  const saved = loadSizes();
  if (saved?.columns) restoreColumnWidths(saved.columns);
});

// ── Sidebar resizer ────────────────────────────────────────────────────────
function initSidebarResizer() {
  const layout  = document.querySelector('.war-layout');
  const sidebar = layout?.querySelector('.war-sidebar');
  const main    = layout?.querySelector('.war-main');
  if (!layout || !sidebar || !main) return;

  // Restore saved width
  const saved = loadSizes();
  if (saved?.sidebar) layout.style.gridTemplateColumns = saved.sidebar;
  if (saved?.modules) {
    const grid = document.querySelector('.modules-grid');
    if (grid) grid.style.gridTemplateColumns = saved.modules;
  }
  layout.style.gap = '0';

  const h = document.createElement('div');
  h.className = 'sidebar-resizer';
  layout.insertBefore(h, main);

  let sx, sw0;
  h.addEventListener('mousedown', e => {
    e.preventDefault();
    sx  = e.clientX;
    sw0 = sidebar.offsetWidth;
    h.classList.add('dragging');
    const onMove = e => {
      const w = Math.max(160, sw0 + (e.clientX - sx));
      layout.style.gridTemplateColumns = `${w}px 10px 1fr`;
      saveSizes();
    };
    const onUp = () => {
      h.classList.remove('dragging');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

// ── Size persistence ───────────────────────────────────────────────────────
const STORAGE_KEY = 'torn-dash-sizes-v2';

function captureColumnWidths() {
  const cols = {};
  document.querySelectorAll('table').forEach(table => {
    const ths = Array.from(table.querySelectorAll('thead th'));
    if (!ths.length) return;
    // Use the first th's id as a stable table key
    const tableKey = ths[0]?.id || null;
    if (!tableKey) return;
    cols[tableKey] = ths.map(th => th.style.width || null);
  });
  return cols;
}

function restoreColumnWidths(cols) {
  if (!cols) return;
  document.querySelectorAll('table').forEach(table => {
    const ths = Array.from(table.querySelectorAll('thead th'));
    if (!ths.length) return;
    const tableKey = ths[0]?.id || null;
    if (!tableKey || !cols[tableKey]) return;
    const saved = cols[tableKey];
    let hasAny = false;
    ths.forEach((th, i) => { if (saved[i]) { th.style.width = saved[i]; hasAny = true; } });
    if (hasAny) table.style.tableLayout = 'fixed';
  });
}

function saveSizes() {
  try {
    const layout = document.querySelector('.war-layout');
    const grid   = document.querySelector('.modules-grid');
    const existing = loadSizes() || {};
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      ...existing,
      sidebar: layout?.style.gridTemplateColumns || existing.sidebar || null,
      modules: grid?.style.gridTemplateColumns || existing.modules || null,
    }));
  } catch(_) {}
}

function saveLayout() {
  try {
    const layout = document.querySelector('.war-layout');
    const grid   = document.querySelector('.modules-grid');
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      sidebar: layout?.style.gridTemplateColumns || null,
      modules: grid?.style.gridTemplateColumns || null,
      columns: captureColumnWidths(),
    }));
    const btn = document.getElementById('save-layout-btn');
    const orig = btn.innerHTML;
    btn.innerHTML = '<i class="ti ti-check" aria-hidden="true"></i> Saved';
    setTimeout(() => { btn.innerHTML = orig; }, 1500);
  } catch(_) {}
}

function loadSizes() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); } catch(_) { return null; }
}

// Save on any drag-end
document.addEventListener('mouseup', () => { saveSizes(); });

// ── Collapsible recents ────────────────────────────────────────────────────
let recentsOpen = true;
function toggleRecents() {
  recentsOpen = !recentsOpen;
  document.getElementById('recents-body-wrap').style.display = recentsOpen ? '' : 'none';
  document.getElementById('recents-chevron').style.transform = recentsOpen ? '' : 'rotate(-90deg)';
}

// ── Enter key ──────────────────────────────────────────────────────────────
document.getElementById('torn-key').addEventListener('keydown', e => {
  if (e.key === 'Enter') initConnect();
});

// Restore saved API key on load
(function() {
  try {
    const saved = localStorage.getItem('torn-dash-apikey');
    if (saved) document.getElementById('torn-key').value = saved;
  } catch(_) {}
})();
