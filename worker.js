/**
 * Doppler Shop server (Cloudflare Worker, free plan)
 *
 * Does three jobs for the shop app:
 *   1. Shop accounts: a free month for each new shop (one per phone number), then paid time
 *      that you add from the admin page after the shop pays.
 *   2. Google Drive: each shop connects its own Google account once. This server keeps the
 *      permission key (encrypted) so backups can run by themselves, every time.
 *   3. Backups: saves the shop's data in its own Drive, folder "Doppler Shop backups":
 *      latest.json plus one copy per day for 30 days. Restore brings back latest.json.
 *
 * Settings (Cloudflare > your Worker > Settings > Variables and Secrets):
 *   SHOPS                 KV namespace binding (Bindings)
 *   GOOGLE_CLIENT_ID      secret
 *   GOOGLE_CLIENT_SECRET  secret
 *   ENC_KEY               secret, any long random text (keeps permission keys locked)
 *   ADMIN_KEY             secret, your password for the admin page
 *   AI                    Workers AI binding (Bindings > Workers AI), reads delivery notes and receipts
 *   AI_MODEL              optional text, the AI model that reads them (default: Llama 4 Scout)
 *   AI_DAILY_LIMIT        optional text, how many sheets one shop can read a day (default 30)
 *   APP_URL               text, e.g. https://duka-ledger-kirui.netlify.app
 *   PRICE_TEXT            text, e.g. Ksh 300 a month
 *   PAY_TEXT              text, e.g. Pay to M-Pesa Till 123456 (Doppler Shop)
 *   TRIAL_DAYS            text, optional, default 30
 */

const DAY = 86400000;
const FOLDER = 'Doppler Shop backups';
const KEEP_DAYS = 30;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname.replace(/\/+$/, '') || '/';
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors() });
    try {
      if (p === '/api/register' && req.method === 'POST') return await register(req, env);
      if (p === '/api/login' && req.method === 'POST') return await login(req, env);
      if (p === '/api/status' && req.method === 'GET') return await withShop(req, env, s => json(statusOf(s, env)));
      if (p === '/api/backup' && req.method === 'POST') return await withShop(req, env, s => backup(req, env, s));
      if (p === '/api/read-sheet' && req.method === 'POST') return await withShop(req, env, s => readSheet(req, env, s));
      if (p === '/api/restore' && req.method === 'GET') return await withShop(req, env, s => restore(env, s));
      if (p === '/api/drive/disconnect' && req.method === 'POST') return await withShop(req, env, async s => { delete s.drive; await saveShop(env, s); return json(statusOf(s, env)); });
      if (p === '/drive/start') return await driveStart(url, env);
      if (p === '/drive/callback') return await driveCallback(url, env);
      if (p === '/admin') return new Response(ADMIN_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } });
      if (p === '/admin/api/shops') return await adminList(req, env);
      if (p === '/admin/api/shop' && req.method === 'POST') return await adminUpdate(req, env);
      if (p === '/') return new Response('Doppler Shop server is running.', { headers: { 'content-type': 'text/plain' } });
      return json({ ok: false, error: 'not-found' }, 404);
    } catch (e) {
      return json({ ok: false, error: 'server', detail: String(e && e.message || e) }, 500);
    }
  }
};

/* ---------- helpers ---------- */
function cors() {
  return { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Authorization,Content-Type,X-Items', 'Access-Control-Max-Age': '86400' };
}
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...cors() } });
}
const enc = new TextEncoder(), dec = new TextDecoder();
function b64u(buf) { let s = ''; new Uint8Array(buf).forEach(b => s += String.fromCharCode(b)); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function unb64u(str) { const s = atob(str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4)); return Uint8Array.from(s, c => c.charCodeAt(0)); }
function randomId(n = 16) { return b64u(crypto.getRandomValues(new Uint8Array(n))); }
async function sha(text) { return b64u(await crypto.subtle.digest('SHA-256', enc.encode(text))); }
function normPhone(p) {
  let d = String(p || '').replace(/\D/g, '');
  if (d.startsWith('0') && d.length === 10) d = '254' + d.slice(1);
  if ((d.startsWith('7') || d.startsWith('1')) && d.length === 9) d = '254' + d;
  return d.length >= 9 ? d : '';
}
async function body(req) { try { return await req.json(); } catch (e) { return {}; } }
async function getShop(env, id) { const t = id && await env.SHOPS.get('shop:' + id); return t ? JSON.parse(t) : null; }
async function saveShop(env, s) { await env.SHOPS.put('shop:' + s.id, JSON.stringify(s)); }
const LIFETIME = Date.UTC(2099, 11, 31, 20, 59, 59);   /* "Lifetime" = paid until 31 Dec 2099 */
function trialDays(env) { const n = parseInt(env.TRIAL_DAYS || '30', 10); return n > 0 ? n : 30; }

