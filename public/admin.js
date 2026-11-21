// Linely admin console — same API as before, new layout.
const $ = (s, el = document) => el.querySelector(s), app = $('#app');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (n) => Number(n || 0).toLocaleString('en-US');
const ICON = {
  home: 'M12 3l9 8h-3v9h-5v-6h-2v6H6v-9H3z', key: 'M7 14a5 5 0 115-5h9v3h-2v2h-3v-2h-4a5 5 0 01-5 2zm0-7a2 2 0 100 4 2 2 0 000-4z',
  bell: 'M12 22a2.5 2.5 0 002.45-2h-4.9A2.5 2.5 0 0012 22zm7-6v-5a7 7 0 00-5.5-6.84V3.5a1.5 1.5 0 00-3 0v.66A7 7 0 005 11v5l-2 2v1h18v-1z',
  users: 'M16 11a3 3 0 100-6 3 3 0 000 6zM8 11a3 3 0 100-6 3 3 0 000 6zm0 2c-2.3 0-7 1.2-7 3.5V19h14v-2.5C15 14.2 10.3 13 8 13zm8 0c-.3 0-.6 0-1 .1 1.2.8 2 1.9 2 3.4V19h6v-2.5c0-2.3-4.7-3.5-7-3.5z',
  eye: 'M12 5C7 5 2.7 8.1 1 12.5 2.7 16.9 7 20 12 20s9.3-3.1 11-7.5C21.3 8.1 17 5 12 5zm0 12.5a5 5 0 110-10 5 5 0 010 10zm0-8a3 3 0 100 6 3 3 0 000-6z',
  bolt: 'M11 21l1-7H7l7-11-1 8h5z', coin: 'M12 2a10 10 0 100 20 10 10 0 000-20zm1 15.5V19h-2v-1.5c-1.5-.3-2.6-1.2-2.8-2.7h2c.2.6.8 1 1.8 1 1.1 0 1.7-.5 1.7-1.2 0-.8-.5-1.1-2-1.5-1.8-.5-3.2-1.1-3.2-2.8 0-1.3 1-2.3 2.5-2.6V5h2v1.5c1.4.3 2.4 1.2 2.6 2.6h-2c-.2-.6-.7-.9-1.5-.9-1 0-1.5.4-1.5 1 0 .7.6.9 1.9 1.3 2 .5 3.3 1.2 3.3 3 0 1.4-1 2.4-2.8 2.7z',
  gift: 'M20 6h-2.2c.1-.3.2-.6.2-1a3 3 0 00-3-3c-1.1 0-2 .5-2.5 1.4L12 4l-.5-.6A3 3 0 009 2a3 3 0 00-3 3c0 .4.1.7.2 1H4a2 2 0 00-2 2v11a2 2 0 002 2h16a2 2 0 002-2V8a2 2 0 00-2-2zm-5-1a1 1 0 110 2 1 1 0 010-2zM9 5a1 1 0 110 2 1 1 0 010-2z',
  img: 'M4 4h7v7H4V4zm9 0h7v7h-7V4zM4 13h7v7H4v-7zm9 0h7v7h-7v-7z',
  out: 'M17 7l-1.4 1.4L18.2 11H8v2h10.2l-2.6 2.6L17 17l5-5zM4 5h8V3H4a2 2 0 00-2 2v14a2 2 0 002 2h8v-2H4z',
};
const svg = (n) => `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="${ICON[n]}"/></svg>`;
const PROVIDERS = ['DeepSeek', 'Claude', '豆包', 'ChatGPT / OpenAI', '第三方中转站 / OpenAI兼容'];
const RELAY = '第三方中转站 / OpenAI兼容';

