'use strict';
/** Linely server: static app, AI proxy, protected admin API, aggregate analytics. */
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
/** LINELY_* env vars; the old DEEPLINE_* names still work so existing deployments keep running */
const env = (n) => process.env['LINELY_' + n] ?? process.env['DEEPLINE_' + n];
const DATA_DIR = env('DATA_DIR') || path.join(__dirname, 'data');
const MAX_BODY = 16 * 1024 * 1024;
const RATE_PER_MIN = Number(process.env.RATE_LIMIT_PER_MIN) || 90;
const ADMIN_PASSWORD = env('ADMIN_PASSWORD') || '';
const PROVIDERS = {
  'DeepSeek': 'https://api.deepseek.com/chat/completions',
  'Claude': 'https://api.anthropic.com/v1/messages',
  '豆包': 'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
  'ChatGPT / OpenAI': 'https://api.openai.com/v1/chat/completions',
};
const MIME = { '.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.webmanifest':'application/manifest+json','.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml','.wav':'audio/wav','.ico':'image/x-icon','.txt':'text/plain; charset=utf-8' };
const COMPRESSIBLE = new Set(['.html','.js','.css','.json','.webmanifest','.svg','.txt']);
fs.mkdirSync(DATA_DIR, { recursive: true });
const CONFIG_FILE = path.join(DATA_DIR, 'admin-config.json');
const METRICS_FILE = path.join(DATA_DIR, 'metrics.json');
const PLAZA_FILE = path.join(DATA_DIR, 'persona-plaza.json');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const THEMES_FILE = path.join(DATA_DIR, 'themes.json');
const GALLERY_FILE = path.join(DATA_DIR, 'gallery.json');
function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function writeJson(file, value) { const tmp=file+'.tmp'; fs.writeFileSync(tmp, JSON.stringify(value,null,2), {mode:0o600}); fs.renameSync(tmp,file); try { fs.chmodSync(file,0o600); } catch {} }
let config = readJson(CONFIG_FILE, { freeApi: { enabled: !!env('FREE_API_KEY'), provider: env('FREE_API_PROVIDER') || 'DeepSeek', model: env('FREE_API_MODEL') || 'deepseek-chat', apiKey: env('FREE_API_KEY') || '' }, announcement: { enabled:false, title:'', body:'', updatedAt:0 } });
config.freeApi ||= { enabled:false, provider:'DeepSeek', model:'deepseek-chat', apiKey:'', baseUrl:'' };
config.freeApi.baseUrl ||= env('FREE_API_BASE_URL') || '';
config.announcement ||= { enabled:false, title:'', body:'', updatedAt:0 };
let plaza = readJson(PLAZA_FILE, []);
if (!Array.isArray(plaza)) plaza = [];
let metrics = readJson(METRICS_FILE, { visits:0, apiRequests:0, freeApiRequests:0, userApiRequests:0, inputTokens:0, outputTokens:0, totalTokens:0, byDay:{} });
const sessions = new Map();
const userSessions = new Map();
let users = readJson(USERS_FILE, []); if (!Array.isArray(users)) users = [];
let themes = readJson(THEMES_FILE, []); if (!Array.isArray(themes)) themes = [];
let gallery = readJson(GALLERY_FILE, []); if (!Array.isArray(gallery)) gallery = [];