function statusOf(s, env) {
  const now = Date.now();
  const paid = s.paidUntil && s.paidUntil > now, trial = s.trialEnds > now;
  const status = paid ? 'paid' : trial ? 'trial' : 'expired';
  const ends = paid ? s.paidUntil : s.trialEnds;
  return {
    ok: true, status, ends, daysLeft: Math.max(0, Math.ceil((ends - now) / DAY)),
    name: s.name, phone: s.phone, trialEnds: s.trialEnds, paidUntil: s.paidUntil || null, lifetime: !!(paid && s.paidUntil >= LIFETIME),
    drive: s.drive ? { connected: true, email: s.drive.email || '' , lastBackup: s.drive.lastBackup || null } : { connected: false },
    price: env.PRICE_TEXT || '', pay: env.PAY_TEXT || '', now
  };
}

/* the app sends "Authorization: Bearer <device token>" */
async function withShop(req, env, fn) {
  const m = (req.headers.get('Authorization') || '').match(/^Bearer\s+(.+)$/);
  if (!m) return json({ ok: false, error: 'no-token' }, 401);
  const id = await env.SHOPS.get('tok:' + await sha(m[1]));
  const s = await getShop(env, id);
  if (!s) return json({ ok: false, error: 'bad-token' }, 401);
  return fn(s);
}
async function newDeviceToken(env, shopId) {
  const t = randomId(24);
  await env.SHOPS.put('tok:' + await sha(t), shopId);
  return t;
}

/* ---------- accounts ---------- */
async function register(req, env) {
  const b = await body(req), name = String(b.name || '').trim().slice(0, 60), phone = normPhone(b.phone);
  if (!name) return json({ ok: false, error: 'no-name' }, 400);
  if (!phone) return json({ ok: false, error: 'bad-phone' }, 400);
  if (await env.SHOPS.get('phone:' + phone)) return json({ ok: false, error: 'phone-used' }, 409);
  const id = randomId(9), pin = String(100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000)), salt = randomId(8);
  const now = Date.now();
  const s = { id, name, phone, salt, pinHash: await sha(salt + pin), created: now, trialEnds: now + trialDays(env) * DAY, paidUntil: null };
  await saveShop(env, s);
  await env.SHOPS.put('phone:' + phone, id);
  const token = await newDeviceToken(env, id);
  return json({ ...statusOf(s, env), token, pin });
}
async function login(req, env) {
  const b = await body(req), phone = normPhone(b.phone), pin = String(b.pin || '').trim();
  const id = phone && await env.SHOPS.get('phone:' + phone);
  const s = await getShop(env, id);
  if (!s) return json({ ok: false, error: 'no-shop' }, 404);
  const now = Date.now();
  if (s.lockUntil && s.lockUntil > now) return json({ ok: false, error: 'locked', until: s.lockUntil }, 429);
  if (await sha(s.salt + pin) !== s.pinHash) {
    s.fails = (s.fails || 0) + 1;
    if (s.fails >= 5) { s.lockUntil = now + 60 * 60 * 1000; s.fails = 0; }
    await saveShop(env, s);
    return json({ ok: false, error: 'wrong-pin' }, 403);
  }
  if (s.fails || s.lockUntil) { s.fails = 0; s.lockUntil = 0; await saveShop(env, s); }
  const token = await newDeviceToken(env, s.id);
  return json({ ...statusOf(s, env), token });
}

