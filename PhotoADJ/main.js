/* All image reads, transformations and ZIP creation happen in this browser. */
const $ = (id) => document.getElementById(id);
const ui = {
  engine: $('engine'), status: $('status'), files: $('files'), folder: $('folder'),
  gallery: $('gallery'), manualSelect: $('manualSelect'), source: $('sourceCanvas'),
  result: $('resultCanvas'), sourcePlaceholder: $('sourcePlaceholder'),
  resultPlaceholder: $('resultPlaceholder'), pointInfo: $('pointInfo'),
  undo: $('undo'), process: $('process'), save: $('save'), next: $('next'), export: $('export')
};
let entries = [];
let selectedId = null;
let busy = false;
let nextId = 1;
const engineReady = true;

function status(message, bad = false) {
  ui.status.textContent = message;
  ui.status.classList.toggle('bad', bad);
}

ui.engine.textContent = '本地图像引擎已就绪';
ui.engine.classList.add('ready');
status('请选择图片或文件夹开始处理。');

function updateCounts() {
  $('totalCount').textContent = entries.length;
  $('autoCount').textContent = entries.filter(e => e.group === 'auto').length;
  $('manualCount').textContent = entries.filter(e => e.group === 'manual').length;
  $('savedCount').textContent = entries.filter(e => e.group === 'saved').length;
  ui.export.disabled = busy || !entries.some(e => e.group === 'auto' || e.group === 'saved');
}

function disposeEntries() {
  for (const entry of entries) if (entry.previewUrl) URL.revokeObjectURL(entry.previewUrl);
  entries = [];
  selectedId = null;
  clearCanvas(ui.source, ui.sourcePlaceholder);
  clearCanvas(ui.result, ui.resultPlaceholder);
}

function clearCanvas(canvas, placeholder) {
  canvas.width = canvas.height = 0;
  canvas.classList.remove('visible');
  placeholder.hidden = false;
}

function imageToCanvas(file) {
  return createImageBitmap(file).then(bitmap => {
    if (bitmap.width * bitmap.height > 80000000) {
      bitmap.close();
      throw new Error('图片像素超过 8000 万，浏览器内存可能不足');
    }
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    bitmap.close();
    return canvas;
  });
}

function orderPoints(points) {
  const s = p => p.x + p.y;
  const d = p => p.y - p.x;
  return [
    points.reduce((a,b) => s(a) < s(b) ? a : b),
    points.reduce((a,b) => d(a) < d(b) ? a : b),
    points.reduce((a,b) => s(a) > s(b) ? a : b),
    points.reduce((a,b) => d(a) > d(b) ? a : b)
  ];
}

