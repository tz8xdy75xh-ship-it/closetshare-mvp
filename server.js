
import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { nanoid } from 'nanoid';
import Stripe from 'stripe';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

const DATA_PATH = path.join(__dirname, 'data', 'db.json');
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;
const PLATFORM_FEE_BPS = Number(process.env.PLATFORM_FEE_BPS || '1000'); // 10% default

const stripeKey = process.env.STRIPE_SECRET_KEY;
const stripe = stripeKey ? new Stripe(stripeKey) : null;

// ---------- DB helpers ----------
function readDB(){
  const raw = fs.readFileSync(DATA_PATH, 'utf8');
  return JSON.parse(raw);
}
function writeDB(db){
  fs.writeFileSync(DATA_PATH, JSON.stringify(db, null, 2), 'utf8');
}
function audit(action, detail, by='system'){
  const db = readDB();
  db.audit.push({ id: nanoid(8), action, detail, by, at: new Date().toISOString() });
  if(db.audit.length > 1000) db.audit = db.audit.slice(-1000);
  writeDB(db);
}
function trustScore(userId){
  const db = readDB();
  const user = db.users.find(u=>u.id===userId);
  if(!user) return 0;
  const rating = user.score || 0;
  const completed = db.bookings.filter(b=>b.status==='completed' && (b.borrowerId===userId || b.ownerId===userId)).length;
  const orders = db.orders.filter(o=>o.status==='paid' && (o.buyerId===userId || o.sellerId===userId)).length;
  const component = (rating/5)*70 + Math.min(completed+orders, 20) + 10;
  return Math.round(component);
}

// ---------- Stripe webhook (raw body) ----------
app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), (req, res) => {
  if (!stripe) return res.status(400).send('Stripe not configured');
  const sig = req.headers['stripe-signature'];
  const whSecret = process.env.STRIPE_WEBHOOK_SECRET;
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, whSecret);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const type = session.metadata?.type;
    const db = readDB();

    if (type === 'rent') {
      const bookingId = session.metadata?.bookingId;
      const b = db.bookings.find(x => x.id === bookingId);
      if (b) {
        b.status = 'approved'; // 保証なしMVP: 決済完了で承認
        writeDB(db);
        audit('rent_paid_approved', bookingId, 'stripe');
      }
    } else if (type === 'sell') {
      const orderId = session.metadata?.orderId;
      const o = db.orders.find(x => x.id === orderId);
      if (o) {
        o.status = 'paid';
        writeDB(db);
        audit('sell_paid', orderId, 'stripe');
      }
    }
  }

  res.json({ received: true });
});

// after webhook, use JSON for others
app.use(express.json());

// ---------- Auth ----------
app.post('/api/login', (req,res)=>{
  const { name, phone } = req.body;
  const db = readDB();
  let user = db.users.find(u=>u.phone===phone) || db.users.find(u=>u.name===name);
  if(!user){
    user = { id: nanoid(6), name: name || 'Guest', phone: phone || '', score: 4.0, reviews: 0, role:'user', stripeAccountId:'' };
    db.users.push(user);
    writeDB(db);
    audit('signup','new user '+user.id, user.id);
  }else{
    audit('login','user '+user.id, user.id);
  }
  res.json({ ok:true, user, trust: trustScore(user.id) });
});

// ---------- Connect onboarding ----------
app.post('/api/connect/create-link', async (req,res)=>{
  try{
    if(!stripe) return res.status(400).json({error:'Stripe not configured'});
    const { userId } = req.body;
    const db = readDB();
    const user = db.users.find(u=>u.id===userId);
    if(!user) return res.status(404).json({error:'user not found'});

    if(!user.stripeAccountId){
      const account = await stripe.accounts.create({ type: 'standard' });
      user.stripeAccountId = account.id;
      writeDB(db);
      audit('connect_account_created', account.id, userId);
    }
    const link = await stripe.accountLinks.create({
      account: user.stripeAccountId,
      refresh_url: `${BASE_URL}/onboarding-refresh`,
      return_url: `${BASE_URL}/onboarding-done`,
      type: 'account_onboarding'
    });
    res.json({ url: link.url });
  }catch(e){
    res.status(500).json({error:e.message});
  }
});

