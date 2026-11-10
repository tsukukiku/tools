/* Buildless first version. All event data shown here comes from the named live feeds. */
(() => {
  'use strict';
  const SOURCES = {
    japan: 'https://api.p2pquake.net/v2/history?codes=551&limit=50',
    eew: 'https://api.p2pquake.net/v2/history?codes=556&limit=5',
    global: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson'
  };
  const REFRESH_MS = 60000;
  const JST = 'Asia/Tokyo';
  const el = id => document.getElementById(id);
  const state = { mode: 'japan', japan: [], global: [], eew: [], lastSuccess: { japan: null, global: null, eew: null }, failed: { japan: false, global: false, eew: false }, loading: false, map: null, markers: null, selected: null };

  function parseJst(value) {
    if (typeof value !== 'string') return null;
    const match = value.match(/^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2})(?::(\d{2}))?/);
    if (!match) return null;
    const date = new Date(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6] || '00'}+09:00`);
    return Number.isFinite(date.getTime()) ? date : null;
  }
  function formatJst(value, seconds = false) {
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) return '时间未提供';
    return new Intl.DateTimeFormat('zh-CN', { timeZone: JST, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}), hour12: false }).format(date);
  }
  function scaleLabel(value) {
    return ({ 10:'1',20:'2',30:'3',40:'4',45:'5弱',50:'5强',55:'6弱',60:'6强',70:'7' })[value] || '未提供';
  }
  function usableCoordinate(lat, lon) { return Number.isFinite(lat) && Number.isFinite(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180; }
  function normalizeJapan(raw) {
    if (!raw || raw.code !== 551 || !raw.earthquake) return null;
    const quake = raw.earthquake, hypo = quake.hypocenter || {};
    const time = parseJst(quake.time) || parseJst(raw.time);
    if (!time) return null;
    const lat = Number(hypo.latitude), lon = Number(hypo.longitude);
    const magnitude = Number(hypo.magnitude), depth = Number(hypo.depth);
    return { id: String(raw.id || `${quake.time}-${hypo.name || ''}`), key: `${quake.time}-${hypo.name || ''}`, source:'japan', time, place: hypo.name || '震源未提供', lat:usableCoordinate(lat,lon) && lat !== -200 && lon !== -200 ? lat : null, lon:usableCoordinate(lat,lon) && lat !== -200 && lon !== -200 ? lon : null, mag: magnitude >= 0 && magnitude < 12 ? magnitude : null, depth: depth >= 0 ? depth : null, scale: scaleLabel(quake.maxScale), points: Array.isArray(raw.points) ? raw.points : [], bulletin: raw.issue?.type || '', sourceName: raw.issue?.source || 'P2PQuake / 气象厅' };
  }
  function normalizeGlobal(feature) {
    const p = feature?.properties, c = feature?.geometry?.coordinates;
    if (!p || !Array.isArray(c) || !Number.isFinite(p.time)) return null;
    const lon = Number(c[0]), lat = Number(c[1]), depth = Number(c[2]);
    const mag = Number(p.mag);
    return { id:String(feature.id || `${p.time}-${p.place}`), source:'global', time:new Date(p.time), place:p.place || '位置未提供', lat:usableCoordinate(lat,lon) ? lat : null, lon:usableCoordinate(lat,lon) ? lon : null, mag:Number.isFinite(mag) ? mag : null, depth:Number.isFinite(depth) && depth >= 0 ? depth : null, url:typeof p.url === 'string' && /^https:\/\/earthquake\.usgs\.gov\//.test(p.url) ? p.url : null };
  }
  function status(source, kind, copy) {
    const box = el(source === 'global' ? 'global-status' : 'japan-status');
    box.className = `source-status ${kind}`;
    box.querySelector('.status-copy').textContent = copy;
    const at = state.lastSuccess[source];
    box.querySelector('.status-time').textContent = at ? `获取 ${formatJst(at)}` : '--';
  }
  async function getJson(url) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(url, { signal: controller.signal, cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } finally { clearTimeout(timeout); }
  }
  async function loadJapan() {
    try {
      const data = await getJson(SOURCES.japan);
      if (!Array.isArray(data)) throw new Error('Invalid Japan feed');
      const seen = new Set();
      state.japan = data.map(normalizeJapan).filter(item => { if (!item || seen.has(item.key)) return false; seen.add(item.key); return true; }).sort((a,b) => b.time-a.time);
      state.lastSuccess.japan = new Date(); state.failed.japan = false;
      status('japan','ok',`已连接 · ${formatJst(state.lastSuccess.japan)} 获取`);
    } catch (error) {
      state.failed.japan = true;
      status('japan','error',state.lastSuccess.japan ? `连接失败 · 显示 ${formatJst(state.lastSuccess.japan)} 缓存` : '连接失败 · 暂无数据');
      console.warn('P2PQuake earthquake feed failed:', error);
    }
    render();
  }
  async function loadEew() {
    try {
      const data = await getJson(SOURCES.eew);
      if (!Array.isArray(data)) throw new Error('Invalid EEW feed');
      state.eew = data.filter(x => x?.code === 556);
      state.lastSuccess.eew = new Date(); state.failed.eew = false;
    } catch (error) { state.failed.eew = true; console.warn('P2PQuake EEW feed failed:', error); }
    renderEew();
  }
  async function loadGlobal() {
    try {
      const data = await getJson(SOURCES.global);
      if (data?.type !== 'FeatureCollection' || !Array.isArray(data.features)) throw new Error('Invalid USGS feed');
      state.global = data.features.map(normalizeGlobal).filter(Boolean).sort((a,b) => b.time-a.time);
      state.lastSuccess.global = new Date(); state.failed.global = false;
      status('global','ok',`已连接 · ${formatJst(state.lastSuccess.global)} 获取`);
    } catch (error) {
      state.failed.global = true;
      status('global','error',state.lastSuccess.global ? `连接失败 · 显示 ${formatJst(state.lastSuccess.global)} 缓存` : '连接失败 · 暂无数据');
      console.warn('USGS feed failed:', error);
    }
    render();
  }
  function renderEew() {
    const panel = el('eew-panel'); panel.replaceChildren();
    if (state.failed.eew) { panel.hidden = false; const strong=document.createElement('strong'); strong.textContent='紧急地震速报状态未知'; const p=document.createElement('p'); p.textContent='EEW 数据连接失败，请查看气象厅等官方渠道。'; panel.append(strong,p); return; }
    const recent = state.eew.find(item => { const time = parseJst(item.issue?.time) || parseJst(item.time); return !item.cancelled && time && Date.now()-time.getTime() >= 0 && Date.now()-time.getTime() <= 10*60000; });
    if (!recent) { panel.hidden = true; return; }
    panel.hidden = false;
    const strong=document.createElement('strong'); strong.textContent='日本紧急地震速报（警报）';
    const p=document.createElement('p'); p.textContent=`${recent.earthquake?.hypocenter?.name || '震源未提供'} · ${formatJst(parseJst(recent.issue?.time) || parseJst(recent.time))} 发布 · 请立即查看官方消息。`;
    panel.append(strong,p);
  }
  function filtered() { const min=Number(el('magnitude-filter').value); return state[state.mode].filter(x => x.mag === null ? min === 0 : x.mag >= min); }
  function text(tag, value, className) { const node=document.createElement(tag); node.textContent=value; if(className) node.className=className; return node; }
  function eventLabel(index) { return String.fromCharCode(65 + index % 26) + (index < 26 ? '' : String(Math.floor(index / 26))); }
  function renderList(items) {
    const list=el('quake-list'); list.replaceChildren();
    const fragment=document.createDocumentFragment();
    for (const [index,item] of items.slice(0,100).entries()) {
      const row=text('li','','quake-row');
      const button=text('button','','quake-button'); button.type='button'; button.setAttribute('aria-expanded','false');
      const badge=text('span','','mag-badge'); badge.append(text('strong',eventLabel(index),'event-code'),text('small',item.mag === null ? 'M --' : `M ${item.mag.toFixed(1)}`));
      if(item.mag >= 6) badge.classList.add('major'); else if(item.mag >= 4.5) badge.classList.add('strong');
      const main=text('span','','quake-main'); main.append(text('strong',item.place),text('small',`${formatJst(item.time)} JST · ${item.depth === null ? '深度未提供' : `深度 ${item.depth} km`}`));
      const right=text('span','','quake-right'); right.append(text('strong',item.source==='japan' ? `最大震度 ${item.scale}` : 'USGS'),text('small',item.source==='japan' ? item.bulletin : '全球地震'));
      button.append(badge,main,right);
      const detail=text('div','','quake-detail'); detail.id=`detail-${item.source}-${item.id.replace(/[^a-zA-Z0-9_-]/g,'')}`; button.setAttribute('aria-controls',detail.id);
      detail.append(text('p',`发生：${formatJst(item.time,true)} JST`),text('p',`震源深度：${item.depth === null ? '未提供' : `${item.depth} km`}`));
      if(item.source==='japan') {
        detail.append(text('p',`最大震度：${item.scale}（P2PQuake 发布的实际观测信息）`));
        if(item.points.length) { const points=item.points.slice(0,30).map(x=>`${x.addr || x.pref || '观测点'}：震度${scaleLabel(x.scale)}`); detail.append(text('p',points.join(' · '),'point-list')); }
      } else if(item.url) { const link=text('a','在 USGS 查看原始事件 ↗'); link.href=item.url; link.target='_blank'; link.rel='noopener noreferrer'; detail.append(link); }
      button.addEventListener('click',()=>{ const open=row.classList.toggle('open'); button.setAttribute('aria-expanded',String(open)); if(open && state.map && item.lat !== null) state.map.flyTo([item.lat,item.lon],Math.max(state.map.getZoom(),5),{duration:.6}); });
      row.append(button,detail); fragment.append(row);
    }
    list.append(fragment);
  }
  function render() {
    el('tab-japan').setAttribute('aria-selected',String(state.mode==='japan'));
    el('tab-global').setAttribute('aria-selected',String(state.mode==='global'));
    el('japan-count').textContent=String(state.japan.length);
    el('global-count').textContent=String(state.global.length);
    el('view-caption').textContent=state.mode==='japan' ? '日本近期地震 · P2PQuake' : '全球过去24小时 M2.5+ · USGS';
    const items=filtered(), notice=el('notice'), hasData=state[state.mode].length>0;
    notice.hidden=items.length>0;
    if(!items.length) notice.textContent=state.failed[state.mode] && !hasData ? '数据连接失败，当前没有可显示的地震记录。' : hasData ? '没有符合当前筛选条件的地震。' : state.lastSuccess[state.mode] ? '此时段暂无地震记录。' : '正在读取最新数据…';
    renderList(items); renderMarkers(items);
  }
  function loadScript(src, onload) {
    return new Promise((resolve,reject)=>{
      const script=document.createElement('script'); script.src=src; if(onload) onload(script); script.onload=resolve; script.onerror=()=>reject(new Error(`Unable to load ${src}`)); document.head.append(script);
    });
  }
  function loadLeaflet() {
    if (window.L) return Promise.resolve();
    return loadScript('https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',script=>{
      script.integrity='sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=';
      script.crossOrigin='anonymous';
    });
  }
  async function toggleMap() {
    const wrap=el('map-wrap'), button=el('map-toggle');
    if(!wrap.hidden){wrap.hidden=true;button.setAttribute('aria-expanded','false');button.firstChild.textContent='查看地图 ';return;}
    wrap.hidden=false; button.setAttribute('aria-expanded','true'); button.firstChild.textContent='收起地图 ';
    try {
      await Promise.all([loadLeaflet(),window.MAP_COUNTRIES ? Promise.resolve() : loadScript('./basemap.js?v=20261111-1')]);
      if(!state.map) {
        state.map=L.map('map',{preferCanvas:true,zoomControl:false,worldCopyJump:true,zoomSnap:1,attributionControl:false,minZoom:2,maxZoom:9}).setView(state.mode==='japan'?[36.5,138]:[20,10],state.mode==='japan'?5:2);
        L.control.zoom({position:'bottomright'}).addTo(state.map);
        L.geoJSON(window.MAP_COUNTRIES,{style:{color:'#427087',weight:.65,fillColor:'#204158',fillOpacity:1},interactive:false}).addTo(state.map);
        state.markers=L.layerGroup().addTo(state.map);
      }
      setTimeout(()=>{state.map.invalidateSize();renderMarkers(filtered());},50);
    } catch(error) { el('map').textContent='地图加载失败。地震列表仍可正常使用。'; console.warn(error); }
  }
  function renderMarkers(items) {
    if(!state.map || !state.markers) return;
    state.markers.clearLayers();
    for(const [index,item] of items.slice(0,100).entries()) {
      if(item.lat===null) continue;
      const label=eventLabel(index), level=item.mag>=6?'major':item.mag>=4.5?'strong':'regular';
      const magnitude=item.mag===null?'M --':`M ${item.mag.toFixed(1)}`;
      const marker=L.marker([item.lat,item.lon],{
        title:`${label} ${magnitude} ${item.place}`,
        icon:L.divIcon({
          className:`map-marker ${level}`,
          html:`<span class="map-magnitude">${magnitude}</span><span class="map-pin">${label}</span>`,
          iconSize:[44,38],
          iconAnchor:[22,30]
        })
      });
      const popup=document.createElement('div'); popup.append(text('strong',`${label} · ${item.place}`),document.createElement('br'),text('span',`${item.mag===null?'M 未提供':`M ${item.mag.toFixed(1)}`} · ${formatJst(item.time)} JST${item.source==='japan'?` · 最大震度 ${item.scale}`:''}`));
      marker.bindPopup(popup); marker.addTo(state.markers);
    }
  }
  async function refresh() {
    if(state.loading || document.hidden || !navigator.onLine) return;
    state.loading=true; el('refresh-button').disabled=true;
    status('japan','loading','正在更新…'); status('global','loading','正在更新…');
    await Promise.allSettled([loadJapan(),loadEew(),loadGlobal()]);
    state.loading=false; el('refresh-button').disabled=false;
  }
  function changeMode(mode) { state.mode=mode; render(); if(state.map) state.map.setView(mode==='japan'?[36.5,138]:[20,10],mode==='japan'?5:2,{animate:false}); }
  el('tab-japan').addEventListener('click',()=>changeMode('japan'));
  el('tab-global').addEventListener('click',()=>changeMode('global'));
  el('magnitude-filter').addEventListener('change',render);
  el('map-toggle').addEventListener('click',toggleMap);
  el('refresh-button').addEventListener('click',refresh);
  window.addEventListener('online',refresh);
  window.addEventListener('offline',()=>{status('japan','error','设备离线 · 显示上次获取数据');status('global','error','设备离线 · 显示上次获取数据');});
  document.addEventListener('visibilitychange',()=>{if(!document.hidden && (!state.lastSuccess.japan || Date.now()-state.lastSuccess.japan>REFRESH_MS)) refresh();});
  setInterval(()=>{el('clock').textContent=new Intl.DateTimeFormat('zh-CN',{timeZone:JST,hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date());renderEew();},1000);
  setInterval(refresh,REFRESH_MS);
  render(); refresh();
})();