/* ---------- Google Drive connection ---------- */
async function hmacKey(env) { return crypto.subtle.importKey('raw', enc.encode(String(env.ENC_KEY || '')), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']); }
async function signState(env, obj) { const p = b64u(enc.encode(JSON.stringify(obj))); const sig = b64u(await crypto.subtle.sign('HMAC', await hmacKey(env), enc.encode(p))); return p + '.' + sig; }
async function readState(env, st) {
  const [p, sig] = String(st || '').split('.'); if (!p || !sig) return null;
  const ok = await crypto.subtle.verify('HMAC', await hmacKey(env), unb64u(sig), enc.encode(p)); if (!ok) return null;
  const o = JSON.parse(dec.decode(unb64u(p))); return o.exp > Date.now() ? o : null;
}
async function aesKey(env) { const raw = await crypto.subtle.digest('SHA-256', enc.encode('aes:' + String(env.ENC_KEY || ''))); return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']); }
async function lock(env, text) { const iv = crypto.getRandomValues(new Uint8Array(12)); const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(env), enc.encode(text)); return b64u(iv) + '.' + b64u(ct); }
async function unlock(env, box) { const [iv, ct] = box.split('.'); return dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64u(iv) }, await aesKey(env), unb64u(ct))); }
function redirectUri(url) { return url.origin + '/drive/callback'; }
function backToApp(env, q) { return Response.redirect(String(env.APP_URL || '/').replace(/\/+$/, '') + '/?' + q, 302); }

async function driveStart(url, env) {
  const t = url.searchParams.get('t') || '';
  const id = t && await env.SHOPS.get('tok:' + await sha(t));
  if (!id) return backToApp(env, 'drive=fail');
  const state = await signState(env, { s: id, exp: Date.now() + 15 * 60 * 1000 });
  const g = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  g.searchParams.set('client_id', env.GOOGLE_CLIENT_ID);
  g.searchParams.set('redirect_uri', redirectUri(url));
  g.searchParams.set('response_type', 'code');
  g.searchParams.set('scope', 'https://www.googleapis.com/auth/drive.file openid email');
  g.searchParams.set('access_type', 'offline');
  g.searchParams.set('prompt', 'consent');
  g.searchParams.set('state', state);
  return Response.redirect(g.toString(), 302);
}
async function driveCallback(url, env) {
  const st = await readState(env, url.searchParams.get('state'));
  const code = url.searchParams.get('code');
  if (!st || !code) return backToApp(env, 'drive=cancelled');
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: redirectUri(url), grant_type: 'authorization_code' })
  });
  const t = await r.json();
  if (!t.refresh_token) return backToApp(env, 'drive=fail');
  let email = '';
  try { email = JSON.parse(dec.decode(unb64u(t.id_token.split('.')[1]))).email || ''; } catch (e) {}
  const s = await getShop(env, st.s); if (!s) return backToApp(env, 'drive=fail');
  s.drive = { rt: await lock(env, t.refresh_token), email, connected: Date.now() };
  await saveShop(env, s);
  return backToApp(env, 'drive=ok');
}
async function accessToken(env, s) {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, refresh_token: await unlock(env, s.drive.rt), grant_type: 'refresh_token' })
  });
  const t = await r.json();
  return t.access_token || null;
}

/* ---------- Drive files ---------- */
const DRV = 'https://www.googleapis.com/drive/v3/files', UP = 'https://www.googleapis.com/upload/drive/v3/files';
async function gfetch(at, u, init = {}) { return fetch(u, { ...init, headers: { ...(init.headers || {}), Authorization: 'Bearer ' + at } }); }
async function findByName(at, name, parent, folder) {
  const q = `name='${name}' and trashed=false` + (parent ? ` and '${parent}' in parents` : '') + (folder ? ` and mimeType='application/vnd.google-apps.folder'` : '');
  const r = await gfetch(at, DRV + '?fields=files(id,name)&q=' + encodeURIComponent(q));
  const j = await r.json(); return j.files && j.files[0] ? j.files[0].id : null;
}
async function createMeta(at, meta) {
  const r = await gfetch(at, DRV + '?fields=id', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(meta) });
  const j = await r.json(); if (!j.id) throw new Error('drive-create'); return j.id;
}
async function putContent(at, id, buf) {
  const r = await gfetch(at, UP + '/' + id + '?uploadType=media', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: buf });
  return r.ok;
}
async function ensureFile(at, s, key, name, folderId, changed) {
  if (s.drive[key]) return s.drive[key];
  s.drive[key] = await findByName(at, name, folderId) || await createMeta(at, { name, parents: [folderId], mimeType: 'application/json' });
  changed.v = true; return s.drive[key];
}
function todayIn(tz) { return new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }

