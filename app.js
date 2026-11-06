'use strict';
const root=document.getElementById('app');
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let session=null,task=null,progress=null,activeSound='A',playbackMode='independent',syncWanted=false,frame=0,dragging=false,dragResume=false,saveTimer=null,dirty=false,chain=Promise.resolve(),busy=false;
const expectedSyncPlays=new WeakSet(),expectedSyncPauses=new WeakSet(),expectedSeekTargets=new WeakMap();
const videoSlots=['source','A','B','C'],hiddenVideoSlots=new Set();
const language={zh:'中文',en:'英文'};
const pagesApiOrigin = "https://spell-successful-engineer-dramatically.trycloudflare.com";
const pagesDeviceKey = 'cineverto-review:' + (window.location.origin === pagesApiOrigin
  ? pagesApiOrigin : window.location.pathname.replace(/index\.html$/, ''));
let pagesSession = '';

async function api(path, body) {
  const headers = {};
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    headers['X-CSRF-Token'] = session?.csrf || '';
  }
  if (pagesSession) headers.Authorization = 'Bearer ' + pagesSession;
  if (path === '/api/login' || path === '/api/session' || path === '/api/pages/transfer') {
    const device = localStorage.getItem(pagesDeviceKey);
    if (device) headers['X-CineVerto-Device'] = device;
  }
  const response = await fetch(pagesApiOrigin + path, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'omit',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '暂时无法连接，请重试。');
  if (typeof data.pages_session === 'string') pagesSession = data.pages_session;
  if (data.pages_device) localStorage.setItem(pagesDeviceKey, data.pages_device);
  delete data.pages_session;
  delete data.pages_device;
  return data;
}
function toast(text){const el=document.getElementById('toast');el.textContent=text;el.hidden=false;clearTimeout(el.timer);el.timer=setTimeout(()=>{el.hidden=true;},3500);}
function videos(){return [...root.querySelectorAll('.comparison-video')];}
function visibleVideos(){return videos().filter(video=>!hiddenVideoSlots.has(video.dataset.slot));}
function videoName(slot){return slot==='source'?'原视频':'候选 '+slot;}
function eyeIcon(hidden=false){return `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>${hidden?'<path class="eye-slash" d="m3 3 18 18"/>':''}</svg>`;}
function columnControlsHTML(){return `<div class="column-controls" role="group" aria-label="显示或隐藏视频列"><strong>显示列</strong><div class="column-toggles">${videoSlots.map(slot=>`<button type="button" class="column-toggle" data-column-toggle="${slot}" aria-pressed="true" aria-label="隐藏${videoName(slot)}列">${eyeIcon()}<span>${videoName(slot)}</span></button>`).join('')}</div><span id="column-count" class="column-count" aria-live="polite">4 / 4 列</span><button type="button" id="show-all-columns" class="show-all-columns" disabled>全部显示</button></div>`;}
function updateSyncControls(){
  const list=visibleVideos();
  const ready=list.length>0&&list.every(video=>video.readyState>=2&&!video.error);
  for(const id of ['play-all','restart']){const button=document.getElementById(id);if(button)button.disabled=!ready;}
  const slider=document.getElementById('timeline');
  if(slider&&task){const max=Math.min(...[task.source,...task.candidates].filter(asset=>!hiddenVideoSlots.has(asset.slot||'source')).map(asset=>asset.duration));slider.max=String(max);slider.value=String(Math.min(Number(slider.value),max));const label=document.getElementById('time-label');if(label)label.textContent=formatTime(slider.value)+' / '+formatTime(max);}
}
function updateColumnVisibility(){
  const list=videos(),visible=visibleVideos();
  list.forEach(video=>{const hidden=hiddenVideoSlots.has(video.dataset.slot);video.closest('.video-card').hidden=hidden;if(hidden){video.pause();video.muted=true;}});
  if(!visible.some(video=>video.dataset.slot===activeSound))selectSound(visible.find(video=>video.dataset.slot!=='source')?.dataset.slot||visible[0].dataset.slot);
  const grid=root.querySelector('.four-videos');grid.style.setProperty('--visible-columns',String(visible.length));grid.dataset.visibleCount=String(visible.length);
  grid.classList.toggle('has-portrait',[task.source,...task.candidates].some(asset=>!hiddenVideoSlots.has(asset.slot||'source')&&asset.height>asset.width));
  grid.classList.toggle('has-source',!hiddenVideoSlots.has('source'));
  const scriptPanel=document.getElementById('source-script-panel'),scriptHost=document.getElementById('source-script-host'),scriptFallback=document.getElementById('source-script-fallback');
  if(scriptPanel&&scriptHost&&scriptFallback){const sourceHidden=hiddenVideoSlots.has('source'),destination=sourceHidden?scriptFallback:scriptHost;if(scriptPanel.parentElement!==destination)destination.append(scriptPanel);scriptFallback.hidden=!sourceHidden;}
  root.querySelectorAll('[data-column-toggle]').forEach(button=>{const slot=button.dataset.columnToggle,shown=!hiddenVideoSlots.has(slot);button.setAttribute('aria-pressed',String(shown));button.setAttribute('aria-label',(shown?'隐藏':'显示')+videoName(slot)+'列');button.title=(shown?'隐藏':'显示')+videoName(slot)+'列';button.innerHTML=eyeIcon(!shown)+`<span>${videoName(slot)}</span>`;});
  document.getElementById('column-count').textContent=visible.length+' / 4 列';document.getElementById('show-all-columns').disabled=hiddenVideoSlots.size===0;
  updateSyncControls();
  const leader=visible.find(video=>video.dataset.slot===activeSound);if(leader){document.getElementById('timeline').value=String(Math.min(leader.currentTime,Number(document.getElementById('timeline').max)));document.getElementById('time-label').textContent=formatTime(document.getElementById('timeline').value)+' / '+formatTime(document.getElementById('timeline').max);}
  if(visible.some(video=>!video.paused))kickClock();
}
function toggleColumn(slot){
  if(!videoSlots.includes(slot))return;
  if(!hiddenVideoSlots.has(slot)&&hiddenVideoSlots.size===videoSlots.length-1){toast('至少保留一列视频；可先显示其他列，再隐藏这一列。');return;}
  independentMode();dragging=false;dragResume=false;
  if(hiddenVideoSlots.has(slot))hiddenVideoSlots.delete(slot);else hiddenVideoSlots.add(slot);
  updateColumnVisibility();
}
function showAllColumns(){independentMode();dragging=false;dragResume=false;hiddenVideoSlots.clear();updateColumnVisibility();}
function storageKey(){return 'av-simple60:'+session.participant+':'+task.id;}
function stash(){if(task&&task.status!=='submitted')localStorage.setItem(storageKey(),JSON.stringify({revision:task.revision,answers:task.answers,dirty}));}
function saveState(text){const el=document.getElementById('save-state');if(el)el.textContent=text;}
function scheduleSave(){if(task.status==='submitted')return;dirty=true;stash();saveState('正在保存…');clearTimeout(saveTimer);saveTimer=setTimeout(()=>flushSave().catch(()=>{}),700);}
async function flushSave(){
  clearTimeout(saveTimer);if(!task||task.status==='submitted')return;const id=task.id;
  const save=async()=>{
    if(!dirty||task?.id!==id)return;
    const body={revision:task.revision,answers:JSON.parse(JSON.stringify(task.answers))};
    try{const result=await api('/api/task/'+id+'/draft',body);task.revision=result.revision;dirty=JSON.stringify(body.answers)!==JSON.stringify(task.answers);stash();saveState(dirty?'正在保存…':'已保存');if(dirty)scheduleSave();}
    catch(error){dirty=true;stash();saveState('未保存，请重试');throw error;}
  };
  const pending=chain.then(save,save);chain=pending.catch(()=>{});await pending;
}
function entry(loginCode=''){
  const {clip_count:count,label}=session.study;
  session=null;task=null;document.getElementById('account').innerHTML='';
  root.innerHTML=`<section class="entry"><h1>开始视频评分</h1><p>请输入收到的评审码。</p><form id="entry-form"><label for="reviewer-code">统一登录码</label><div><input id="reviewer-code" name="code" autocomplete="off" value="${esc(loginCode)}" required><button class="primary" type="submit">进入评分</button></div><p id="entry-error" role="alert"></p></form><p class="entry-help">只需首次进入；以后使用同一浏览器打开，会自动继续上次的进度。${esc(label)}，共 ${count} 条视频，可随时保存并继续；每条提交一次。</p></section>`;
  document.getElementById('entry-form').addEventListener('submit',async event=>{event.preventDefault();const button=event.currentTarget.querySelector('button');button.disabled=true;try{await api('/api/login',{code:event.currentTarget.code.value});await boot();}catch(error){document.getElementById('entry-error').textContent=error.message;button.disabled=false;}});
}
function renderAccount(){
  document.getElementById('account').innerHTML=`<span class="mode">${session.kind==='preview'?'全量预览 · 不计入统计':'本次 '+progress.total+' 条 · 已记住进度'}</span><span id="save-state">已连接</span><button class="link-button" id="logout" type="button">${session.kind==='preview'?'退出预览':'保存进度'}</button>`;
  document.getElementById('logout').addEventListener('click',async()=>{try{pauseAll();await flushSave();if(session.kind==='preview'){await api('/api/logout',{});entry();}else toast('进度已保存，可以直接关闭网页。下次会自动继续。');}catch(error){toast(error.message);}});
  if (session.pages_url) {
    const transfer = document.createElement('button');
    transfer.className = 'link-button';
    transfer.type = 'button';
    transfer.textContent = '到公网续评';
    transfer.addEventListener('click', async () => {
      transfer.disabled = true;
      try {
        pauseAll();
        await flushSave();
        const {ticket} = await api('/api/pages/transfer', {});
        window.location.assign(session.pages_url + '#resume=' + encodeURIComponent(ticket));
      } catch (error) {
        toast(error.message);
        transfer.disabled = false;
      }
    });
    document.getElementById('account').append(transfer);
  }
}
async function openTask(id){
  if(busy)return;
  try{pauseAll();dragging=false;dragResume=false;if(task&&task.status!=='submitted')await flushSave();const next=await api('/api/task/'+id);task=next;dirty=false;activeSound='A';
    const stored=localStorage.getItem(storageKey());if(stored&&task.status!=='submitted'){const draft=JSON.parse(stored);if(draft.dirty&&draft.revision===task.revision){task.answers=draft.answers;dirty=true;}}
    render();window.scrollTo({top:0,behavior:'instant'});if(dirty)scheduleSave();
  }catch(error){toast(error.message);}
}
function questionHTML(criterion){
  const locked=task.status==='submitted';
  return `<section class="question" role="group" aria-labelledby="q-${criterion.id}" data-question="${criterion.id}"><div class="question-copy"><h2 id="q-${criterion.id}">${criterion.label}</h2><p>${criterion.hint}</p></div><div class="answer-options">${['A','B','C'].map(slot=>`<label class="choice"><input type="checkbox" data-criterion="${criterion.id}" data-slot="${slot}" aria-label="${criterion.label} 选${slot}" ${locked?'disabled':''}><span>${slot}</span></label>`).join('')}<button type="button" class="special" data-criterion="${criterion.id}" data-special="equal" aria-pressed="false" ${locked?'disabled':''}>都相当</button><button type="button" class="special" data-criterion="${criterion.id}" data-special="none" aria-pressed="false" ${locked?'disabled':''}>都不满意</button><button type="button" class="special" data-criterion="${criterion.id}" data-special="unavailable" aria-pressed="false" ${locked?'disabled':''}>无法判断</button>${criterion.no_visible_mouth?`<button type="button" class="special" data-criterion="${criterion.id}" data-special="no-mouth" aria-pressed="false" ${locked?'disabled':''}>无可见口型</button>`:''}</div></section>`;
}
function sourceScriptPairHTML(text,available,fallback){
  const source=available?text:fallback;
  const sourceLines=source.split(/\r?\n/),targetLines=task.target_text.split(/\r?\n/);
  const rows=available&&sourceLines.length===targetLines.length?sourceLines.map((line,index)=>[line,targetLines[index]]):[[source,task.target_text]];
  return `<section class="source-script-panel" id="source-script-panel" aria-label="原台词与目标台词对照"><div class="script-pair-content" aria-label="原台词与目标台词完整对照"><table class="script-pair-table"><thead><tr><th scope="col">原台词<span>${language[task.source_language]} · MOSS</span></th><th scope="col">目标台词<span>${language[task.target_language]}</span></th></tr></thead><tbody>${rows.map(([original,target])=>`<tr><td class="script-source-cell" lang="${task.source_language}">${esc(original)}</td><td class="script-target-cell" lang="${task.target_language}">${esc(target)}</td></tr>`).join('')}</tbody></table></div></section>`;
}
function playerHTML(asset,slot){
  const name=videoName(slot);
  const text=slot==='source'?(asset.moss_transcript??task.source_text):asset.moss_transcript;
  const available=typeof text==='string'&&text.trim().length>0;
  const fallback=asset.moss_status==='empty'?'MOSS 未识别到可用文本。':'暂无已有 MOSS 转录。';
  const dialogue=slot==='source'?`<div id="source-script-host">${sourceScriptPairHTML(text,available,fallback)}</div>`:`<div class="moss-panel"><h3>MOSS 自动转录</h3><p id="moss-${slot}" class="moss-text ${available?'':'unavailable'}" aria-label="${name}的 MOSS 转录">${esc(available?text:fallback).replace(/\n/g,'<br>')}</p></div>`;
  return `<section class="video-card ${slot==='source'?'source-card':''}" aria-label="${name}播放器"><div class="video-title"><strong>${name}</strong><div><button class="sound-button ${slot===activeSound?'active':''}" data-sound="${slot}" aria-pressed="${slot===activeSound}" aria-label="听${name}声音" type="button">${slot===activeSound?'当前声音':'听声音'}</button><button class="expand-button" data-expand="${slot}" aria-label="放大${name}" type="button">放大</button><button class="hide-column-button" data-hide-column="${slot}" aria-label="隐藏${name}列" title="隐藏此列，可在上方恢复" type="button">${eyeIcon()}</button></div></div><div class="picture ${asset.height>asset.width?'portrait':''}"><video class="comparison-video ${slot==='source'?'source-video':'candidate-video'}" controls playsinline preload="auto" data-slot="${slot}" aria-label="${name}" src="${esc(asset.url)}" ${slot!==activeSound?'muted':''}></video><span class="video-loading" data-loading="${slot}">加载视频…</span></div><div class="individual-controls"><button type="button" class="individual-play" data-play="${slot}" aria-label="播放${name}">播放</button><button type="button" data-replay="${slot}" aria-label="重播${name}">重播</button><span>独立控制</span></div>${dialogue}</section>`;
}
function render(){
  const max=Math.min(task.source.duration,...task.candidates.map(c=>c.duration));
  root.innerHTML=`<section class="comparison"><nav class="case-nav" aria-label="视频切换"><button type="button" id="previous" ${task.index===0?'disabled':''}>← 上一条</button><label class="case-picker"><span class="sr-only">选择视频</span><select id="case-select" aria-label="选择视频">${progress.tasks.map((t,index)=>`<option value="${t.id}" ${t.id===task.id?'selected':''}>${String(index+1).padStart(2,'0')} / ${progress.total} · ${esc(t.label)}${t.status==='submitted'?' ✓':''}</option>`).join('')}</select></label><span class="progress-count">已完成 ${progress.completed} / ${progress.total}</span><button type="button" id="next" ${task.index===progress.total-1?'disabled':''}>下一条 →</button></nav><div class="viewer-heading"><h1>${esc(task.label)}<span>${language[task.source_language]} → ${language[task.target_language]}</span></h1><span class="viewer-hint">自由隐藏列，并排对比</span></div><aside class="comparison-guide" aria-label="对比操作提示"><p><strong>并排查看</strong>点小眼睛隐藏列，其余视频自动展开；再点上方列名恢复。</p><p><strong>切换声音</strong>点「听声音」；单列「播放／重播」也会自动切到该列声音。</p><p><strong>播放比对</strong>各列可独立播放；同步播放／重播只控制显示的列，始终只听一列声音。</p></aside><p class="review-notice" role="note">建议分别播放对比；生成视频的人物动作、表情和画面细节可能与原视频有所不同。</p>${columnControlsHTML()}<div class="transport"><button type="button" id="play-all" class="play-button" aria-label="同步播放当前显示的视频" disabled>同步播放</button><button type="button" id="restart" class="restart-button" aria-label="同步重播当前显示的视频" disabled>同步重播</button><button type="button" id="pause-all" aria-label="暂停全部视频">全部暂停</button><input type="range" id="timeline" min="0" max="${max}" step="0.01" value="0" aria-label="当前显示的视频共同定位进度"><output id="time-label">0:00 / ${formatTime(max)}</output><span class="playback-mode" id="playback-mode">独立播放</span></div><div class="four-videos ${[task.source,...task.candidates].some(v=>v.height>v.width)?'has-portrait':''}">${playerHTML(task.source,'source')}${task.candidates.map(candidate=>playerHTML(candidate,candidate.slot)).join('')}</div><div id="source-script-fallback" class="source-script-fallback" hidden></div><p class="moss-reference-note">MOSS 自动转录仅供参考，可能存在识别误差，请以实际音视频为准。</p><section class="ballot" aria-label="四项偏好评价"><div class="ballot-heading"><strong>${task.status==='submitted'?'已提交的选择':'三个结果中，各方面你更喜欢哪个？'}</strong><span>点 A / B / C，可多选表示并列</span></div>${session.criteria.map(questionHTML).join('')}</section><div class="submit-row"><p id="answer-error" role="alert"></p><span id="answer-count"></span><button type="button" class="primary" id="submit">${task.status==='submitted'?'查看下一条':'提交并下一条'} →</button></div><p class="small-note">${session.kind==='preview'?'预览中的选择不进入人评统计。':'未看完可直接关闭；同一浏览器再次打开会自动继续。'}</p></section>`;
  bindVideos();updateColumnVisibility();renderAnswers();
  root.querySelectorAll('[data-column-toggle]').forEach(button=>button.addEventListener('click',()=>toggleColumn(button.dataset.columnToggle)));
  root.querySelectorAll('[data-hide-column]').forEach(button=>button.addEventListener('click',()=>toggleColumn(button.dataset.hideColumn)));
  document.getElementById('show-all-columns').addEventListener('click',showAllColumns);
  document.getElementById('previous').addEventListener('click',()=>openTask(progress.tasks[task.index-1].id));
  document.getElementById('next').addEventListener('click',()=>openTask(progress.tasks[task.index+1].id));
  document.getElementById('case-select').addEventListener('change',event=>openTask(event.target.value));
  root.querySelectorAll('[data-sound]').forEach(button=>button.addEventListener('click',()=>selectSound(button.dataset.sound)));
  root.querySelectorAll('[data-expand]').forEach(button=>button.addEventListener('click',()=>videos().find(v=>v.dataset.slot===button.dataset.expand).requestFullscreen?.().catch(()=>toast('可使用浏览器放大页面查看。'))));
  root.querySelectorAll('input[data-criterion]').forEach(input=>input.addEventListener('change',()=>{
    const key=input.dataset.criterion;const current=task.answers[key];let choices=current?.status==='chosen'?[...current.choices]:[];
    choices=input.checked?[...new Set([...choices,input.dataset.slot])]:choices.filter(s=>s!==input.dataset.slot);
    if(choices.length)task.answers[key]={status:'chosen',choices:choices.sort()};else delete task.answers[key];
    renderAnswers();scheduleSave();
  }));
  root.querySelectorAll('[data-special]').forEach(button=>button.addEventListener('click',()=>{
    const key=button.dataset.criterion;const type=button.dataset.special;
    const answer=type==='equal'?{status:'chosen',choices:['A','B','C']}:type==='none'?{status:'none'}:{status:'unavailable',reason:type==='no-mouth'?'no_visible_mouth':'cannot_judge'};
    if(JSON.stringify(task.answers[key])===JSON.stringify(answer))delete task.answers[key];else task.answers[key]=answer;
    renderAnswers();scheduleSave();
  }));
  document.getElementById('submit').addEventListener('click',submit);
  saveState(dirty?'正在保存…':'已保存');
}
function renderAnswers(){
  for(const criterion of session.criteria){
    const value=task.answers[criterion.id];const row=root.querySelector(`[data-question="${criterion.id}"]`);
    row.classList.toggle('answered',Boolean(value));if(value)row.classList.remove('invalid');
    row.querySelectorAll('input[data-slot]').forEach(input=>{input.checked=value?.status==='chosen'&&value.choices.includes(input.dataset.slot);});
    row.querySelectorAll('[data-special]').forEach(button=>{
      const type=button.dataset.special;const selected=type==='equal'?value?.status==='chosen'&&value.choices.length===3:type==='none'?value?.status==='none':value?.status==='unavailable'&&value.reason===(type==='no-mouth'?'no_visible_mouth':'cannot_judge');
      button.setAttribute('aria-pressed',String(Boolean(selected)));
    });
  }
  document.getElementById('answer-count').textContent=task.status==='submitted'?'本条已保存，可回看。':`${Object.keys(task.answers).length} / 4 已选`;
}
function selectSound(slot){
  if(hiddenVideoSlots.has(slot)||!videoSlots.includes(slot))return;
  activeSound=slot;videos().forEach(video=>{video.muted=video.dataset.slot!==slot;});
  root.querySelectorAll('[data-sound]').forEach(button=>{const selected=button.dataset.sound===slot;button.classList.toggle('active',selected);button.textContent=selected?'当前声音':'听声音';button.setAttribute('aria-pressed',String(selected));});
}
function formatTime(value){const seconds=Math.floor(Number(value)||0);return `${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`;}
function independentMode(){playbackMode='independent';syncWanted=false;updatePlaybackMode();}
function updatePlaybackMode(){const el=document.getElementById('playback-mode');if(el){el.textContent=playbackMode==='sync'&&syncWanted?'同步播放中':'独立播放';el.classList.toggle('is-sync',playbackMode==='sync'&&syncWanted);}}
function updateIndividualButton(video){const button=root.querySelector(`[data-play="${video.dataset.slot}"]`);if(button){button.textContent=video.paused?'播放':'暂停';button.setAttribute('aria-label',(video.paused?'播放':'暂停')+videoName(video.dataset.slot));}}
function pauseAll(){independentMode();cancelAnimationFrame(frame);videos().forEach(video=>video.pause());}
async function playOne(video,restart=false){
  if(!video||hiddenVideoSlots.has(video.dataset.slot))return;
  independentMode();selectSound(video.dataset.slot);
  if(restart&&video.readyState>=1)video.currentTime=0;
  try{await video.play();kickClock();}catch(error){if(error.name!=='AbortError')toast('视频暂未准备好，请稍后重试。');}
}
function setVideoTime(video,time){if(video.readyState>=1){const target=Math.min(time,video.duration);expectedSeekTargets.set(video,target);video.currentTime=target;}}
async function playAll(restart=false){
  const list=visibleVideos();if(!list.length)return;
  const range=document.getElementById('timeline');const target=restart?0:Number(range.value);
  playbackMode='sync';syncWanted=true;updatePlaybackMode();
  for(const video of list){expectedSyncPauses.delete(video);if(!video.paused){expectedSyncPauses.add(video);video.pause();}setVideoTime(video,target);}
  selectSound(activeSound);
  const results=await Promise.allSettled(list.map(video=>{expectedSyncPlays.add(video);return video.play();}));
  if(playbackMode!=='sync'||!syncWanted)return;
  if(results.some(r=>r.status==='rejected'&&r.reason?.name!=='AbortError')){pauseAll();toast('部分视频尚未准备好，请稍后重试同步播放。');return;}
  kickClock();
}
function seekAll(value){
  const time=Number(value);visibleVideos().forEach(video=>setVideoTime(video,time));
  const slider=document.getElementById('timeline');slider.value=String(time);document.getElementById('time-label').textContent=formatTime(time)+' / '+formatTime(slider.max);
}
function tick(){
  if(dragging)return;
  const list=visibleVideos();const leader=list.find(video=>video.dataset.slot===activeSound)||list[0];
  if(!leader)return;
  if(playbackMode==='sync'&&syncWanted)for(const video of list){if(video!==leader&&video.readyState>=2&&!video.seeking&&Math.abs(video.currentTime-leader.currentTime)>.15)setVideoTime(video,leader.currentTime);}
  const slider=document.getElementById('timeline');if(slider){slider.value=leader.currentTime;document.getElementById('time-label').textContent=formatTime(leader.currentTime)+' / '+formatTime(slider.max);}
  if(playbackMode==='sync'&&syncWanted&&leader.ended){pauseAll();return;}
  if(list.some(video=>!video.paused))frame=requestAnimationFrame(tick);
}
function kickClock(){cancelAnimationFrame(frame);frame=requestAnimationFrame(tick);}
function bindVideos(){
  const list=videos();
  const readiness=updateSyncControls;
  list.forEach(video=>{
    video.muted=video.dataset.slot!==activeSound;
    video.addEventListener('loadeddata',()=>{root.querySelector(`[data-loading="${video.dataset.slot}"]`).hidden=true;readiness();});
    video.addEventListener('canplay',readiness);
    video.addEventListener('error',()=>{const el=root.querySelector(`[data-loading="${video.dataset.slot}"]`);el.hidden=false;el.textContent='加载失败，请重试本条';readiness();});
    video.addEventListener('play',()=>{if(hiddenVideoSlots.has(video.dataset.slot)){expectedSyncPlays.delete(video);video.pause();video.muted=true;return;}const fromSync=playbackMode==='sync'&&syncWanted&&expectedSyncPlays.has(video);expectedSyncPlays.delete(video);if(!fromSync){independentMode();selectSound(video.dataset.slot);}updateIndividualButton(video);kickClock();});
    video.addEventListener('pause',()=>{if(expectedSyncPauses.has(video))expectedSyncPauses.delete(video);else if(playbackMode==='sync'&&!hiddenVideoSlots.has(video.dataset.slot))independentMode();updateIndividualButton(video);});
    video.addEventListener('seeking',()=>{const target=expectedSeekTargets.get(video);if(target===undefined||Math.abs(video.currentTime-target)>.25)independentMode();updateIndividualButton(video);});
    video.addEventListener('seeked',()=>expectedSeekTargets.delete(video));
    video.addEventListener('volumechange',()=>{if(hiddenVideoSlots.has(video.dataset.slot)){video.muted=true;return;}if(!video.muted&&video.dataset.slot!==activeSound)selectSound(video.dataset.slot);});
    video.addEventListener('ended',()=>{updateIndividualButton(video);if(playbackMode==='sync'&&syncWanted&&!hiddenVideoSlots.has(video.dataset.slot)){const end=Math.min(...visibleVideos().map(v=>v.duration||Infinity));if(video.currentTime>=end-.15){seekAll(end);pauseAll();}}});
  });
  root.querySelectorAll('[data-play]').forEach(button=>button.addEventListener('click',()=>{const video=list.find(v=>v.dataset.slot===button.dataset.play);if(video.paused)playOne(video);else{independentMode();video.pause();}}));
  root.querySelectorAll('[data-replay]').forEach(button=>button.addEventListener('click',()=>playOne(list.find(v=>v.dataset.slot===button.dataset.replay),true)));
  document.getElementById('play-all').addEventListener('click',()=>playAll(false));
  document.getElementById('restart').addEventListener('click',()=>playAll(true));
  document.getElementById('pause-all').addEventListener('click',pauseAll);
  const slider=document.getElementById('timeline');
  slider.addEventListener('input',()=>{if(!dragging){dragResume=playbackMode==='sync'&&syncWanted;pauseAll();dragging=true;}seekAll(slider.value);});
  slider.addEventListener('change',()=>{seekAll(slider.value);dragging=false;if(dragResume)playAll();dragResume=false;});
}
async function submit(){
  if(busy)return;
  if(task.status==='submitted'){const next=progress.tasks.find(t=>t.status!=='submitted');if(next)openTask(next.id);else toast('本组已全部完成，感谢参与。');return;}
  let missing=false;for(const c of session.criteria)if(!task.answers[c.id]){root.querySelector(`[data-question="${c.id}"]`).classList.add('invalid');missing=true;}
  const error=document.getElementById('answer-error');if(missing){error.textContent='请完成四个选择。';root.querySelector('.invalid input')?.focus();return;}
  pauseAll();busy=true;document.getElementById('submit').disabled=true;error.textContent='';
  try{await flushSave();const result=await api('/api/task/'+task.id+'/submit',{revision:task.revision,answers:task.answers});progress=result.progress;task.revision=result.revision;task.status='submitted';dirty=false;localStorage.removeItem(storageKey());busy=false;
    const next=progress.tasks.find(t=>t.status!=='submitted');if(next)await openTask(next.id);else{render();toast('本组已完成，感谢参与。');}toast('已提交。');
  }catch(err){error.textContent=err.message;document.getElementById('submit').disabled=false;busy=false;}
}
window.addEventListener('beforeunload',()=>{if(dirty)stash();});
document.addEventListener('visibilitychange',()=>{if(document.hidden&&dirty)flushSave().catch(()=>{});});
async function boot(){try{session=await api('/api/session');const label=document.querySelector('.dataset-label');if(label&&session.study)label.textContent=session.study.label;if(!session.authenticated)return entry(session.login_code);progress=session.progress;renderAccount();await openTask(progress.tasks.find(t=>t.status!=='submitted')?.id||progress.tasks[0].id);}catch(error){root.innerHTML=`<p class="loading">${esc(error.message)}，请刷新重试。</p>`;}}
async function startPagesReview() {
  const ticket = new URLSearchParams(window.location.hash.slice(1)).get('resume');
  let transferError;
  if (ticket) {
    history.replaceState(null, '', window.location.pathname + window.location.search);
    try {
      await api('/api/pages/resume', {ticket});
    } catch (error) {
      transferError = error.message;
    }
  }
  await boot();
  if (transferError) toast(transferError);
}
startPagesReview();