async function api(path, opts = {}) {
  const r = await fetch(path, { credentials: 'same-origin', headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) }, ...opts });
  let j = {}; try { j = await r.json(); } catch { /* empty */ }
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}
function toast(text, bad = false) {
  const t = document.createElement('div'); t.className = 'toast' + (bad ? ' bad' : ''); t.textContent = text; $('#toasts').append(t);
  setTimeout(() => t.remove(), 3200);
}
function confirmSheet(title, text, label, danger = true) {
  return new Promise((res) => {
    const el = document.createElement('div'); el.className = 'scrim';
    el.innerHTML = `<div class="sheet" role="dialog" aria-modal="true"><h3>${esc(title)}</h3><p>${esc(text)}</p><div class="actions"><button class="btn soft" data-r="0">取消</button><button class="btn ${danger ? 'danger' : ''}" data-r="1">${esc(label)}</button></div></div>`;
    el.onclick = (e) => { const b = e.target.closest('button'); if (b || e.target === el) { el.remove(); res(!!b && b.dataset.r === '1'); } };
    document.body.append(el);
  });
}
async function busy(btn, fn) { btn.disabled = true; try { await fn(); } catch (x) { toast(x.message, true); } finally { btn.disabled = false; } }

// ───────────── login ─────────────
function loginView(message = '') {
  app.innerHTML = `<div class="login-wrap"><section class="login glass"><span class="logo" aria-hidden="true">L</span><h1>Linely 管理后台</h1><p>使用部署时设置的管理员密码登录</p><form id="login"><input id="password" type="password" autocomplete="current-password" placeholder="管理员密码" required><button class="btn">登录</button></form><p class="error" id="err">${esc(message)}</p></section></div>`;
  $('#login').onsubmit = async (e) => {
    e.preventDefault();
    try { await api('/api/admin/login', { method: 'POST', body: JSON.stringify({ password: $('#password').value }) }); await boot(); }
    catch (x) { $('#err').textContent = x.message; }
  };
}

// ───────────── dashboard ─────────────
const S = { tab: 'overview', m: null, c: null, users: null, q: '' };
const TABS = [['overview', '概览', 'home'], ['api', '免费 API', 'key'], ['notice', '公告', 'bell'], ['users', '用户', 'users'], ['gallery', '角色图鉴', 'img']];

async function boot() {
  app.innerHTML = '<div class="shell"><div class="skeleton" style="grid-column:1/-1"></div></div>';
  [S.m, S.c] = await Promise.all([api('/api/admin/metrics'), api('/api/admin/config')]);
  S.users = null; shell();
}
function shell() {
  app.innerHTML = `<div class="shell"><aside class="side glass"><div class="brand"><span class="logo" aria-hidden="true">L</span><div><b>Linely</b><small>管理后台</small></div></div>${TABS.map(([id, label, ic]) => `<button class="nav ${S.tab === id ? 'on' : ''}" data-tab="${id}">${svg(ic)}<span class="lbl">${label}</span>${id === 'users' && S.users ? `<span class="count">${S.users.length}</span>` : ''}</button>`).join('')}<div class="grow"></div><button class="nav out" id="logout">${svg('out')}<span class="lbl">退出登录</span></button></aside><main class="main" id="main"></main></div>`;
  app.querySelectorAll('[data-tab]').forEach((b) => (b.onclick = () => { S.tab = b.dataset.tab; shell(); window.scrollTo({ top: 0 }); }));
  $('#logout').onclick = async () => { try { await api('/api/admin/logout', { method: 'POST', body: '{}' }); } catch { /* ignore */ } loginView(); };
  ({ overview, api: freeApi, notice, users, gallery })[S.tab]();
}
const head = (t, p) => `<div class="page-head"><div><h1>${t}</h1><p>${p}</p></div></div>`;