function detectCorners(canvas) {
  // Work on a bounded preview; final warping still uses the full resolution image.
  const scale = Math.min(1, 1000 / Math.max(canvas.width, canvas.height));
  const w = Math.max(1, Math.round(canvas.width * scale)), h = Math.max(1, Math.round(canvas.height * scale));
  const work = document.createElement('canvas'); work.width = w; work.height = h;
  const ctx = work.getContext('2d', {willReadFrequently:true});
  ctx.drawImage(canvas, 0, 0, w, h);
  const rgba = ctx.getImageData(0, 0, w, h).data;
  const gray = new Uint8Array(w*h);
  for (let i=0,j=0;i<gray.length;i++,j+=4) gray[i] = Math.round(.299*rgba[j]+.587*rgba[j+1]+.114*rgba[j+2]);
  const edges = new Uint8Array(w*h);
  for (let y=1;y<h-1;y++) for(let x=1;x<w-1;x++) {
    const i=y*w+x;
    const gx=-gray[i-w-1]+gray[i-w+1]-2*gray[i-1]+2*gray[i+1]-gray[i+w-1]+gray[i+w+1];
    const gy=-gray[i-w-1]-2*gray[i-w]-gray[i-w+1]+gray[i+w-1]+2*gray[i+w]+gray[i+w+1];
    if(Math.abs(gx)+Math.abs(gy)>240) edges[i]=1;
  }
  // Join short gaps before finding connected edge regions.
  const joined = new Uint8Array(w*h);
  for(let y=2;y<h-2;y++) for(let x=2;x<w-2;x++) {
    const i=y*w+x; if(!edges[i])continue;
    for(let dy=-2;dy<=2;dy++) for(let dx=-2;dx<=2;dx++) joined[i+dy*w+dx]=1;
  }
  const seen = new Uint8Array(w*h), components=[];
  for(let start=0;start<joined.length;start++) {
    if(!joined[start]||seen[start])continue;
    const queue=[start], points=[]; seen[start]=1;
    for(let head=0;head<queue.length;head++) {
      const i=queue[head], x=i%w, y=(i/w)|0;
      if(edges[i]) points.push({x,y});
      for(const neighbor of [i-1,i+1,i-w,i+w]) {
        if(neighbor<0||neighbor>=joined.length||seen[neighbor]||!joined[neighbor])continue;
        if(Math.abs(neighbor%w-x)>1)continue;
        seen[neighbor]=1; queue.push(neighbor);
      }
    }
    if(points.length>20) components.push(points);
  }
  const hull = points => {
    points.sort((a,b)=>a.x-b.x||a.y-b.y);
    const cross=(a,b,c)=>(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);
    const lower=[],upper=[];
    for(const p of points){while(lower.length>1&&cross(lower.at(-2),lower.at(-1),p)<=0)lower.pop();lower.push(p);}
    for(let i=points.length-1;i>=0;i--){const p=points[i];while(upper.length>1&&cross(upper.at(-2),upper.at(-1),p)<=0)upper.pop();upper.push(p);}
    lower.pop();upper.pop();return lower.concat(upper);
  };
  const polygonArea = points => Math.abs(points.reduce((sum,p,i)=>sum+p.x*points[(i+1)%points.length].y-p.y*points[(i+1)%points.length].x,0))/2;
  const ranked=components.map(points=>{const boundary=hull(points);return {boundary,area:boundary.length>=3?polygonArea(boundary):0};}).sort((a,b)=>b.area-a.area);
  for(const candidate of ranked.slice(0,5)) {
    if(candidate.area<w*h*.05)continue;
    const corners=orderPoints(candidate.boundary);
    if(new Set(corners).size!==4)continue;
    const area=polygonArea(corners);
    if(area/candidate.area<.7)continue;
    return corners.map(p=>({x:p.x/scale,y:p.y/scale}));
  }
  return null;
}

function transformed(h, x, y) {
  const divisor = h[6]*x + h[7]*y + h[8];
  return {x: (h[0]*x + h[1]*y + h[2])/divisor, y: (h[3]*x + h[4]*y + h[5])/divisor};
}

function homography(src,dst) {
  const rows=[];
  for(let i=0;i<4;i++) {
    const {x,y}=src[i], u=dst[i].x, v=dst[i].y;
    rows.push([x,y,1,0,0,0,-u*x,-u*y,u]);
    rows.push([0,0,0,x,y,1,-v*x,-v*y,v]);
  }
  for(let col=0;col<8;col++) {
    let pivot=col;
    for(let r=col+1;r<8;r++)if(Math.abs(rows[r][col])>Math.abs(rows[pivot][col]))pivot=r;
    if(Math.abs(rows[pivot][col])<1e-9)throw new Error('四个角不能共线或重合');
    [rows[col],rows[pivot]]=[rows[pivot],rows[col]];
    const divisor=rows[col][col];for(let c=col;c<9;c++)rows[col][c]/=divisor;
    for(let r=0;r<8;r++)if(r!==col){const factor=rows[r][col];for(let c=col;c<9;c++)rows[r][c]-=factor*rows[col][c];}
  }
  return [...rows.map(row=>row[8]),1];
}

function inverse3(h) {
  const [a,b,c,d,e,f,g,i,j]=h;
  const A=e*j-f*i,B=c*i-b*j,C=b*f-c*e,D=f*g-d*j,E=a*j-c*g,F=c*d-a*f,G=d*i-e*g,H=b*g-a*i,I=a*e-b*d;
  const det=a*A+b*D+c*G;
  if(Math.abs(det)<1e-12)throw new Error('透视矩阵不可逆，请重新选点');
  return [A,B,C,D,E,F,G,H,I].map(v=>v/det);
}