async function backup(req, env, s) {
  if (!s.drive) return json({ ok: false, error: 'no-drive' }, 400);
  if (req.headers.get('X-Items') === '0') return json({ ok: false, error: 'empty' }, 400);
  const buf = await req.arrayBuffer();               /* passed through as is, so big shops stay fast */
  if (buf.byteLength < 20) return json({ ok: false, error: 'empty' }, 400);
  const at = await accessToken(env, s);
  if (!at) { delete s.drive; await saveShop(env, s); return json({ ok: false, error: 'drive-disconnected' }, 401); }
  const changed = { v: false };
  if (!s.drive.folder) { s.drive.folder = await findByName(at, FOLDER, null, true) || await createMeta(at, { name: FOLDER, mimeType: 'application/vnd.google-apps.folder' }); changed.v = true; }
  let latest = await ensureFile(at, s, 'latest', 'latest.json', s.drive.folder, changed);
  if (!await putContent(at, latest, buf)) {             /* the file was deleted in Drive: make it again */
    delete s.drive.latest; delete s.drive.folder; changed.v = true;
    s.drive.folder = await findByName(at, FOLDER, null, true) || await createMeta(at, { name: FOLDER, mimeType: 'application/vnd.google-apps.folder' });
    latest = await ensureFile(at, s, 'latest', 'latest.json', s.drive.folder, changed);
    await putContent(at, latest, buf);
  }
  const day = todayIn(env.TZ);
  if (s.drive.day !== day) {
    s.drive.day = day; s.drive.dayFile = await createMeta(at, { name: 'backup-' + day + '.json', parents: [s.drive.folder], mimeType: 'application/json' }); changed.v = true;
    await cleanOld(at, s.drive.folder);
  }
  await putContent(at, s.drive.dayFile, buf);
  s.drive.lastBackup = Date.now();
  if (changed.v) await saveShop(env, s);   /* storage is written only when something new was created (about once a day) */
  return json({ ok: true, at: s.drive.lastBackup });
}
async function cleanOld(at, folder) {
  const cutoff = new Date(Date.now() - KEEP_DAYS * DAY).toISOString();
  const q = `'${folder}' in parents and name contains 'backup-' and createdTime < '${cutoff}' and trashed=false`;
  const r = await gfetch(at, DRV + '?fields=files(id)&q=' + encodeURIComponent(q)); const j = await r.json();
  for (const f of (j.files || []).slice(0, 20)) await gfetch(at, DRV + '/' + f.id, { method: 'DELETE' });
}
async function restore(env, s) {
  if (!s.drive) return json({ ok: false, error: 'no-drive' }, 400);
  const at = await accessToken(env, s);
  if (!at) return json({ ok: false, error: 'drive-disconnected' }, 401);
  const folder = s.drive.folder || await findByName(at, FOLDER, null, true);
  const id = (folder && (s.drive.latest || await findByName(at, 'latest.json', folder))) || null;
  if (!id) return json({ ok: false, error: 'no-backup' }, 404);
  const r = await gfetch(at, DRV + '/' + id + '?alt=media');
  if (!r.ok) return json({ ok: false, error: 'no-backup' }, 404);
  const text = await r.text();
  return new Response('{"ok":true,"data":' + text + '}', { headers: { 'content-type': 'application/json', ...cors() } });
}

/* ---------- reading a delivery note, invoice or receipt ----------
   The app sends a photo, the text of a spreadsheet or Word file, or a PDF.
   Workers AI turns it into a list of products; the shopkeeper checks the list in the app before anything is added.
   Nothing is stored. */
