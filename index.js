import { createClient } from '@supabase/supabase-js';
import fetch from 'node-fetch';
import express from 'express';

const sleep = ms => new Promise(r => setTimeout(r, ms));

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const MY_CHAT_ID     = process.env.MY_CHAT_ID;
const GROQ_KEY       = process.env.GROQ_KEY;
const supabase       = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const app  = express();
const PORT = parseInt(process.env.PORT) || 8080;
app.use(express.json());

// ─── TIME ─────────────────────────────────────────────────────────────────────
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

// ─── TELEGRAM ─────────────────────────────────────────────────────────────────
async function sendMessage(chatId, text, markdown=false) {
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ chat_id:chatId, text, parse_mode: markdown?'Markdown':undefined })
    });
  } catch(e) { console.error('sendMessage error:', e.message); }
}

// ─── MEMORY ───────────────────────────────────────────────────────────────────
async function loadMemory(chatId, limit=10) {
  const { data } = await supabase.from('memory').select('role,content')
    .eq('chat_id', chatId).order('created_at',{ascending:false}).limit(limit);
  return (data||[]).reverse();
}
async function saveMemory(chatId, role, content) {
  await supabase.from('memory').insert({ chat_id:chatId, role, content });
}
async function trimMemory(chatId) {
  const { data } = await supabase.from('memory').select('id')
    .eq('chat_id',chatId).order('created_at',{ascending:true});
  if (!data||data.length<40) return;
  const toDelete = data.slice(0, data.length-30).map(r=>r.id);
  await supabase.from('memory').delete().in('id', toDelete);
}

// ─── GROQ ─────────────────────────────────────────────────────────────────────
async function callGroq(messages, temperature=0.1, maxTokens=600, model='llama-3.1-8b-instant') {
  for (let i=0;i<3;i++) {
    try {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method:'POST',
        headers:{'Content-Type':'application/json', Authorization:`Bearer ${GROQ_KEY}`},
        body: JSON.stringify({model, messages, temperature, max_tokens:maxTokens})
      });
      const data = await res.json();
      if (data.error?.message?.includes('Rate limit') || res.status===429) {
        console.warn(`Rate limit (attempt ${i+1})`);
        if (i<2) { await sleep(30000); continue; }
        return null;
      }
      if (data.error) { if(i<2){await sleep(3000);continue;} return null; }
      return data.choices[0].message.content;
    } catch(e) {
      console.error(`Groq attempt ${i+1}:`,e.message);
      if(i<2) await sleep(3000); else return null;
    }
  }
  return null;
}

// ─── AI PARSE ─────────────────────────────────────────────────────────────────
// Simple keyword-based pre-check — AI call বাঁচায় এবং accuracy বাড়ায়
function quickParse(text) {
  const t = text.toLowerCase().trim();

  // রিপোর্ট
  if (t.includes('রিপোর্ট') || t.includes('হিসাব দাও') || t.includes('report')) {
    if (t.includes('বিক্রি') || t.includes('sale')) return {type:'show_sale_detail', period:getPeriod(t)};
    if (t.includes('খরচ') || t.includes('expense')) return {type:'show_expense_detail', period:getPeriod(t)};
    if (t.includes('বাকি') || t.includes('credit') || t.includes('ধার')) return {type:'show_credit_detail', period:getPeriod(t)};
    return {type:'report', period:getPeriod(t)};
  }
  if (t.includes('রিপোর্ট দাও') || t.includes('আজকের রিপোর্ট')) return {type:'report', period:'today'};
  if (t.includes('সব entry') || t.includes('সব এন্ট্রি')) return {type:'show_entries', period:getPeriod(t)};
  if (t.includes('ব্যবসা কেমন') || t.includes('ceo') || t.includes('সার্বিক')) return {type:'ceo_mode', period:getPeriod(t)};
  if (t.includes('পূর্বাভাস') || t.includes('forecast')) return {type:'forecast', period:getPeriod(t)};
  if (t.includes('স্টক') && (t.includes('দেখাও') || t.includes('কত আছে'))) return {type:'stock_status'};

  return null; // AI-এ পাঠাও
}

function getPeriod(t) {
  if (t.includes('গতকাল')) return 'yesterday';
  if (t.includes('সপ্তাহ') || t.includes('৭ দিন')) return 'week';
  if (t.includes('গত মাস')) return 'last_month';
  if (t.includes('এই মাস') || t.includes('মাসের')) return 'month';
  if (t.includes('বছর')) return 'year';
  return 'today';
}

