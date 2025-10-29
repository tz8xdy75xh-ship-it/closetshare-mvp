
const state = { me: null, connected: false };

async function api(path, opts={}){
  const res = await fetch(path, { headers:{'Content-Type':'application/json', ...(opts.headers||{})}, ...opts });
  if(!res.ok){
    const t = await res.text();
    throw new Error(t || (res.status+''));
  }
  return res.json();
}
const el = q => document.querySelector(q);

function toggleFields(){
  const mode = el('#mode').value;
  el('#rentFields').style.display = mode==='rent' ? '' : 'none';
  el('#sellFields').style.display = mode==='sell' ? '' : 'none';
}
if(document.querySelector('#mode')){
  document.querySelector('#mode').addEventListener('change', toggleFields);
  toggleFields();
}

// Auth
const loginBtn = document.querySelector('#loginBtn');
if(loginBtn){
  loginBtn.onclick = async ()=>{
    const name = el('#name').value || 'Guest';
    const phone = el('#phone').value || '';
    const data = await api('/api/login',{ method:'POST', body: JSON.stringify({name, phone})});
    state.me = data.user;
    el('#meInfo').textContent = `ID: ${state.me.id} / 信頼: ${data.trust}`;
    await refreshConnectStatus();
    refreshItems();
  };
}

// Stripe Connect Onboarding
const connectBtn = document.querySelector('#connectBtn');
if(connectBtn){
  connectBtn.onclick = async ()=>{
    if(!state.me) return alert('先にログインしてね');
    const r = await api('/api/connect/create-link',{ method:'POST', body: JSON.stringify({ userId: state.me.id })});
    location.href = r.url;
  };
}
async function refreshConnectStatus(){
  if(!state.me) return;
  const s = await api('/api/connect/status/'+state.me.id);
  state.connected = s.connected;
  const cs = document.querySelector('#connectStatus'); if(cs) cs.textContent = state.connected ? '口座登録OK' : '未登録';
}

// List an item
const listBtn = document.querySelector('#listBtn');
if(listBtn){
  listBtn.onclick = async ()=>{
    if(!state.me) return alert('先にログインしてね');
    const mode = el('#mode').value;
    const payload = {
      ownerId: state.me.id,
      mode,
      title: el('#title').value,
      city: el('#city').value,
      pricePerDay: mode==='rent' ? Number(el('#pricePerDay').value||0) : null,
      deposit: mode==='rent' ? Number(el('#deposit').value||0) : null,
      priceSell: mode==='sell' ? Number(el('#priceSell').value||0) : null,
      desc: el('#desc').value
    };
    const item = await api('/api/items',{ method:'POST', body: JSON.stringify(payload)});
    alert('出品追加: '+item.id);
    refreshItems();
  };
}

async function refreshItems(){
  const itemsBox = document.querySelector('#items');
  if(!itemsBox) return;
  const list = await api('/api/items');
  itemsBox.innerHTML = '';
  list.forEach(item=>{
    const div = document.createElement('div');
    div.className = 'card';
    const modeLabel = item.mode==='rent' ? 'レンタル' : '販売';
    const priceLabel = item.mode==='rent' ? `¥${item.pricePerDay}/日` : `¥${item.priceSell}`;
    div.innerHTML = `
      <h3>${item.title}
        <span class="badge mode-badge">${modeLabel}</span>
        <span class="badge">${priceLabel}</span>
      </h3>
      <div>${item.city} / 出品者: ${item.ownerId}</div>
      <p>${item.desc||''}</p>
      <div class="actions"></div>
    `;
    const actions = div.querySelector('.actions');
    if(item.mode==='rent'){
      const s = document.createElement('input'); s.type='date'; s.className='start';
      const e = document.createElement('input'); e.type='date'; e.className='end';
      const btn = document.createElement('button'); btn.textContent='レンタル予約→決済';
      btn.onclick = async ()=>{
        if(!state.me) return alert('先にログインしてね');
        try{
          const booking = await api('/api/bookings',{ method:'POST', body: JSON.stringify({
            itemId: item.id, borrowerId: state.me.id, startDate: s.value, endDate: e.value
          })});
          const checkout = await api('/api/pay/checkout',{ method:'POST', body: JSON.stringify({ type:'rent', id: booking.id })});
          location.href = checkout.url;
        }catch(err){ alert('エラー: '+err.message); }
      };
      actions.appendChild(s); actions.appendChild(e); actions.appendChild(btn);
    } else {
      const btn = document.createElement('button'); btn.textContent='今すぐ購入→決済';
      btn.onclick = async ()=>{
        if(!state.me) return alert('先にログインしてね');
        try{
          const order = await api('/api/orders',{ method:'POST', body: JSON.stringify({ itemId: item.id, buyerId: state.me.id })});
          const checkout = await api('/api/pay/checkout',{ method:'POST', body: JSON.stringify({ type:'sell', id: order.id })});
          location.href = checkout.url;
        }catch(err){ alert('エラー: '+err.message); }
      };
      actions.appendChild(btn);
    }
    itemsBox.appendChild(div);
  });
}
refreshItems();
