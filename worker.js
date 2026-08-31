// Deployment trigger: secrets configured 2026-08-31
const SEARCH = 'https://www.googleapis.com/youtube/v3/search';
const VIDEOS = 'https://www.googleapis.com/youtube/v3/videos';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const allowedOrigins = (env.ALLOWED_ORIGINS || 'https://tsukukiku.github.io,https://star-style-studio.net,https://www.star-style-studio.net').split(',').map(x => x.trim());
    const requestOrigin = request.headers.get('Origin') || '';
    const allowedOrigin = allowedOrigins.includes(requestOrigin) ? requestOrigin : allowedOrigins[0];
    const cors = {
      'Access-Control-Allow-Origin': allowedOrigin,
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };
    if (request.method === 'OPTIONS') return new Response(null, {status:204, headers:cors});
    if (url.pathname === '/health') return reply({ok:true}, 200, cors);
    if (url.pathname !== '/api/search') return reply({error:'Not found'}, 404, cors);
    const q = (url.searchParams.get('q') || '').trim();
    if (!q) return reply({error:'关键词不能为空'}, 400, cors);
    if (!env.YOUTUBE_API_KEY) return reply({error:'缺少YOUTUBE_API_KEY'}, 500, cors);

    const cache = caches.default;
    const cacheKey = new Request(`${url.origin}/cache/search?q=${encodeURIComponent(q.toLowerCase())}`);
    const hit = await cache.match(cacheKey);
    if (hit) return addCors(hit, cors);

    try {
      const sp = new URLSearchParams({part:'snippet', q, type:'video', maxResults:'50', safeSearch:'moderate', key:env.YOUTUBE_API_KEY});
      const sr = await fetch(`${SEARCH}?${sp}`), sd = await sr.json();
      if (!sr.ok) throw new Error(sd?.error?.message || 'YouTube搜索失败');
      const ids = sd.items.map(x => x.id.videoId).filter(Boolean);
      let details = new Map();
      if (ids.length) {
        const vp = new URLSearchParams({part:'contentDetails,statistics', id:ids.join(','), key:env.YOUTUBE_API_KEY});
        const vr = await fetch(`${VIDEOS}?${vp}`), vd = await vr.json();
        if (vr.ok) details = new Map((vd.items || []).map(x => [x.id, x]));
      }
      const items = sd.items.map(x => {
        const id=x.id.videoId, d=details.get(id)||{};
        return {id, title:decode(x.snippet.title), channel:decode(x.snippet.channelTitle),
          thumb:x.snippet.thumbnails?.high?.url||x.snippet.thumbnails?.medium?.url||`https://img.youtube.com/vi/${id}/mqdefault.jpg`,
          duration:duration(d.contentDetails?.duration||''), views:views(d.statistics?.viewCount)};
      });
      const response = reply({query:q,items}, 200, {...cors,'Cache-Control':'public, max-age=300'});
      await cache.put(cacheKey,response.clone()); return response;
    } catch(e) { return reply({error:e.message||'搜索服务暂时不可用'},502,cors); }
  }
};
const reply=(data,status,headers)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json; charset=utf-8',...headers}});
function addCors(r,c){const h=new Headers(r.headers);Object.entries(c).forEach(([k,v])=>h.set(k,v));return new Response(r.body,{status:r.status,headers:h});}
function decode(s=''){return s.replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>');}
function views(v){const n=Number(v||0);if(!n)return'';if(n>=1e9)return(n/1e9).toFixed(1)+'B';if(n>=1e6)return(n/1e6).toFixed(1)+'M';if(n>=1e3)return(n/1e3).toFixed(1)+'K';return String(n);}
function duration(v){const m=v.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);if(!m)return'';const h=+(m[1]||0),mi=+(m[2]||0),s=+(m[3]||0);return(h?h+':':'')+String(mi).padStart(h?2:1,'0')+':'+String(s).padStart(2,'0');}