async function parseMessage(chatId, text) {
  await saveMemory(chatId, 'user', text);

  // quick parse চেষ্টা করো আগে
  const quick = quickParse(text);
  if (quick) {
    await saveMemory(chatId, 'assistant', '');
    return quick;
  }

  // AI parse
  const history = await loadMemory(chatId, 8);

  const sys = `You are a shop management bot. Analyze the Bengali/English message and return ONLY a JSON object.

RULES:
- Return ONLY valid JSON, nothing else
- No markdown, no explanation
- "reply" must be a short Bengali confirmation (NOT the word "confirm" or any placeholder)

JSON fields:
- type: one of [sale, expense_cash, expense_fixed, expense_extra, cash_open, credit_given_customer, credit_paid_customer, credit_taken_supplier, credit_paid_supplier, loan_given, loan_received, stock_update, show_entries, show_expense_detail, show_credit_detail, show_sale_detail, delete_entry, set_reminder, report, smart_insight, ceo_mode, stock_status, forecast, unknown]
- amount: number or null
- description: string or null  
- party: person/company name or null
- item: product name or null
- quantity: number or null
- unit: string or null
- number: entry number for delete or null
- period: today/yesterday/week/month/last_month/year (default: today)
- reminder_time: HH:MM or null
- reminder_text: string or null
- insight_query: question string or null
- reply: SHORT Bengali text like "বিক্রি লিখলাম" or "খরচ যোগ হলো" (NEVER use placeholder text)

TYPE MAPPING:
sale = বিক্রি
expense_cash = নগদ খরচ (বাজার, তেল, কাঁচামাল)
expense_fixed = নির্দিষ্ট খরচ (ভাড়া, বিল, কিস্তি)
expense_extra = বাড়তি/অতিরিক্ত খরচ
cash_open = দোকান খোলার ক্যাশ
credit_given_customer = কাস্টমারকে বাকি দিলাম
credit_paid_customer = কাস্টমার বাকি মেটালো
credit_taken_supplier = সাপ্লায়ার থেকে বাকিতে মাল নিলাম
credit_paid_supplier = সাপ্লায়ারকে টাকা দিলাম
show_credit_detail = বাকির হিসাব দেখাও
show_expense_detail = খরচের হিসাব দেখাও
show_sale_detail = বিক্রির হিসাব দেখাও
report = সম্পূর্ণ রিপোর্ট
smart_insight = বিশ্লেষণ বা কেন প্রশ্ন
ceo_mode = ব্যবসার সার্বিক অবস্থা
unknown = বুঝিনি`;

  const messages = [
    {role:'system', content:sys},
    ...history,
    {role:'user', content:text},
    {role:'assistant', content:'{"type":"'}
  ];

  const raw = await callGroq(messages, 0.1, 400, 'llama-3.1-8b-instant');

  if (!raw) return { type:'unknown', reply:'⚠️ এখন ব্যস্ত, একটু পরে বলো।' };

  let parsed;
  try {
    const fullRaw = '{"type":"' + raw;
    const m = fullRaw.match(/\{[\s\S]*?\}/);
    if (!m) throw new Error('no json');
    parsed = JSON.parse(m[0]);

    // reply placeholder fix
    const badReplies = ['ছোট বাংলা confirm', 'confirm', 'reply', 'short bengali'];
    if (!parsed.reply || badReplies.some(b => parsed.reply.toLowerCase().includes(b))) {
      const replyMap = {
        sale: '✅ বিক্রি লিখলাম!',
        expense_cash: '✅ নগদ খরচ লিখলাম!',
        expense_fixed: '✅ নির্দিষ্ট খরচ লিখলাম!',
        expense_extra: '✅ বাড়তি খরচ লিখলাম!',
        cash_open: '✅ ক্যাশ লিখলাম!',
        credit_given_customer: '✅ বাকি লিখলাম!',
        credit_paid_customer: '✅ বাকি পরিশোধ লিখলাম!',
        credit_taken_supplier: '✅ সাপ্লায়ার বাকি লিখলাম!',
        credit_paid_supplier: '✅ সাপ্লায়ার পরিশোধ লিখলাম!',
        loan_given: '✅ ধার লিখলাম!',
        loan_received: '✅ ধার ফেরত লিখলাম!',
        stock_update: '✅ স্টক আপডেট হলো!',
        unknown: '🤔 বুঝতে পারিনি, আবার বলো।',
      };
      parsed.reply = replyMap[parsed.type] || '✅ লিখে রাখলাম!';
    }
  } catch(e) {
    console.error('JSON parse error:', e.message, '| raw:', raw?.slice(0,60));
    return { type:'unknown', reply:'🤔 বুঝতে পারিনি, আবার বলো।' };
  }

  await saveMemory(chatId, 'assistant', parsed.reply||'');
  trimMemory(chatId).catch(()=>{});
  return parsed;
}

