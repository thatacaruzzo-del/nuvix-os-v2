const SUPABASE_URL = 'https://quullcxptbiqycyakzlc.supabase.co';
const SUPABASE_KEY = 'sb_publishable_hHub8WOjVFPavMPjmfGIBA_kDyvO1s6';

const headers = {
  'apikey': SUPABASE_KEY,
  'Authorization': 'Bearer ' + SUPABASE_KEY,
  'Content-Type': 'application/json',
  'Prefer': 'return=representation'
};

async function dbGet(table, query = '') {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}${query}`, { headers });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

async function dbPost(table, data) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST', headers, body: JSON.stringify(data)
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

async function dbPatch(table, id, data) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?id=eq.${id}`, {
    method: 'PATCH', headers, body: JSON.stringify(data)
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

async function dbDelete(table, id) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?id=eq.${id}`, {
    method: 'DELETE', headers
  });
  if (!r.ok) throw new Error(await r.text());
  return true;
}

function withEmpresa(obj) {
  const s = getSession();
  return { ...obj, empresa_id: s?.empresa_id };
}

window.db = { get: dbGet, post: dbPost, patch: dbPatch, delete: dbDelete };
window.withEmpresa = withEmpresa;
