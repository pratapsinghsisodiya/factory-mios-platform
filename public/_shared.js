/* ═══════════════════════════════════════════════════════════
   Factory-MIOS Dashboard — Shared JavaScript Utilities
   Plant: Factory-MIOS, Delhi | Machine: Demo CNC Machine
   ═══════════════════════════════════════════════════════════ */

/* ── Auth helpers ───────────────────────────────────────── */
function zGetToken() {
  return localStorage.getItem('oee_token') || getCookie('oee_token') || '';
}

function zAuthHeader() {
  const t = zGetToken();
  return t ? { 'Authorization': 'Bearer ' + t } : {};
}

function getCookie(name) {
  const m = document.cookie.match('(?:^|;)\\s*' + name + '\\s*=\\s*([^;]+)');
  return m ? decodeURIComponent(m[1]) : '';
}

// Auth check — only redirect on 401, never on network/timeout
// Uses /api/cnc/live as a lightweight auth probe (does not require auth,
// but if there is a token the server validates it; 401 means invalid token)
function zCheckAuth() {
  // First: if no token at all, redirect to login immediately
  const tok = zGetToken();
  if (!tok) {
    window.location.href = '/login.html';
    return Promise.resolve(null);
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  return fetch('/api/cnc/live?machine=MACHINE001', {
    headers: zAuthHeader(),
    signal: ctrl.signal
  })
  .then(r => {
    clearTimeout(timer);
    if (r.status === 401) {
      window.location.href = '/login.html';
    }
    return r;
  })
  .catch(err => {
    clearTimeout(timer);
    // Timeout or network error — do NOT redirect
    return null;
  });
}

function zLogout() {
  localStorage.removeItem('oee_token');
  document.cookie = 'oee_token=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT';
  window.location.href = '/login.html';
}

/* ── zFetch — wraps fetch with auth + timeout ───────────── */
function zFetch(url, opts, timeoutMs) {
  timeoutMs = timeoutMs || 8000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const options = Object.assign({}, opts || {});
  options.headers = Object.assign({}, zAuthHeader(), options.headers || {});
  if (!options.headers['Content-Type'] && options.body && typeof options.body === 'string') {
    options.headers['Content-Type'] = 'application/json';
  }
  options.signal = ctrl.signal;
  return fetch(url, options)
    .then(r => {
      clearTimeout(timer);
      if (r.status === 401) { window.location.href = '/login.html'; return {}; }
      return r.json().catch(() => ({}));
    })
    .catch(err => {
      clearTimeout(timer);
      if (err.name === 'AbortError') {
        const e = new Error('Request timeout: ' + url);
        e.isTimeout = true;
        throw e;
      }
      throw err;
    });
}

/* ── Shift helpers ──────────────────────────────────────── */
function zCurrentShift() {
  const now = new Date();
  const ist = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const h = ist.getHours();
  return (h >= 7 && h < 19) ? 'A' : 'B';
}

function zShiftInfo() {
  const now = new Date();
  const ist = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const h = ist.getHours();
  const m = ist.getMinutes();
  const totalMin = h * 60 + m;
  const shift = (h >= 7 && h < 19) ? 'A' : 'B';
  let elapsed, remaining;
  if (shift === 'A') {
    elapsed   = totalMin - 7 * 60;
    remaining = 12 * 60 - elapsed;
  } else {
    // Shift B: 19:00 – 07:00 (720 min)
    const shiftStart = 19 * 60;
    if (totalMin >= shiftStart) {
      elapsed = totalMin - shiftStart;
    } else {
      elapsed = (24 * 60 - shiftStart) + totalMin;
    }
    remaining = 12 * 60 - elapsed;
  }
  elapsed   = Math.max(0, elapsed);
  remaining = Math.max(0, remaining);
  return { shift, elapsed, remaining };
}

/* ── Formatters ─────────────────────────────────────────── */
function fmtNum(v, dec) {
  if (v === null || v === undefined || isNaN(v)) return '--';
  dec = dec === undefined ? 1 : dec;
  return Number(v).toFixed(dec);
}

function fmtInt(v) {
  if (v === null || v === undefined || isNaN(v)) return '--';
  return Math.round(Number(v)).toLocaleString();
}

function fmtPct(v) {
  if (v === null || v === undefined || isNaN(v)) return '--%';
  return Number(v).toFixed(1) + '%';
}

function fmtHM(min) {
  if (min === null || min === undefined || isNaN(min)) return '--';
  min = Math.round(Number(min));
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return m + 'm';
  return h + 'h ' + m + 'm';
}

function fmtIST(ts) {
  if (!ts) return '--';
  try {
    return new Date(ts).toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata',
      day: '2-digit', month: 'short',
      hour: '2-digit', minute: '2-digit',
      hour12: false
    });
  } catch { return '--'; }
}