// ───────────── meme search (AI sends Chinese meme images) ─────────────
const dnsP = require('dns').promises, net = require('net');
const MEME_ON = env('MEME_SEARCH') !== '0';
const MEME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const memeCache = new Map();
function isPrivateIp(ip){
  if(net.isIPv4(ip)){const p=ip.split('.').map(Number);return p[0]===10||p[0]===127||p[0]===0||(p[0]===169&&p[1]===254)||(p[0]===172&&p[1]>=16&&p[1]<=31)||(p[0]===192&&p[1]===168)||(p[0]===100&&p[1]>=64&&p[1]<=127)||p[0]>=224;}
  const x=String(ip).toLowerCase(); if(x==='::1'||x==='::')return true; if(x.startsWith('::ffff:'))return isPrivateIp(x.slice(7)); return /^(fc|fd|fe[89ab])/.test(x);
}
async function safeUrl(u){
  let url; try{url=new URL(u);}catch{return null;}
  if(!/^https?:$/.test(url.protocol)||url.username||url.password)return null;
  if(url.port&&!['80','443'].includes(url.port))return null;
  const host=url.hostname.replace(/^\[|\]$/g,'');
  const addrs=net.isIP(host)?[{address:host}]:await dnsP.lookup(host,{all:true}).catch(()=>[]);
  if(!addrs.length||addrs.some(a=>isPrivateIp(a.address)))return null;
  return url;
}
/** GET with a size cap, timeout and manual redirects that are re-checked against private addresses. */
async function fetchLimited(u,{max=3*1024*1024,accept='image/*',timeout=8000,headers={}}={}){
  let url=await safeUrl(u);
  for(let i=0;i<4&&url;i++){
    const ac=new AbortController(), t=setTimeout(()=>ac.abort(),timeout);
    try{
      const r=await fetch(url,{redirect:'manual',signal:ac.signal,headers:{'User-Agent':MEME_UA,'Accept':accept,...headers}});
      if(r.status>=300&&r.status<400&&r.headers.get('location')){url=await safeUrl(new URL(r.headers.get('location'),url).href);continue;}
      if(!r.ok)return null;
      if(Number(r.headers.get('content-length')||0)>max)return null;
      const chunks=[];let size=0;
      for await(const c of r.body){size+=c.length;if(size>max){ac.abort();return null;}chunks.push(c);}
      return {type:(r.headers.get('content-type')||'').split(';')[0].trim().toLowerCase(),buf:Buffer.concat(chunks)};
    }catch{return null;}finally{clearTimeout(t);}
  }
  return null;
}
const unent=s=>s.replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
async function bingImages(q,gif){
  const u='https://cn.bing.com/images/async?q='+encodeURIComponent(q)+'&first=0&count=35&mmasync=1'+(gif?'&qft='+encodeURIComponent('+filterui:photo-animatedgif'):'');
  const r=await fetchLimited(u,{accept:'text/html',max:2*1024*1024,headers:{'Accept-Language':'zh-CN,zh;q=0.9','Cookie':'SRCHHPGUSR=ADLT=STRICT'}});
  if(!r)return [];
  const html=r.buf.toString('utf8'),out=[];
  for(const m of html.matchAll(/\sm="([^"]+)"/g)){
    try{const j=JSON.parse(unent(m[1]));if(j.murl&&/^https?:\/\//.test(j.murl)&&!/\.svg(\?|$)/i.test(j.murl))out.push({url:j.murl,thumb:j.turl||j.murl,title:String(j.t||'').replace(/<[^>]+>/g,'').slice(0,80)});}catch{}
  }
  return out;
}
async function sogouImages(q){
  const r=await fetchLimited('https://pic.sogou.com/napi/pc/searchList?mode=1&start=0&xml_len=40&query='+encodeURIComponent(q),{accept:'application/json',max:1024*1024,headers:{'Referer':'https://pic.sogou.com/'}});
  if(!r)return [];
  try{const j=JSON.parse(r.buf.toString('utf8'));return ((j.data&&j.data.items)||[]).map(it=>({url:it.picUrl||it.ori_pic_url||it.thumbUrl||'',thumb:it.thumbUrl||it.picUrl||'',title:String(it.title||'').replace(/<[^>]+>/g,'').slice(0,80)})).filter(x=>/^https?:\/\//.test(x.url));}catch{return [];}
}

// ───────────── neural text-to-speech (the free "Read Aloud" voices used by Microsoft Edge) ─────────────
// Natural-sounding Chinese/English/Japanese/Korean voices. Generated on the server so the browser only plays an mp3.
// Set LINELY_TTS=0 to turn it off; the app then falls back to the device's own voices.
const TTS_ON = env('TTS') !== '0';
const TTS_WSS = env('TTS_WSS_URL') || 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1';
const TTS_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4', TTS_CHROME = '130.0.2849.68';
const TTS_VOICES = [
  { id: 'zh-CN-XiaoxiaoNeural', name: '晓晓', lang: 'zh-CN', gender: 'female', desc: '温暖亲切，最自然', styles: true },
  { id: 'zh-CN-XiaoyiNeural', name: '晓伊', lang: 'zh-CN', gender: 'female', desc: '活泼可爱的少女', styles: true },
  { id: 'zh-CN-YunxiNeural', name: '云希', lang: 'zh-CN', gender: 'male', desc: '阳光少年感', styles: true },
  { id: 'zh-CN-YunjianNeural', name: '云健', lang: 'zh-CN', gender: 'male', desc: '沉稳有磁性', styles: true },
  { id: 'zh-CN-YunyangNeural', name: '云扬', lang: 'zh-CN', gender: 'male', desc: '专业播音腔', styles: true },
  { id: 'zh-CN-YunxiaNeural', name: '云夏', lang: 'zh-CN', gender: 'male', desc: '可爱的小男孩', styles: false },
  { id: 'zh-CN-liaoning-XiaobeiNeural', name: '晓北', lang: 'zh-CN', gender: 'female', desc: '东北话', styles: false },
  { id: 'zh-CN-shaanxi-XiaoniNeural', name: '晓妮', lang: 'zh-CN', gender: 'female', desc: '陕西话', styles: false },
  { id: 'zh-TW-HsiaoChenNeural', name: '曉臻', lang: 'zh-TW', gender: 'female', desc: '台湾女声', styles: false },
  { id: 'zh-TW-YunJheNeural', name: '雲哲', lang: 'zh-TW', gender: 'male', desc: '台湾男声', styles: false },
  { id: 'zh-HK-HiuGaaiNeural', name: '曉佳', lang: 'zh-HK', gender: 'female', desc: '粤语女声', styles: false },
  { id: 'zh-HK-WanLungNeural', name: '雲龍', lang: 'zh-HK', gender: 'male', desc: '粤语男声', styles: false },
  { id: 'ja-JP-NanamiNeural', name: '七海', lang: 'ja-JP', gender: 'female', desc: '日语女声', styles: false },
  { id: 'ja-JP-KeitaNeural', name: '圭太', lang: 'ja-JP', gender: 'male', desc: '日语男声', styles: false },
  { id: 'en-US-AriaNeural', name: 'Aria', lang: 'en-US', gender: 'female', desc: 'English · warm', styles: true },
  { id: 'en-US-JennyNeural', name: 'Jenny', lang: 'en-US', gender: 'female', desc: 'English · friendly', styles: true },
  { id: 'en-US-GuyNeural', name: 'Guy', lang: 'en-US', gender: 'male', desc: 'English · calm', styles: true },
  { id: 'ko-KR-SunHiNeural', name: '선히', lang: 'ko-KR', gender: 'female', desc: '한국어 여성', styles: false },
  { id: 'ko-KR-InJoonNeural', name: '인준', lang: 'ko-KR', gender: 'male', desc: '한국어 남성', styles: false },
];
const TTS_STYLES = new Set(['gentle', 'cheerful', 'affectionate', 'calm', 'newscast', 'sad', 'angry', 'friendly', 'chat']);
const ttsCache = new Map();
function ttsGec(){ let t=Math.floor(Date.now()/1000)+11644473600; t-=t%300; return crypto.createHash('sha256').update((BigInt(t)*10000000n).toString()+TTS_TOKEN).digest('hex').toUpperCase(); }
const xmlEsc=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
const ttsStamp=()=>{const d=new Date(),p=n=>String(n).padStart(2,'0');return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getUTCDay()]+' '+['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getUTCMonth()]+' '+p(d.getUTCDate())+' '+d.getUTCFullYear()+' '+p(d.getUTCHours())+':'+p(d.getUTCMinutes())+':'+p(d.getUTCSeconds())+' GMT+0000 (Coordinated Universal Time)';};
const sgn=n=>(n>=0?'+':'')+n;
function ttsSsml(o){
  const lang=o.voice.split('-').slice(0,2).join('-');
  const pros=`<prosody pitch='${sgn(o.pitch)}Hz' rate='${sgn(o.rate)}%' volume='${sgn(o.volume)}%'>${xmlEsc(o.text)}</prosody>`;
  return `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xmlns:mstts='https://www.w3.org/2001/mstts' xml:lang='${lang}'><voice name='${o.voice}'>${o.style?`<mstts:express-as style='${o.style}'>${pros}</mstts:express-as>`:pros}</voice></speak>`;
}
function ttsOnce(o){
  return new Promise((resolve,reject)=>{
    const id=crypto.randomUUID().replace(/-/g,'');
    const url=`${TTS_WSS}?TrustedClientToken=${TTS_TOKEN}&ConnectionId=${id}&Sec-MS-GEC=${ttsGec()}&Sec-MS-GEC-Version=1-${TTS_CHROME}`;
    let ws; try{ws=new WebSocket(url,{headers:{'Pragma':'no-cache','Cache-Control':'no-cache','Origin':'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold','User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0','Accept-Language':'en-US,en;q=0.9'}});}catch(e){return reject(e);}
    ws.binaryType='arraybuffer'; const chunks=[]; let done=false;
    const finish=err=>{if(done)return;done=true;clearTimeout(timer);try{ws.close();}catch{}err?reject(err):(chunks.length?resolve(Buffer.concat(chunks)):reject(new Error('no audio')));};
    const timer=setTimeout(()=>finish(new Error('timeout')),15000);
    ws.onopen=()=>{
      ws.send(`X-Timestamp:${ttsStamp()}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}\r\n`);
      ws.send(`X-RequestId:${id}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${ttsStamp()}Z\r\nPath:ssml\r\n\r\n${ttsSsml(o)}`);
    };
    ws.onmessage=ev=>{
      if(typeof ev.data==='string'){if(ev.data.includes('Path:turn.end'))finish();return;}
      const buf=Buffer.from(ev.data); if(buf.length<2)return; const hl=buf.readUInt16BE(0);
      if(buf.subarray(2,2+hl).toString('utf8').includes('Path:audio'))chunks.push(buf.subarray(2+hl));
    };
    ws.onerror=()=>finish(new Error('ws error')); ws.onclose=()=>finish(chunks.length?undefined:new Error('closed'));
  });
}
async function ttsSynth(o){
  const key=crypto.createHash('sha1').update(JSON.stringify(o)).digest('hex'), hit=ttsCache.get(key); if(hit)return hit;
  let audio;
  try{audio=await ttsOnce(o);}catch(e){ if(o.style){try{audio=await ttsOnce({...o,style:''});}catch{throw e;}} else {try{audio=await ttsOnce(o);}catch{throw e;}} }
  ttsCache.set(key,audio); if(ttsCache.size>150)ttsCache.delete(ttsCache.keys().next().value);
  return audio;
}
const clampInt=(v,lo,hi,d)=>{v=Math.round(Number(v));return Number.isFinite(v)?Math.min(hi,Math.max(lo,v)):d;};
function saveGallery(){ writeJson(GALLERY_FILE, gallery); }
function galleryImage(v){ return typeof v==='string' && /^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(v) && v.length<200000; }

function saveUsers(){ writeJson(USERS_FILE, users); }
function userSession(req){ const token=cookies(req).dl_user; const rec=token&&userSessions.get(token); if(!rec)return null; if(Date.now()>rec.expires){userSessions.delete(token);return null;} const u=users.find(x=>x.id===rec.id); return u&&!u.banned?u:null; }
function requireUser(req,res){ if(!userSession(req)){sendJson(res,401,{error:'请先登录',loginRequired:true});return false;} return true; }
function setUserCookie(res,token){res.setHeader('Set-Cookie',`dl_user=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${process.env.NODE_ENV==='production'?'; Secure':''}`);}
const hits = new Map();
function persistMetrics(){ try { writeJson(METRICS_FILE,metrics); } catch(e){ console.error('metrics save failed',e.message); } }
function dayKey(){ return new Date().toISOString().slice(0,10); }
function bump(key,n=1){ metrics[key]=(metrics[key]||0)+n; const d=dayKey(); metrics.byDay[d] ||= {visits:0,apiRequests:0,freeApiRequests:0,userApiRequests:0,inputTokens:0,outputTokens:0,totalTokens:0}; metrics.byDay[d][key]=(metrics.byDay[d][key]||0)+n; }
function securityHeaders(res){ res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Content-Security-Policy',["default-src 'self'","script-src 'self'","style-src 'self' 'unsafe-inline'","img-src 'self' data: blob:","media-src 'self' data: blob:","font-src 'self' data:","connect-src 'self' https://api.deepseek.com https://api.anthropic.com https://ark.cn-beijing.volces.com https://api.openai.com","frame-src 'none'","frame-ancestors 'none'","base-uri 'none'","form-action 'self'"].join('; '));res.setHeader('Permissions-Policy','microphone=(self), camera=(self)'); }
function sendJson(res,status,obj){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(obj));}
function readBody(req){return new Promise((resolve,reject)=>{let size=0,failed=false;const chunks=[];req.on('data',c=>{if(failed)return;size+=c.length;if(size>MAX_BODY){failed=true;chunks.length=0;reject(Object.assign(new Error('请求体过大'),{status:413}));return;}chunks.push(c);});req.on('end',()=>{if(!failed)resolve(Buffer.concat(chunks).toString('utf8'));});req.on('error',e=>{if(!failed)reject(e);});});}
function clientIp(req){return String(req.headers['x-forwarded-for']||req.socket.remoteAddress||'').split(',')[0].trim();}
function limited(ip,limit=RATE_PER_MIN){const now=Date.now(),a=(hits.get(ip)||[]).filter(t=>now-t<60000);a.push(now);hits.set(ip,a);return a.length>limit;}
function cookies(req){return Object.fromEntries(String(req.headers.cookie||'').split(';').map(x=>x.trim().split('=').map(decodeURIComponent)).filter(x=>x.length===2));}
function adminSession(req){const token=cookies(req).dl_admin;if(!token||!sessions.has(token))return false;const expires=sessions.get(token);if(Date.now()>expires){sessions.delete(token);return false;}return true;}
function requireAdmin(req,res){if(!adminSession(req)){sendJson(res,401,{error:'请先登录管理员账号'});return false;}return true;}
function publicConfig(){return {enabled:!!(config.freeApi.enabled&&config.freeApi.apiKey),provider:config.freeApi.provider,model:config.freeApi.model};}
function adminConfig(){return {freeApi:{enabled:!!config.freeApi.enabled,provider:config.freeApi.provider,model:config.freeApi.model,baseUrl:config.freeApi.baseUrl||'',hasKey:!!config.freeApi.apiKey,keyHint:config.freeApi.apiKey?'已配置（不会显示密钥）':'未配置'},announcement:config.announcement};}
async function handleAi(req,res){
 if(limited(clientIp(req)))return sendJson(res,429,{error:{message:'请求太频繁，请稍后再试。'}});
 let p;try{p=JSON.parse(await readBody(req));}catch(e){return sendJson(res,e.status||400,{error:{message:e.status===413?'请求体过大':'请求格式错误'}});}
 const useFree=!!p.useFreeApi; let provider=p.provider, body=p.body, headers={};
 if(useFree){if(!config.freeApi.enabled||!config.freeApi.apiKey)return sendJson(res,503,{error:{message:'管理员尚未配置可用的免费 API'}});provider=config.freeApi.provider;body={...body,model:config.freeApi.model};if(provider==='第三方中转站 / OpenAI兼容')p.baseUrl=config.freeApi.baseUrl;headers=provider==='Claude'?{'x-api-key':config.freeApi.apiKey,'anthropic-version':'2023-06-01'}:{Authorization:'Bearer '+config.freeApi.apiKey};}
 else {for(const [k,v] of Object.entries(p.headers||{})){if(['authorization','x-api-key','anthropic-version'].includes(k.toLowerCase())&&typeof v==='string')headers[k.toLowerCase()]=v;}}
 let url=PROVIDERS[provider]; const custom=provider==='第三方中转站 / OpenAI兼容'; if(custom){ try{const u=new URL(String(p.baseUrl||''));if(u.protocol!=='https:'||!u.hostname||u.username||u.password||/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)/i.test(u.hostname))throw new Error();url=u.toString().replace(/\/$/,'');if(!url.endsWith('/chat/completions'))url+='/chat/completions';}catch{return sendJson(res,400,{error:{message:'中转站地址必须是有效的 HTTPS OpenAI 兼容接口地址'}});} } if(!url)return sendJson(res,400,{error:{message:'不支持的 AI 服务商'}});if(!body||typeof body!=='object')return sendJson(res,400,{error:{message:'缺少请求内容'}});
 if(!useFree&&!headers.authorization&&!headers['x-api-key'])return sendJson(res,400,{error:{message:'缺少 API Key'}});
 const outHeaders={'Content-Type':'application/json',...headers};
 try{const upstream=await fetch(url,{method:'POST',headers:outHeaders,body:JSON.stringify(body),signal:AbortSignal.timeout(120000)});const raw=await upstream.text();let json={};try{json=JSON.parse(raw);}catch{}
  bump('apiRequests');bump(useFree?'freeApiRequests':'userApiRequests');
  const usage=json.usage||{},input=Number(usage.input_tokens??usage.prompt_tokens??0)||0,output=Number(usage.output_tokens??usage.completion_tokens??0)||0,total=Number(usage.total_tokens??(input+output))||0;
  bump('inputTokens',input);bump('outputTokens',output);bump('totalTokens',total);persistMetrics();
  res.writeHead(upstream.status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(raw);
 }catch(e){bump('apiRequests');bump(useFree?'freeApiRequests':'userApiRequests');persistMetrics();sendJson(res,502,{error:{message:'服务器无法连接 AI 服务商：'+(e&&e.name==='TimeoutError'?'超时':(e&&e.message)||'未知错误')}});}
}
async function authApi(req,res,pathname){
 if(pathname==='/api/auth/me'&&req.method==='GET'){const u=userSession(req);return sendJson(res,200,{authenticated:!!u,user:u?{id:u.id,username:u.username}:null});}
 if(pathname==='/api/auth/register'&&req.method==='POST'){
  let b;try{b=JSON.parse(await readBody(req));}catch{return sendJson(res,400,{error:'请求格式错误'});}
  const username=String(b.username||'').trim(),password=String(b.password||'');
  if(!/^[a-zA-Z0-9_\u4e00-\u9fa5]{3,24}$/.test(username))return sendJson(res,400,{error:'用户名需为 3-24 位字母、数字、下划线或中文'});
  if(password.length<8||password.length>128)return sendJson(res,400,{error:'密码长度必须为 8-128 位'});
  if(users.some(x=>x.username.toLowerCase()===username.toLowerCase()))return sendJson(res,409,{error:'用户名已存在'});
  const salt=crypto.randomBytes(16).toString('hex'),hash=crypto.scryptSync(password,salt,64).toString('hex');
  const u={id:crypto.randomUUID(),username,salt,hash,banned:false,createdAt:Date.now()};users.push(u);saveUsers();const token=crypto.randomBytes(32).toString('hex');userSessions.set(token,{id:u.id,expires:Date.now()+30*86400000});setUserCookie(res,token);return sendJson(res,201,{ok:true,user:{id:u.id,username:u.username}});
 }
 if(pathname==='/api/auth/login'&&req.method==='POST'){
  let b;try{b=JSON.parse(await readBody(req));}catch{return sendJson(res,400,{error:'请求格式错误'});}
  const u=users.find(x=>x.username.toLowerCase()===String(b.username||'').trim().toLowerCase());if(!u)return sendJson(res,401,{error:'用户名或密码错误'});if(u.banned)return sendJson(res,403,{error:'账号已被管理员封禁'});
  const hash=crypto.scryptSync(String(b.password||''),u.salt,64);const expected=Buffer.from(u.hash,'hex');if(hash.length!==expected.length||!crypto.timingSafeEqual(hash,expected))return sendJson(res,401,{error:'用户名或密码错误'});
  const token=crypto.randomBytes(32).toString('hex');userSessions.set(token,{id:u.id,expires:Date.now()+30*86400000});setUserCookie(res,token);return sendJson(res,200,{ok:true,user:{id:u.id,username:u.username}});
 }
 if(pathname==='/api/auth/logout'&&req.method==='POST'){const t=cookies(req).dl_user;userSessions.delete(t);res.setHeader('Set-Cookie','dl_user=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');return sendJson(res,200,{ok:true});}
 return sendJson(res,404,{error:'Not found'});
}
async function adminApi(req,res,pathname){
 if(pathname==='/api/admin/login'&&req.method==='POST'){if(!ADMIN_PASSWORD)return sendJson(res,503,{error:'服务器未设置 LINELY_ADMIN_PASSWORD'});if(limited(clientIp(req),12))return sendJson(res,429,{error:'登录尝试过多，请稍后再试'});let b;try{b=JSON.parse(await readBody(req));}catch{return sendJson(res,400,{error:'请求格式错误'});}const a=Buffer.from(String(b.password||'')),z=Buffer.from(ADMIN_PASSWORD);if(a.length!==z.length||!crypto.timingSafeEqual(a,z))return sendJson(res,401,{error:'管理员密码错误'});const token=crypto.randomBytes(32).toString('hex');sessions.set(token,Date.now()+12*60*60*1000);res.setHeader('Set-Cookie',`dl_admin=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${process.env.NODE_ENV==='production'?'; Secure':''}`);return sendJson(res,200,{ok:true});}
 if(pathname==='/api/admin/logout'&&req.method==='POST'){const t=cookies(req).dl_admin;sessions.delete(t);res.setHeader('Set-Cookie','dl_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');return sendJson(res,200,{ok:true});}
 if(pathname==='/api/admin/me'&&req.method==='GET')return sendJson(res,200,{authenticated:!!adminSession(req),configured:!!ADMIN_PASSWORD});
 if(!requireAdmin(req,res))return;
 if(pathname==='/api/admin/users'&&req.method==='GET')return sendJson(res,200,{users:users.map(({id,username,banned,createdAt})=>({id,username,banned,createdAt}))});
 if(pathname.startsWith('/api/admin/users/')&&req.method==='POST'){const id=pathname.split('/').pop();const u=users.find(x=>x.id===id);if(!u)return sendJson(res,404,{error:'用户不存在'});let b;try{b=JSON.parse(await readBody(req));}catch{return sendJson(res,400,{error:'请求格式错误'});}u.banned=!!b.banned;saveUsers();for(const [t,v] of userSessions)if(v.id===id)userSessions.delete(t);return sendJson(res,200,{ok:true,banned:u.banned});}

 if(pathname==='/api/admin/gallery'&&req.method==='GET')return sendJson(res,200,{characters:gallery.map(c=>({id:c.id,name:c.name,author:c.author,createdAt:c.createdAt,avatars:c.avatars.map(a=>({id:a.id,author:a.author,image:a.image}))}))});
 let adc=pathname.match(/^\/api\/admin\/gallery\/([\w-]{8,64})\/delete$/);
 if(adc&&req.method==='POST'){gallery=gallery.filter(c=>c.id!==adc[1]);saveGallery();return sendJson(res,200,{ok:true});}
 let ada=pathname.match(/^\/api\/admin\/gallery\/([\w-]{8,64})\/avatars\/([\w-]{8,64})\/delete$/);
 if(ada&&req.method==='POST'){const c=gallery.find(x=>x.id===ada[1]);if(c)c.avatars=c.avatars.filter(a=>a.id!==ada[2]);saveGallery();return sendJson(res,200,{ok:true});}
 if(pathname==='/api/admin/metrics'&&req.method==='GET')return sendJson(res,200,metrics);
 if(pathname==='/api/admin/config'&&req.method==='GET')return sendJson(res,200,adminConfig());
 if(pathname==='/api/admin/config'&&req.method==='POST'){let b;try{b=JSON.parse(await readBody(req));}catch{return sendJson(res,400,{error:'请求格式错误'});}const f=b.freeApi||{};if(f.provider&&!PROVIDERS[f.provider]&&f.provider!=='第三方中转站 / OpenAI兼容')return sendJson(res,400,{error:'不支持的服务商'});if(f.provider==='第三方中转站 / OpenAI兼容'){try{const u=new URL(String(f.baseUrl||''));if(u.protocol!=='https:'||!u.hostname||u.username||u.password||/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)/i.test(u.hostname))throw new Error();}catch{return sendJson(res,400,{error:'第三方 API 必须填写有效的 HTTPS OpenAI 兼容 Base URL'});}}config.freeApi.enabled=!!f.enabled;if(f.provider)config.freeApi.provider=f.provider;if(typeof f.baseUrl==='string')config.freeApi.baseUrl=f.baseUrl.trim().slice(0,500);if(typeof f.model==='string'&&f.model.trim())config.freeApi.model=f.model.trim().slice(0,160);if(typeof f.apiKey==='string'&&f.apiKey.trim())config.freeApi.apiKey=f.apiKey.trim();if(f.clearKey===true)config.freeApi.apiKey='';writeJson(CONFIG_FILE,config);return sendJson(res,200,adminConfig());}
 if(pathname==='/api/admin/announcement'&&req.method==='POST'){let b;try{b=JSON.parse(await readBody(req));}catch{return sendJson(res,400,{error:'请求格式错误'});}config.announcement={enabled:!!b.enabled,title:String(b.title||'').slice(0,100),body:String(b.body||'').slice(0,2000),updatedAt:Date.now()};writeJson(CONFIG_FILE,config);return sendJson(res,200,{ok:true,announcement:config.announcement});}
 return sendJson(res,404,{error:'Not found'});
}
function serveStatic(req,res,pathname){let rel;try{rel=decodeURIComponent(pathname);}catch{return res.writeHead(400).end('Bad request');}if(rel.endsWith('/'))rel+='index.html';const file=path.normalize(path.join(PUBLIC_DIR,rel));if(!file.startsWith(PUBLIC_DIR+path.sep)&&file!==PUBLIC_DIR)return res.writeHead(403).end('Forbidden');fs.stat(file,(err,st)=>{if(err||!st.isFile()){if(!path.extname(rel))return serveStatic(req,res,'/index.html');res.writeHead(404,{'Content-Type':'text/plain; charset=utf-8'});return res.end('Not found');}const ext=path.extname(file).toLowerCase(),headers={'Content-Type':MIME[ext]||'application/octet-stream','Cache-Control':ext==='.html'||ext==='.js'||ext==='.css'?'no-cache':'public, max-age=604800'};if(rel==='/index.html'&&req.method==='GET'){bump('visits');persistMetrics();}const gz=COMPRESSIBLE.has(ext)&&/\bgzip\b/.test(req.headers['accept-encoding']||'');if(gz){headers['Content-Encoding']='gzip';headers.Vary='Accept-Encoding';res.writeHead(200,headers);fs.createReadStream(file).pipe(zlib.createGzip()).pipe(res);}else{headers['Content-Length']=st.size;res.writeHead(200,headers);fs.createReadStream(file).pipe(res);}});}
const server=http.createServer(async(req,res)=>{securityHeaders(res);const {pathname}=new URL(req.url,'http://localhost');if(req.method==='GET'&&pathname==='/healthz')return sendJson(res,200,{ok:true});if(pathname.startsWith('/api/auth/'))return authApi(req,res,pathname);if(pathname==='/auth.html'||pathname==='/auth.css'||pathname==='/auth.js')return serveStatic(req,res,pathname);if(pathname.startsWith('/api/admin/'))return adminApi(req,res,pathname);if(!pathname.startsWith('/api/')&&pathname!=='/favicon.ico'&&!userSession(req)&&!['/auth.html','/admin.html','/admin.js','/admin.css'].includes(pathname)){res.writeHead(302,{Location:'/auth.html'});return res.end();}if(pathname.startsWith('/api/')&&!pathname.startsWith('/api/admin/')&&!requireUser(req,res))return;if(req.method==='GET'&&pathname==='/api/free-config')return sendJson(res,200,publicConfig());if(req.method==='POST'&&pathname==='/api/ai')return handleAi(req,res);if(req.method==='GET'&&pathname==='/api/announcement')return sendJson(res,200,config.announcement.enabled?config.announcement:{enabled:false});
 if(req.method==='GET'&&pathname==='/api/themes')return sendJson(res,200,themes.map(({id,name,description,author,accent,bubbleColor,myBubbleColor,myTextColor,aiTextColor,bubbleStyle,bubbleRadius,background,createdAt})=>({id,name,description,author,accent,bubbleColor,myBubbleColor,myTextColor,aiTextColor,bubbleStyle,bubbleRadius,background,createdAt})));
 if(req.method==='POST'&&pathname==='/api/themes'){let b;try{b=JSON.parse(await readBody(req));}catch{return sendJson(res,400,{error:'请求格式错误'});}if(!String(b.name||'').trim())return sendJson(res,400,{error:'主题名称不能为空'});const u=userSession(req);const item={id:crypto.randomUUID(),name:String(b.name).slice(0,50),description:String(b.description||'').slice(0,200),author:u.username,accent:/^#[0-9a-f]{6}$/i.test(b.accent)?b.accent:'#0A84FF',bubbleColor:/^#[0-9a-f]{6}$/i.test(b.bubbleColor)?b.bubbleColor:'#FFFFFF',myBubbleColor:/^#[0-9a-f]{6}$/i.test(b.myBubbleColor)?b.myBubbleColor:'#0A84FF',myTextColor:/^#[0-9a-f]{6}$/i.test(b.myTextColor)?b.myTextColor:'#243047',aiTextColor:/^#[0-9a-f]{6}$/i.test(b.aiTextColor)?b.aiTextColor:'#263247',bubbleStyle:['classic','bunny','kitty','cloud','sticker'].includes(b.bubbleStyle)?b.bubbleStyle:'classic',bubbleRadius:Math.min(30,Math.max(8,Math.round(Number(b.bubbleRadius))||18)),background:typeof b.background==='string'&&b.background.startsWith('data:image/')&&b.background.length<500000?b.background:'',createdAt:Date.now()};themes.unshift(item);themes=themes.slice(0,300);writeJson(THEMES_FILE,themes);return sendJson(res,201,{ok:true,id:item.id});}



 if(pathname==='/api/tts/voices'&&req.method==='GET'){if(!requireUser(req,res))return;return sendJson(res,200,{enabled:TTS_ON,voices:TTS_ON?TTS_VOICES.map(({id,name,lang,gender,desc,styles})=>({id,name,lang,gender,desc,styles})):[]});}
 if(pathname==='/api/tts'&&req.method==='POST'){
  if(!requireUser(req,res))return; if(!TTS_ON)return sendJson(res,404,{error:'云端语音已关闭'});
  let b;try{b=JSON.parse(await readBody(req));}catch{return sendJson(res,400,{error:'请求格式错误'});}
  const text=String(b.text||'').trim().slice(0,600), v=TTS_VOICES.find(x=>x.id===b.voice);
  if(!text)return sendJson(res,400,{error:'没有要朗读的文字'}); if(!v)return sendJson(res,400,{error:'不支持这个声音'});
  const o={text,voice:v.id,rate:clampInt(b.rate,-50,50,0),pitch:clampInt(b.pitch,-40,40,0),volume:clampInt(b.volume,-50,0,0),style:v.styles&&TTS_STYLES.has(b.style)?b.style:''};
  try{const audio=await ttsSynth(o);res.writeHead(200,{'Content-Type':'audio/mpeg','Cache-Control':'private, max-age=600','X-Content-Type-Options':'nosniff'});return res.end(audio);}
  catch(e){return sendJson(res,502,{error:'云端语音暂时不可用'});}
 }
 if(pathname==='/api/meme/search'&&req.method==='GET'){
  if(!requireUser(req,res))return;
  if(!MEME_ON)return sendJson(res,200,{enabled:false,items:[]});
  const sp=new URL(req.url,'http://localhost').searchParams; let q=String(sp.get('q')||'').trim().slice(0,40);
  if(!q)return sendJson(res,400,{error:'请输入搜索词'});
  const gif=sp.get('gif')==='1'; if(!/表情|梗图|斗图|meme/i.test(q))q+=' 表情包';
  const key=q+'|'+gif, hit=memeCache.get(key);
  if(hit&&Date.now()-hit.t<600000)return sendJson(res,200,{enabled:true,items:hit.items});
  let items=[]; try{items=await bingImages(q,gif);}catch{}
  if(items.length<6){try{items=items.concat(await sogouImages(q));}catch{}}
  const seen=new Set(); items=items.filter(i=>!seen.has(i.url)&&seen.add(i.url)).slice(0,24);
  if(items.length){memeCache.set(key,{t:Date.now(),items});if(memeCache.size>200)memeCache.delete(memeCache.keys().next().value);}
  return sendJson(res,200,{enabled:true,items});
 }
 if(pathname==='/api/meme/img'&&req.method==='GET'){
  if(!requireUser(req,res))return;
  if(!MEME_ON)return sendJson(res,404,{error:'表情包搜索已关闭'});
  const u=new URL(req.url,'http://localhost').searchParams.get('u')||'';
  const r=await fetchLimited(u,{max:3*1024*1024});
  if(!r||!/^image\/(jpeg|png|gif|webp)$/.test(r.type))return sendJson(res,404,{error:'图片无法获取'});
  res.writeHead(200,{'Content-Type':r.type,'Cache-Control':'private, max-age=3600','X-Content-Type-Options':'nosniff'});return res.end(r.buf);
 }
 if(pathname==='/api/gallery'&&req.method==='GET'){const u=userSession(req);return sendJson(res,200,gallery.map(c=>({id:c.id,name:c.name,bio:c.bio,author:c.author,mine:c.authorId===u.id,hasPersona:!!c.persona,createdAt:c.createdAt,avatarCount:c.avatars.length,avatars:c.avatars.slice(0,6).map(a=>({id:a.id,author:a.author,image:a.image}))})));}
 let gm=pathname.match(/^\/api\/gallery\/([\w-]{8,64})$/);
 if(gm&&req.method==='GET'){const u=userSession(req);const c=gallery.find(x=>x.id===gm[1]);if(!c)return sendJson(res,404,{error:'角色不存在'});return sendJson(res,200,{id:c.id,name:c.name,bio:c.bio,persona:c.persona,author:c.author,mine:c.authorId===u.id,createdAt:c.createdAt,avatars:c.avatars.map(a=>({id:a.id,author:a.author,mine:a.authorId===u.id,image:a.image,note:a.note,createdAt:a.createdAt}))});}
 if(pathname==='/api/gallery'&&req.method==='POST'){let b;try{b=JSON.parse(await readBody(req));}catch{return sendJson(res,400,{error:'请求格式错误'});}const name=String(b.name||'').trim();if(!name)return sendJson(res,400,{error:'角色名称不能为空'});if(!galleryImage(b.avatar))return sendJson(res,400,{error:'请提供头像图片（需小于约 150KB）'});const u=userSession(req);if(gallery.filter(c=>c.authorId===u.id).length>=30)return sendJson(res,400,{error:'你发布的角色已达上限（30 个）'});const c={id:crypto.randomUUID(),name:name.slice(0,60),bio:String(b.bio||'').slice(0,240),persona:b.sharePersona?String(b.persona||'').slice(0,12000):'',author:u.username,authorId:u.id,createdAt:Date.now(),avatars:[{id:crypto.randomUUID(),author:u.username,authorId:u.id,image:b.avatar,note:'原作者头像',createdAt:Date.now()}]};gallery.unshift(c);gallery=gallery.slice(0,600);saveGallery();return sendJson(res,201,{ok:true,id:c.id});}
 let ga=pathname.match(/^\/api\/gallery\/([\w-]{8,64})\/avatars$/);
 if(ga&&req.method==='POST'){let b;try{b=JSON.parse(await readBody(req));}catch{return sendJson(res,400,{error:'请求格式错误'});}const c=gallery.find(x=>x.id===ga[1]);if(!c)return sendJson(res,404,{error:'角色不存在'});if(!galleryImage(b.image))return sendJson(res,400,{error:'请提供头像图片（需小于约 150KB）'});const u=userSession(req);if(c.avatars.length>=60)return sendJson(res,400,{error:'这个角色的头像已满'});if(c.avatars.filter(a=>a.authorId===u.id).length>=5)return sendJson(res,400,{error:'每人最多为同一角色投稿 5 张头像'});const a={id:crypto.randomUUID(),author:u.username,authorId:u.id,image:b.image,note:String(b.note||'').slice(0,80),createdAt:Date.now()};c.avatars.push(a);saveGallery();return sendJson(res,201,{ok:true,id:a.id});}
 let gd=pathname.match(/^\/api\/gallery\/([\w-]{8,64})\/delete$/);
 if(gd&&req.method==='POST'){const u=userSession(req);const c=gallery.find(x=>x.id===gd[1]);if(!c)return sendJson(res,404,{error:'角色不存在'});if(c.authorId!==u.id)return sendJson(res,403,{error:'只能删除自己发布的角色'});gallery=gallery.filter(x=>x!==c);saveGallery();return sendJson(res,200,{ok:true});}
 let gad=pathname.match(/^\/api\/gallery\/([\w-]{8,64})\/avatars\/([\w-]{8,64})\/delete$/);
 if(gad&&req.method==='POST'){const u=userSession(req);const c=gallery.find(x=>x.id===gad[1]);const a=c&&c.avatars.find(x=>x.id===gad[2]);if(!a)return sendJson(res,404,{error:'头像不存在'});if(a.authorId!==u.id&&c.authorId!==u.id)return sendJson(res,403,{error:'没有权限删除'});c.avatars=c.avatars.filter(x=>x!==a);saveGallery();return sendJson(res,200,{ok:true});}
 if(req.method==='GET'&&pathname==='/api/plaza')return sendJson(res,200,plaza.map(({id,name,bio,persona,avatar,provider,model,likes,dislikes,hobbies,gender,relationship,createdAt})=>({id,name,bio,persona,avatar,provider,model,likes,dislikes,hobbies,gender,relationship,createdAt})));
 if(req.method==='POST'&&pathname==='/api/plaza'){let b;try{b=JSON.parse(await readBody(req));}catch{return sendJson(res,400,{error:'请求格式错误'});}if(!b||!String(b.name||'').trim()||!String(b.persona||'').trim())return sendJson(res,400,{error:'人设名称和内容不能为空'});const item={id:crypto.randomUUID(),name:String(b.name).slice(0,60),bio:String(b.bio||'').slice(0,240),persona:String(b.persona).slice(0,12000),avatar:typeof b.avatar==='string'&&b.avatar.startsWith('data:image/')&&b.avatar.length<700000?b.avatar:'',provider:String(b.provider||'DeepSeek').slice(0,80),model:String(b.model||'').slice(0,120),likes:String(b.likes||'').slice(0,500),dislikes:String(b.dislikes||'').slice(0,500),hobbies:String(b.hobbies||'').slice(0,500),gender:String(b.gender||'其他').slice(0,20),relationship:String(b.relationship||'朋友').slice(0,30),createdAt:Date.now()};plaza.unshift(item);plaza=plaza.slice(0,500);writeJson(PLAZA_FILE,plaza);return sendJson(res,201,{ok:true,id:item.id});}if(req.method==='GET'||req.method==='HEAD')return serveStatic(req,res,pathname);res.writeHead(405);res.end('Method Not Allowed');});
server.listen(PORT,'0.0.0.0',()=>console.log(`Linely web listening on :${PORT}`));
