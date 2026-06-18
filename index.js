import { createClient } from '@supabase/supabase-js';
import fetch from 'node-fetch';

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const MY_CHAT_ID     = process.env.MY_CHAT_ID;
const GROQ_KEY       = process.env.GROQ_KEY;
const supabase       = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// ─── STATE ────────────────────────────────────────────────────────────────────
let offset         = 0;
let isProcessing   = false;
let lastEntries    = [];
let reminders      = [];

// ✅ DOUBLE-REPLY FIX: Supabase-এ processed update_id save করা হবে
// Supabase-এ এই table বানাও:
// CREATE TABLE processed_updates (update_id bigint primary key, created_at timestamptz default now());
// ALTER TABLE processed_updates DISABLE ROW LEVEL SECURITY;
async function isAlreadyProcessed(updateId) {
  try {
    const { data } = await supabase
      .from('processed_updates')
      .select('update_id')
      .eq('update_id', updateId)
      .single();
    return !!data;
  } catch { return false; }
}

async function markProcessed(updateId) {
  try {
    await supabase.from('processed_updates').insert({ update_id: updateId });
    // পুরনো records মুছে রাখো (১০০০ এর বেশি হলে)
    const { count } = await supabase.from('processed_updates').select('*', { count: 'exact', head: true });
    if (count > 1000) {
      const { data: old } = await supabase
        .from('processed_updates')
        .select('update_id')
        .order('created_at', { ascending: true })
        .limit(500);
      if (old?.length) {
        await supabase.from('processed_updates').delete().in('update_id', old.map(r => r.update_id));
      }
    }
  } catch (e) { console.error('markProcessed error:', e.message); }
}

// ─── SUPABASE TABLES NEEDED ───────────────────────────────────────────────────
// transactions  — existing
// stock         — existing
// memory        — NEW: id, chat_id, role, content, summary, created_at
// daily_reports — NEW: id, chat_id, date, report_json, created_at

// ═══════════════════════════════════════════════════════════════════════════════
// TIME HELPERS
// ═══════════════════════════════════════════════════════════════════════════════
function getIST() {
  return new Date(Date.now() + 5.5 * 3600000);
}

function formatTime(isoString) {
  return new Date(new Date(isoString).getTime() + 5.5 * 3600000)
    .toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
}

function formatDate(ist) {
  return ist.toLocaleDateString('bn-IN', { day: 'numeric', month: 'long', year: 'numeric' });
}

function todayIST() {
  return getIST().toISOString().split('T')[0];
}

function getDateRange(period) {
  const IST = getIST();
  let start, end, label;

  if (period === 'yesterday') {
    const y = new Date(IST.getTime() - 86400000).toISOString().split('T')[0];
    start = `${y}T00:00:00+05:30`; end = `${y}T23:59:59+05:30`; label = 'গতকালের';
  } else if (period === 'week') {
    const w = new Date(IST.getTime() - 7 * 86400000).toISOString().split('T')[0];
    start = `${w}T00:00:00+05:30`; end = `${todayIST()}T23:59:59+05:30`; label = 'গত ৭ দিনের';
  } else if (period === 'month') {
    const y = IST.getFullYear(), m = String(IST.getMonth() + 1).padStart(2, '0');
    start = `${y}-${m}-01T00:00:00+05:30`; end = `${todayIST()}T23:59:59+05:30`; label = 'এই মাসের';
  } else if (period === 'last_month') {
    const d = new Date(IST.getFullYear(), IST.getMonth(), 0);
    const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0');
    const last = new Date(y, d.getMonth() + 1, 0).getDate();
    start = `${y}-${m}-01T00:00:00+05:30`; end = `${y}-${m}-${last}T23:59:59+05:30`; label = 'গত মাসের';
  } else if (period === 'year') {
    const y = IST.getFullYear();
    start = `${y}-01-01T00:00:00+05:30`; end = `${y}-12-31T23:59:59+05:30`; label = `${y} সালের`;
  } else {
    // default: today
    const t = todayIST();
    start = `${t}T00:00:00+05:30`; end = `${t}T23:59:59+05:30`; label = 'আজকের';
  }
  return { start, end, label };
}