// ─── DATA ─────────────────────────────────────────────────────────────────────
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

// ─── REPORT ───────────────────────────────────────────────────────────────────
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

  // unique unpaid customers
  const paidParties=new Set(data.filter(r=>r.type==='credit_paid_customer').map(r=>r.party));
  const unpaidMap={};
  data.filter(r=>r.type==='credit_given_customer'&&!paidParties.has(r.party))
    .forEach(r=>{ unpaidMap[r.party||'অজানা']=(unpaidMap[r.party||'অজানা']||0)+(r.amount||0); });

  let creditList='';
  if (Object.keys(unpaidMap).length) {
    creditList='\n\n⚠️ *বাকি আছে:*\n';
    Object.entries(unpaidMap).forEach(([k,v])=>{ creditList+=`👤 ${k} — ₹${v}\n`; });
  }

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

// ─── CEO MODE ─────────────────────────────────────────────────────────────────
function getTopItems(data) {
  const map={};
  data.forEach(r=>{ const k=r.description||'অন্যান্য'; map[k]=(map[k]||0)+(r.amount||0); });
  return Object.entries(map).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([k,v])=>({name:k,amount:v}));
}

async function getCEOReport(chatId) {
  await sendMessage(chatId, '🧠 CEO বিশ্লেষণ তৈরি হচ্ছে...');
  const [today,week,month]=await Promise.all([getDataByPeriod('today'),getDataByPeriod('week'),getDataByPeriod('month')]);
  const mk=(d)=>({
    sales:sumType(d,'sale'),
    expense:sumType(d,'expense_cash')+sumType(d,'expense_fixed')+sumType(d,'expense_extra'),
    profit:sumType(d,'sale')-(sumType(d,'expense_cash')+sumType(d,'expense_fixed')+sumType(d,'expense_extra'))
  });
  const s={today:mk(today),week:mk(week),month:mk(month),
    unpaid:Math.max(0,sumType(month,'credit_given_customer')-sumType(month,'credit_paid_customer')),
    supplier_debt:Math.max(0,sumType(month,'credit_taken_supplier')-sumType(month,'credit_paid_supplier')),
    top_expenses:getTopItems(month.filter(r=>['expense_cash','expense_fixed','expense_extra'].includes(r.type))),
    top_sales:getTopItems(month.filter(r=>r.type==='sale'))};

  const answer=await callGroq([
    {role:'system',content:`তুমি business analyst। দোকানের ডেটা: ${JSON.stringify(s)}\nCEO-কে বাংলায় সংক্ষেপে বলো: ১. সার্বিক অবস্থা ২. লাভ-ক্ষতি ৩. সমস্যা ৪. করণীয়`},
    {role:'user',content:'ব্যবসার অবস্থা বলো'}
  ],0.3,500,'llama-3.1-8b-instant');

  return `👔 *CEO রিপোর্ট*\n\n${answer||'বিশ্লেষণ করা যায়নি।'}\n\n━━━━━━━━━━\n📊 আজ: বিক্রি ₹${s.today.sales} | লাভ ₹${s.today.profit}\n📈 সপ্তাহ: বিক্রি ₹${s.week.sales} | লাভ ₹${s.week.profit}\n📅 মাস: বিক্রি ₹${s.month.sales} | লাভ ₹${s.month.profit}`;
}

// ─── SMART INSIGHT ────────────────────────────────────────────────────────────
async function getSmartInsight(chatId, query, period) {
  await sendMessage(chatId,'🧠 বিশ্লেষণ করছি...');
  const data=await getDataByPeriod(period||'month');
  const expMap={},saleMap={};
  data.filter(r=>['expense_cash','expense_fixed','expense_extra'].includes(r.type))
    .forEach(r=>{const k=r.description||'অন্যান্য';expMap[k]=(expMap[k]||0)+(r.amount||0);});
  data.filter(r=>r.type==='sale')
    .forEach(r=>{const k=r.description||'অন্যান্য';saleMap[k]=(saleMap[k]||0)+(r.amount||0);});
  const summary={
    total_sales:sumType(data,'sale'),
    total_expense:sumType(data,'expense_cash')+sumType(data,'expense_fixed')+sumType(data,'expense_extra'),
    net_profit:sumType(data,'sale')-(sumType(data,'expense_cash')+sumType(data,'expense_fixed')+sumType(data,'expense_extra')),
    expense_breakdown:expMap,sale_breakdown:saleMap
  };
  const answer=await callGroq([
    {role:'system',content:`তুমি business analyst। ডেটা: ${JSON.stringify(summary)}\nবাংলায় insightful উত্তর দাও।`},
    {role:'user',content:query}
  ],0.3,400,'llama-3.1-8b-instant');
  return `🧠 *স্মার্ট বিশ্লেষণ*\n\n${answer||'বিশ্লেষণ করা যায়নি।'}`;
}

