import { createClient } from '@supabase/supabase-js';
import fetch from 'node-fetch';
import express from 'express';
const sleep = ms => new Promise(r => setTimeout(r, ms));
// ─── CONFIG ───────────────────────────────────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const MY_CHAT_ID     = process.env.MY_CHAT_ID;
const GROQ_KEY       = process.env.GROQ_KEY;
const supabase       = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// ─── EXPRESS ──────────────────────────────────────────────────────────────────
const app  = express();
const PORT = parseInt(process.env.PORT) || 8080;
app.use(express.json());

// ═══════════════════════════════════════════════════════════════════════════════
// TIME HELPERS
// ═══════════════════════════════════════════════════════════════════════════════
function getIST() { return new Date(Date.now() + 5.5 * 3600000); }
function todayIST() { return getIST().toISOString().split('T')[0]; }
function formatTime(iso) {
  return new Date(new Date(iso).getTime() + 5.5*3600000)
    .toLocaleTimeString('en-IN', { hour:'2-digit', minute:'2-digit', hour12:true });
}
function formatDate(d) {
  return d.toLocaleDateString('bn-IN', { day:'numeric', month:'long', year:'numeric' });
}
function getDateRange(period) {
  const IST = getIST(), t = todayIST();
  let start, end, label;
  if (period === 'yesterday') {
    const y = new Date(IST.getTime()-86400000).toISOString().split('T')[0];
    start=`${y}T00:00:00+05:30`; end=`${y}T23:59:59+05:30`; label='গতকালের';
  } else if (period === 'week') {
    const w = new Date(IST.getTime()-7*86400000).toISOString().split('T')[0];
    start=`${w}T00:00:00+05:30`; end=`${t}T23:59:59+05:30`; label='গত ৭ দিনের';
  } else if (period === 'month') {
    const y=IST.getFullYear(), m=String(IST.getMonth()+1).padStart(2,'0');
    start=`${y}-${m}-01T00:00:00+05:30`; end=`${t}T23:59:59+05:30`; label='এই মাসের';
  } else if (period === 'last_month') {
    const d=new Date(IST.getFullYear(),IST.getMonth(),0);
    const y=d.getFullYear(), m=String(d.getMonth()+1).padStart(2,'0');
    const last=new Date(y,d.getMonth()+1,0).getDate();
    start=`${y}-${m}-01T00:00:00+05:30`; end=`${y}-${m}-${last}T23:59:59+05:30`; label='গত মাসের';
  } else if (period === 'year') {
    const y=IST.getFullYear();
    start=`${y}-01-01T00:00:00+05:30`; end=`${y}-12-31T23:59:59+05:30`; label=`${y} সালের`;
  } else {
    start=`${t}T00:00:00+05:30`; end=`${t}T23:59:59+05:30`; label='আজকের';
  }
  return { start, end, label };
}

// ═══════════════════════════════════════════════════════════════════════════════
// TELEGRAM
// ═══════════════════════════════════════════════════════════════════════════════
async function sendMessage(chatId, text, markdown=false) {
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ chat_id:chatId, text, parse_mode: markdown?'Markdown':undefined })
    });
  } catch(e) { console.error('sendMessage error:', e.message); }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MEMORY SYSTEM
// ═══════════════════════════════════════════════════════════════════════════════
async function loadMemory(chatId, limit=16) {
  const { data } = await supabase.from('memory').select('role,content')
    .eq('chat_id', chatId).order('created_at',{ascending:false}).limit(limit);
  return (data||[]).reverse();
}
async function saveMemory(chatId, role, content) {
  await supabase.from('memory').insert({ chat_id:chatId, role, content });
}
async function summariseOldMemory(chatId) {
  const { data } = await supabase.from('memory').select('id,role,content')
    .eq('chat_id',chatId).order('created_at',{ascending:true});
  if (!data||data.length<40) return;
  const toSum = data.slice(0, data.length-30);
  const text = toSum.map(r=>`${r.role}: ${r.content}`).join('\n');
  const res = await callGroq([
    {role:'system',content:'Summarise this shop conversation in Bengali in 3-4 lines.'},
    {role:'user',content:text}
  ], 0.2, 300);
  await supabase.from('memory').delete().in('id', toSum.map(r=>r.id));
  await supabase.from('memory').insert({chat_id:chatId, role:'system', content:`[সারসংক্ষেপ] ${res}`});
}