// ═══════════════════════════════════════════════════════════════════════════════
// TELEGRAM
// ═══════════════════════════════════════════════════════════════════════════════
async function sendMessage(chatId, text, markdown = false) {
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id:    chatId,
        text,
        parse_mode: markdown ? 'Markdown' : undefined
      })
    });
  } catch (e) {
    console.error('sendMessage error:', e.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MEMORY SYSTEM  (Supabase `memory` table)
// ═══════════════════════════════════════════════════════════════════════════════
async function loadMemory(chatId, limit = 20) {
  const { data } = await supabase
    .from('memory')
    .select('role, content')
    .eq('chat_id', chatId)
    .order('created_at', { ascending: false })
    .limit(limit);
  return (data || []).reverse();
}

async function saveMemory(chatId, role, content) {
  await supabase.from('memory').insert({ chat_id: chatId, role, content });
}

async function summariseOldMemory(chatId) {
  // keep only last 30 rows — summarise older ones to save space
  const { data } = await supabase
    .from('memory')
    .select('id, role, content')
    .eq('chat_id', chatId)
    .order('created_at', { ascending: true });

  if (!data || data.length < 40) return;

  const toSummarise = data.slice(0, data.length - 30);
  const text = toSummarise.map(r => `${r.role}: ${r.content}`).join('\n');

  const res = await callGroq([
    { role: 'system', content: 'Summarise the following shop conversation in Bengali in 3-4 lines.' },
    { role: 'user',   content: text }
  ], 0.2, 300);

  // replace old rows with a single summary row
  await supabase.from('memory').delete().in('id', toSummarise.map(r => r.id));
  await supabase.from('memory').insert({ chat_id: chatId, role: 'system', content: `[পুরনো সারসংক্ষেপ] ${res}` });
}

// ═══════════════════════════════════════════════════════════════════════════════
// GROQ HELPER
// ═══════════════════════════════════════════════════════════════════════════════
async function callGroq(messages, temperature = 0.1, maxTokens = 800) {
  for (let i = 0; i < 3; i++) {
    try {
      const res  = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${GROQ_KEY}` },
        body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages, temperature, max_tokens: maxTokens })
      });
      const data = await res.json();
      if (data.error) { if (i < 2) { await sleep(3000); continue; } throw new Error(data.error.message); }
      return data.choices[0].message.content;
    } catch (e) {
      console.error(`Groq attempt ${i + 1}:`, e.message);
      if (i < 2) await sleep(3000); else throw e;
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// AI PARSE  (intent → JSON)
// ═══════════════════════════════════════════════════════════════════════════════
async function parseMessage(chatId, text) {
  const history = await loadMemory(chatId, 16);
  await saveMemory(chatId, 'user', text);

  const systemPrompt = `তুমি "AI Shop Manager" — একটি স্মার্ট ফাস্ট ফুড দোকানের AI সহকারী।
পশ্চিমবঙ্গের বাংলায় কথা বলবে। মুদ্রা ₹। আগের conversation মনে রাখো।

শুধু একটি JSON object দাও (markdown ছাড়া):
{
  "type": "sale|expense_cash|expense_fixed|expense_extra|cash_open|credit_given_customer|credit_paid_customer|credit_taken_supplier|credit_paid_supplier|loan_given|loan_received|stock_update|show_entries|show_expense_detail|show_credit_detail|show_sale_detail|delete_entry|set_reminder|report|smart_insight|unknown",
  "amount": 100,
  "description": "বিবরণ",
  "party": "নাম বা null",
  "item": "মালের নাম বা null",
  "quantity": 10,
  "unit": "কেজি বা null",
  "number": null,
  "period": "today|yesterday|week|month|last_month|year",
  "reminder_time": "HH:MM বা null",
  "reminder_text": "reminder message বা null",
  "insight_query": "user কি জানতে চাইছে বা null",
  "reply": "পশ্চিমবঙ্গের বাংলায় ছোট confirm"
}

period নিয়ম:
"আজকের"/কিছু না বললে → today | "গতকালের" → yesterday
"গত সপ্তাহ/৭ দিন" → week | "এই মাস" → month | "গত মাস" → last_month | সাল → year

type নিয়ম:
sale=বিক্রি | expense_cash=নগদ খরচ | expense_fixed=নির্দিষ্ট খরচ | expense_extra=বাড়তি খরচ
cash_open=দোকান খোলার ক্যাশ | credit_given_customer=কাস্টমারকে বাকি | credit_paid_customer=বাকি পেলাম
credit_taken_supplier=সাপ্লায়ার থেকে বাকিতে আনলাম | credit_paid_supplier=সাপ্লায়ারকে দিলাম
loan_given=ধার দিলাম | loan_received=ধার ফেরত | stock_update=স্টক
show_entries=সব entry | show_expense_detail=খরচ বিস্তারিত | show_credit_detail=বাকি হিসাব
show_sale_detail=বিক্রি বিস্তারিত | delete_entry=মুছতে চাই | set_reminder=reminder
report=রিপোর্ট | smart_insight=বিশ্লেষণ/কেন/তুলনা/পরামর্শ | unknown=বুঝিনি`;

  const messages = [
    { role: 'system', content: systemPrompt },
    ...history,
    { role: 'user', content: text }
  ];

  const raw = await callGroq(messages, 0.1, 600);

  let parsed;
  try {
    // JSON বের করার চেষ্টা — Groq কখনো extra text দিলেও কাজ করবে
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON found');
    parsed = JSON.parse(jsonMatch[0]);
  } catch (e) {
    console.error('JSON parse error:', e.message, '| raw:', raw.slice(0, 100));
    // parse fail হলে safe fallback — retry করবে না
    return { type: 'unknown', reply: '🤔 বুঝতে পারিনি, একটু স্পষ্ট করে বলো।' };
  }

  await saveMemory(chatId, 'assistant', parsed.reply || '');
  summariseOldMemory(chatId).catch(() => {});  // background, await নয়
  return parsed;
}

// ═══════════════════════════════════════════════════════════════════════════════
// DATA HELPERS
// ═══════════════════════════════════════════════════════════════════════════════
async function getDataByPeriod(period) {
  const { start, end } = getDateRange(period || 'today');
  const { data, error } = await supabase
    .from('transactions').select('*')
    .gte('created_at', start).lte('created_at', end)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data || [];
}

function sumType(data, type) {
  return data.filter(r => r.type === type).reduce((s, r) => s + (r.amount || 0), 0);
}

// ═══════════════════════════════════════════════════════════════════════════════
// REPORT
// ═══════════════════════════════════════════════════════════════════════════════
async function getReport(period) {
  const IST = getIST();
  const { label } = getDateRange(period || 'today');
  const data = await getDataByPeriod(period);

  if (!data.length) return `📊 *AI Shop Manager — ${label} রিপোর্ট*\n\nকোনো এন্ট্রি নেই।`;

  const sales    = sumType(data, 'sale');
  const cashOpen = sumType(data, 'cash_open');
  const expCash  = sumType(data, 'expense_cash');
  const expFixed = sumType(data, 'expense_fixed');
  const expExtra = sumType(data, 'expense_extra');
  const totalExp = expCash + expFixed + expExtra;
  const custOwed = Math.max(0, sumType(data, 'credit_given_customer') - sumType(data, 'credit_paid_customer'));
  const suppOwed = Math.max(0, sumType(data, 'credit_taken_supplier') - sumType(data, 'credit_paid_supplier'));
  const loans    = Math.max(0, sumType(data, 'loan_given') - sumType(data, 'loan_received'));
  const netProfit = sales - totalExp;

  // unpaid customers
  const custGiven = data.filter(r => r.type === 'credit_given_customer');
  const custPaidParties = data.filter(r => r.type === 'credit_paid_customer').map(r => r.party);
  const unpaid = custGiven.filter(r => !custPaidParties.includes(r.party));
  let creditList = '';
  if (unpaid.length) {
    creditList = '\n\n⚠️ *বাকি আছে:*\n';
    unpaid.forEach(c => { creditList += `👤 ${c.party || 'অজানা'} — ₹${c.amount}\n`; });
  }

  // expense breakdown
  const expBreak = expCash || expFixed || expExtra
    ? `\n   🛒 নগদ: ₹${expCash} | 🏠 নির্দিষ্ট: ₹${expFixed} | ➕ বাড়তি: ₹${expExtra}`
    : '';

  return `📊 *AI Shop Manager — ${label} রিপোর্ট*\n📅 ${formatDate(IST)}\n\n` +
    `🏪 শুরুর ক্যাশ: ₹${cashOpen}\n` +
    `✅ মোট বিক্রি: ₹${sales}\n` +
    `❌ মোট খরচ: ₹${totalExp}${expBreak}\n` +
    `🏆 *নিট লাভ: ₹${netProfit}*\n\n` +
    `⚠️ কাস্টমার পাওনা: ₹${custOwed}\n` +
    `🏭 সাপ্লায়ার দেনা: ₹${suppOwed}\n` +
    `🤝 ধার দেওয়া: ₹${loans}` +
    creditList;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SMART INSIGHT  (AI analyst)
// ═══════════════════════════════════════════════════════════════════════════════
async function getSmartInsight(chatId, query, period) {
  await sendMessage(chatId, '🧠 বিশ্লেষণ করছি...');

  const data    = await getDataByPeriod(period || 'month');
  const sales   = sumType(data, 'sale');
  const expCash = sumType(data, 'expense_cash');
  const expFixed= sumType(data, 'expense_fixed');
  const expExtra= sumType(data, 'expense_extra');

  // group expenses by description
  const expMap = {};
  data.filter(r => ['expense_cash','expense_fixed','expense_extra'].includes(r.type))
    .forEach(r => {
      const key = r.description || 'অন্যান্য';
      expMap[key] = (expMap[key] || 0) + (r.amount || 0);
    });

  // group sales by description
  const saleMap = {};
  data.filter(r => r.type === 'sale').forEach(r => {
    const key = r.description || 'অন্যান্য';
    saleMap[key] = (saleMap[key] || 0) + (r.amount || 0);
  });

  const summary = {
    period: period || 'month',
    total_sales: sales,
    total_expense: expCash + expFixed + expExtra,
    net_profit: sales - expCash - expFixed - expExtra,
    expense_breakdown: expMap,
    sale_breakdown: saleMap,
    credit_given: sumType(data, 'credit_given_customer'),
    credit_received: sumType(data, 'credit_paid_customer'),
  };

  const insightPrompt = `তুমি একজন দোকানের business analyst। নিচের ডেটা দেখে user-এর প্রশ্নের উত্তর দাও।
পশ্চিমবঙ্গের বাংলায় উত্তর দাও। সংক্ষেপে কিন্তু insightful।

ডেটা: ${JSON.stringify(summary)}
User-এর প্রশ্ন: ${query}

সম্ভব হলে:
- সংখ্যা/শতাংশ দিয়ে explain করো
- কোনো সমস্যা থাকলে বলো
- পরামর্শ দাও`;

  const answer = await callGroq(
    [{ role: 'system', content: insightPrompt }, { role: 'user', content: query }],
    0.3, 500
  );
  return `🧠 *স্মার্ট বিশ্লেষণ*\n\n${answer}`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPENSE / CREDIT / SALE DETAIL
// ═══════════════════════════════════════════════════════════════════════════════
async function getExpenseDetail(period) {
  const { label } = getDateRange(period || 'today');
  const data = await getDataByPeriod(period);
  const expenses = data.filter(r => ['expense_cash','expense_fixed','expense_extra'].includes(r.type));
  if (!expenses.length) return `📋 ${label} কোনো খরচ নেই।`;

  const typeNames = { expense_cash:'🛒 নগদ খরচ', expense_fixed:'🏠 নির্দিষ্ট খরচ', expense_extra:'➕ বাড়তি খরচ' };
  let msg = `📋 *${label} খরচের বিস্তারিত*\n\n`;
  let total = 0;
  expenses.forEach((e, i) => {
    msg += `${i+1}. ${typeNames[e.type]}\n   📝 ${e.description||'খরচ'} — ₹${e.amount} [${formatTime(e.created_at)}]\n\n`;
    total += e.amount || 0;
  });
  msg += `━━━━━━━━━━\n💸 *মোট: ₹${total}*`;
  return msg;
}

async function getCreditDetail(period) {
  const { label } = getDateRange(period || 'today');
  const data = await getDataByPeriod(period);
  const cg = data.filter(r => r.type === 'credit_given_customer');
  const cp = data.filter(r => r.type === 'credit_paid_customer');
  const sg = data.filter(r => r.type === 'credit_taken_supplier');
  const lg = data.filter(r => r.type === 'loan_given');
  if (!cg.length && !sg.length && !lg.length) return `📋 ${label} কোনো বাকি বা ধার নেই।`;

  let msg = `📋 *${label} বাকি ও ধারের হিসাব*\n\n`;
  if (cg.length) {
    msg += `👥 *কাস্টমারের বাকি:*\n`;
    cg.forEach(c => {
      const paid = cp.find(p => p.party === c.party);
      msg += `👤 ${c.party||'অজানা'} — ₹${c.amount} [${paid ? '✅ মিটিয়েছে' : '⏳ বাকি আছে'}]\n`;
    });
    msg += '\n';
  }
  if (sg.length) {
    msg += `🏭 *সাপ্লায়ারের দেনা:*\n`;
    sg.forEach(s => { msg += `🏪 ${s.party||'অজানা'} — ₹${s.amount}\n`; });
    msg += '\n';
  }
  if (lg.length) {
    msg += `🤝 *ধার দেওয়া:*\n`;
    lg.forEach(l => { msg += `👤 ${l.party||'অজানা'} — ₹${l.amount}\n`; });
  }
  return msg;
}

async function getSaleDetail(period) {
  const { label } = getDateRange(period || 'today');
  const data = await getDataByPeriod(period);
  const sales = data.filter(r => r.type === 'sale');
  if (!sales.length) return `📋 ${label} কোনো বিক্রি নেই।`;

  let msg = `📋 *${label} বিক্রির বিস্তারিত*\n\n`;
  let total = 0;
  sales.forEach((s, i) => {
    msg += `${i+1}. 💰 ${s.description||'বিক্রি'} — ₹${s.amount} [${formatTime(s.created_at)}]\n`;
    total += s.amount || 0;
  });
  msg += `\n━━━━━━━━━━\n✅ *মোট: ₹${total}*`;
  return msg;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SHOW ENTRIES + DELETE
// ═══════════════════════════════════════════════════════════════════════════════
async function showEntries(chatId, period) {
  const { label } = getDateRange(period || 'today');
  const data = await getDataByPeriod(period);
  if (!data.length) { await sendMessage(chatId, `📋 ${label} কোনো এন্ট্রি নেই।`); return; }

  lastEntries = data;
  const typeNames = {
    sale:'💰 বিক্রি', expense_cash:'🛒 নগদ খরচ', expense_fixed:'🏠 নির্দিষ্ট খরচ',
    expense_extra:'➕ বাড়তি খরচ', cash_open:'🏪 শুরুর ক্যাশ',
    credit_given_customer:'👤 কাস্টমার বাকি', credit_paid_customer:'✅ বাকি পরিশোধ',
    credit_taken_supplier:'🏭 সাপ্লায়ার বাকি', credit_paid_supplier:'✅ সাপ্লায়ার পরিশোধ',
    loan_given:'🤝 ধার দেওয়া', loan_received:'🤝 ধার পাওয়া', stock_update:'📦 স্টক',
  };

  let msg = `📋 *${label} সব এন্ট্রি:*\n\n`;
  data.forEach((e, i) => {
    const party  = e.party  ? ` (${e.party})`  : '';
    const amount = e.amount ? ` — ₹${e.amount}` : '';
    msg += `${i+1}. ${typeNames[e.type]||e.type}${party}${amount} [${formatTime(e.created_at)}]\n`;
  });
  msg += '\n🗑️ মুছতে: "৩ নম্বর মুছে দাও"';
  await sendMessage(chatId, msg, true);
}

async function deleteEntry(chatId, number) {
  if (!lastEntries?.length) {
    await showEntries(chatId, 'today');
    await sendMessage(chatId, '👆 কোন নম্বর মুছতে চাও বলো।');
    return;
  }
  const idx = number - 1;
  if (idx < 0 || idx >= lastEntries.length) {
    await sendMessage(chatId, `⚠️ ${number} নম্বর নেই। ১ থেকে ${lastEntries.length} এর মধ্যে বলো।`);
    return;
  }
  const entry = lastEntries[idx];
  await supabase.from('transactions').delete().eq('id', entry.id);
  lastEntries.splice(idx, 1);
  await sendMessage(chatId, `✅ মুছে দেওয়া হয়েছে।\n❌ ${entry.description||entry.type} — ₹${entry.amount||0}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// REMINDER
// ═══════════════════════════════════════════════════════════════════════════════
function setReminder(chatId, time, text) {
  const [hours, minutes] = time.split(':').map(Number);
  const id = setInterval(() => {
    const IST = getIST();
    if (IST.getHours() === hours && IST.getMinutes() === minutes) {
      sendMessage(chatId, `⏰ *রিমাইন্ডার!*\n\n${text}`, true);
    }
  }, 60000);
  reminders.push(id);
  return `⏰ *রিমাইন্ডার সেট হয়েছে!*\n🕐 সময়: ${time}\n📝 বিষয়: ${text}`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// AUTO DAILY REPORT  (sends at 10 PM IST every day)
// ═══════════════════════════════════════════════════════════════════════════════
let lastAutoReportDate = '';
async function checkAutoReport() {
  const IST = getIST();
  if (IST.getHours() === 22 && IST.getMinutes() === 0) {
    const today = todayIST();
    if (lastAutoReportDate !== today) {
      lastAutoReportDate = today;
      const report = await getReport('today');
      await sendMessage(MY_CHAT_ID, `🌙 *রাতের অটো রিপোর্ট*\n\n${report.replace('📊 *AI Shop Manager — আজকের রিপোর্ট*\n', '')}`, true);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// HANDLE MESSAGE  (main router)
// ═══════════════════════════════════════════════════════════════════════════════
async function handleMessage(chatId, text) {
  try {
    const parsed = await parseMessage(chatId, text);
    const period = parsed.period || 'today';

    switch (parsed.type) {

      case 'report':
        await sendMessage(chatId, await getReport(period), true);
        break;

      case 'smart_insight':
        await sendMessage(chatId, await getSmartInsight(chatId, parsed.insight_query || text, period), true);
        break;

      case 'show_entries':
        await showEntries(chatId, period);
        break;

      case 'show_expense_detail':
        await sendMessage(chatId, await getExpenseDetail(period), true);
        break;

      case 'show_credit_detail':
        await sendMessage(chatId, await getCreditDetail(period), true);
        break;

      case 'show_sale_detail':
        await sendMessage(chatId, await getSaleDetail(period), true);
        break;

      case 'delete_entry':
        if (parsed.number) await deleteEntry(chatId, parsed.number);
        else { await showEntries(chatId, 'today'); await sendMessage(chatId, '👆 কোন নম্বর মুছতে চাও বলো।'); }
        break;

      case 'set_reminder':
        if (parsed.reminder_time && parsed.reminder_text) {
          await sendMessage(chatId, setReminder(chatId, parsed.reminder_time, parsed.reminder_text), true);
        } else {
          await sendMessage(chatId, '⚠️ সময় আর বিষয় দুটোই বলো।\nযেমন: "রাত ৯টায় দোকান বন্ধের reminder দাও"');
        }
        break;

      case 'unknown':
        await sendMessage(chatId, parsed.reply || '🤔 বুঝতে পারিনি, একটু স্পষ্ট করে বলো।');
        break;

      default:
        if (parsed.type === 'stock_update' && parsed.item) {
          await supabase.from('stock').upsert({
            item: parsed.item, quantity: parsed.quantity,
            unit: parsed.unit, updated_at: new Date().toISOString()
          }, { onConflict: 'item' });
        } else if (parsed.amount) {
          await supabase.from('transactions').insert({
            type: parsed.type, amount: parsed.amount,
            description: parsed.description, party: parsed.party
          });
        }
        await sendMessage(chatId, parsed.reply || '✅ লিখে রাখলাম!');
    }
  } catch (e) {
    console.error('handleMessage error:', e.message);
    // শুধু log করো — message পাঠিও না, নাহলে double reply হয়
  }
}


// ═══════════════════════════════════════════════════════════════════════════════
// WEBHOOK SERVER  (double-reply permanently fixed)
// ═══════════════════════════════════════════════════════════════════════════════
import express from 'express';

const app  = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());

// Telegram webhook endpoint
app.post(`/webhook/${TELEGRAM_TOKEN}`, async (req, res) => {
  res.sendStatus(200);  // ✅ Telegram-কে সাথে সাথে 200 দাও — retry বন্ধ হবে

  try {
    const update = req.body;
    const msg    = update?.message;
    if (!msg?.text) return;

    const chatId = msg.chat.id.toString();
    if (chatId !== MY_CHAT_ID) {
      await sendMessage(chatId, '⛔ এই bot টি private।');
      return;
    }

    await handleMessage(chatId, msg.text);
  } catch (e) {
    console.error('Webhook handler error:', e.message);
  }
});

// Health check
app.get('/', (req, res) => res.send('🤖 AI Shop Manager চলছে!'));

// Auto daily report check (every minute)
setInterval(checkAutoReport, 60000);

// Register webhook with Telegram
async function registerWebhook() {
  const url = process.env.WEBHOOK_URL;  // যেমন: https://your-app.railway.app
  if (!url) { console.error('❌ WEBHOOK_URL env variable নেই!'); return; }

  const webhookUrl = `${url}/webhook/${TELEGRAM_TOKEN}`;
  const res  = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/setWebhook?url=${webhookUrl}`);
  const data = await res.json();
  if (data.ok) console.log('✅ Webhook registered:', webhookUrl);
  else console.error('❌ Webhook registration failed:', data);
}

app.listen(PORT, async () => {
  console.log(`🤖 AI Shop Manager Advanced চালু হয়েছে! Port: ${PORT}`);
  await registerWebhook();
});

process.on('SIGTERM', () => { console.log('Shutting down...'); process.exit(0); });