function overview() {
  const m = S.m;
  const metric = (label, v, ic, color) => `<article class="metric glass"><div class="ic" style="background:${color}">${svg(ic)}</div><span>${label}</span><strong>${num(v)}</strong></article>`;
  const days = Object.entries(m.byDay || {}).sort((a, b) => a[0].localeCompare(b[0])).slice(-14);
  const maxV = Math.max(1, ...days.map(([, v]) => v.visits || 0)), maxA = Math.max(1, ...days.map(([, v]) => v.apiRequests || 0));
  const chart = days.length ? `<div class="chart">${days.map(([d, v]) => `<div class="bar" data-tip="${esc(d)} · 访问 ${v.visits || 0}"><i style="height:${Math.max(3, (v.visits || 0) / maxV * 100)}%"></i><small>${esc(d.slice(5))}</small></div>`).join('')}</div><div class="legend"><span><b style="background:var(--accent)"></b>每日访问</span></div><div class="chart" style="height:120px;margin-top:16px">${days.map(([d, v]) => `<div class="bar alt" data-tip="${esc(d)} · API ${v.apiRequests || 0}"><i style="height:${Math.max(3, (v.apiRequests || 0) / maxA * 100)}%"></i></div>`).join('')}</div><div class="legend"><span><b style="background:#7b61ff"></b>每日 API 调用</span></div>` : '<div class="empty">暂无数据，有访客后这里会出现趋势图</div>';
  const rows = Object.entries(m.byDay || {}).sort((a, b) => b[0].localeCompare(a[0])).slice(0, 30);
  $('#main').innerHTML = `${head('概览', '服务端统计，每次打开后台时刷新')}
  <section class="grid4">${metric('网站访问', m.visits, 'eye', 'linear-gradient(135deg,#5eb0ff,#0a84ff)')}${metric('API 调用', m.apiRequests, 'bolt', 'linear-gradient(135deg,#b9a2ff,#7b61ff)')}${metric('Token 总消耗', m.totalTokens, 'coin', 'linear-gradient(135deg,#ffb35e,#f08a1b)')}${metric('免费 API 调用', m.freeApiRequests, 'gift', 'linear-gradient(135deg,#59d6a0,#16a06a)')}</section>
  <section class="card glass"><h2>近 14 天趋势</h2><p class="sub">按日统计的页面加载和 AI 请求次数</p>${chart}</section>
  <div class="two"><section class="card glass"><h2>用量明细</h2><p class="sub">Token 以服务商返回的 usage 为准</p><div class="list">${[['用户自带 API', m.userApiRequests, '次'], ['免费 API', m.freeApiRequests, '次'], ['输入 Token', m.inputTokens, ''], ['输出 Token', m.outputTokens, '']].map(([k, v, u]) => `<div class="item"><div class="who"><b>${k}</b></div><b>${num(v)} ${u}</b></div>`).join('')}</div></section>
  <section class="card glass"><h2>每日统计</h2><p class="sub">最近 30 天</p>${rows.length ? `<div class="day head"><span>日期</span><span>访问</span><span>API</span><span>Token</span></div>${rows.map(([d, v]) => `<div class="day"><span>${esc(d)}</span><span>${num(v.visits)}</span><span>${num(v.apiRequests)}</span><span>${num(v.totalTokens)}</span></div>`).join('')}` : '<div class="empty">暂无数据</div>'}</section></div>
  <div class="notice">访问次数按页面加载请求计数，不等于独立访客人数。用户启用「浏览器直连」时，请求不经过本站服务器，无法被统计。未返回 usage 的服务商不会被推算 Token。</div>`;
}

