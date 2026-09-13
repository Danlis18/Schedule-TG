const $ = (s, root=document) => root.querySelector(s);
const $$ = (s, root=document) => [...root.querySelectorAll(s)];
const state = { token: localStorage.getItem('levelup_token') || '', data: null, selectedDate: isoDate(), filter: 'all' };
const days = ['Нд','Пн','Вт','Ср','Чт','Пт','Сб'];
const months = ['січня','лютого','березня','квітня','травня','червня','липня','серпня','вересня','жовтня','листопада','грудня'];
const categories = { growth:'Розвиток', health:'Здоров’я', work:'Робота', balance:'Баланс' };
function isoDate(d=new Date()){return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,10)}
function money(n){return new Intl.NumberFormat('uk-UA',{maximumFractionDigits:0}).format(n||0)}
async function request(path, options={}){const res=await fetch(path,{...options,headers:{'content-type':'application/json',...(state.token?{authorization:`Bearer ${state.token}`}:{}) ,...(options.headers||{})}});const data=await res.json().catch(()=>({}));if(!res.ok)throw new Error(data.error||'Сталася помилка');return data}
function toast(message, ok=true){const el=$('#toast');$('span',el).textContent=ok?'✓':'!';$('p',el).textContent=message;el.classList.add('show');clearTimeout(toast.timer);toast.timer=setTimeout(()=>el.classList.remove('show'),2800)}
function celebrate(){const box=$('#celebration');for(let i=0;i<24;i++){const p=document.createElement('i');p.className='confetti';p.textContent=['★','✦','•'][i%3];p.style.left=`${Math.random()*100}%`;p.style.setProperty('--drift',`${(Math.random()-.5)*180}px`);p.style.animationDelay=`${Math.random()*.35}s`;p.style.fontSize=`${8+Math.random()*12}px`;box.append(p);setTimeout(()=>p.remove(),2400)}}
function setToken(token){state.token=token;localStorage.setItem('levelup_token',token)}