const AI_MODEL_DEFAULT = '@cf/meta/llama-4-scout-17b-16e-instruct';
const SHEET_PROMPT = `You read delivery notes, invoices, receipts and stock sheets for small shops (dukas) in Kenya.
List every product line that came in. Answer with JSON only, no other words, in exactly this shape:
{"supplier":string|null,"date":"YYYY-MM-DD"|null,"total":number|null,"lines":[{"name":string,"brand":string|null,"size":string|null,"qty":number|null,"unit_cost":number|null,"total":number|null,"sell_price":number|null,"match":string|null}]}
Rules:
- name: the product in plain words, without the brand or size, e.g. "Sugar", "Cooking oil", "Bar soap".
- brand: the brand on its own, e.g. "Mumias", "Elianto", "Geisha". null if none.
- size: the size of one pack as written, e.g. "2 kg", "500 ml", "50 kg". null if none.
- qty: how many of that size came. If a line is cartons, bales or dozens of smaller packs (e.g. "2 bales of 12 x 2kg"), qty is the number of small packs (24) and size is the small pack ("2 kg").
- unit_cost: price paid for one of qty. total: what the whole line cost. Plain numbers in Kenya shillings, no commas.
- sell_price: only if the sheet shows a selling or retail price.
- Leave out lines that are totals, VAT, discounts, transport or delivery charges, deposits or empties.
- match: if the line is clearly one of the shop's own products listed below, copy that product's name exactly; otherwise null.
- If you cannot read a number, use null. Never invent lines.`;
function num(v) { if (v === null || v === undefined || v === '') return null; const n = Number(String(v).replace(/[^0-9.\-]/g, '')); return isFinite(n) ? n : null; }
function pickJson(out) {
  if (out && typeof out === 'object' && !Array.isArray(out)) { if (Array.isArray(out.lines)) return out; out = out.response ?? out.result ?? ''; }
  if (out && typeof out === 'object') return Array.isArray(out) ? { lines: out } : out;
  let t = String(out || '').replace(/```(?:json)?/gi, '').trim();
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch (e) {} }
  const c = t.indexOf('['), d = t.lastIndexOf(']');
  if (c >= 0 && d > c) { try { return { lines: JSON.parse(t.slice(c, d + 1)) }; } catch (e) {} }
  return null;
}
function cleanSheet(j) {
  const str = v => (v === null || v === undefined) ? null : (String(v).trim().slice(0, 80) || null);
  const lines = (Array.isArray(j.lines) ? j.lines : []).slice(0, 200).map(l => ({
    name: str(l && (l.name || l.product || l.item || l.description)), brand: str(l && l.brand), size: str(l && l.size),
    qty: num(l && (l.qty ?? l.quantity)), unit_cost: num(l && (l.unit_cost ?? l.price)), total: num(l && (l.total ?? l.amount)),
    sell_price: num(l && l.sell_price), match: str(l && l.match)
  })).filter(l => l.name && !/^(vat|tax|sub ?total|total|grand total|discount|transport|delivery charge|deposit)\b/i.test(l.name) && (l.qty || l.total || l.unit_cost));
  lines.forEach(l => { if (l.qty === null && l.total && l.unit_cost) l.qty = Math.round(l.total / l.unit_cost * 100) / 100; if (l.total === null && l.qty && l.unit_cost) l.total = Math.round(l.qty * l.unit_cost * 100) / 100; });
  return { supplier: str(j.supplier), date: /^\d{4}-\d{2}-\d{2}$/.test(String(j.date || '')) ? j.date : null, total: num(j.total), lines };
}
function b64bytes(dataUrl) { const b = atob(dataUrl.slice(dataUrl.indexOf(',') + 1)); const u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; }
async function readSheet(req, env, s) {
  if (!env.AI) return json({ ok: false, error: 'no-ai' }, 501);
  if (statusOf(s, env).status === 'expired') return json({ ok: false, error: 'expired' }, 402);
  const b = await body(req);
  let text = typeof b.text === 'string' ? b.text.slice(0, 40000) : '';
  const image = typeof b.image === 'string' && /^data:image\/(jpeg|png|webp);base64,/.test(b.image) ? b.image : '';
  const pdf = typeof b.pdf === 'string' && /^data:application\/pdf;base64,/.test(b.pdf) ? b.pdf : '';
  if (!text && !image && !pdf) return json({ ok: false, error: 'empty' }, 400);
  if (image.length > 8e6 || pdf.length > 14e6) return json({ ok: false, error: 'too-big' }, 413);
  const lim = parseInt(env.AI_DAILY_LIMIT || '30', 10) || 30, key = 'ai:' + s.id + ':' + todayIn(env.TZ);
  const used = parseInt(await env.SHOPS.get(key) || '0', 10);
  if (used >= lim) return json({ ok: false, error: 'limit', limit: lim }, 429);
  await env.SHOPS.put(key, String(used + 1), { expirationTtl: 2 * 86400 });
  if (pdf) {
    /* a PDF is turned into text first; a scanned PDF has no text, so the app asks for a photo instead */
    try {
      const r = await env.AI.toMarkdown([{ name: 'sheet.pdf', blob: new Blob([b64bytes(pdf)], { type: 'application/pdf' }) }]);
      const md = r && r[0] && (r[0].data || '');
      text = String(md || '').replace(/!\[[^\]]*\]\([^)]*\)/g, '').trim().slice(0, 40000);
    } catch (e) { return json({ ok: false, error: 'pdf-failed', detail: String(e && e.message || e).slice(0, 200) }, 502); }
    if (text.replace(/[^A-Za-z0-9]/g, '').length < 20) return json({ ok: false, error: 'scanned' }, 422);
  }
  const known = Array.isArray(b.products) ? b.products.slice(0, 400).map(x => String(x).slice(0, 100)).join('\n') : '';
  const ask = (known ? `The shop's own products (name, then sizes):\n${known}\n\n` : '') + (text ? `The sheet:\n${text}` : 'The sheet is in the picture.');
  const content = image ? [{ type: 'text', text: ask }, { type: 'image_url', image_url: { url: image } }] : ask;
  let out;
  /* if the main model refuses, try a second model that also reads pictures */
  const models = [env.AI_MODEL || AI_MODEL_DEFAULT, '@cf/google/gemma-3-12b-it'], why = [];
  for (const m of models) {
    try { out = await env.AI.run(m, { messages: [{ role: 'system', content: SHEET_PROMPT }, { role: 'user', content }], max_tokens: 4000, temperature: 0.1 }); if (pickJson(out)) break; why.push(m.split('/').pop() + ': no list'); }
    catch (e) { why.push(m.split('/').pop() + ': ' + String(e && e.message || e).slice(0, 150)); out = null; }
  }
  if (!out) return json({ ok: false, error: 'ai-failed', detail: why.join(' / ').slice(0, 300) }, 502);
  const j = pickJson(out);
  if (!j) return json({ ok: false, error: 'unreadable', detail: String(out && out.response || '').slice(0, 300) }, 422);
  const sheet = cleanSheet(j);
  return json({ ok: true, ...sheet, left: Math.max(0, lim - used - 1) });
}

/* ---------- admin ---------- */
function isAdmin(req, env) { return env.ADMIN_KEY && req.headers.get('X-Admin-Key') === env.ADMIN_KEY; }
async function adminList(req, env) {
  if (!isAdmin(req, env)) return json({ ok: false, error: 'wrong-key' }, 403);
  const out = []; let cursor;
  do {
    const l = await env.SHOPS.list({ prefix: 'shop:', cursor });
    for (const k of l.keys) { const s = await getShop(env, k.name.slice(5)); if (s) out.push({ id: s.id, ...statusOf(s, env), created: s.created }); }
    cursor = l.list_complete ? null : l.cursor;
  } while (cursor);
  out.sort((a, b) => b.created - a.created);
  return json({ ok: true, shops: out });
}
async function adminUpdate(req, env) {
  if (!isAdmin(req, env)) return json({ ok: false, error: 'wrong-key' }, 403);
  const b = await body(req), s = await getShop(env, b.id); if (!s) return json({ ok: false, error: 'no-shop' }, 404);
  const now = Date.now(), from = Math.max(now, s.paidUntil || 0, s.trialEnds > now ? s.trialEnds : 0);
  let pin = null;
  if (b.action === 'paid30') s.paidUntil = from + 30 * DAY;
  else if (b.action === 'paid365') s.paidUntil = from + 365 * DAY;
  else if (b.action === 'trial7') s.trialEnds = Math.max(now, s.trialEnds) + 7 * DAY;
  else if (b.action === 'lifetime') s.paidUntil = LIFETIME;
  else if (b.action === 'unpaid') s.paidUntil = null;   /* undo paid time; any free days left stay */
  else if (b.action === 'setend') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.until || ''))) return json({ ok: false, error: 'bad-date' }, 400);
    const t = Date.parse(b.until + 'T23:59:59+03:00');   /* end of that day, Kenya time */
    if (!t) return json({ ok: false, error: 'bad-date' }, 400);
    s.paidUntil = t > now ? Math.min(t, LIFETIME) : null;
  }
  else if (b.action === 'stop') { s.paidUntil = null; s.trialEnds = now - 1; }
  else if (b.action === 'newpin') { pin = String(100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000)); s.salt = randomId(8); s.pinHash = await sha(s.salt + pin); s.fails = 0; s.lockUntil = 0; }
  else return json({ ok: false, error: 'bad-action' }, 400);
  await saveShop(env, s);
  return json({ ok: true, shop: { id: s.id, ...statusOf(s, env) }, pin });
}