function warpCanvas(canvas, points) {
  const ordered = orderPoints(points);
  const distance = (a,b) => Math.hypot(a.x-b.x, a.y-b.y);
  const [tl,tr,br,bl] = ordered;
  const targetW = Math.max(1, Math.floor(Math.max(distance(tl,tr), distance(bl,br))));
  const targetH = Math.max(1, Math.floor(Math.max(distance(tl,bl), distance(tr,br))));
  const H=homography(ordered,[{x:0,y:0},{x:targetW,y:0},{x:targetW,y:targetH},{x:0,y:targetH}]);
    const corners = [[0,0],[canvas.width,0],[canvas.width,canvas.height],[0,canvas.height]].map(([x,y]) => transformed(H,x,y));
    const xs = corners.map(p => p.x), ys = corners.map(p => p.y);
    const xMin = Math.min(...xs), yMin = Math.min(...ys);
    const width = Math.ceil(Math.max(...xs)-xMin), height = Math.ceil(Math.max(...ys)-yMin);
    if (!Number.isFinite(width*height) || width < 1 || height < 1 || width*height > 80000000 || width > 32767 || height > 32767) {
      throw new Error('选点形成的输出尺寸过大，请重新选择四个角');
    }
    const inverse=inverse3(H);
    const source=canvas.getContext('2d',{willReadFrequently:true}).getImageData(0,0,canvas.width,canvas.height).data;
    const output = document.createElement('canvas');
    output.width = width; output.height = height;
    const outCtx=output.getContext('2d');const image=outCtx.createImageData(width,height), dst=image.data;
    const sw=canvas.width,sh=canvas.height;
    for(let y=0;y<height;y++)for(let x=0;x<width;x++) {
      const offset=(y*width+x)*4, pt=transformed(inverse,x+xMin,y+yMin);
      const sx=pt.x,sy=pt.y;
      if(!Number.isFinite(sx)||!Number.isFinite(sy)||sx<0||sy<0||sx>sw-1||sy>sh-1){dst[offset]=dst[offset+1]=dst[offset+2]=dst[offset+3]=255;continue;}
      const x0=Math.floor(sx),y0=Math.floor(sy),x1=Math.min(sw-1,x0+1),y1=Math.min(sh-1,y0+1);
      const fx=sx-x0,fy=sy-y0;
      const a=(y0*sw+x0)*4,b=(y0*sw+x1)*4,c=(y1*sw+x0)*4,d=(y1*sw+x1)*4;
      for(let channel=0;channel<3;channel++)dst[offset+channel]=source[a+channel]*(1-fx)*(1-fy)+source[b+channel]*fx*(1-fy)+source[c+channel]*(1-fx)*fy+source[d+channel]*fx*fy;
      dst[offset+3]=255;
    }
    outCtx.putImageData(image,0,0);
    return output;
}

function toJpegBlob(canvas) {
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('JPEG 导出失败')), 'image/jpeg', 1));
}

async function setResult(entry, canvas) {
  const blob = await toJpegBlob(canvas);
  if (entry.previewUrl) URL.revokeObjectURL(entry.previewUrl);
  entry.result = blob;
  entry.previewUrl = URL.createObjectURL(blob);
}

function renderGallery() {
  ui.gallery.replaceChildren();
  const auto = entries.filter(e => e.group === 'auto');
  ui.gallery.classList.toggle('empty', !auto.length);
  if (!auto.length) { ui.gallery.textContent = '暂无自动完成的图片。'; return; }
  for (const entry of auto) {
    const card = document.createElement('div'); card.className = 'card';
    const img = document.createElement('img'); img.src = entry.previewUrl; img.alt = entry.name + ' 校正结果';
    const body = document.createElement('div'); body.className = 'cardbody';
    const name = document.createElement('span'); name.className = 'filename'; name.title = entry.name; name.textContent = entry.name;
    const button = document.createElement('button'); button.textContent = '效果不满意？转入手动校正';
    button.onclick = () => { entry.group = 'manual'; entry.points = []; entry.result = null; URL.revokeObjectURL(entry.previewUrl); entry.previewUrl = null; renderAll(); selectManual(entry.id); };
    body.append(name,button); card.append(img,body); ui.gallery.append(card);
  }
}