// ─── FORECAST ─────────────────────────────────────────────────────────────────
async function getForecast(chatId) {
  await sendMessage(chatId,'🔮 পূর্বাভাস তৈরি হচ্ছে...');
  const week=await getDataByPeriod('week'),month=await getDataByPeriod('month');
  const dailySales={};
  week.filter(r=>r.type==='sale').forEach(r=>{const d=r.created_at.split('T')[0];dailySales[d]=(dailySales[d]||0)+(r.amount||0);});
  const vals=Object.values(dailySales);
  const avgDaily=vals.length?Math.round(vals.reduce((a,b)=>a+b,0)/vals.length):0;
  const answer=await callGroq([
    {role:'system',content:`দোকানের ডেটা: গড় দৈনিক বিক্রি ₹${avgDaily}, মাসিক বিক্রি ₹${sumType(month,'sale')}, মাসিক খরচ ₹${sumType(month,'expense_cash')+sumType(month,'expense_fixed')+sumType(month,'expense_extra')}। বাংলায় আগামীকালের পূর্বাভাস ও পরামর্শ দাও।`},
    {role:'user',content:'পূর্বাভাস দাও'}
  ],0.3,400,'llama-3.1-8b-instant');
  return `🔮 *ব্যবসায়িক পূর্বাভাস*\n\n${answer||'পূর্বাভাস করা যায়নি।'}\n\n📊 গড় দৈনিক বিক্রি: ₹${avgDaily}`;
}

// ─── STOCK ────────────────────────────────────────────────────────────────────
async function getStockStatus() {
  const {data,error}=await supabase.from('stock').select('*').order('item');
  if (error||!data?.length) return '📦 কোনো স্টক তথ্য নেই।';
  let msg='📦 *স্টক অবস্থা*\n\n';
  data.forEach(s=>{msg+=`• ${s.item}: ${s.quantity} ${s.unit||''}${s.quantity<=5?' ⚠️ কম!':''}\n`;});
  return msg;
}

// ─── DETAIL VIEWS ─────────────────────────────────────────────────────────────
async function getExpenseDetail(period) {
  const {label}=getDateRange(period||'today');
  const data=await getDataByPeriod(period);
  const expenses=data.filter(r=>['expense_cash','expense_fixed','expense_extra'].includes(r.type));
  if (!expenses.length) return `📋 ${label} কোনো খরচ নেই।`;
  const names={expense_cash:'🛒 নগদ',expense_fixed:'🏠 নির্দিষ্ট',expense_extra:'➕ বাড়তি'};
  let msg=`📋 *${label} খরচের বিস্তারিত*\n\n`,total=0;
  expenses.forEach((e,i)=>{msg+=`${i+1}. ${names[e.type]} — ${e.description||'খরচ'} — ₹${e.amount} [${formatTime(e.created_at)}]\n`;total+=e.amount||0;});
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

  // unique customer credit
  const custMap={};
  cg.forEach(r=>{const k=r.party||'অজানা';custMap[k]=(custMap[k]||0)+(r.amount||0);});
  const paidParties=new Set(cp.map(r=>r.party));

  let msg=`📋 *${label} বাকি ও ধারের হিসাব*\n\n`;
  if (Object.keys(custMap).length) {
    msg+=`👥 *কাস্টমারের বাকি:*\n`;
    Object.entries(custMap).forEach(([name,amt])=>{
      msg+=`👤 ${name} — ₹${amt} [${paidParties.has(name)?'✅ মিটিয়েছে':'⏳ বাকি'}]\n`;
    });
    msg+='\n';
  }
  if (sg.length){msg+=`🏭 *সাপ্লায়ারের দেনা:*\n`;sg.forEach(s=>{msg+=`🏪 ${s.party||'অজানা'} — ₹${s.amount}\n`;});msg+='\n';}
  if (lg.length){msg+=`🤝 *ধার দেওয়া:*\n`;lg.forEach(l=>{msg+=`👤 ${l.party||'অজানা'} — ₹${l.amount}\n`;});}
  return msg;
}