app.get('/api/connect/status/:userId', async (req,res)=>{
  try{
    if(!stripe) return res.status(400).json({error:'Stripe not configured'});
    const db = readDB();
    const user = db.users.find(u=>u.id===req.params.userId);
    if(!user || !user.stripeAccountId) return res.json({ connected: false });
    const acct = await stripe.accounts.retrieve(user.stripeAccountId);
    res.json({ connected: acct.details_submitted && !(acct.requirements?.currently_due||[]).length, accountId: user.stripeAccountId });
  }catch(e){
    res.status(500).json({error:e.message});
  }
});

// ---------- Items (rent or sell) ----------
app.get('/api/items', (req,res)=>{
  const db = readDB();
  res.json(db.items);
});
app.post('/api/items', (req,res)=>{
  const { ownerId, mode, title, city, pricePerDay, deposit, priceSell, desc } = req.body;
  const db = readDB();
  const item = { id: nanoid(6), ownerId, mode, title, city, pricePerDay, deposit, priceSell, images:[], desc, available:true };
  db.items.push(item);
  writeDB(db);
  audit('create_item', `${item.id}:${mode}`, ownerId);
  res.json(item);
});

// ---------- Rental bookings ----------
function overlap(aStart, aEnd, bStart, bEnd){
  return (aStart <= bEnd) && (bStart <= aEnd);
}
app.post('/api/bookings', (req,res)=>{
  const { itemId, borrowerId, startDate, endDate } = req.body;
  const db = readDB();
  const item = db.items.find(i=>i.id===itemId);
  if(!item) return res.status(404).json({error:'item not found'});
  if(item.mode!=='rent') return res.status(400).json({error:'item not rent mode'});
  const s = new Date(startDate);
  const e = new Date(endDate);
  if(!(s<e)) return res.status(400).json({error:'invalid dates'});
  const conflicts = db.bookings.filter(b=>b.itemId===itemId && ['pending','approved','payment_required'].includes(b.status))
    .some(b=>overlap(new Date(b.startDate), new Date(b.endDate), s, e));
  if(conflicts) return res.status(409).json({error:'date conflict'});
  const booking = { id:nanoid(8), itemId, ownerId:item.ownerId, borrowerId, startDate, endDate, status:'pending', createdAt:new Date().toISOString() };
  db.bookings.push(booking);
  writeDB(db);
  audit('request_booking', booking.id, borrowerId);
  res.json(booking);
});

// ---------- Purchase orders (sell) ----------
app.post('/api/orders', (req,res)=>{
  const { itemId, buyerId } = req.body;
  const db = readDB();
  const item = db.items.find(i=>i.id===itemId);
  if(!item) return res.status(404).json({error:'item not found'});
  if(item.mode!=='sell') return res.status(400).json({error:'item not sell mode'});
  const order = { id: nanoid(8), itemId, buyerId, sellerId: item.ownerId, price: item.priceSell, status:'created', createdAt:new Date().toISOString() };
  db.orders.push(order);
  writeDB(db);
  audit('create_order', order.id, buyerId);
  res.json(order);
});