function renderManualSelect() {
  const pending = entries.filter(e => e.group === 'manual');
  ui.manualSelect.replaceChildren();
  if (!pending.length) {
    ui.manualSelect.add(new Option('暂无待处理图片', ''));
    selectedId = null;
    clearCanvas(ui.source, ui.sourcePlaceholder); clearCanvas(ui.result, ui.resultPlaceholder);
    ui.pointInfo.textContent = '已选 0 / 4 点';
  } else {
    if (!pending.some(e => e.id === selectedId)) selectedId = pending[0].id;
    for (const e of pending) ui.manualSelect.add(new Option(e.name, String(e.id)));
    ui.manualSelect.value = String(selectedId);
  }
  updateButtons();
}

function renderAll() { updateCounts(); renderGallery(); renderManualSelect(); if (selectedId) renderSelected(); }
function current() { return entries.find(e => e.id === selectedId && e.group === 'manual'); }

function renderSelected() {
  const entry = current();
  if (!entry) return;
  const scale = Math.min(1, 1024 / Math.max(entry.canvas.width,entry.canvas.height));
  const width = Math.max(1,Math.round(entry.canvas.width*scale)), height = Math.max(1,Math.round(entry.canvas.height*scale));
  ui.source.width = width; ui.source.height = height;
  const ctx = ui.source.getContext('2d');
  ctx.drawImage(entry.canvas,0,0,width,height);
  ctx.strokeStyle = '#1872ed'; ctx.lineWidth = 2;
  if (entry.points.length > 1) {
    ctx.beginPath(); entry.points.forEach((p,i) => i ? ctx.lineTo(p.x*scale,p.y*scale) : ctx.moveTo(p.x*scale,p.y*scale));
    if (entry.points.length === 4) ctx.closePath(); ctx.stroke();
  }
  entry.points.forEach((p,i) => { ctx.beginPath(); ctx.arc(p.x*scale,p.y*scale,7,0,Math.PI*2); ctx.fillStyle='#f04438'; ctx.fill(); ctx.fillStyle='#fff'; ctx.font='bold 13px Arial'; ctx.fillText(String(i+1),p.x*scale+10,p.y*scale+5); });
  ui.source.classList.add('visible'); ui.sourcePlaceholder.hidden = true;
  ui.pointInfo.textContent = `已选 ${entry.points.length} / 4 点 · ${entry.name}`;
  if (entry.result) {
    const img = new Image();
    img.onload = () => { if (current() !== entry || !entry.result) return; const s = Math.min(1,1024/Math.max(img.width,img.height)); ui.result.width=Math.round(img.width*s); ui.result.height=Math.round(img.height*s); ui.result.getContext('2d').drawImage(img,0,0,ui.result.width,ui.result.height); ui.result.classList.add('visible'); ui.resultPlaceholder.hidden=true; };
    img.src = entry.previewUrl;
  } else clearCanvas(ui.result,ui.resultPlaceholder);
  updateButtons();
}

function updateButtons() {
  const e = current();
  ui.undo.disabled = busy || !e || !e.points.length;
  ui.process.disabled = busy || !e || e.points.length !== 4;
  ui.save.disabled = busy || !e || !e.result;
  ui.next.disabled = busy || !e || e.points.length !== 4;
}

function selectManual(id) { selectedId = id; ui.manualSelect.value = String(id); renderSelected(); }

async function processFiles(fileList) {
  if (!engineReady) return;
  if (busy) return;
  const files = Array.from(fileList).filter(f => f.type.startsWith('image/') || /\.(jpe?g|png|webp|bmp)$/i.test(f.name));
  if (!files.length) { status('没有找到可处理的图片。', true); return; }
  if (files.length > 50) status(`找到 ${files.length} 张图片，仅处理前 50 张。`);
  busy = true; disposeEntries(); renderAll();
  const failures = [];
  for (const file of files.slice(0,50)) {
    try {
      const canvas = await imageToCanvas(file);
      const entry = {id:nextId++, name:file.name, canvas, group:'manual', points:[], result:null, previewUrl:null};
      const corners = detectCorners(canvas);
      if (corners) { await setResult(entry,warpCanvas(canvas,corners)); entry.group='auto'; }
      entries.push(entry);
    } catch (error) { failures.push(`${file.name}: ${error.message}`); }
    status(`已处理 ${entries.length+failures.length} / ${Math.min(files.length,50)} 张…`);
    await new Promise(resolve => setTimeout(resolve,0));
  }
  busy = false; renderAll();
  status(`处理完成：自动校正 ${entries.filter(e=>e.group==='auto').length} 张，待手动 ${entries.filter(e=>e.group==='manual').length} 张。${failures.length ? `失败 ${failures.length} 张：${failures.join('；')}` : ''}`,!!failures.length);
}

