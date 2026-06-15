/**
 * auth-check.js
 * Include this on every protected page with:
 *   <script src="/auth-check.js"></script>
 *
 * It checks the JWT token from localStorage or cookie,
 * redirects to /login if missing, and injects a logout button.
 */
(async function() {
  const token = localStorage.getItem('oee_token');

  // Verify with server
  try {
    const res  = await fetch('/api/auth/me', {
      headers: token ? { Authorization: 'Bearer ' + token } : {}
    });
    const data = await res.json();

    if (!data.ok) {
      localStorage.removeItem('oee_token');
      localStorage.removeItem('oee_user');
      window.location.href = '/login?redirect=' + encodeURIComponent(window.location.pathname);
      return;
    }

    // Store user info globally
    window.OEE_USER = data.user;

    // Inject user info + logout button into .topnav if present
    const nav = document.querySelector('.nav-links') || document.querySelector('.topnav');
    if (nav) {
      const userChip = document.createElement('div');
      userChip.style.cssText = 'display:flex;align-items:center;gap:10px;border-left:1px solid #334155;margin-left:8px;padding-left:16px;';
      userChip.innerHTML = `
        <span style="font-size:12px;color:#64748B;">
          👤 <span style="color:#94A3B8;font-weight:600;">${data.user.username}</span>
          <span style="font-size:10px;background:rgba(37,99,235,.2);color:#93C5FD;padding:1px 7px;border-radius:10px;margin-left:4px;">${data.user.role}</span>
        </span>
        <button onclick="logout()" style="background:rgba(220,38,38,.15);color:#FCA5A5;border:1px solid rgba(220,38,38,.3);border-radius:6px;font-size:12px;font-weight:600;padding:5px 12px;cursor:pointer;transition:all .2s;"
          onmouseover="this.style.background='rgba(220,38,38,.3)'"
          onmouseout="this.style.background='rgba(220,38,38,.15)'">
          🚪 Logout
        </button>`;
      nav.appendChild(userChip);
    }

  } catch (e) {
    window.location.href = '/login';
  }

  window.logout = async function() {
    try { await fetch('/api/auth/logout', { method: 'POST' }); } catch(e) {}
    localStorage.removeItem('oee_token');
    localStorage.removeItem('oee_user');
    window.location.href = '/login';
  };
})();