async function getSaleDetail(period) {
  const {label}=getDateRange(period||'today');
  const data=await getDataByPeriod(period);
  const sales=data.filter(r=>r.type==='sale');
  if (!sales.length) return `📋 ${label} কোনো বিক্রি নেই।`;
  let msg=`📋 *${label} বিক্রির বিস্তারিত*\n\n`,total=0;
  sales.forEach((s,i)=>{msg+=`${i+1}. 💰 ${s.description||'বিক্রি'} — ₹${s.amount} [${formatTime(s.created_at)}]\n`;total+=s.amount||0;});
  return msg+`\n━━━━━━━━━━\n✅ *মোট: ₹${total}*`;
}

// ─── ENTRIES + DELETE ─────────────────────────────────────────────────────────
let lastEntries=[];
async function showEntries(chatId,period) {
  const {label}=getDateRange(period||'today');
  const data=await getDataByPeriod(period);
  if (!data.length){await sendMessage(chatId,`📋 ${label} কোনো এন্ট্রি নেই।`);return;}
  lastEntries=data;
  const names={sale:'💰 বিক্রি',expense_cash:'🛒 নগদ খরচ',expense_fixed:'🏠 নির্দিষ্ট খরচ',expense_extra:'➕ বাড়তি খরচ',cash_open:'🏪 শুরুর ক্যাশ',credit_given_customer:'👤 কাস্টমার বাকি',credit_paid_customer:'✅ বাকি পরিশোধ',credit_taken_supplier:'🏭 সাপ্লায়ার বাকি',credit_paid_supplier:'✅ সাপ্লায়ার পরিশোধ',loan_given:'🤝 ধার দেওয়া',loan_received:'🤝 ধার পাওয়া',stock_update:'📦 স্টক'};
  let msg=`📋 *${label} সব এন্ট্রি:*\n\n`;
  data.forEach((e,i)=>{msg+=`${i+1}. ${names[e.type]||e.type}${e.party?` (${e.party})`:''}${e.amount?` — ₹${e.amount}`:''} [${formatTime(e.created_at)}]\n`;});
  msg+='\n🗑️ মুছতে: "৩ নম্বর মুছে দাও"';
  await sendMessage(chatId,msg,true);
}

async function deleteEntry(chatId,number) {
  if (!lastEntries?.length){await showEntries(chatId,'today');await sendMessage(chatId,'👆 কোন নম্বর মুছতে চাও বলো।');return;}
  const idx=number-1;
  if (idx<0||idx>=lastEntries.length){await sendMessage(chatId,`⚠️ ${number} নম্বর নেই।`);return;}
  const entry=lastEntries[idx];
  await supabase.from('transactions').delete().eq('id',entry.id);
  lastEntries.splice(idx,1);
  await sendMessage(chatId,`✅ মুছে দেওয়া হয়েছে।\n❌ ${entry.description||entry.type} — ₹${entry.amount||0}`);
}

// ─── REMINDERS ────────────────────────────────────────────────────────────────
async function checkReminders() {
  const IST=getIST();
  const currentTime=`${String(IST.getHours()).padStart(2,'0')}:${String(IST.getMinutes()).padStart(2,'0')}`;
  const {data}=await supabase.from('reminders').select('*').eq('active',true);
  for (const r of (data||[])) {
    if (r.time===currentTime) await sendMessage(r.chat_id,`⏰ *রিমাইন্ডার!*\n\n${r.text}`,true);
  }
}
async function setReminder(chatId,time,text) {
  await supabase.from('reminders').insert({chat_id:chatId,time,text,active:true});
  return `⏰ *রিমাইন্ডার সেট হয়েছে!*\n🕐 সময়: ${time}\n📝 বিষয়: ${text}\n\n✅ Server restart হলেও থাকবে!`;
}