ui.files.onchange = event => { processFiles(event.target.files); event.target.value=''; };
ui.folder.onchange = event => { processFiles(event.target.files); event.target.value=''; };
ui.manualSelect.onchange = () => { selectedId=Number(ui.manualSelect.value)||null; renderSelected(); };
ui.source.onclick = event => {
  const e = current(); if (!e || busy || e.points.length>=4) return;
  const rect = ui.source.getBoundingClientRect();
  // object-fit:contain can leave margins inside the canvas element.
  const fit = Math.min(rect.width/ui.source.width,rect.height/ui.source.height);
  const drawnW=ui.source.width*fit, drawnH=ui.source.height*fit;
  const left=rect.left+(rect.width-drawnW)/2, top=rect.top+(rect.height-drawnH)/2;
  const x=(event.clientX-left)/drawnW*e.canvas.width, y=(event.clientY-top)/drawnH*e.canvas.height;
  if (x<0||y<0||x>e.canvas.width||y>e.canvas.height) return;
  e.points.push({x,y}); e.result=null;
  if (e.previewUrl) { URL.revokeObjectURL(e.previewUrl); e.previewUrl=null; }
  renderSelected();
};
ui.undo.onclick = () => { const e=current(); if (!e) return; e.points.pop(); e.result=null; if(e.previewUrl){URL.revokeObjectURL(e.previewUrl);e.previewUrl=null;} renderSelected(); };
ui.process.onclick = async () => {
  const e=current(); if (!e||e.points.length!==4) return;
  try { busy=true; updateButtons(); status(`正在校正 ${e.name}…`); await setResult(e,warpCanvas(e.canvas,e.points)); renderSelected(); status(`${e.name} 校正完成。满意后点击“保存当前图片”。`); }
  catch(error){ status(error.message,true); }
  finally{busy=false;updateButtons();}
};
ui.save.onclick = () => { const e=current(); if(!e||!e.result)return; e.group='saved'; renderAll(); status(`${e.name} 已保存。`); };
ui.next.onclick = async () => {
  const e=current(); if(!e||e.points.length!==4)return;
  try {
    busy=true; updateButtons();
    if(!e.result) await setResult(e,warpCanvas(e.canvas,e.points));
    const points=e.points.map(p=>({...p})); e.group='saved';
    const next=entries.find(item=>item.group==='manual');
    if(next){ next.points=points; await setResult(next,warpCanvas(next.canvas,points)); selectedId=next.id; status(`${e.name} 已保存；已沿用坐标校正 ${next.name}，请检查预览。`); }
    else status(`${e.name} 已保存；所有图片均已完成。`);
    renderAll();
  } catch(error){renderAll();status(error.message,true);}
  finally{busy=false;updateButtons();}
};
ui.export.onclick = async () => {
  if(busy)return;
  const completed=entries.filter(e=>e.group==='auto'||e.group==='saved'); if(!completed.length)return;
  busy=true;updateCounts();
  try {
    const zip=new JSZip(); const used=new Set();
    for(const e of completed){
      const stem=e.name.replace(/\.[^.]+$/,'').replace(/[\\/:*?"<>|\x00-\x1f]/g,'_');
      let name=`Adj_${stem}.jpg`, suffix=2;
      while(used.has(name.toLowerCase())) name=`Adj_${stem}_${suffix++}.jpg`;
      used.add(name.toLowerCase()); zip.file(name,e.result);
    }
    status(`正在打包 ${completed.length} 张图片…`);
    const blob=await zip.generateAsync({type:'blob',compression:'STORE'});
    const url=URL.createObjectURL(blob), link=document.createElement('a');
    link.href=url;link.download='rectified_images.zip';document.body.append(link);link.click();link.remove();
    setTimeout(()=>URL.revokeObjectURL(url),60000);
    status(`已打包 ${completed.length} 张图片，下载已开始。`);
  } catch(error){status(`打包失败：${error.message}`,true);}
  finally{busy=false;updateCounts();}
};