// ---------- Unified Checkout (rent or sell) ----------
app.post('/api/pay/checkout', async (req,res)=>{
  try{
    if(!stripe) return res.status(400).json({error:'Stripe not configured'});
    const { type, id } = req.body; // rent->bookingId, sell->orderId
    const db = readDB();

    if(type==='rent'){
      const booking = db.bookings.find(b=>b.id===id);
      if(!booking) return res.status(404).json({error:'booking not found'});
      const item = db.items.find(i=>i.id===booking.itemId);
      const seller = db.users.find(u=>u.id===item.ownerId);
      if(!seller?.stripeAccountId) return res.status(400).json({error:'seller not onboarded to Stripe'});

      const days = Math.max(1, Math.ceil((new Date(booking.endDate) - new Date(booking.startDate)) / (1000*60*60*24)));
      const rent = (item.pricePerDay||0)*days;
      const amount = rent + (item.deposit||0);
      const fee = Math.floor(amount * PLATFORM_FEE_BPS / 10000);

      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        payment_method_types: ['card'],
        currency: 'jpy',
        line_items: [{ price_data:{ currency:'jpy', product_data:{ name:`[レンタル] ${item.title}（${days}日）` }, unit_amount: amount }, quantity: 1 }],
        success_url: `${BASE_URL}/?paid=1&type=rent&booking=${booking.id}`,
        cancel_url: `${BASE_URL}/?cancel=1&type=rent&booking=${booking.id}`,
        metadata: { type:'rent', bookingId: booking.id, itemId: item.id },
        payment_intent_data: {
          application_fee_amount: fee,
          transfer_data: { destination: seller.stripeAccountId }
        }
      });
      booking.status = 'payment_required';
      writeDB(db);
      audit('checkout_rent', booking.id, booking.borrowerId);
      return res.json({ url: session.url });
    }

    if(type==='sell'){
      const order = db.orders.find(o=>o.id===id);
      if(!order) return res.status(404).json({error:'order not found'});
      const item = db.items.find(i=>i.id===order.itemId);
      const seller = db.users.find(u=>u.id===item.ownerId);
      if(!seller?.stripeAccountId) return res.status(400).json({error:'seller not onboarded to Stripe'});

      const amount = item.priceSell;
      const fee = Math.floor(amount * PLATFORM_FEE_BPS / 10000);
      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        payment_method_types: ['card'],
        currency: 'jpy',
        line_items: [{ price_data:{ currency:'jpy', product_data:{ name:`[販売] ${item.title}` }, unit_amount: amount }, quantity: 1 }],
        success_url: `${BASE_URL}/?paid=1&type=sell&order=${order.id}`,
        cancel_url: `${BASE_URL}/?cancel=1&type=sell&order=${order.id}`,
        metadata: { type:'sell', orderId: order.id, itemId: item.id },
        payment_intent_data: {
          application_fee_amount: fee,
          transfer_data: { destination: seller.stripeAccountId }
        }
      });
      order.status = 'payment_required';
      writeDB(db);
      audit('checkout_sell', order.id, order.buyerId);
      return res.json({ url: session.url });
    }

    res.status(400).json({error:'unknown type'});
  }catch(e){
    res.status(500).json({error:e.message});
  }
});

// ---------- Ratings ----------
app.post('/api/ratings', (req,res)=>{
  const { targetUserId, byUserId, stars, comment } = req.body;
  const db = readDB();
  if(stars<1 || stars>5) return res.status(400).json({error:'stars 1..5'});
  db.ratings.push({ id:nanoid(8), targetUserId, byUserId, stars, comment, at:new Date().toISOString() });
  const all = db.ratings.filter(r=>r.targetUserId===targetUserId);
  const avg = all.reduce((a,b)=>a+b.stars,0)/all.length;
  const user = db.users.find(u=>u.id===targetUserId);
  if(user){ user.score = Math.round(avg*10)/10; user.reviews = all.length; }
  writeDB(db);
  audit('rate', targetUserId, byUserId);
  res.json({ ok:true, score:user?.score||0, reviews:user?.reviews||0, trust: trustScore(targetUserId) });
});

// ---------- Admin Endpoints ----------
function isAdmin(req){
  const key = req.headers['x-admin-key'];
  return key && (key===process.env.ADMIN_KEY || key===process.env.SECOND_ADMIN_KEY);
}
app.get('/api/audit', (req,res)=>{
  if(!isAdmin(req)) return res.status(403).json({error:'forbidden'});
  const db = readDB();
  res.json(db.audit.slice(-300));
});
app.get('/api/admin/bookings', (req,res)=>{
  if(!isAdmin(req)) return res.status(403).json({error:'forbidden'});
  const db = readDB();
  res.json(db.bookings.slice(-100).reverse());
});
app.get('/api/admin/orders', (req,res)=>{
  if(!isAdmin(req)) return res.status(403).json({error:'forbidden'});
  const db = readDB();
  res.json(db.orders.slice(-100).reverse());
});
app.get('/api/admin/search', (req,res)=>{
  if(!isAdmin(req)) return res.status(403).json({error:'forbidden'});
  const q = (req.query.q||'').toLowerCase();
  const db = readDB();
  const items = db.items.filter(i=>(i.title||'').toLowerCase().includes(q) || (i.city||'').toLowerCase().includes(q) || (i.desc||'').toLowerCase().includes(q));
  res.json(items.slice(0,100));
});

// Health
app.get('/healthz', (req,res)=>res.json({ok:true}));

// Fallback SPA
app.get('*', (req,res)=>{
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, ()=>{
  console.log('Rental MVP v3.8 (full-ready) running on port', PORT);
});