// ═══════════════════════════════════════════════════════════════════════════════
// GROQ
// ═══════════════════════════════════════════════════════════════════════════════
async function callGroq(messages, temperature=0.1, maxTokens=800) {
  for (let i=0;i<3;i++) {
    try {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method:'POST',
        headers:{'Content-Type':'application/json', Authorization:`Bearer ${GROQ_KEY}`},
        body: JSON.stringify({model:'llama-3.3-70b-versatile', messages, temperature, max_tokens:maxTokens})
      });
      const data = await res.json();
      if (data.error) { if(i<2){await sleep(3000);continue;} throw new Error(data.error.message); }
      return data.choices[0].message.content;
    } catch(e) { console.error(`Groq attempt ${i+1}:`,e.message); if(i<2) await sleep(3000); else throw e; }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// AI PARSE
// ═══════════════════════════════════════════════════════════════════════════════
async function parseMessage(chatId, text) {
  const history = await loadMemory(chatId, 16);
  await saveMemory(chatId, 'user', text);

  const sys = `তুমি "AI Shop Manager Pro" — স্মার্ট দোকান AI। পশ্চিমবঙ্গের বাংলায় কথা বলো। মুদ্রা ₹।
শুধু JSON দাও:
{
  "type": "sale|expense_cash|expense_fixed|expense_extra|cash_open|credit_given_customer|credit_paid_customer|credit_taken_supplier|credit_paid_supplier|loan_given|loan_received|stock_update|show_entries|show_expense_detail|show_credit_detail|show_sale_detail|delete_entry|set_reminder|report|smart_insight|ceo_mode|stock_status|forecast|unknown",
  "amount": 100,
  "description": "বিবরণ",
  "party": "নাম বা null",
  "item": "পণ্যের নাম বা null",
  "quantity": 10,
  "unit": "কেজি বা null",
  "number": null,
  "period": "today|yesterday|week|month|last_month|year",
  "reminder_time": "HH:MM বা null",
  "reminder_text": "reminder message বা null",
  "insight_query": "user কী জানতে চাইছে বা null",
  "reply": "ছোট বাংলা confirm"
}
type নিয়ম:
sale=বিক্রি | expense_cash=নগদ খরচ | expense_fixed=নির্দিষ্ট খরচ | expense_extra=বাড়তি খরচ
cash_open=দোকান খোলার ক্যাশ | credit_given_customer=কাস্টমারকে বাকি | credit_paid_customer=বাকি পেলাম
credit_taken_supplier=সাপ্লায়ার থেকে বাকিতে | credit_paid_supplier=সাপ্লায়ারকে দিলাম
loan_given=ধার দিলাম | loan_received=ধার ফেরত | stock_update=স্টক আপডেট
show_entries=সব entry | show_expense_detail=খরচ বিস্তারিত | show_credit_detail=বাকি হিসাব
show_sale_detail=বিক্রি বিস্তারিত | delete_entry=মুছতে চাই | set_reminder=reminder
report=রিপোর্ট | smart_insight=বিশ্লেষণ | ceo_mode=ব্যবসার সার্বিক অবস্থা
stock_status=স্টক দেখাও | forecast=পূর্বাভাস | unknown=বুঝিনি
period: আজকের/কিছু না=today | গতকাল=yesterday | সপ্তাহ=week | এই মাস=month | গত মাস=last_month | বছর=year`;

  const messages = [{role:'system',content:sys}, ...history, {role:'user',content:text}];
  const raw = await callGroq(messages, 0.1, 600);

  let parsed;
  try {
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('No JSON');
    parsed = JSON.parse(m[0]);
  } catch(e) {
    console.error('JSON parse error:', e.message);
    return { type:'unknown', reply:'🤔 বুঝতে পারিনি, আবার বলো।' };
  }

  await saveMemory(chatId, 'assistant', parsed.reply||'');
  summariseOldMemory(chatId).catch(()=>{});
  return parsed;
}

// ═══════════════════════════════════════════════════════════════════════════════
// DATA HELPERS
// ═══════════════════════════════════════════════════════════════════════════════
async function getDataByPeriod(period) {
  const {start,end} = getDateRange(period||'today');
  const {data,error} = await supabase.from('transactions').select('*')
    .gte('created_at',start).lte('created_at',end).order('created_at',{ascending:true});
  if (error) throw error;
  return data||[];
}
function sumType(data, type) {
  return data.filter(r=>r.type===type).reduce((s,r)=>s+(r.amount||0),0);
}