const ADMIN_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Doppler Shop admin</title>
<style>body{margin:0;font-family:system-ui,sans-serif;background:#F6F4EA;color:#18213A}main{max-width:760px;margin:0 auto;padding:16px}h1{font-size:1.3rem;color:#0B3D91}
input,button{font:inherit}input{padding:10px;border-radius:10px;border:1px solid #E2DED0;width:100%;box-sizing:border-box}button{border:0;border-radius:10px;padding:8px 12px;background:#0B3D91;color:#fff;font-weight:700;cursor:pointer}
button.soft{background:#ECE8D9;color:#18213A}.shop{background:#fff;border-radius:14px;padding:12px 14px;margin:10px 0}.row{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}.tag{font-size:.75rem;font-weight:800;border-radius:6px;padding:2px 7px}
.trial{background:#E2E8F4;color:#082D6B}.paid{background:#DDF0E5;color:#1D7A4C}.expired{background:#F2E0D9;color:#A4442F}small{color:#5E6577}#msg{font-weight:700}.fix{align-items:center;border-top:1px solid #ECE8D9;padding-top:8px}.fix span{font-size:.85rem;color:#5E6577}.fix input{width:auto;padding:6px 8px}</style></head><body><main>
<h1>Doppler Shop: shops</h1><div id="login"><p>Admin password</p><input id="k" type="password"><div class="row"><button id="go">Open</button></div></div><p id="msg"></p><div id="list"></div></main>
<script>
const $=s=>document.querySelector(s);let K=sessionStorage.getItem('dk')||'';
const d=t=>t?new Date(t).toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'}):'-';
async function load(){const r=await fetch('/admin/api/shops',{headers:{'X-Admin-Key':K}});const j=await r.json();if(!j.ok){$('#msg').textContent='Wrong password.';$('#login').hidden=false;return;}
$('#login').hidden=true;sessionStorage.setItem('dk',K);$('#msg').textContent=j.shops.length+' shops';
$('#list').innerHTML=j.shops.map(s=>'<div class="shop"><b>'+s.name.replace(/</g,'&lt;')+'</b> <span class="tag '+s.status+'">'+(s.lifetime?'lifetime':s.status)+'</span><br><small>Phone '+s.phone+' · joined '+d(s.created)+' · '+(s.lifetime?'lifetime access':s.status==='paid'?'paid until '+d(s.paidUntil):s.status==='trial'?'free month ends '+d(s.trialEnds):'ended '+d(s.ends))+' · Drive '+(s.drive.connected?'connected'+(s.drive.lastBackup?', last backup '+d(s.drive.lastBackup):''):'not connected')+'</small>'+
'<div class="row"><button data-a="paid30" data-id="'+s.id+'">Paid 1 month</button><button data-a="paid365" data-id="'+s.id+'">Paid 1 year</button><button class="soft" data-a="trial7" data-id="'+s.id+'">+7 free days</button><button class="soft" data-a="newpin" data-id="'+s.id+'">New PIN</button><button data-a="lifetime" data-id="'+s.id+'">Lifetime</button><button class="soft" data-a="stop" data-id="'+s.id+'">Stop</button></div>'+
'<div class="row fix"><span>Fix a mistake:</span><input type="date" id="dt-'+s.id+'" value="'+(s.paidUntil&&!s.lifetime?new Date(s.paidUntil+3*3600000).toISOString().slice(0,10):'')+'"><button class="soft" data-a="setend" data-id="'+s.id+'">Set paid until</button><button class="soft" data-a="unpaid" data-id="'+s.id+'">Remove paid time</button></div></div>').join('');}
$('#go').onclick=()=>{K=$('#k').value.trim();load();};
document.addEventListener('click',async e=>{const b=e.target.closest('[data-a]');if(!b)return;const r=await fetch('/admin/api/shop',{method:'POST',headers:{'X-Admin-Key':K,'content-type':'application/json'},body:JSON.stringify({id:b.dataset.id,action:b.dataset.a,until:(document.getElementById('dt-'+b.dataset.id)||{}).value||''})});const j=await r.json();
const m=j.ok?(j.pin?'New PIN for this shop: '+j.pin+' (tell the owner)':'Saved.'):(j.error==='bad-date'?'Pick a date first.':'Could not save.');await load();$('#msg').textContent=m;});
if(K)load();
</script></body></html>`;