function fmtISTTime(ts) {
  if (!ts) return '--';
  try {
    return new Date(ts).toLocaleTimeString('en-IN', {
      timeZone: 'Asia/Kolkata',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false
    });
  } catch { return '--'; }
}

/* ── OEE color / grade ──────────────────────────────────── */
function oeeColor(v) {
  v = parseFloat(v);
  if (isNaN(v)) return '#6b8cae';
  if (v >= 85) return '#00ff88';
  if (v >= 65) return '#ffb300';
  return '#ff4444';
}

function oeeGrade(v) {
  v = parseFloat(v);
  if (isNaN(v)) return 'N/A';
  if (v >= 85) return 'World Class';
  if (v >= 75) return 'Good';
  if (v >= 65) return 'Average';
  if (v >= 50) return 'Fair';
  return 'Poor';
}

function oeeGradeBadge(v) {
  const g = oeeGrade(v);
  const cls = v >= 85 ? 'success' : v >= 65 ? 'warning' : 'danger';
  return `<span class="z-badge ${cls}">${g}</span>`;
}

function stateColor(s) {
  if (!s) return '#6b8cae';
  s = s.toUpperCase();
  if (s === 'RUNNING')  return '#00ff88';
  if (s === 'STOPPED')  return '#ffb300';
  if (s === 'ALARM')    return '#ff4444';
  if (s === 'IDLE')     return '#4488ff';
  return '#6b8cae';
}

function stateClass(s) {
  if (!s) return 'state-idle';
  s = s.toUpperCase();
  if (s === 'RUNNING') return 'state-running';
  if (s === 'STOPPED') return 'state-stopped';
  if (s === 'ALARM')   return 'state-alarm';
  return 'state-idle';
}

/* ── SVG Donut ──────────────────────────────────────────── */
function zDonut(pct, color, size, stroke) {
  pct    = Math.max(0, Math.min(100, parseFloat(pct) || 0));
  color  = color  || '#00d4ff';
  size   = size   || 64;
  stroke = stroke || 6;
  const r = (size - stroke) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const circ = 2 * Math.PI * r;
  const dash = (pct / 100) * circ;
  const gap  = circ - dash;
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">
  <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="rgba(255,255,255,.07)" stroke-width="${stroke}"/>
  <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}" stroke-width="${stroke}"
    stroke-dasharray="${dash.toFixed(2)} ${gap.toFixed(2)}"
    stroke-dashoffset="${(circ / 4).toFixed(2)}"
    stroke-linecap="round" transform="rotate(-90 ${cx} ${cy})"/>