// ═══════════════════════════════════════════════════════════════════════════════
// REPORT
// ═══════════════════════════════════════════════════════════════════════════════
async function getReport(period) {
  const IST=getIST(), {label}=getDateRange(period||'today');
  const data = await getDataByPeriod(period);
  if (!data.length) return `📊 *${label} রিপোর্ট*\n\nকোনো এন্ট্রি নেই।`;

  const sales=sumType(data,'sale'), cashOpen=sumType(data,'cash_open');
  const expC=sumType(data,'expense_cash'), expF=sumType(data,'expense_fixed'), expE=sumType(data,'expense_extra');
  const totalExp=expC+expF+expE, net=sales-totalExp;
  const custOwed=Math.max(0,sumType(data,'credit_given_customer')-sumType(data,'credit_paid_customer'));
  const suppOwed=Math.max(0,sumType(data,'credit_taken_supplier')-sumType(data,'credit_paid_supplier'));
  const loans=Math.max(0,sumType(data,'loan_given')-sumType(data,'loan_received'));

  const unpaid = data.filter(r=>r.type==='credit_given_customer')
    .filter(r=>!data.find(p=>p.type==='credit_paid_customer'&&p.party===r.party));
  let creditList = unpaid.length ? '\n\n⚠️ *বাকি আছে:*\n'+unpaid.map(c=>`👤 ${c.party||'অজানা'} — ₹${c.amount}`).join('\n') : '';

  return `📊 *AI Shop Manager Pro — ${label} রিপোর্ট*\n📅 ${formatDate(IST)}\n\n`+
    `🏪 শুরুর ক্যাশ: ₹${cashOpen}\n`+
    `✅ মোট বিক্রি: ₹${sales}\n`+
    `❌ মোট খরচ: ₹${totalExp}\n`+
    `   🛒 নগদ: ₹${expC} | 🏠 নির্দিষ্ট: ₹${expF} | ➕ বাড়তি: ₹${expE}\n`+
    `🏆 *নিট লাভ: ₹${net}*\n\n`+
    `⚠️ কাস্টমার পাওনা: ₹${custOwed}\n`+
    `🏭 সাপ্লায়ার দেনা: ₹${suppOwed}\n`+
    `🤝 ধার দেওয়া: ₹${loans}`+creditList;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CEO MODE
// ═══════════════════════════════════════════════════════════════════════════════
async function getCEOReport(chatId) {
  await sendMessage(chatId, '🧠 CEO বিশ্লেষণ তৈরি হচ্ছে...');

  const [today, week, month] = await Promise.all([
    getDataByPeriod('today'), getDataByPeriod('week'), getDataByPeriod('month')
  ]);

  const summary = {
    today: {
      sales: sumType(today,'sale'),
      expense: sumType(today,'expense_cash')+sumType(today,'expense_fixed')+sumType(today,'expense_extra'),
      profit: sumType(today,'sale')-(sumType(today,'expense_cash')+sumType(today,'expense_fixed')+sumType(today,'expense_extra'))
    },
    week: {
      sales: sumType(week,'sale'),
      expense: sumType(week,'expense_cash')+sumType(week,'expense_fixed')+sumType(week,'expense_extra'),
      profit: sumType(week,'sale')-(sumType(week,'expense_cash')+sumType(week,'expense_fixed')+sumType(week,'expense_extra'))
    },
    month: {
      sales: sumType(month,'sale'),
      expense: sumType(month,'expense_cash')+sumType(month,'expense_fixed')+sumType(month,'expense_extra'),
      profit: sumType(month,'sale')-(sumType(month,'expense_cash')+sumType(month,'expense_fixed')+sumType(month,'expense_extra'))
    },
    unpaid_customers: Math.max(0,sumType(month,'credit_given_customer')-sumType(month,'credit_paid_customer')),
    supplier_debt: Math.max(0,sumType(month,'credit_taken_supplier')-sumType(month,'credit_paid_supplier')),
    top_expenses: getTopItems(month.filter(r=>['expense_cash','expense_fixed','expense_extra'].includes(r.type))),
    top_sales: getTopItems(month.filter(r=>r.type==='sale'))
  };

  const prompt = `তুমি একজন Business Analyst। নিচের দোকানের ডেটা দেখে CEO-কে বাংলায় সম্পূর্ণ ব্যবসায়িক বিশ্লেষণ দাও।
ডেটা: ${JSON.stringify(summary)}
বলো:
1. ব্যবসার সার্বিক অবস্থা (ভালো/খারাপ/মধ্যম)
2. লাভ-ক্ষতির বিশ্লেষণ
3. সবচেয়ে বড় সমস্যা
4. তাৎক্ষণিক করণীয়
5. এই সপ্তাহের লক্ষ্য
সংক্ষেপে কিন্তু কার্যকরভাবে বলো।`;

  const answer = await callGroq([{role:'system',content:prompt},{role:'user',content:'আমার ব্যবসার অবস্থা বলো'}], 0.3, 700);
  return `👔 *CEO রিপোর্ট*\n\n${answer}\n\n━━━━━━━━━━\n📊 আজ: বিক্রি ₹${summary.today.sales} | লাভ ₹${summary.today.profit}\n📈 সপ্তাহ: বিক্রি ₹${summary.week.sales} | লাভ ₹${summary.week.profit}\n📅 মাস: বিক্রি ₹${summary.month.sales} | লাভ ₹${summary.month.profit}`;
}

function getTopItems(data) {
  const map = {};
  data.forEach(r => { const k=r.description||'অন্যান্য'; map[k]=(map[k]||0)+(r.amount||0); });
  return Object.entries(map).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([k,v])=>({name:k,amount:v}));
}