async function init(){
  window.Telegram?.WebApp?.ready?.(); window.Telegram?.WebApp?.expand?.();
  setupAuth(); setupNavigation(); setupModals(); setupForms(); setupEmoji();
  const tg=window.Telegram?.WebApp; if(tg?.initData){$('#telegramLogin').classList.remove('hidden');$('#telegramLogin').onclick=()=>telegramAuth(tg.initData).catch(error=>toast(error.message,false))}
  registerWebMCP();
  if(state.token){try{await load();return}catch{localStorage.removeItem('levelup_token');state.token=''}}
  if(tg?.initData){try{await telegramAuth(tg.initData);return}catch{}}
  showAuth();
}
function registerWebMCP(){
  const context=document.modelContext;if(!context?.registerTool)return;
  const register=tool=>Promise.resolve(context.registerTool(tool)).catch(()=>{});
  register({name:'read_weekly_progress',title:'Переглянути прогрес',description:'Повертає поточний баланс, серію та продуктивність за сім днів.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true,untrustedContentHint:false},execute:async()=>{if(!state.data)throw new Error('Користувач не увійшов');const {user,dashboard}=state.data;return{stars:user.stars,savedMoney:user.savedMoney,streak:dashboard.streak,productivity:dashboard.productivity}}});
  register({name:'create_daily_quest',title:'Створити квест',description:'Створює нове щоденне завдання з указаною нагородою в зірках.',inputSchema:{type:'object',properties:{title:{type:'string'},stars:{type:'integer',minimum:1,maximum:999},date:{type:'string',description:'Дата YYYY-MM-DD'},emoji:{type:'string'}},required:['title','stars'],additionalProperties:false},annotations:{readOnlyHint:false,untrustedContentHint:false},execute:async input=>{if(!state.data)throw new Error('Користувач не увійшов');const task=await request('/api/tasks',{method:'POST',body:JSON.stringify({...input,date:input.date||isoDate(),category:'growth'})});await load();return{id:task.id,title:task.title,stars:task.stars,date:task.date}}});
  register({name:'record_income',title:'Записати дохід',description:'Додає надходження до фінансового щоденника.',inputSchema:{type:'object',properties:{amount:{type:'number',exclusiveMinimum:0},source:{type:'string'},note:{type:'string'},toSavings:{type:'number',minimum:0}},required:['amount','source'],additionalProperties:false},annotations:{readOnlyHint:false,untrustedContentHint:false},execute:async input=>{if(!state.data)throw new Error('Користувач не увійшов');const income=await request('/api/incomes',{method:'POST',body:JSON.stringify({...input,date:isoDate()})});await load();return{id:income.id,amount:income.amount,source:income.source}}});
}
function showAuth(){ $('#authScreen').classList.remove('hidden');$('#app').classList.add('hidden') }
function showApp(){ $('#authScreen').classList.add('hidden');$('#app').classList.remove('hidden') }
function setupAuth(){
  let mode='login';
  $$('[data-auth-tab]').forEach(btn=>btn.onclick=()=>{mode=btn.dataset.authTab;$$('[data-auth-tab]').forEach(x=>x.classList.toggle('active',x===btn));$('.register-only').classList.toggle('hidden',mode==='login');$('#authError').textContent='';});
  $('#authForm').onsubmit=async e=>{e.preventDefault();const form=Object.fromEntries(new FormData(e.currentTarget));try{$('#authSubmitText').textContent='Зачекай…';const result=await request(`/api/auth/${mode}`,{method:'POST',body:JSON.stringify(form)});setToken(result.token);await load();toast(mode==='login'?'Радий бачити знову!':'Твоя нова гра починається!')}catch(err){$('#authError').textContent=err.message}finally{$('#authSubmitText').textContent='Продовжити'}};
  $('#logoutBtn').onclick=()=>{localStorage.removeItem('levelup_token');state.token='';state.data=null;showAuth()};
}
async function telegramAuth(initData){const result=await request('/api/auth/telegram',{method:'POST',body:JSON.stringify({initData})});setToken(result.token);await load();return result}
async function load(){state.data=await request('/api/bootstrap');showApp();render()}

function setupNavigation(){
  $$('[data-view]').forEach(btn=>btn.onclick=()=>switchView(btn.dataset.view));
  $$('[data-view-jump]').forEach(btn=>btn.onclick=()=>switchView(btn.dataset.viewJump));
}
function switchView(name){$$('.view').forEach(v=>v.classList.toggle('active',v.id===`view-${name}`));$$('[data-view]').forEach(b=>b.classList.toggle('active',b.dataset.view===name));window.scrollTo({top:0,behavior:'smooth'})}
function setupModals(){
  $$('[data-open]').forEach(btn=>btn.onclick=()=>openModal(btn.dataset.open));
  $$('[data-close]').forEach(btn=>btn.onclick=closeModals);$('#modalBackdrop').onclick=closeModals;
  $$('dialog').forEach(d=>d.addEventListener('cancel',e=>{e.preventDefault();closeModals()}));
}
function openModal(id){const modal=$(`#${id}`);if(!modal)return;const tomorrow=new Date();tomorrow.setDate(tomorrow.getDate()+1);const dateInput=$('input[name="date"]',modal);if(dateInput)dateInput.value=id==='taskModal'?isoDate(tomorrow):isoDate();$('#modalBackdrop').classList.remove('hidden');modal.showModal()}
function closeModals(){$$('dialog[open]').forEach(d=>d.close());$('#modalBackdrop').classList.add('hidden')}
function setupEmoji(){const items=['🎯','🧠','📚','💪','🏃','💧','💼','💻','🧘','🎨','🚀','🏆','⭐','❤️'];[['#taskEmoji','🎯'],['#rewardEmoji','🏆']].forEach(([selector,initial])=>{const box=$(selector);items.forEach(icon=>{const b=document.createElement('button');b.type='button';b.textContent=icon;b.setAttribute('aria-label',`Обрати ${icon}`);b.classList.toggle('active',icon===initial);b.onclick=()=>{$$('button',box).forEach(x=>x.classList.remove('active'));b.classList.add('active');box.nextElementSibling.value=icon};box.append(b)})})}
function setupForms(){
  $('#taskForm').onsubmit=e=>submitForm(e,'/api/tasks','Квест додано до плану');
  $('#incomeForm').onsubmit=e=>submitForm(e,'/api/incomes','Дохід зафіксовано');
  $('#rewardForm').onsubmit=e=>submitForm(e,'/api/rewards','Нове бажання додано');
  $('#savingsForm').onsubmit=e=>submitForm(e,'/api/savings','Баланс скарбнички оновлено');
  $$('.segmented button').forEach(btn=>btn.onclick=()=>{state.filter=btn.dataset.filter;$$('.segmented button').forEach(x=>x.classList.toggle('active',x===btn));renderTaskBoard()});
}
async function submitForm(e,path,message){e.preventDefault();const form=e.currentTarget;const payload=Object.fromEntries(new FormData(form));$$('button',form).forEach(b=>b.disabled=true);try{await request(path,{method:'POST',body:JSON.stringify(payload)});closeModals();form.reset();await load();toast(message)}catch(err){toast(err.message,false)}finally{$$('button',form).forEach(b=>b.disabled=false)}}

function render(){const {user,dashboard}=state.data;$('#profileName').textContent=user.name;$('#avatar').textContent=(user.name||'Г')[0].toUpperCase();$('#greeting').textContent=`Вітаю, ${(user.name||'Гравець').split(' ')[0]}!`;const d=new Date();$('#dayLabel').textContent=`${days[d.getDay()]}, ${d.getDate()} ${months[d.getMonth()]}`;updateBalances();renderDashboard();renderDates();renderTaskBoard();renderIncome();renderShop();renderStats();$('#sideQuote').textContent=dashboard.quote[0]}
function updateBalances(){const u=state.data.user;$('#starBalance').textContent=money(u.stars);$('#moneyBalance').textContent=money(u.savedMoney);$('#shopStars').textContent=money(u.stars);$('#shopMoney').textContent=money(u.savedMoney);$('#savingsTotal').textContent=`$${money(u.savedMoney)}`}
function progress(el,percent,total=314){el.style.strokeDashoffset=total-(total*Math.min(100,percent)/100)}
function taskRow(task){const row=document.createElement('div');row.className=`task-row ${task.completed?'done':''}`;row.innerHTML=`<button class="task-check" aria-label="${task.completed?'Скасувати виконання':'Виконати'}">✓</button><div><div class="task-title"><span>${escapeHTML(task.emoji)}</span> ${escapeHTML(task.title)}</div><div class="task-cat">${categories[task.category]||'Особисте'}</div></div><span class="star-chip">★ ${task.stars}</span><button class="delete-task" aria-label="Видалити">×</button>`;$('.task-check',row).onclick=()=>toggleTask(task.id,!task.completed);$('.delete-task',row).onclick=()=>deleteTask(task.id);return row}
function renderDashboard(){const d=state.data.dashboard;const total=d.today.length,done=d.today.filter(x=>x.completed).length,pct=total?Math.round(done/total*100):0;$('#todayPercent').textContent=`${pct}%`;progress($('.hero-orb .progress'),pct);$('#heroSummary').textContent=total?`${done} із ${total} квестів завершено. ${total-done?'Наступний крок уже чекає.':'День закрито ідеально!'}`:'Твій чистий аркуш. Додай перший квест.';$('#streakCount').textContent=d.streak;$('#dailyQuote').textContent=d.quote[0];$('#quoteAuthor').textContent=d.quote[1];const list=$('#todayTasks');list.innerHTML='';d.today.slice(0,5).forEach(t=>list.append(taskRow(t)));if(!d.today.length)list.innerHTML='<div class="empty"><b>Сьогодні ще немає квестів</b>Створи один — і день отримає напрям.</div>';const bars=$('#miniBars');bars.innerHTML='';d.week.forEach((x,i)=>{const b=document.createElement('i');b.style.height=`${Math.max(7,x.percent)}%`;b.classList.toggle('active',i===6);bars.append(b)});$('#weekDone').textContent=d.week.reduce((s,x)=>s+x.done,0);const prev=d.week.slice(0,3).reduce((s,x)=>s+x.percent,0)/3||0,last=d.week.slice(4).reduce((s,x)=>s+x.percent,0)/3||0;$('#weekChange').textContent=`${last>=prev?'↑':'↓'} ${Math.abs(Math.round(last-prev))}%`}
function renderDates(){const box=$('#dateStrip');box.innerHTML='';for(let i=-3;i<=3;i++){const d=new Date();d.setDate(d.getDate()+i);const date=isoDate(d);const b=document.createElement('button');b.className=`date-btn ${date===state.selectedDate?'active':''}`;b.innerHTML=`<small>${i===0?'Сьогодні':days[d.getDay()]}</small><b>${d.getDate()}</b>`;b.onclick=()=>{state.selectedDate=date;renderDates();renderTaskBoard()};box.append(b)}}
function renderTaskBoard(){if(!state.data)return;let tasks=state.data.tasks.filter(x=>x.date===state.selectedDate);if(state.filter==='done')tasks=tasks.filter(x=>x.completed);if(state.filter==='open')tasks=tasks.filter(x=>!x.completed);$('#taskCounter').textContent=`${tasks.length} ${tasks.length===1?'завдання':'завдань'}`;const box=$('#taskBoard');box.innerHTML='';tasks.forEach(t=>box.append(taskRow(t)));if(!tasks.length)box.innerHTML='<div class="empty"><b>Тут поки тихо</b>Додай завдання або обери інший день.</div>'}
async function toggleTask(id,wasOpen){try{const result=await request(`/api/tasks/${id}/toggle`,{method:'PATCH'});await load();if(wasOpen){celebrate();toast(`+${result.task.stars} зірок. Чудовий рух!`)}}catch(err){toast(err.message,false)}}
async function deleteTask(id){if(!confirm('Видалити це завдання?'))return;try{await request(`/api/tasks/${id}`,{method:'DELETE'});await load();toast('Завдання видалено')}catch(err){toast(err.message,false)}}
function renderIncome(){const d=state.data;$('#monthIncome').textContent=`$${money(d.dashboard.monthIncome)}`;const wave=$('#moneyWave');wave.innerHTML='';[28,44,35,63,52,82,70,100].forEach(h=>{const i=document.createElement('i');i.style.height=`${h}%`;wave.append(i)});const list=$('#incomeList');list.innerHTML='';d.incomes.slice(0,10).forEach(x=>{const row=document.createElement('div');row.className='ledger-row';row.innerHTML=`<span class="ledger-icon">↗</span><div><b>${escapeHTML(x.source)}</b><small>${formatDate(x.date)}${x.note?` · ${escapeHTML(x.note)}`:''}</small></div><b class="ledger-amount">+ $${money(x.amount)}</b>`;list.append(row)});if(!d.incomes.length)list.innerHTML='<div class="empty"><b>Надходжень ще немає</b>Перший запис створить твою фінансову історію.</div>'}
function renderShop(){const box=$('#rewardGrid');box.innerHTML='';const u=state.data.user;state.data.rewards.forEach(r=>{const can=u.stars>=r.price&&u.savedMoney>=r.money;const card=document.createElement('article');card.className='reward-card';card.innerHTML=`<span class="reward-emoji">${escapeHTML(r.emoji)}</span><h3>${escapeHTML(r.title)}</h3><div class="reward-price"><span class="gold">★ ${money(r.price)}</span>${r.money?`<span>+</span><span class="mint">$${money(r.money)}</span>`:''}</div><button ${can?'':'disabled'}>${can?'Забрати нагороду':'Ще трохи попрацювати'}</button>`;$('button',card).onclick=()=>buyReward(r.id);box.append(card)});if(!state.data.rewards.length)box.innerHTML='<div class="empty"><b>Створи перше бажання</b>Нехай у дисципліни буде приємна мета.</div>'}
async function buyReward(id){if(!confirm('Обміняти накопичені зірки та гроші на цю нагороду?'))return;try{await request(`/api/rewards/${id}/buy`,{method:'POST'});await load();celebrate();toast('Нагорода твоя. Ти її заслужив!')}catch(err){toast(err.message,false)}}
function renderStats(){const d=state.data.dashboard;$('#statPercent').textContent=`${d.productivity}%`;progress($('#statRing'),d.productivity,452);$('#statStreak').textContent=d.streak;$('#earnedStars').textContent=money(state.data.tasks.filter(x=>x.completed).reduce((s,x)=>s+x.stars,0));$('#statMessage').textContent=d.productivity>=80?'Сильний тиждень. Тримай цей темп.':d.productivity>=50?'Хороший ритм. Ще трохи фокусу.':'Не тисни на себе — повернися до одного кроку.';const chart=$('#weeklyChart');chart.innerHTML='';d.week.forEach((x,i)=>{const col=document.createElement('div');col.className=`bar-col ${i===6?'active':''}`;const dt=new Date(`${x.date}T12:00:00`);col.innerHTML=`<span>${x.percent}%</span><i style="--h:${Math.max(4,x.percent)}%"></i><b>${days[dt.getDay()]}</b>`;chart.append(col)})}
function formatDate(date){const d=new Date(`${date}T12:00:00`);return `${d.getDate()} ${months[d.getMonth()]}`}
function escapeHTML(value){const el=document.createElement('div');el.textContent=String(value??'');return el.innerHTML}
document.addEventListener('DOMContentLoaded',()=>{
  init();
  if('serviceWorker' in navigator){navigator.serviceWorker.register('/sw.js').catch(()=>{});}
});