</svg>`;
}

/* ── OEE Date helper — handles Shift B crossing midnight ─── */
function zOEEDate(shift) {
  const now = new Date();
  const ist = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const h = ist.getHours();
  // Shift B: 19:00–07:00. At hours 0–6 (past midnight) the shift STARTED yesterday
  if ((shift || 'A').toUpperCase() === 'B' && h >= 0 && h < 7) {
    const d = new Date(ist);
    d.setDate(d.getDate() - 1);
    return d.toLocaleDateString('en-CA');
  }
  return ist.toLocaleDateString('en-CA');
}

/* ── Render Nav ─────────────────────────────────────────── */
// All pages flat-listed — shown in scrollable top bar; filtered by tenant permissions
const ALL_NAV_PAGES = [
  { href: '/',                      icon: '⊡',  label: 'Home',        key: 'dashboard' },
  { href: '/machine-live.html',     icon: '⚙',  label: 'Machine',     key: 'machine-live' },
  { href: '/manager.html',          icon: '◉',  label: 'Manager',     key: 'manager' },
  { href: '/predictive.html',       icon: '◆',  label: 'Predict',     key: 'predictive' },
  { href: '/downtime-analysis',     icon: '⊠',  label: 'Downtime',    key: 'downtime-analysis' },
  { href: '/quality-entry.html',    icon: '✓',  label: 'Quality',     key: 'quality-entry' },
  { href: '/master-data.html',      icon: '⊞',  label: 'Master',      key: 'master-data' },
  { href: '/reports.html',          icon: '▤',  label: 'Reports',     key: 'reports' },
  { href: '/shift-log.html',        icon: '📋', label: 'Shift Log',   key: 'shift-log' },
  { href: '/downtime-log.html',     icon: '⚠',  label: 'DT Log',      key: 'downtime-log' },
  { href: '/chat.html',             icon: '◎',  label: 'AI Chat',     key: 'chat' },
  { href: '/operator.html',         icon: '▣',  label: 'Operator',    key: 'operator' },
  { href: '/supervisor.html',       icon: '◫',  label: 'Supervisor',  key: 'supervisor' },
  { href: '/digital-twin.html',     icon: '◈',  label: 'Twin',        key: 'digital-twin' },
  { href: '/connectivity.html',     icon: '◌',  label: 'Network',     key: 'connectivity' },
  { href: '/alerts.html',           icon: '🔔', label: 'Alerts',      key: 'alerts' },
  { href: '/dashboard-builder.html',icon: '⊕',  label: 'Builder',     key: 'builder' },
  { href: '/my-dashboards',         icon: '▦',  label: 'Dashboards',  key: 'my-dashboards' },
  // Admin-only pages — only shown to admin / superadmin roles
  { href: '/users.html',            icon: '◧',  label: 'Users',       key: 'users',         adminOnly: true },
  { href: '/saas-platform',         icon: '🏗',  label: 'Platform',    key: 'saas-platform', adminOnly: true },
  { href: '/super-admin.html',      icon: '⬟',  label: 'Admin',       key: 'super-admin',   adminOnly: true },
];

// Keep backwards-compat aliases
const Z_NAV_PRIMARY = ALL_NAV_PAGES.filter(p => !p.adminOnly);
const Z_NAV_MORE = [];

function zRenderNav(containerId, activePage) {
  const el = document.getElementById(containerId);
  if (!el) return;
  const cur = activePage || location.pathname;

  function isActive(href) {
    return href === '/' ? (cur === '/' || cur === '/index.html') : cur.includes(href.replace('.html', ''));
  }

  // Parse user from localStorage
  const userRaw = localStorage.getItem('oee_user') || '';
  let userName = 'Operator', userRole = '';
  try {
    const obj = JSON.parse(userRaw);
    userName = obj.name || obj.username || 'Operator';
    userRole = obj.role || '';
  } catch (e) {
    userName = userRaw || 'Operator';
  }
  const initials = userName.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase() || 'OP';
  const isAdmin = (userRole === 'admin' || userRole === 'superadmin');

  // Build flat list — hide adminOnly for non-admin users
  const allLinks = ALL_NAV_PAGES
    .filter(function(l) { return !l.adminOnly || isAdmin; })
    .map(function(l) {
      return '<a href="' + l.href + '" class="nav-link' + (isActive(l.href) ? ' active' : '') +
             '" data-page-key="' + l.key + '">' +
             '<span class="nav-icon">' + l.icon + '</span>' +
             '<span class="nav-label">' + l.label + '</span></a>';
    }).join('');

  el.className = 'z-nav';
  el.innerHTML =
    '<div class="nav-brand">' +
      '<img class="nav-logo-img" src="/assets/factory-mios-logo.png" alt="Factory-MIOS logo"/>' +
      '<div><div class="nav-title">Factory-MIOS</div>' +
      '<div class="nav-subtitle" id="z-nav-subtitle">—</div></div>' +
    '</div>' +
    '<div class="nav-links" id="nav-links-wrap">' + allLinks + '</div>' +
    '<div class="nav-right">' +
      '<div class="nav-clock" id="z-clock">--:--:--<br><span style="font-size:.7rem;opacity:.7">IST</span></div>' +
      '<div class="nav-user">' +
        '<div class="nav-avatar">' + initials + '</div>' +
        '<span class="nav-name" title="' + userName + '">' + userName.split(' ')[0] + '</span>' +
        (userRole ? '<span class="nav-role-badge">' + userRole + '</span>' : '') +
      '</div>' +
      '<button class="nav-logout" onclick="zLogout()">Logout</button>' +
    '</div>';

  // Async: filter nav by tenant permissions (non-admin only)
  if (!isAdmin) { zApplyNavPermissions(); }
  // Async: append saved dashboards as extra links
  zLoadPublishedDashboards(cur);
  // Async: populate nav subtitle with real plant / company info from DB
  zLoadNavSubtitle();
}

// Fetch machine + plant info and update the nav subtitle dynamically
function zLoadNavSubtitle() {
  fetch('/api/machine-info?machine_id=MACHINE001', { headers: zAuthHeader() })
    .then(function(r) { return r.json(); })
    .then(function(d) {
      var el = document.getElementById('z-nav-subtitle');
      if (!el || !d || !d.ok) return;
      var parts = [];
      if (d.plant_name && d.plant_name !== '—')     parts.push(d.plant_name);
      if (d.machine_id)                               parts.push(d.machine_id);
      el.textContent = parts.join(' · ') || 'Factory-MIOS';
    })
    .catch(function() {
      var el = document.getElementById('z-nav-subtitle');
      if (el) el.textContent = 'MACHINE001';
    });
}

// Apply tenant page permissions — hide disabled pages from nav
function zApplyNavPermissions() {
  fetch('/api/saas/permissions/mine', { headers: zAuthHeader() })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (!data || !data.pages || !data.pages.length) return;
      data.pages.forEach(function(p) {
        if (!p.enabled) {
          var el = document.querySelector('[data-page-key="' + p.page_key + '"]');
          if (el) el.style.display = 'none';
        }
      });
    })
    .catch(function() { /* silent */ });
}

// Fetch published dashboards and append as nav links
function zLoadPublishedDashboards(cur) {
  fetch('/api/dashboards/list')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      const wrap = document.getElementById('nav-links-wrap');
      if (!wrap) return;
      const list = (data && data.dashboards) ? data.dashboards : [];
      if (!list.length) return;
      // Thin divider spacer
      const sep = document.createElement('span');
      sep.style.cssText = 'width:1px;height:20px;background:var(--border);flex-shrink:0;margin:0 4px;align-self:center;';
      wrap.appendChild(sep);
      // One link per saved dashboard
      list.forEach(function(d) {
        const href = '/view/' + d.slug;
        const isAct = cur && cur.startsWith(href);
        const a = document.createElement('a');
        a.href = href;
        a.className = 'nav-link' + (isAct ? ' active' : '');
        a.title = d.name;
        a.innerHTML = '<span class="nav-icon">' + (d.theme && d.theme.icon ? d.theme.icon : '📊') + '</span>' +
          '<span class="nav-label">' + d.name.replace(/</g,'&lt;').replace(/>/g,'&gt;').slice(0,12) + '</span>';
        wrap.appendChild(a);
      });
    })
    .catch(function() { /* silent */ });
}

function zToggleMoreMenu() {
  const menu = document.getElementById('nav-more-menu');
  if (menu) menu.classList.toggle('open');
  // Close on outside click
  setTimeout(function() {
    document.addEventListener('click', function closeMenu(e) {
      const wrap = document.getElementById('nav-more-wrap');
      if (wrap && !wrap.contains(e.target)) {
        if (menu) menu.classList.remove('open');
        document.removeEventListener('click', closeMenu);
      }
    });
  }, 0);
}

/* ── Clock ──────────────────────────────────────────────── */
function zStartClock(elId) {
  function tick() {
    const el = document.getElementById(elId);
    if (!el) return;
    const now = new Date();
    const ist = now.toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false
    });
    const date = now.toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata',
      day: '2-digit', month: 'short', year: 'numeric'
    });
    el.innerHTML = `${ist}<br><span style="font-size:.7rem;opacity:.7">${date}</span>`;
  }
  tick();
  setInterval(tick, 1000);
}

/* ── Toast ──────────────────────────────────────────────── */
function zToast(msg, type, duration) {
  type     = type     || 'info';
  duration = duration || 3500;
  let wrap = document.getElementById('z-toasts');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.id = 'z-toasts';
    document.body.appendChild(wrap);
  }
  const icons = { success: '✓', warning: '⚠', error: '✕', info: 'ℹ' };
  const t = document.createElement('div');
  t.className = `z-toast ${type}`;
  t.innerHTML = `<span style="font-size:1rem">${icons[type] || 'ℹ'}</span><span>${msg}</span>`;
  wrap.appendChild(t);
  setTimeout(() => {
    t.classList.add('fade-out');
    setTimeout(() => t.remove(), 280);
  }, duration);
}

/* ── Particles ──────────────────────────────────────────── */
function zParticles() {
  const canvas = document.createElement('canvas');
  canvas.id = 'z-particles';
  document.body.insertBefore(canvas, document.body.firstChild);
  const ctx = canvas.getContext('2d');
  let W, H, particles = [];

  function resize() {
    W = canvas.width  = window.innerWidth;
    H = canvas.height = window.innerHeight;
  }
  resize();
  window.addEventListener('resize', resize);

  const N = 48;
  for (let i = 0; i < N; i++) {
    particles.push({
      x: Math.random() * 1920,
      y: Math.random() * 1080,
      r: Math.random() * 1.4 + .4,
      vx: (Math.random() - .5) * .3,
      vy: (Math.random() - .5) * .3,
      a: Math.random() * .5 + .15,
    });
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);
    for (const p of particles) {
      p.x += p.vx; p.y += p.vy;
      if (p.x < 0) p.x = W; if (p.x > W) p.x = 0;
      if (p.y < 0) p.y = H; if (p.y > H) p.y = 0;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(0,180,255,${p.a})`;
      ctx.fill();
    }
    // Draw connecting lines
    for (let i = 0; i < particles.length; i++) {
      for (let j = i + 1; j < particles.length; j++) {
        const dx = particles[i].x - particles[j].x;
        const dy = particles[i].y - particles[j].y;
        const d  = Math.sqrt(dx * dx + dy * dy);
        if (d < 120) {
          ctx.beginPath();
          ctx.strokeStyle = `rgba(0,180,255,${.06 * (1 - d / 120)})`;
          ctx.lineWidth = .5;
          ctx.moveTo(particles[i].x, particles[i].y);
          ctx.lineTo(particles[j].x, particles[j].y);
          ctx.stroke();
        }
      }
    }
    requestAnimationFrame(draw);
  }
  draw();
}

/* ── Flash a value element on update ───────────────────── */
function zFlash(el) {
  if (!el) return;
  el.classList.remove('val-flash');
  void el.offsetWidth; // reflow
  el.classList.add('val-flash');
}

/* ── Safe set text content ──────────────────────────────── */
function zSet(id, val) {
  const el = document.getElementById(id);
  if (el) {
    el.textContent = val;
    el.classList.remove('skeleton');
  }
}

function zSetHTML(id, html) {
  const el = document.getElementById(id);
  if (el) {
    el.innerHTML = html;
    el.classList.remove('skeleton');
  }
}

/* ── DOMContentLoaded bootstrap ────────────────────────── */
document.addEventListener('DOMContentLoaded', function () {
  zRenderNav('z-nav');
  zStartClock('z-clock');
  zCheckAuth().catch(function () {});
});
