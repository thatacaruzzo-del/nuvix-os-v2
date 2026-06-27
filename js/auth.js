const SESSION_KEY = 'nuvix_v2_session';

function saveSession(user, empresa) {
  const data = { user, empresa, loginAt: Date.now() };
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(data));
}

function getSession() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (Date.now() - data.loginAt > 8 * 60 * 60 * 1000) {
      clearSession();
      return null;
    }
    return { ...data.user, empresa_id: data.empresa?.id, empresa: data.empresa };
  } catch {
    return null;
  }
}

function clearSession() {
  sessionStorage.removeItem(SESSION_KEY);
}

function logout() {
  clearSession();
  window.location.href = '/index.html';
}

function requireAuth(allowedRoles = null) {
  const session = getSession();
  if (!session) {
    window.location.href = '/index.html';
    return null;
  }