function freeApi() {
  const f = S.c.freeApi;
  $('#main').innerHTML = `${head('免费 API', '让所有用户无需自备密钥也能聊天')}
  <section class="card glass"><form id="free">
   <div class="field"><span>状态</span><div class="seg" id="enabledSeg"><button type="button" data-v="true">启用</button><button type="button" data-v="false">停用</button></div></div>
   <div class="two"><label class="field"><span>服务商</span><select id="provider">${PROVIDERS.map((x) => `<option>${esc(x)}</option>`).join('')}</select></label>
   <label class="field"><span>模型名称</span><input id="model" maxlength="160"></label></div>
   <label class="field" id="baseField"><span>第三方 API Base URL</span><input id="baseUrl" type="url" placeholder="https://你的中转站/v1" maxlength="500"><small>仅「第三方中转站」需要，必须是 HTTPS 的 OpenAI 兼容地址。</small></label>
   <label class="field"><span>API Key</span><input id="key" type="password" autocomplete="new-password" placeholder="${esc(f.keyHint)}"><small>${esc(f.keyHint)} · 留空则保持原密钥。密钥只保存在服务端，不会返回浏览器，也不会进入用户备份。</small></label>
   <div class="actions"><button class="btn">保存配置</button><button class="btn danger" type="button" id="clear">清除密钥</button></div></form></section>`;
  let enabled = !!f.enabled;
  const seg = () => $('#enabledSeg').querySelectorAll('button').forEach((b) => b.classList.toggle('on', (b.dataset.v === 'true') === enabled));
  $('#enabledSeg').onclick = (e) => { const b = e.target.closest('button'); if (b) { enabled = b.dataset.v === 'true'; seg(); } }; seg();
  $('#provider').value = f.provider; $('#model').value = f.model || ''; $('#baseUrl').value = f.baseUrl || '';
  $('#provider').onchange = () => { $('#baseField').style.display = $('#provider').value === RELAY ? 'grid' : 'none'; }; $('#provider').onchange();
  $('#free').onsubmit = (e) => { e.preventDefault(); busy($('#free .btn'), async () => {
    S.c = await api('/api/admin/config', { method: 'POST', body: JSON.stringify({ freeApi: { enabled, provider: $('#provider').value, baseUrl: $('#baseUrl').value, model: $('#model').value, apiKey: $('#key').value } }) });
    toast('免费 API 配置已保存'); freeApi(); }); };
  $('#clear').onclick = async () => { if (await confirmSheet('清除免费 API 密钥？', '清除后免费 API 会立即停用，用户将无法使用。', '清除密钥')) busy($('#clear'), async () => { S.c = await api('/api/admin/config', { method: 'POST', body: JSON.stringify({ freeApi: { clearKey: true, enabled: false } }) }); toast('密钥已清除'); freeApi(); }); };
}

function notice() {
  const a = S.c.announcement || {};
  $('#main').innerHTML = `${head('网站公告', '用户打开网页时顶部会显示公告条')}
  <section class="card glass"><form id="ann"><div class="field"><span>状态</span><div class="seg" id="annSeg"><button type="button" data-v="true">发布</button><button type="button" data-v="false">关闭</button></div></div>
   <label class="field"><span>标题</span><input id="title" maxlength="100" placeholder="例如：系统维护通知"></label>
   <label class="field"><span>内容</span><textarea id="body" maxlength="2000" placeholder="公告正文…"></textarea></label>
   <div class="actions"><button class="btn">保存并发布</button></div></form></section>`;
  let on = !!a.enabled;
  const seg = () => $('#annSeg').querySelectorAll('button').forEach((b) => b.classList.toggle('on', (b.dataset.v === 'true') === on));
  $('#annSeg').onclick = (e) => { const b = e.target.closest('button'); if (b) { on = b.dataset.v === 'true'; seg(); } }; seg();
  $('#title').value = a.title || ''; $('#body').value = a.body || '';
  $('#ann').onsubmit = (e) => { e.preventDefault(); busy($('#ann .btn'), async () => { const r = await api('/api/admin/announcement', { method: 'POST', body: JSON.stringify({ enabled: on, title: $('#title').value, body: $('#body').value }) }); S.c.announcement = r.announcement; toast(on ? '公告已发布' : '公告已保存（未发布）'); }); };
}