// ─── AUTO REPORTS ─────────────────────────────────────────────────────────────
let lastDailyReport='',lastWeeklyReport='';
async function checkAutoReports() {
  try {
    const IST=getIST(),h=IST.getHours(),m=IST.getMinutes(),today=todayIST();
    if (h===22&&m===0&&lastDailyReport!==today) {
      lastDailyReport=today;
      await sendMessage(MY_CHAT_ID,`🌙 *রাতের অটো রিপোর্ট*\n\n${await getReport('today')}`,true);
    }
    if (IST.getDay()===0&&h===21&&m===0&&lastWeeklyReport!==today) {
      lastWeeklyReport=today;
      await sendMessage(MY_CHAT_ID,`📅 *সাপ্তাহিক রিপোর্ট*\n\n${await getReport('week')}`,true);
    }
    await checkReminders();
  } catch(e){console.error('autoReport error:',e.message);}
}

// ─── HANDLE MESSAGE ───────────────────────────────────────────────────────────
async function handleMessage(chatId,text) {
  try {
    const parsed=await parseMessage(chatId,text);
    const period=parsed.period||'today';

    switch(parsed.type) {
      case 'report':
        await sendMessage(chatId,await getReport(period),true); break;
      case 'ceo_mode':
        await sendMessage(chatId,await getCEOReport(chatId),true); break;
      case 'smart_insight':
        await sendMessage(chatId,await getSmartInsight(chatId,parsed.insight_query||text,period),true); break;
      case 'forecast':
        await sendMessage(chatId,await getForecast(chatId),true); break;
      case 'stock_status':
        await sendMessage(chatId,await getStockStatus(),true); break;
      case 'show_entries':
        await showEntries(chatId,period); break;
      case 'show_expense_detail':
        await sendMessage(chatId,await getExpenseDetail(period),true); break;
      case 'show_credit_detail':
        await sendMessage(chatId,await getCreditDetail(period),true); break;
      case 'show_sale_detail':
        await sendMessage(chatId,await getSaleDetail(period),true); break;
      case 'delete_entry':
        if (parsed.number) await deleteEntry(chatId,parsed.number);
        else {await showEntries(chatId,'today');await sendMessage(chatId,'👆 কোন নম্বর মুছতে চাও বলো।');}
        break;
      case 'set_reminder':
        if (parsed.reminder_time&&parsed.reminder_text) {
          await sendMessage(chatId,await setReminder(chatId,parsed.reminder_time,parsed.reminder_text),true);
        } else {
          await sendMessage(chatId,'⚠️ সময় আর বিষয় দুটোই বলো।\nযেমন: "রাত ৯টায় দোকান বন্ধের reminder দাও"');
        }
        break;
      case 'unknown':
        await sendMessage(chatId,parsed.reply||'🤔 বুঝতে পারিনি, আবার বলো।'); break;
      default:
        if (parsed.type==='stock_update'&&parsed.item) {
          await supabase.from('stock').upsert(
            {item:parsed.item,quantity:parsed.quantity,unit:parsed.unit,updated_at:new Date().toISOString()},
            {onConflict:'item'}
          );
        } else if (parsed.amount) {
          await supabase.from('transactions').insert({
            type:parsed.type,amount:parsed.amount,
            description:parsed.description,party:parsed.party
          });
        }
        await sendMessage(chatId,parsed.reply||'✅ লিখে রাখলাম!');
    }
  } catch(e) {
    console.error('handleMessage error:',e.message);
  }
}

// ─── WEBHOOK ──────────────────────────────────────────────────────────────────
app.post(`/webhook/${TELEGRAM_TOKEN}`, async (req,res) => {
  res.sendStatus(200);
  try {
    const msg=req.body?.message;
    if (!msg?.text) return;
    const chatId=msg.chat.id.toString();
    if (chatId!==MY_CHAT_ID){await sendMessage(chatId,'⛔ এই bot টি private।');return;}
    await handleMessage(chatId,msg.text);
  } catch(e){console.error('Webhook error:',e.message);}
});

app.get('/',(_,res)=>res.send('🤖 AI Shop Manager Pro চলছে!'));
setInterval(checkAutoReports,60000);

async function registerWebhook() {
  const url=process.env.WEBHOOK_URL;
  if (!url){console.error('❌ WEBHOOK_URL নেই!');return;}
  const webhookUrl=`${url}/webhook/${TELEGRAM_TOKEN}`;
  const res=await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/setWebhook?url=${webhookUrl}`);
  const data=await res.json();
  if (data.ok) console.log('✅ Webhook registered:',webhookUrl);
  else console.error('❌ Webhook failed:',data);
}

app.listen(PORT,async()=>{
  console.log(`🤖 AI Shop Manager Pro চালু হয়েছে! Port: ${PORT}`);
  await registerWebhook();
});

process.on('SIGTERM',()=>{console.log('Shutting down...');process.exit(0);});
