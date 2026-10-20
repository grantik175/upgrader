// Upgrade Lab — Steam helper for a static site (Cloudflare Worker, free plan).
//   GET /profile?id=<SteamID64>  → {"steamid","name","avatar","avatarMedium","avatarIcon","url"}
//   GET /verify?<openid.* params returned by Steam> → {"ok":true,"steamid":"7656…"} or {"ok":false}
// Uses only public Steam endpoints, no API key needed.

// Which sites may call this worker. Add your own domain if you get one.
const ALLOWED_ORIGINS = [
  'https://grantik175.github.io',
  'http://localhost:8765',
];

const STEAM_OPENID = 'https://steamcommunity.com/openid/login';
const ID_RE = /^\d{17}$/;

function cors(origin) {
  const ok = ALLOWED_ORIGINS.includes(origin);
  return {
    'Access-Control-Allow-Origin': ok ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}
function json(data, status, origin, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors(origin), ...extra },
  });
}
// <tag><![CDATA[value]]></tag>  or  <tag>value</tag>
function xmlTag(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}>\\s*(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([^<]*))\\s*</${tag}>`));
  return m ? (m[1] ?? m[2] ?? '').trim() : '';
}

async function profile(id, origin, ctx) {
  if (!ID_RE.test(id)) return json({ error: 'bad id' }, 400, origin);
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const cacheKey = new Request(`https://steam-profile.cache/${id}`);
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return json(await hit.json(), 200, origin, { 'X-Cache': 'HIT' });
  }
  const r = await fetch(`https://steamcommunity.com/profiles/${id}/?xml=1`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (UpgradeLab profile fetch)' },
  });
  if (!r.ok) return json({ error: 'steam ' + r.status }, 502, origin);
  const xml = await r.text();
  if (xml.includes('<error>')) return json({ error: xmlTag(xml, 'error') || 'not found' }, 404, origin);
  const data = {
    steamid: xmlTag(xml, 'steamID64') || id,
    name: xmlTag(xml, 'steamID'),
    avatar: xmlTag(xml, 'avatarFull'),
    avatarMedium: xmlTag(xml, 'avatarMedium'),
    avatarIcon: xmlTag(xml, 'avatarIcon'),
    url: `https://steamcommunity.com/profiles/${id}`,
  };
  if (!data.name) return json({ error: 'no profile data' }, 502, origin);
  if (cache) {
    const put = cache.put(cacheKey, new Response(JSON.stringify(data), { headers: { 'Cache-Control': 'max-age=3600' } }));
    ctx && ctx.waitUntil ? ctx.waitUntil(put) : await put;
  }
  return json(data, 200, origin);
}

// Ask Steam whether the login response it gave the browser is genuine.
async function verify(params, origin) {
  if (params.get('openid.mode') !== 'id_res') return json({ ok: false, error: 'mode' }, 400, origin);
  const claimed = params.get('openid.claimed_id') || '';
  const m = claimed.match(/^https:\/\/steamcommunity\.com\/openid\/id\/(\d{17})$/);
  if (!m) return json({ ok: false, error: 'claimed_id' }, 400, origin);
  const body = new URLSearchParams();
  for (const [k, v] of params) if (k.startsWith('openid.')) body.set(k, v);
  body.set('openid.mode', 'check_authentication');
  const r = await fetch(STEAM_OPENID, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const text = await r.text();
  const ok = /is_valid\s*:\s*true/.test(text);
  return json(ok ? { ok: true, steamid: m[1] } : { ok: false, error: 'invalid' }, ok ? 200 : 403, origin);
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });
    if (request.method !== 'GET') return json({ error: 'method' }, 405, origin);
    const url = new URL(request.url);
    try {
      if (url.pathname === '/profile') return await profile(url.searchParams.get('id') || '', origin, ctx);
      if (url.pathname === '/verify') return await verify(url.searchParams, origin);
      return json({ ok: true, service: 'upgrade-lab-steam', routes: ['/profile?id=', '/verify?openid.*'] }, 200, origin);
    } catch (e) {
      return json({ error: 'internal', detail: String(e && e.message || e) }, 500, origin);
    }
  },
};