// ═══════════════════════════════════════════════════════════════════════════════
// SMART INSIGHT
// ═══════════════════════════════════════════════════════════════════════════════
async function getSmartInsight(chatId, query, period) {
  await sendMessage(chatId, '🧠 বিশ্লেষণ করছি...');
  const data = await getDataByPeriod(period||'month');
  const expMap={}, saleMap={};
  data.filter(r=>['expense_cash','expense_fixed','expense_extra'].includes(r.type))
    .forEach(r=>{ const k=r.description||'অন্যান্য'; expMap[k]=(expMap[k]||0)+(r.amount||0); });
  data.filter(r=>r.type==='sale')
    .forEach(r=>{ const k=r.description||'অন্যান্য'; saleMap[k]=(saleMap[k]||0)+(r.amount||0); });

  const summary = {
    period:period||'month', total_sales:sumType(data,'sale'),
    total_expense:sumType(data,'expense_cash')+sumType(data,'expense_fixed')+sumType(data,'expense_extra'),
    net_profit:sumType(data,'sale')-(sumType(data,'expense_cash')+sumType(data,'expense_fixed')+sumType(data,'expense_extra')),
    expense_breakdown:expMap, sale_breakdown:saleMap,
    credit_given:sumType(data,'credit_given_customer'), credit_received:sumType(data,'credit_paid_customer')
  };

  const answer = await callGroq([
    {role:'system',content:`তুমি business analyst। ডেটা: ${JSON.stringify(summary)}\nবাংলায় সংক্ষেপে insightful উত্তর দাও। সংখ্যা ও শতাংশ ব্যবহার করো।`},
    {role:'user',content:query}
  ], 0.3, 500);
  return `🧠 *স্মার্ট বিশ্লেষণ*\n\n${answer}`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// FORECAST
// ═══════════════════════════════════════════════════════════════════════════════
async function getForecast(chatId) {
  await sendMessage(chatId, '🔮 পূর্বাভাস তৈরি হচ্ছে...');
  const week = await getDataByPeriod('week');
  const month = await getDataByPeriod('month');

  const dailySales = {};
  week.filter(r=>r.type==='sale').forEach(r=>{
    const d=r.created_at.split('T')[0];
    dailySales[d]=(dailySales[d]||0)+(r.amount||0);
  });
  const avgDaily = Object.values(dailySales).length
    ? Math.round(Object.values(dailySales).reduce((a,b)=>a+b,0)/Object.values(dailySales).length) : 0;

  const totalMonthSales = sumType(month,'sale');
  const totalMonthExp = sumType(month,'expense_cash')+sumType(month,'expense_fixed')+sumType(month,'expense_extra');

  const prompt = `দোকানের ডেটা:
- গত ৭ দিনের গড় দৈনিক বিক্রি: ₹${avgDaily}
- এই মাসের মোট বিক্রি: ₹${totalMonthSales}
- এই মাসের মোট খরচ: ₹${totalMonthExp}
- দৈনিক বিক্রি: ${JSON.stringify(dailySales)}
বাংলায় বলো:
1. আগামীকালের বিক্রির পূর্বাভাস
2. এই সপ্তাহের পূর্বাভাস
3. কোন পণ্য বেশি বিক্রি হতে পারে
4. স্টক কী কী লাগতে পারে`;

  const answer = await callGroq([{role:'system',content:prompt},{role:'user',content:'পূর্বাভাস দাও'}], 0.4, 500);
  return `🔮 *ব্যবসায়িক পূর্বাভাস*\n\n${answer}\n\n📊 গড় দৈনিক বিক্রি: ₹${avgDaily}`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STOCK STATUS
// ═══════════════════════════════════════════════════════════════════════════════
async function getStockStatus() {
  const {data,error} = await supabase.from('stock').select('*').order('item');
  if (error||!data?.length) return '📦 কোনো স্টক তথ্য নেই।';

  let msg = '📦 *স্টক অবস্থা*\n\n';
  data.forEach(s=>{
    const alert = s.quantity<=5 ? ' ⚠️ কম!' : '';
    msg += `• ${s.item}: ${s.quantity} ${s.unit||''}${alert}\n`;
  });
  return msg;
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPENSE / CREDIT / SALE DETAIL
// ═══════════════════════════════════════════════════════════════════════════════
async function getExpenseDetail(period) {
  const {label}=getDateRange(period||'today');
  const data=await getDataByPeriod(period);
  const expenses=data.filter(r=>['expense_cash','expense_fixed','expense_extra'].includes(r.type));
  if (!expenses.length) return `📋 ${label} কোনো খরচ নেই।`;
  const names={expense_cash:'🛒 নগদ',expense_fixed:'🏠 নির্দিষ্ট',expense_extra:'➕ বাড়তি'};
  let msg=`📋 *${label} খরচের বিস্তারিত*\n\n`, total=0;
  expenses.forEach((e,i)=>{ msg+=`${i+1}. ${names[e.type]} — ${e.description||'খরচ'} — ₹${e.amount} [${formatTime(e.created_at)}]\n`; total+=e.amount||0; });
  return msg+`\n━━━━━━━━━━\n💸 *মোট: ₹${total}*`;
}

async function getCreditDetail(period) {
  const {label}=getDateRange(period||'today');
  const data=await getDataByPeriod(period);
  const cg=data.filter(r=>r.type==='credit_given_customer');
  const cp=data.filter(r=>r.type==='credit_paid_customer');
  const sg=data.filter(r=>r.type==='credit_taken_supplier');
  const lg=data.filter(r=>r.type==='loan_given');
  if (!cg.length&&!sg.length&&!lg.length) return `📋 ${label} কোনো বাকি বা ধার নেই।`;
  let msg=`📋 *${label} বাকি ও ধারের হিসাব*\n\n`;
  if (cg.length) { msg+=`👥 *কাস্টমারের বাকি:*\n`; cg.forEach(c=>{ const paid=cp.find(p=>p.party===c.party); msg+=`👤 ${c.party||'অজানা'} — ₹${c.amount} [${paid?'✅ মিটিয়েছে':'⏳ বাকি'}]\n`; }); msg+='\n'; }
  if (sg.length) { msg+=`🏭 *সাপ্লায়ারের দেনা:*\n`; sg.forEach(s=>{ msg+=`🏪 ${s.party||'অজানা'} — ₹${s.amount}\n`; }); msg+='\n'; }
  if (lg.length) { msg+=`🤝 *ধার দেওয়া:*\n`; lg.forEach(l=>{ msg+=`👤 ${l.party||'অজানা'} — ₹${l.amount}\n`; }); }
  return msg;
}

async function getSaleDetail(period) {
  const {label}=getDateRange(period||'today');
  const data=await getDataByPeriod(period);
  const sales=data.filter(r=>r.type==='sale');
  if (!sales.length) return `📋 ${label} কোনো বিক্রি নেই।`;
  let msg=`📋 *${label} বিক্রির বিস্তারিত*\n\n`, total=0;
  sales.forEach((s,i)=>{ msg+=`${i+1}. 💰 ${s.description||'বিক্রি'} — ₹${s.amount} [${formatTime(s.created_at)}]\n`; total+=s.amount||0; });
  return msg+`\n━━━━━━━━━━\n✅ *মোট: ₹${total}*`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SHOW ENTRIES + DELETE
// ═══════════════════════════════════════════════════════════════════════════════
let lastEntries = [];
async function showEntries(chatId, period) {
  const {label}=getDateRange(period||'today');
  const data=await getDataByPeriod(period);
  if (!data.length) { await sendMessage(chatId,`📋 ${label} কোনো এন্ট্রি নেই।`); return; }
  lastEntries=data;
  const names={sale:'💰 বিক্রি',expense_cash:'🛒 নগদ খরচ',expense_fixed:'🏠 নির্দিষ্ট খরচ',expense_extra:'➕ বাড়তি খরচ',cash_open:'🏪 শুরুর ক্যাশ',credit_given_customer:'👤 কাস্টমার বাকি',credit_paid_customer:'✅ বাকি পরিশোধ',credit_taken_supplier:'🏭 সাপ্লায়ার বাকি',credit_paid_supplier:'✅ সাপ্লায়ার পরিশোধ',loan_given:'🤝 ধার দেওয়া',loan_received:'🤝 ধার পাওয়া',stock_update:'📦 স্টক'};
  let msg=`📋 *${label} সব এন্ট্রি:*\n\n`;
  data.forEach((e,i)=>{ msg+=`${i+1}. ${names[e.type]||e.type}${e.party?` (${e.party})`:''}${e.amount?` — ₹${e.amount}`:''} [${formatTime(e.created_at)}]\n`; });
  msg+='\n🗑️ মুছতে: "৩ নম্বর মুছে দাও"';
  await sendMessage(chatId, msg, true);
}

async function deleteEntry(chatId, number) {
  if (!lastEntries?.length) { await showEntries(chatId,'today'); await sendMessage(chatId,'👆 কোন নম্বর মুছতে চাও বলো।'); return; }
  const idx=number-1;
  if (idx<0||idx>=lastEntries.length) { await sendMessage(chatId,`⚠️ ${number} নম্বর নেই।`); return; }
  const entry=lastEntries[idx];
  await supabase.from('transactions').delete().eq('id',entry.id);
  lastEntries.splice(idx,1);
  await sendMessage(chatId,`✅ মুছে দেওয়া হয়েছে।\n❌ ${entry.description||entry.type} — ₹${entry.amount||0}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// PERSISTENT REMINDER SYSTEM
// ═══════════════════════════════════════════════════════════════════════════════
async function loadReminders() {
  const {data} = await supabase.from('reminders').select('*').eq('active', true);
  return data||[];
}

async function saveReminder(chatId, time, text) {
  const {data} = await supabase.from('reminders').insert({
    chat_id:chatId, time, text, active:true
  }).select().single();
  return data;
}

async function checkReminders() {
  const IST=getIST();
  const hh=String(IST.getHours()).padStart(2,'0');
  const mm=String(IST.getMinutes()).padStart(2,'0');
  const currentTime=`${hh}:${mm}`;
  const reminders=await loadReminders();
  for (const r of reminders) {
    if (r.time===currentTime) {
      await sendMessage(r.chat_id, `⏰ *রিমাইন্ডার!*\n\n${r.text}`, true);
    }
  }
}

async function setReminder(chatId, time, text) {
  await saveReminder(chatId, time, text);
  return `⏰ *রিমাইন্ডার সেট হয়েছে!*\n🕐 সময়: ${time}\n📝 বিষয়: ${text}\n\n✅ Server restart হলেও reminder থাকবে!`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// AUTO REPORTS
// ═══════════════════════════════════════════════════════════════════════════════
let lastAutoReportDate='', lastWeeklyReportDate='';
async function checkAutoReports() {
  const IST=getIST();
  const h=IST.getHours(), m=IST.getMinutes();
  const today=todayIST();

  // Daily report at 10 PM
  if (h===22&&m===0&&lastAutoReportDate!==today) {
    lastAutoReportDate=today;
    const report=await getReport('today');
    await sendMessage(MY_CHAT_ID,`🌙 *রাতের অটো রিপোর্ট*\n\n${report}`,true);
  }

  // Weekly report on Sunday at 9 PM
  if (IST.getDay()===0&&h===21&&m===0&&lastWeeklyReportDate!==today) {
    lastWeeklyReportDate=today;
    const report=await getReport('week');
    await sendMessage(MY_CHAT_ID,`📅 *সাপ্তাহিক রিপোর্ট*\n\n${report}`,true);
  }

  // Check reminders
  await checkReminders();
}

// ═══════════════════════════════════════════════════════════════════════════════
// HANDLE MESSAGE
// ═══════════════════════════════════════════════════════════════════════════════
async function handleMessage(chatId, text) {
  try {
    const parsed=await parseMessage(chatId, text);
    const period=parsed.period||'today';

    switch(parsed.type) {
      case 'report':
        await sendMessage(chatId, await getReport(period), true); break;
      case 'ceo_mode':
        await sendMessage(chatId, await getCEOReport(chatId), true); break;
      case 'smart_insight':
        await sendMessage(chatId, await getSmartInsight(chatId, parsed.insight_query||text, period), true); break;
      case 'forecast':
        await sendMessage(chatId, await getForecast(chatId), true); break;
      case 'stock_status':
        await sendMessage(chatId, await getStockStatus(), true); break;
      case 'show_entries':
        await showEntries(chatId, period); break;
      case 'show_expense_detail':
        await sendMessage(chatId, await getExpenseDetail(period), true); break;
      case 'show_credit_detail':
        await sendMessage(chatId, await getCreditDetail(period), true); break;
      case 'show_sale_detail':
        await sendMessage(chatId, await getSaleDetail(period), true); break;
      case 'delete_entry':
        if (parsed.number) await deleteEntry(chatId, parsed.number);
        else { await showEntries(chatId,'today'); await sendMessage(chatId,'👆 কোন নম্বর মুছতে চাও বলো।'); }
        break;
      case 'set_reminder':
        if (parsed.reminder_time&&parsed.reminder_text) {
          await sendMessage(chatId, await setReminder(chatId, parsed.reminder_time, parsed.reminder_text), true);
        } else {
          await sendMessage(chatId,'⚠️ সময় আর বিষয় দুটোই বলো।\nযেমন: "রাত ৯টায় দোকান বন্ধের reminder দাও"');
        }
        break;
      case 'unknown':
        await sendMessage(chatId, parsed.reply||'🤔 বুঝতে পারিনি, আবার বলো।'); break;
      default:
        if (parsed.type==='stock_update'&&parsed.item) {
          await supabase.from('stock').upsert({item:parsed.item,quantity:parsed.quantity,unit:parsed.unit,updated_at:new Date().toISOString()},{onConflict:'item'});
        } else if (parsed.amount) {
          await supabase.from('transactions').insert({type:parsed.type,amount:parsed.amount,description:parsed.description,party:parsed.party});
        }
        await sendMessage(chatId, parsed.reply||'✅ লিখে রাখলাম!');
    }
  } catch(e) {
    console.error('handleMessage error:', e.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// WEBHOOK SERVER
// ═══════════════════════════════════════════════════════════════════════════════
app.post(`/webhook/${TELEGRAM_TOKEN}`, async (req, res) => {
  res.sendStatus(200); // ✅ সাথে সাথে 200 — double reply impossible
  try {
    const msg=req.body?.message;
    if (!msg?.text) return;
    const chatId=msg.chat.id.toString();
    if (chatId!==MY_CHAT_ID) { await sendMessage(chatId,'⛔ এই bot টি private।'); return; }
    await handleMessage(chatId, msg.text);
  } catch(e) { console.error('Webhook error:', e.message); }
});

app.get('/', (_,res)=>res.send('🤖 AI Shop Manager Pro চলছে!'));

// Auto report + reminder check every minute
setInterval(checkAutoReports, 60000);

async function sleep(ms) { return new Promise(r=>setTimeout(r,ms)); }

async function registerWebhook() {
  const url=process.env.WEBHOOK_URL;
  if (!url) { console.error('❌ WEBHOOK_URL নেই!'); return; }
  const webhookUrl=`${url}/webhook/${TELEGRAM_TOKEN}`;
  const res=await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/setWebhook?url=${webhookUrl}`);
  const data=await res.json();
  if (data.ok) console.log('✅ Webhook registered:', webhookUrl);
  else console.error('❌ Webhook failed:', data);
}

app.listen(PORT, async ()=>{
  console.log(`🤖 AI Shop Manager Pro চালু হয়েছে! Port: ${PORT}`);
  await registerWebhook();
});

process.on('SIGTERM',()=>{ console.log('Shutting down...'); process.exit(0); });
