(() => {
  const $ = (s, r=document) => r.querySelector(s);
  const $$ = (s, r=document) => [...r.querySelectorAll(s)];
  const esc = (s) => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  const isSafeUrl = (u) => { try{ const x=new URL(u); return x.protocol==='http:'||x.protocol==='https:'; }catch{ return false; } };
  const fmtSize = (n) => { if(!n&&n!==0) return ''; const u=['B','KB','MB','GB']; let i=0, v=n; while(v>=1024&&i<u.length-1){v/=1024;i++;} return (v>=10?Math.round(v):Math.round(v*10)/10)+' '+u[i]; };
  const fmtDate = (ts) => { if(!ts) return '—'; const d=new Date(ts); return d.toLocaleString('tr-TR',{day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}); };
  const fmtTime = (ts) => { if(!ts) return ''; const d=new Date(ts); return d.toLocaleString('tr-TR',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}); };
  const toHex = (n) => n==null?'':Number(n).toString(16).padStart(6,'0');
  const parseData = () => {
    const el=$('#transcriptData'); if(!el) return null;
    try{ const raw=el.textContent.trim(); if(!raw||raw==='__TRANSCRIPT_JSON__') return null; return JSON.parse(raw); }catch(e){ console.error('parse transcript',e); return null; }
  };
  const DATA = parseData();
  if(!DATA){ console.warn('Transcript data missing'); return; }
  const { transcript, messages, users, config } = DATA;
  const userMap = new Map(users.map(u=>[u.userId,u]));
  const msgMap = new Map(messages.map(m=>[m.messageId,m]));
  let state = { user:null, type:'all', media:'all', mediaTab:'all', search:'', };

  // THEME
  const themeKey='tr-theme';
  const applyTheme=(t)=>{ document.documentElement.setAttribute('data-theme',t); localStorage.setItem(themeKey,t); $('#themeIcon').textContent=t==='light'?'🌙':'☀️'; };
  applyTheme(localStorage.getItem(themeKey)|| (matchMedia('(prefers-color-scheme: light)').matches?'light':'dark'));
  $('#themeToggle')?.addEventListener('click',()=>{ const cur=document.documentElement.getAttribute('data-theme')||'dark'; applyTheme(cur==='dark'?'light':'dark'); });

  // SIDEBAR
  const sidebar=$('#sidebar'), overlay=$('#sidebarOverlay');
  const openSide=()=>{sidebar.classList.add('open');overlay.classList.add('open');};
  const closeSide=()=>{sidebar.classList.remove('open');overlay.classList.remove('open');};
  $('#sidebarToggle')?.addEventListener('click',()=> sidebar.classList.contains('open')?closeSide():openSide());
  overlay?.addEventListener('click',closeSide);
  $$('.tab').forEach(b=>b.addEventListener('click',()=>{
    $$('.tab').forEach(x=>x.classList.remove('active')); b.classList.add('active');
    const tab=b.dataset.tab; $$('.tab-panel').forEach(p=>p.classList.remove('active')); $('#panel-'+tab)?.classList.add('active');
    if(window.innerWidth<=1100) closeSide();
  }));

  // BRAND
  $('#brandName').textContent = config.botName || 'Javrex Bot System';

  // SIDEBAR INFO
  const infoDl = (obj) => Object.entries(obj).map(([k,v])=>`<div><dt>${esc(k)}</dt><dd>${v}</dd></div>`).join('');
  $('#ticketInfo').innerHTML = infoDl({
    'Ticket ID': `<code>#${esc(transcript.ticketId)}</code>`,
    'Kanal ID': `<code>${esc(transcript.channelId)}</code>`,
    'Sunucu': `<code>${esc(transcript.guildId)}</code>`,
    'Durum': `<span class="chip active">${esc(transcript.status)}</span>`,
  });
  $('#dateInfo').innerHTML = infoDl({
    'Açılma': esc(fmtDate(transcript.createdAt)),
    'Kapanma': esc(fmtDate(transcript.closedAt)),
  });
  const getUserLabel = (id, fallback='—')=>{
    if(!id) return esc(fallback);
    const u=userMap.get(String(id));
    if(u) return `<span style="font-weight:700">${esc(u.displayName)}</span> <span class="muted">@${esc(u.username)}</span>`;
    return `<code>${esc(String(id))}</code>`;
  };
  $('#peopleInfo').innerHTML = infoDl({
    'Sahip': getUserLabel(transcript.ticketOwnerId),
    'Sahiplenen': transcript.claimedById?getUserLabel(transcript.claimedById):'<span class="muted">—</span>',
    'Kapatan': transcript.claimedById!==transcript.closedById && transcript.closedById?getUserLabel(transcript.closedById):(transcript.closedById?getUserLabel(transcript.closedById):'<span class="muted">—</span>'),
  });
  const stats = [
    ['Mesaj', transcript.messageCount],
    ['Kullanıcı', transcript.userCount],
    ['Ekler', transcript.attachmentCount],
    ['Görsel', transcript.imageCount],
    ['Video', transcript.videoCount],
    ['Dosya', transcript.fileCount],
  ];
  $('#statsGrid').innerHTML = stats.map(([l,v])=>`<div class="stat"><b>${esc(String(v))}</b><span>${esc(l)}</span></div>`).join('');
  $('#participantCount').textContent = `(${users.length})`;

  // PARTICIPANT CHIPS + LIST
  const chipsRoot=$('#userChips'), listRoot=$('#participantsList');
  const chipAll = `<button class="chip active" data-user="all">Tümü</button>`;
  const userChips = users.map(u=>`<button class="chip" data-user="${esc(u.userId)}">@${esc(u.username)}</button>`).join('');
  chipsRoot.innerHTML = chipAll + userChips;
  listRoot.innerHTML = users.map(u=>`
    <button class="participant" data-user="${esc(u.userId)}">
      <img src="${esc(u.avatarUrl||'https://cdn.discordapp.com/embed/avatars/0.png')}" alt="" loading="lazy" onerror="this.src='https://cdn.discordapp.com/embed/avatars/0.png'">
      <div style="flex:1;min-width:0"><div class="name">${esc(u.displayName)}</div><div class="meta">@${esc(u.username)} · ${esc(String(u.messageCount))} mesaj</div></div>
      ${u.roles?.[0]?.color?`<span style="width:10px;height:10px;border-radius:50%;background:${esc(u.roles[0].color)}"></span>`:''}
    </button>`).join('');
  const setUserFilter=(id)=>{
    state.user=id;
    $$('[data-user]').forEach(b=>b.classList.toggle('active', b.dataset.user===id));
    $$('.participant').forEach(b=>b.classList.toggle('active', b.dataset.user===id));
    render();
  };
  chipsRoot.addEventListener('click',e=>{ const b=e.target.closest('[data-user]'); if(b) setUserFilter(b.dataset.user); });
  listRoot.addEventListener('click',e=>{ const b=e.target.closest('[data-user]'); if(b) setUserFilter(b.dataset.user); });

  // TYPE FILTERS
  $$('#typeFilters .chip').forEach(b=>b.addEventListener('click',()=>{
    $$('#typeFilters .chip').forEach(x=>x.classList.remove('active')); b.classList.add('active'); state.type=b.dataset.filter; render();
  }));
  $$('#mediaFilters .chip').forEach(b=>b.addEventListener('click',()=>{
    $$('#mediaFilters .chip').forEach(x=>x.classList.remove('active')); b.classList.add('active'); state.media=b.dataset.media; render();
  }));
  $$('#mediaTabFilters .chip').forEach(b=>b.addEventListener('click',()=>{
    $$('#mediaTabFilters .chip').forEach(x=>x.classList.remove('active')); b.classList.add('active'); state.mediaTab=b.dataset.mediatab; renderMedia();
  }));

  // SEARCH
  const searchInput=$('#searchInput');
  let searchTimer=null;
  const doSearch=()=>{ state.search = (searchInput.value||'').trim().toLowerCase(); render(); renderMedia(); };
  searchInput?.addEventListener('input',()=>{ clearTimeout(searchTimer); searchTimer=setTimeout(doSearch,160); });
  searchInput?.addEventListener('keydown',e=>{ if(e.key==='Escape'){ searchInput.value=''; doSearch(); searchInput.blur(); }});
  document.addEventListener('keydown',e=>{
    if((e.ctrlKey||e.metaKey) && e.key.toLowerCase()==='k'){ e.preventDefault(); searchInput?.focus(); }
    if(e.key==='Escape' && document.activeElement===searchInput){ searchInput.value=''; doSearch(); }
  });

  // JUMP
  $('#jumpTop')?.addEventListener('click',()=>window.scrollTo({top:0,behavior:'smooth'}));
  $('#jumpBottom')?.addEventListener('click',()=>window.scrollTo({top:document.body.scrollHeight,behavior:'smooth'}));

  // MARKDOWN + MENTIONS
  const mentionMap = new Map();
  users.forEach(u=>{ mentionMap.set(u.userId, '@'+u.username); });
  // also map role ids if available (first roles)
  const roleMap = new Map();
  users.forEach(u=> (u.roles||[]).forEach(r=> roleMap.set(r.id, '@'+r.name)));

  function renderMarkdown(raw){
    if(!raw) return '';
    let s = esc(raw);
    // code block ```...```
    s = s.replace(/```([\s\S]*?)```/g, (m,code)=>`<pre><code>${esc(code)}</code></pre>`);
    // inline code `...`
    s = s.replace(/`([^`]+?)`/g, (m,code)=>`<code>${esc(code)}</code>`);
    // bold **...**
    s = s.replace(/\*\*([^\*]+?)\*\*/g, '<b>$1</b>');
    // italic *...* or _..._
    s = s.replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, '$1<i>$2</i>');
    s = s.replace(/(^|[^_])_([^_\n]+?)_(?!_)/g, '$1<i>$2</i>');
    // quote >...
    s = s.replace(/^&gt;\s?(.+)$/gm, '<blockquote>$1</blockquote>');
    // links [text](url)
    s = s.replace(/\[([^\]]+?)\]\((https?:\/\/[^\s)]+)\)/g, (m,text,url)=> isSafeUrl(url)?`<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(text)}</a>`:esc(m));
    // plain urls
    s = s.replace(/(https?:\/\/[^\s<]+)/g, (m,url)=> isSafeUrl(url)?`<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(url)}</a>`:esc(m));
    // mentions <@123>, <@&123>, <#123>
    s = s.replace(/&lt;@!?(\d{17,20})&gt;/g, (m,id)=>`<span class="chip" style="padding:2px 6px;background:rgba(88,101,242,.15);border-color:rgba(88,101,242,.25)">${esc(mentionMap.get(id)||'@'+id)}</span>`);
    s = s.replace(/&lt;@&amp;(\d{17,20})&gt;/g, (m,id)=>`<span class="chip" style="padding:2px 6px">${esc(roleMap.get(id)||'@role:'+id)}</span>`);
    s = s.replace(/&lt;#(\d{17,20})&gt;/g, (m,id)=>`<span class="chip" style="padding:2px 6px">#${esc(id)}</span>`);
    // line breaks
    s = s.replace(/\n/g,'<br>');
    return s;
  }

  function hasMediaType(msg, type){
    const atts=msg.attachments||[];
    const isImg=atts.some(a=> (a.contentType||'').startsWith('image/'));
    const isVid=atts.some(a=> (a.contentType||'').startsWith('video/'));
    const isFile=atts.length && !isImg && !isVid;
    if(type==='image') return isImg;
    if(type==='video') return isVid;
    if(type==='file') return isFile;
    if(type==='embed') return (msg.embeds||[]).length>0;
    if(type==='bot') return !!msg.bot;
    if(type==='text') return !!msg.content && !isImg && !isVid;
    return true;
  }

  function matchesSearch(msg){
    if(!state.search) return true;
    const q=state.search;
    return (msg.content||'').toLowerCase().includes(q) || (msg.username||'').toLowerCase().includes(q) || (msg.displayName||'').toLowerCase().includes(q);
  }

  function matchesMedia(msg){
    if(state.media==='all') return true;
    const atts=msg.attachments||[];
    if(state.media==='images') return atts.some(a=> (a.contentType||'').startsWith('image/'));
    if(state.media==='videos') return atts.some(a=> (a.contentType||'').startsWith('video/'));
    if(state.media==='files') return atts.some(a=> !(a.contentType||'').startsWith('image/') && !(a.contentType||'').startsWith('video/'));
    return true;
  }

  // RENDER MESSAGES
  const listEl=$('#messagesList');
  const loadBar=$('#loadBar'), loadInfo=$('#loadInfo');
  let galleryItems=[]; // for lightbox

  function buildAttachmentHtml(att, msg){
    const url=att.url, proxy=att.proxyUrl||url, name=att.filename||'dosya', ct=att.contentType||'', size=att.size;
    if(ct.startsWith('image/')){
      return `<div class="att image" data-url="${esc(url)}" data-proxy="${esc(proxy)}" data-name="${esc(name)}"><img src="${esc(proxy)}" alt="${esc(name)}" loading="lazy" onerror="this.closest('.att').style.display='none'"><div style="padding:8px 10px;display:flex;justify-content:space-between;gap:8px;align-items:center"><span class="file-name">${esc(name)}</span><span class="muted" style="font-size:12px">${esc(fmtSize(size))}</span></div></div>`;
    } else if(ct.startsWith('video/')){
      const safe = isSafeUrl(url)?esc(url):'#';
      return `<div class="att video"><video src="${safe}" controls preload="metadata" playsinline></video><div style="padding:8px 10px;display:flex;justify-content:space-between"><span class="file-name">${esc(name)}</span><span class="muted" style="font-size:12px">${esc(fmtSize(size))}</span></div><a href="${safe}" target="_blank" rel="noopener noreferrer" style="display:block;padding:0 10px 10px;font-size:12px">↗ Orijinali aç</a></div>`;
    } else {
      const icon = ct.includes('pdf')?'📄':ct.includes('zip')||ct.includes('rar')?'🗜️':ct.includes('audio')?'🎵':'📎';
      const safe = isSafeUrl(url)?esc(url):'#';
      return `<div class="att file"><div class="file-icon">${icon}</div><div class="file-meta"><div class="file-name">${esc(name)}</div><div class="file-size">${esc(fmtSize(size))} · ${esc(ct||'dosya')}</div></div><a class="file-open" href="${safe}" target="_blank" rel="noopener noreferrer">⬇</a></div>`;
    }
  }

  function buildEmbedHtml(e){
    const color = e.color!=null?`style="border-left-color:#${toHex(e.color)}"`:'';
    return `<div class="embed" ${color}>
      ${e.author?`<div style="display:flex;gap:8px;align-items:center;font-size:12px;color:var(--muted)">${e.author.iconUrl?`<img src="${esc(e.author.iconUrl)}" style="width:16px;height:16px;border-radius:50%">`:''}<b>${esc(e.author.name||'')}</b></div>`:''}
      ${e.title?`<div class="embed-title">${esc(e.title)}</div>`:''}
      ${e.description?`<div class="embed-desc">${renderMarkdown(e.description)}</div>`:''}
      ${e.fields&&e.fields.length?`<div class="embed-fields">${e.fields.map(f=>`<div class="field"><b>${esc(f.name)}</b><div>${renderMarkdown(f.value||'')}</div></div>`).join('')}</div>`:''}
      ${e.image?`<img src="${esc(e.image.url)}" style="width:100%;border-radius:8px;max-height:320px;object-fit:cover" loading="lazy">`:''}
      ${e.thumbnail?`<img src="${esc(e.thumbnail.url)}" style="width:80px;height:80px;object-fit:cover;border-radius:8px;float:right" loading="lazy">`:''}
      ${e.footer?`<div class="embed-footer">${e.footer.iconUrl?`<img src="${esc(e.footer.iconUrl)}" style="width:14px;height:14px;border-radius:50%">`:''}<span>${esc(e.footer.text||'')}</span>${e.timestamp?`<span>· ${esc(fmtDate(e.timestamp))}</span>`:''}</div>`:''}
    </div>`;
  }

  function render(){
    const filtered = messages.filter(m=>{
      if(state.user && state.user!=='all' && String(m.userId)!==String(state.user)) return false;
      if(state.type!=='all' && !hasMediaType(m, state.type)) return false;
      if(!matchesMedia(m)) return false;
      if(!matchesSearch(m)) return false;
      return true;
    });
    galleryItems = [];
    filtered.forEach(m=> (m.attachments||[]).forEach(a=>{ if((a.contentType||'').startsWith('image/')) galleryItems.push({url:a.url, proxy:a.proxyUrl||a.url, name:a.filename, msgId:m.messageId}); }));

    if(filtered.length===0){
      listEl.innerHTML = `<div class="empty">🔍 Bu filtrede mesaj bulunamadı.<br><span class="muted" style="font-size:12px">Filtreleri temizlemeyi deneyin.</span></div>`;
      loadBar.style.display='none';
      return;
    }
    // group consecutive messages from same user within 7 minutes?
    let html='', prevUser=null, prevTime=0;
    filtered.forEach((m,idx)=>{
      const sameGroup = prevUser===m.userId && (m.createdAt - prevTime) < 7*60*1000 && idx!==0;
      const isGrouped = sameGroup && !m.replyPreview && !(m.attachments&&m.attachments.length) && !(m.embeds&&m.embeds.length);
      const reply = m.replyPreview?`<div class="reply" data-reply="${esc(m.replyPreview.messageId||'')}"><span style="width:2px;background:var(--border2);border-radius:999px;align-self:stretch"></span><div><b>${esc(m.replyPreview.author||'')}</b> <span class="muted">${esc((m.replyPreview.content||'').slice(0,120))}</span></div></div>`:'';
      const edited = m.editedAt?`<span class="edited" title="${esc(fmtDate(m.editedAt))}">düzenlendi</span>`:'';
      const atts = (m.attachments&&m.attachments.length)?`<div class="attachments">${m.attachments.map(a=>buildAttachmentHtml(a,m)).join('')}</div>`:'';
      const embeds = (m.embeds&&m.embeds.length)?m.embeds.map(buildEmbedHtml).join(''):'';
      const reacts = m.reactions && Object.keys(m.reactions).length?`<div class="reactions">${Object.entries(m.reactions).map(([e,c])=>`<span class="reaction">${esc(e)} ${esc(String(c))}</span>`).join('')}</div>`:'';
      const stickers = m.stickerItems&&m.stickerItems.length?`<div class="stickers">${m.stickerItems.map(s=>`<img class="sticker" src="${esc(s.url||'')}" alt="${esc(s.name||'')}" loading="lazy">`).join('')}</div>`:'';
      if(isGrouped){
        html+=`<div class="message grouped" data-id="${esc(m.messageId)}" data-user="${esc(m.userId)}" style="margin-top:-6px;padding-top:4px">
          <div></div><div class="markdown" style="font-size:14px">${reply}${m.content?renderMarkdown(m.content):'<span class="muted" style="font-size:12px">(boş mesaj)</span>'}${edited}${atts}${embeds}${reacts}${stickers}</div></div>`;
      } else {
        html+=`<article class="message" data-id="${esc(m.messageId)}" data-user="${esc(m.userId)}">
          <div class="avatar-wrap"><img class="avatar" src="${esc(m.avatarUrl||'https://cdn.discordapp.com/embed/avatars/0.png')}" alt="" loading="lazy" onerror="this.src='https://cdn.discordapp.com/embed/avatars/0.png'">${m.bot?'<span class="bot-badge">BOT</span>':''}</div>
          <div style="min-width:0">
            <div class="msg-head"><div class="author"><span class="author-name" data-user="${esc(m.userId)}" style="cursor:pointer;${m.roleColor?`color:#${toHex(m.roleColor)}`:''}">${esc(m.displayName||m.username)}</span><span class="author-user">@${esc(m.username)}</span>${m.roleName?`<span class="role" style="background:#${toHex(m.roleColor)||'5865f2'}">${esc(m.roleName)}</span>`:''}</div><div class="meta"><time datetime="${new Date(m.createdAt).toISOString()}" title="${esc(fmtDate(m.createdAt))}">${esc(fmtTime(m.createdAt))}</time>${edited}<button class="icon-btn" style="width:28px;height:28px" data-ctx="${esc(m.messageId)}" aria-label="Menü">⋯</button></div></div>
            ${reply}
            <div class="markdown">${m.content?renderMarkdown(m.content):'<span class="muted" style="font-size:12px">(boş mesaj)</span>'}</div>
            ${atts}${embeds}${reacts}${stickers}
          </div>
        </article>`;
      }
      prevUser=m.userId; prevTime=m.createdAt;
    });
    // highlight search
    if(state.search){
      const q=state.search.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
      const re=new RegExp('('+q+')','gi');
      html=html.replace(/>([^<]+)</g,(m,txt)=> '>'+txt.replace(re,'<mark style="background:#faa61a;color:#000;padding:0 2px;border-radius:4px">$1</mark>')+'<' );
    }
    listEl.innerHTML=html;
    loadBar.style.display='block';
    loadInfo.textContent=`${filtered.length} / ${messages.length} mesaj gösteriliyor`;
    // bind reply jumps
    $$('.reply').forEach(el=>el.addEventListener('click',()=>{
      const id=el.dataset.reply; const target = listEl.querySelector(`[data-id="${CSS.escape(id)}"]`); if(target){ target.scrollIntoView({behavior:'smooth',block:'center'}); target.classList.add('highlight'); setTimeout(()=>target.classList.remove('highlight'),1800); }
    }));
    // bind image lightbox
    $$('.att.image').forEach((el,idx)=>{
      el.addEventListener('click',()=> openLightbox(galleryItems.findIndex(x=>x.url===el.dataset.url)));
      el.style.cursor='zoom-in';
    });
    // bind ctx
    $$('[data-ctx]').forEach(b=>b.addEventListener('click',e=>{ e.stopPropagation(); openCtx(e, b.dataset.ctx); }));
    // bind author click -> profile
    $$('.author-name').forEach(el=>el.addEventListener('click',()=> openUserModal(el.dataset.user)));
  }

  function renderMedia(){
    const grid=$('#mediaGrid'), empty=$('#mediaEmpty');
    let items=[];
    messages.forEach(m=> (m.attachments||[]).forEach(a=>{
      const isImg=(a.contentType||'').startsWith('image/'), isVid=(a.contentType||'').startsWith('video/'), isFile=!isImg&&!isVid;
      let pass=true;
      if(state.mediaTab==='images') pass=isImg;
      else if(state.mediaTab==='videos') pass=isVid;
      else if(state.mediaTab==='files') pass=isFile;
      if(!pass) return;
      if(state.user && state.user!=='all' && String(m.userId)!==String(state.user)) return;
      if(state.search && !matchesSearch(m)) return;
      items.push({...a, msg:m});
    }));
    if(items.length===0){ grid.innerHTML=''; empty.style.display='block'; return; }
    empty.style.display='none';
    grid.innerHTML=items.map(a=>{
      const isImg=(a.contentType||'').startsWith('image/'), isVid=(a.contentType||'').startsWith('video/');
      const safe=isSafeUrl(a.url)?esc(a.url):'#';
      if(isImg) return `<div class="media-item"><img src="${esc(a.proxyUrl||a.url)}" alt="${esc(a.filename)}" loading="lazy"><div class="media-meta"><b title="${esc(a.filename)}">${esc(a.filename)}</b><a href="${safe}" target="_blank" rel="noopener">↗</a></div><div class="muted" style="padding:0 10px 10px;font-size:12px">@${esc(a.msg.username)} · ${esc(fmtTime(a.msg.createdAt))}</div></div>`;
      if(isVid) return `<div class="media-item"><video src="${safe}" controls preload="metadata"></video><div class="media-meta"><b>${esc(a.filename)}</b><span class="muted">${esc(fmtSize(a.size))}</span></div></div>`;
      return `<div class="media-item"><div style="padding:14px;display:flex;gap:10px;align-items:center"><div class="file-icon">📎</div><div style="flex:1;min-width:0"><div style="font-weight:700;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(a.filename)}</div><div class="muted" style="font-size:12px">${esc(a.contentType||'dosya')} · ${esc(fmtSize(a.size))}</div></div><a class="file-open" href="${safe}" target="_blank" rel="noopener">⬇</a></div><div class="muted" style="padding:0 14px 14px;font-size:12px">@${esc(a.msg.username)}</div></div>`;
    }).join('');
    // lightbox for media grid images
    $$('#mediaGrid img').forEach((img,i)=>{
      img.style.cursor='zoom-in';
      img.addEventListener('click',()=>{
        const filtered = items.filter(x=> (x.contentType||'').startsWith('image/'));
        const idx = filtered.findIndex(x=> (x.proxyUrl||x.url)===img.src);
        // build gallery from filtered
        galleryItems = filtered.map(x=>({url:x.url, proxy:x.proxyUrl||x.url, name:x.filename}));
        openLightbox(idx>=0?idx:0);
      });
    });
  }

  // PARTICIPANTS DETAILED
  function renderParticipants(){
    const root=$('#participantsDetailed');
    root.innerHTML = users.map(u=>`
      <div class="pd-card">
        <img src="${esc(u.avatarUrl||'https://cdn.discordapp.com/embed/avatars/0.png')}" alt="">
        <div style="flex:1;min-width:0"><div style="font-weight:800">${esc(u.displayName)} ${u.bot?'<span class="chip" style="font-size:10px">BOT</span>':''}</div><div class="muted" style="font-size:12px">@${esc(u.username)} · ${esc(u.userId)}</div><div class="muted" style="font-size:12px">${esc(String(u.messageCount))} mesaj · ilk: ${esc(fmtTime(u.firstMessageAt))} · son: ${esc(fmtTime(u.lastMessageAt))}</div>${(u.roles||[]).length?`<div class="chips" style="margin-top:6px">${u.roles.slice(0,6).map(r=>`<span class="chip" style="border-color:${esc(r.color||'#2b2d31')};color:${esc(r.color||'var(--muted)')}">${esc(r.name)}</span>`).join('')}</div>`:''}</div>
        <button class="chip" data-user="${esc(u.userId)}">Filtrele</button>
      </div>`).join('');
    root.querySelectorAll('[data-user]').forEach(b=>b.addEventListener('click',()=>{ setUserFilter(b.dataset.user); $$('.tab').forEach(x=>x.classList.remove('active')); $('[data-tab="messages"]').classList.add('active'); $$('.tab-panel').forEach(p=>p.classList.remove('active')); $('#panel-messages').classList.add('active'); window.scrollTo({top:0}); }));
  }

  // TIMELINE
  function renderTimeline(){
    const tl=$('#timeline');
    const events=[
      {icon:'🎫', title:'Ticket Açıldı', desc:`Sahip: @${esc(userMap.get(String(transcript.ticketOwnerId))?.username||transcript.ticketOwnerId)}`, time:transcript.createdAt},
      transcript.claimedById?{icon:'🛡️', title:'Sahiplenildi', desc:`Yetkili: @${esc(userMap.get(String(transcript.claimedById))?.username||transcript.claimedById)}`, time:transcript.createdAt+1}:null,
      {icon:'🔒', title:'Ticket Kapatıldı', desc:`Kapatan: @${esc(userMap.get(String(transcript.closedById))?.username||transcript.closedById||'—')}`, time:transcript.closedAt},
    ].filter(Boolean).sort((a,b)=>a.time-b.time);
    tl.innerHTML = events.map(e=>`<div class="tl-item"><div class="tl-dot">${e.icon}</div><div style="flex:1"><b>${esc(e.title)}</b><div class="muted" style="font-size:13px">${e.desc}</div></div><span class="muted" style="font-size:12px">${esc(fmtDate(e.time))}</span></div>`).join('') + `<div class="tl-item"><div class="tl-dot">💬</div><div style="flex:1"><b>Mesaj İstatistikleri</b><div class="muted" style="font-size:13px">${esc(String(transcript.messageCount))} mesaj, ${esc(String(transcript.userCount))} katılımcı, ${esc(String(transcript.attachmentCount))} ek</div></div></div>`;
  }

  // LIGHTBOX
  const lb=$('#lightbox'), lbImg=$('#lbImg'), lbVideo=$('#lbVideo'), lbName=$('#lbName'), lbCounter=$('#lbCounter');
  let lbIdx=0;
  function openLightbox(idx){
    if(!galleryItems.length) return;
    lbIdx = Math.max(0, Math.min(idx, galleryItems.length-1));
    const item=galleryItems[lbIdx];
    lb.classList.add('open'); lb.setAttribute('aria-hidden','false');
    if(!item) return;
    lbName.textContent=item.name||''; lbCounter.textContent=(lbIdx+1)+' / '+galleryItems.length;
    lbImg.style.display='none'; lbVideo.style.display='none'; lbVideo.pause();
    lbImg.src=item.proxy||item.url; lbImg.style.display='block';
    // preload neighbours
    const prev=galleryItems[lbIdx-1], next=galleryItems[lbIdx+1];
    if(prev){ const i=new Image(); i.src=prev.proxy||prev.url; } if(next){ const i=new Image(); i.src=next.proxy||next.url; }
  }
  function closeLightbox(){ lb.classList.remove('open'); lb.setAttribute('aria-hidden','true'); lbVideo.pause(); }
  $('#lbClose')?.addEventListener('click',closeLightbox);
  $('#lbPrev')?.addEventListener('click',()=> openLightbox(lbIdx-1));
  $('#lbNext')?.addEventListener('click',()=> openLightbox(lbIdx+1));
  lb?.addEventListener('click',e=>{ if(e.target===lb) closeLightbox(); });
  document.addEventListener('keydown',e=>{ if(!lb.classList.contains('open')) return; if(e.key==='Escape') closeLightbox(); if(e.key==='ArrowLeft') openLightbox(lbIdx-1); if(e.key==='ArrowRight') openLightbox(lbIdx+1); });

  // USER MODAL
  function openUserModal(userId){
    const u=userMap.get(String(userId)); if(!u) return toast('Kullanıcı bulunamadı');
    const body=$('#userModalBody');
    body.innerHTML=`<div style="padding:16px;display:flex;gap:16px;align-items:center"><img src="${esc(u.avatarUrl)}" style="width:64px;height:64px;border-radius:50%" onerror="this.src='https://cdn.discordapp.com/embed/avatars/0.png'"><div><div style="font-weight:800;font-size:18px">${esc(u.displayName)} ${u.bot?'<span class="chip">BOT</span>':''}</div><div class="muted">@${esc(u.username)} · ${esc(u.userId)}</div><div style="margin-top:6px" class="chips">${(u.roles||[]).slice(0,8).map(r=>`<span class="chip" style="border-color:${esc(r.color||'var(--border)')}">${esc(r.name)}</span>`).join('')||'<span class="muted" style="font-size:12px">Rol yok</span>'}</div></div></div><div style="padding:0 16px 16px;display:grid;grid-template-columns:repeat(3,1fr);gap:8px"><div class="stat"><b>${esc(String(u.messageCount))}</b><span>Mesaj</span></div><div class="stat"><b>${esc(fmtTime(u.firstMessageAt))}</b><span>İlk mesaj</span></div><div class="stat"><b>${esc(fmtTime(u.lastMessageAt))}</b><span>Son mesaj</span></div></div>`;
    $('#userModal').classList.add('open'); $('#userModal').setAttribute('aria-hidden','false');
  }
  $('#userModalClose')?.addEventListener('click',()=>{ $('#userModal').classList.remove('open'); });
  $('#userModal')?.addEventListener('click',e=>{ if(e.target.id==='userModal') e.currentTarget.classList.remove('open'); });

  // CONTEXT MENU
  const ctx=$('#ctxMenu'); let ctxMsgId=null;
  function openCtx(e, msgId){ ctxMsgId=msgId; ctx.style.left=e.pageX+'px'; ctx.style.top=e.pageY+'px'; ctx.style.display='block'; }
  function closeCtx(){ ctx.style.display='none'; ctxMsgId=null; }
  document.addEventListener('click',closeCtx);
  ctx?.addEventListener('click',e=>{
    const act=e.target.closest('[data-act]')?.dataset.act; if(!act||!ctxMsgId) return;
    const msg=msgMap.get(ctxMsgId);
    if(act==='copy' && msg){ navigator.clipboard.writeText(msg.content||'').then(()=>toast('Kopyalandı')).catch(()=>toast('Kopyalanamadı')); }
    if(act==='copyLink'){ const url=location.href.split('#')[0]+'#'+ctxMsgId; navigator.clipboard.writeText(url).then(()=>toast('Link kopyalandı')); }
    if(act==='jump'){ const el=document.querySelector(`[data-id="${CSS.escape(ctxMsgId)}"]`); if(el){ el.scrollIntoView({behavior:'smooth',block:'center'}); el.classList.add('highlight'); setTimeout(()=>el.classList.remove('highlight'),1800);} }
    if(act==='filterUser' && msg){ setUserFilter(String(msg.userId)); closeCtx(); window.scrollTo({top:0,behavior:'smooth'}); return; }
    if(act==='profile' && msg){ openUserModal(String(msg.userId)); }
    closeCtx();
  });

  // TOAST
  function toast(msg){
    const t=document.createElement('div'); t.className='toast'; t.textContent=msg; $('#toastWrap').appendChild(t); setTimeout(()=>{ t.style.opacity='0'; t.style.transform='translateY(6px)'; setTimeout(()=>t.remove(),300); },2200);
  }

  // INIT
  render(); renderMedia(); renderParticipants(); renderTimeline();
  // handle hash jump
  if(location.hash){
    const id=location.hash.slice(1); setTimeout(()=>{ const el=document.querySelector(`[data-id="${CSS.escape(id)}"]`); if(el) el.scrollIntoView({behavior:'smooth',block:'center'}); },400);
  }
})();