async function users() {
  $('#main').innerHTML = `${head('用户管理', '查看注册用户，封禁后会立即下线')}<section class="card glass"><div class="tools"><input id="q" type="search" placeholder="搜索用户名" value="${esc(S.q)}"></div><div id="ulist"><div class="skeleton"></div></div></section>`;
  try { S.users = (await api('/api/admin/users')).users || []; } catch (x) { $('#ulist').innerHTML = `<div class="empty">${esc(x.message)}</div>`; return; }
  const cnt = document.querySelector('.nav[data-tab="users"]'); if (cnt && !cnt.querySelector('.count')) cnt.insertAdjacentHTML('beforeend', `<span class="count">${S.users.length}</span>`);
  const draw = () => {
    const q = S.q.trim().toLowerCase(), list = S.users.filter((u) => !q || u.username.toLowerCase().includes(q));
    $('#ulist').innerHTML = list.length ? `<div class="list">${list.map((u) => `<div class="item"><div class="av">${esc(u.username.slice(0, 1).toUpperCase())}</div><div class="who"><b>${esc(u.username)}</b><small>注册于 ${u.createdAt ? new Date(u.createdAt).toLocaleDateString('zh-CN') : '—'}</small></div><span class="pill ${u.banned ? 'bad' : 'ok'}">${u.banned ? '已封禁' : '正常'}</span><button class="btn small ${u.banned ? 'soft' : 'danger'}" data-id="${esc(u.id)}" data-ban="${!u.banned}" data-name="${esc(u.username)}">${u.banned ? '解封' : '封禁'}</button></div>`).join('')}</div>` : `<div class="empty">${S.users.length ? '没有匹配的用户' : '暂无注册用户'}</div>`;
    $('#ulist').querySelectorAll('button[data-id]').forEach((b) => (b.onclick = async () => {
      const ban = b.dataset.ban === 'true';
      if (ban && !(await confirmSheet(`封禁 ${b.dataset.name}？`, '该用户会被立即登出，且无法再次登录，直到你解封。', '封禁'))) return;
      busy(b, async () => { await api('/api/admin/users/' + b.dataset.id, { method: 'POST', body: JSON.stringify({ banned: ban }) }); const u = S.users.find((x) => x.id === b.dataset.id); if (u) u.banned = ban; toast(ban ? '已封禁' : '已解封'); draw(); });
    }));
  };
  $('#q').oninput = () => { S.q = $('#q').value; draw(); }; draw();
}

async function gallery() {
  $('#main').innerHTML = `${head('角色图鉴', '审核用户发布的角色和头像，可随时删除不合适的内容')}<div id="glist"><div class="skeleton"></div></div>`;
  let chars; try { chars = (await api('/api/admin/gallery')).characters || []; } catch (x) { $('#glist').innerHTML = `<section class="card glass"><div class="empty">${esc(x.message)}</div></section>`; return; }
  if (!chars.length) { $('#glist').innerHTML = '<section class="card glass"><div class="empty">还没有用户发布角色</div></section>'; return; }
  $('#glist').innerHTML = chars.map((c) => `<section class="card glass" style="margin-bottom:14px"><div class="item" style="padding-top:0"><div class="who"><b>${esc(c.name)}</b><small>发布者 ${esc(c.author)} · ${c.avatars.length} 张头像 · ${new Date(c.createdAt).toLocaleDateString('zh-CN')}</small></div><button class="btn small danger" data-c="${esc(c.id)}" data-name="${esc(c.name)}">删除角色</button></div><div class="thumbs">${c.avatars.map((a) => `<figure><img src="${esc(a.image)}" alt=""><figcaption>${esc(a.author)}</figcaption><button class="x" data-c="${esc(c.id)}" data-a="${esc(a.id)}" aria-label="删除头像">×</button></figure>`).join('')}</div></section>`).join('');
  $('#glist').querySelectorAll('button[data-c]').forEach((b) => (b.onclick = async () => {
    const av = b.dataset.a;
    if (!(await confirmSheet(av ? '删除这张头像？' : `删除角色「${b.dataset.name}」？`, av ? '头像会立即从图鉴中移除。' : '角色和所有人为它投稿的头像都会被删除。', '删除'))) return;
    busy(b, async () => { await api(`/api/admin/gallery/${b.dataset.c}${av ? '/avatars/' + av : ''}/delete`, { method: 'POST', body: '{}' }); toast('已删除'); gallery(); });
  }));
}

(async function start() {
  try { const s = await api('/api/admin/me'); if (s.authenticated) await boot(); else loginView(s.configured ? '' : '服务器尚未设置 LINELY_ADMIN_PASSWORD，请先配置环境变量。'); }
  catch (e) { loginView(e.message); }
})();
