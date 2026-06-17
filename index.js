import { createClient } from '@supabase/supabase-js';
import fetch from 'node-fetch';

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const MY_CHAT_ID = process.env.MY_CHAT_ID;
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

let offset = 0;
let isProcessing = false;
let lastEntries = [];
let conversationHistory = [];
let reminders = [];

function getIST() {
  return new Date(new Date().getTime() + (5.5 * 60 * 60 * 1000));
}

function formatTime(isoString) {
  const ist = new Date(new Date(isoString).getTime() + (5.5 * 60 * 60 * 1000));
  return ist.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
}

function formatDate(ist) {
  return ist.toLocaleDateString('bn-IN', { day: 'numeric', month: 'long', year: 'numeric' });
}

function getDateRange(period) {
  const IST = getIST();
  let start, end, label;

  if (period === 'today') {
    const today = IST.toISOString().split('T')[0];
    start = `${today}T00:00:00+05:30`;
    end = `${today}T23:59:59+05:30`;
    label = 'আজকের';
  } else if (period === 'yesterday') {
    const yesterday = new Date(IST.getTime() - 24 * 60 * 60 * 1000);
    const y = yesterday.toISOString().split('T')[0];
    start = `${y}T00:00:00+05:30`;
    end = `${y}T23:59:59+05:30`;
    label = 'গতকালের';
  } else if (period === 'week') {
    const weekAgo = new Date(IST.getTime() - 7 * 24 * 60 * 60 * 1000);
    start = `${weekAgo.toISOString().split('T')[0]}T00:00:00+05:30`;
    end = `${IST.toISOString().split('T')[0]}T23:59:59+05:30`;
    label = 'গত ৭ দিনের';
  } else if (period === 'month') {
    const y = IST.getFullYear();
    const m = String(IST.getMonth() + 1).padStart(2, '0');
    start = `${y}-${m}-01T00:00:00+05:30`;
    end = `${IST.toISOString().split('T')[0]}T23:59:59+05:30`;
    label = 'এই মাসের';
  } else if (period === 'last_month') {
    const d = new Date(IST.getFullYear(), IST.getMonth(), 1);
    const lastMonth = new Date(d.getTime() - 1);
    const y = lastMonth.getFullYear();
    const m = String(lastMonth.getMonth() + 1).padStart(2, '0');
    const lastDay = new Date(y, lastMonth.getMonth() + 1, 0).getDate();
    start = `${y}-${m}-01T00:00:00+05:30`;
    end = `${y}-${m}-${lastDay}T23:59:59+05:30`;
    label = 'গত মাসের';
  } else if (period === 'year') {
    const y = IST.getFullYear();
    start = `${y}-01-01T00:00:00+05:30`;
    end = `${y}-12-31T23:59:59+05:30`;
    label = `${y} সালের`;
  } else {
    const today = IST.toISOString().split('T')[0];
    start = `${today}T00:00:00+05:30`;
    end = `${today}T23:59:59+05:30`;
    label = 'আজকের';
  }

  return { start, end, label };
}

async function sendMessage(chatId, text, markdown = false) {
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: markdown ? 'Markdown' : undefined
      })
    });
  } catch (e) {
    console.error('sendMessage error:', e.message);
  }
}

async function parseMessage(text) {
  conversationHistory.push({ role: 'user', content: text });
  if (conversationHistory.length > 20) conversationHistory = conversationHistory.slice(-20);

  for (let i = 0; i < 3; i++) {
    try {
      const messages = [
        {
          role: 'system',
          content: `তুমি "AI Shop Manager" — একটি স্মার্ট ফাস্ট ফুড দোকানের AI সহকারী। পশ্চিমবঙ্গের বাংলায় কথা বলবে। মুদ্রা ₹। তুমি আগের conversation মনে রাখো এবং context বুঝে উত্তর দাও।

শুধু JSON দাও:
{
  "type": "sale|expense_cash|expense_fixed|expense_extra|cash_open|credit_given_customer|credit_paid_customer|credit_taken_supplier|credit_paid_supplier|loan_given|loan_received|stock_update|show_entries|show_expense_detail|show_credit_detail|show_sale_detail|delete_entry|set_reminder|report|unknown",
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
  "reply": "পশ্চিমবঙ্গের বাংলায় ছোট confirm"
}

period এর নিয়ম:
- "আজকের" বা কিছু না বললে → today
- "গতকালের" → yesterday
- "গত সপ্তাহ" বা "গত ৭ দিন" → week
- "এই মাস" বা "এই মাসের" → month
- "গত মাস" → last_month
- "এই বছর" বা সাল উল্লেখ → year

type গুলো:
- sale: বিক্রি
- expense_cash: নগদ খরচ (বাজার, তেল)
- expense_fixed: নির্দিষ্ট খরচ (ভাড়া, বিল, কিস্তি)
- expense_extra: বাড়তি খরচ
- cash_open: দোকান খোলার ক্যাশ
- credit_given_customer: কাস্টমারকে বাকি
- credit_paid_customer: কাস্টমার বাকি মেটাল
- credit_taken_supplier: সাপ্লায়ার থেকে বাকিতে আনলাম
- credit_paid_supplier: সাপ্লায়ারকে বাকি দিলাম
- loan_given: ধার দিলাম
- loan_received: ধার ফেরত
- stock_update: স্টক
- show_entries: সব entry দেখাও
- show_expense_detail: খরচের বিস্তারিত
- show_credit_detail: বাকির হিসাব
- show_sale_detail: বিক্রির বিস্তারিত
- delete_entry: entry মুছতে চাই
- set_reminder: reminder সেট
- report: সম্পূর্ণ রিপোর্ট
- unknown: বুঝিনি`
        },
        ...conversationHistory.slice(-10)
      ];

      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.GROQ_KEY}`
        },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages,
          temperature: 0.1
        })
      });

      const data = await res.json();
      if (data.error) {
        if (i < 2) { await new Promise(r => setTimeout(r, 3000)); continue; }
        throw new Error(data.error.message);
      }

      const raw = data.choices[0].message.content;
      const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
      conversationHistory.push({ role: 'assistant', content: parsed.reply || '' });
      return parsed;

    } catch (e) {
      console.error(`Attempt ${i + 1}:`, e.message);
      if (i < 2) await new Promise(r => setTimeout(r, 3000));
      else throw e;
    }
  }
}

async function getDataByPeriod(period) {
  const { start, end } = getDateRange(period || 'today');
  const { data, error } = await supabase
    .from('transactions')
    .select('*')
    .gte('created_at', start)
    .lte('created_at', end)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data || [];
}

async function getReport(period) {
  const IST = getIST();
  const { label } = getDateRange(period || 'today');
  const data = await getDataByPeriod(period);

  if (data.length === 0) {
    return `📊 *AI Shop Manager — ${label} রিপোর্ট*\n\nকোনো এন্ট্রি নেই।`;
  }

  const sum = (type) => data.filter(r => r.type === type).reduce((s, r) => s + (r.amount || 0), 0);
  const sales = sum('sale');
  const cashOpen = sum('cash_open');
  const expCash = sum('expense_cash');
  const expFixed = sum('expense_fixed');
  const expExtra = sum('expense_extra');
  const totalExp = expCash + expFixed + expExtra;
  const custOwed = Math.max(0, sum('credit_given_customer') - sum('credit_paid_customer'));
  const suppOwed = Math.max(0, sum('credit_taken_supplier') - sum('credit_paid_supplier'));
  const loans = Math.max(0, sum('loan_given') - sum('loan_received'));

  const custList = data.filter(r => r.type === 'credit_given_customer');
  const paidList = data.filter(r => r.type === 'credit_paid_customer').map(r => r.party);
  const unpaid = custList.filter(r => !paidList.includes(r.party));

  let creditList = '';
  if (unpaid.length > 0) {
    creditList = '\n\n⚠️ *বাকি আছে:*\n';
    unpaid.forEach(c => { creditList += `👤 ${c.party || 'অজানা'} — ₹${c.amount}\n`; });
  }

  return `📊 *AI Shop Manager — ${label} রিপোর্ট*\n📅 ${formatDate(IST)}\n\n` +
    `🏪 শুরুর ক্যাশ: ₹${cashOpen}\n` +
    `✅ মোট বিক্রি: ₹${sales}\n` +
    `❌ মোট খরচ: ₹${totalExp}\n` +
    `🏆 *নিট লাভ: ₹${sales - totalExp}*\n\n` +
    `⚠️ কাস্টমার পাওনা: ₹${custOwed}\n` +
    `🏭 সাপ্লায়ার দেনা: ₹${suppOwed}\n` +
    `🤝 ধার দেওয়া: ₹${loans}` +
    creditList;
}

async function getExpenseDetail(period) {
  const { label } = getDateRange(period || 'today');
  const data = await getDataByPeriod(period);
  const expenses = data.filter(r => ['expense_cash', 'expense_fixed', 'expense_extra'].includes(r.type));

  if (expenses.length === 0) return `📋 ${label} কোনো খরচ নেই।`;

  const typeNames = {
    expense_cash: '🛒 নগদ খরচ',
    expense_fixed: '🏠 নির্দিষ্ট খরচ',
    expense_extra: '➕ বাড়তি খরচ'
  };

  let msg = `📋 *${label} খরচের বিস্তারিত*\n\n`;
  let total = 0;

  expenses.forEach((e, i) => {
    const time = formatTime(e.created_at);
    msg += `${i + 1}. ${typeNames[e.type]}\n   📝 ${e.description || 'খরচ'} — ₹${e.amount} [${time}]\n\n`;
    total += e.amount || 0;
  });

  msg += `━━━━━━━━━━\n💸 *মোট: ₹${total}*`;
  return msg;
}

async function getCreditDetail(period) {
  const { label } = getDateRange(period || 'today');
  const data = await getDataByPeriod(period);

  const custGiven = data.filter(r => r.type === 'credit_given_customer');
  const custPaid = data.filter(r => r.type === 'credit_paid_customer');
  const suppGiven = data.filter(r => r.type === 'credit_taken_supplier');
  const loans = data.filter(r => r.type === 'loan_given');

  if (!custGiven.length && !suppGiven.length && !loans.length) {
    return `📋 ${label} কোনো বাকি বা ধার নেই।`;
  }

  let msg = `📋 *${label} বাকি ও ধারের হিসাব*\n\n`;

  if (custGiven.length > 0) {
    msg += `👥 *কাস্টমারের বাকি:*\n`;
    custGiven.forEach(c => {
      const paid = custPaid.find(p => p.party === c.party);
      msg += `👤 ${c.party || 'অজানা'} — ₹${c.amount} [${paid ? '✅ মিটিয়েছে' : '⏳ বাকি আছে'}]\n`;
    });
    msg += '\n';
  }

  if (suppGiven.length > 0) {
    msg += `🏭 *সাপ্লায়ারের দেনা:*\n`;
    suppGiven.forEach(s => {
      msg += `🏪 ${s.party || 'অজানা'} — ₹${s.amount}\n`;
    });
    msg += '\n';
  }

  if (loans.length > 0) {
    msg += `🤝 *ধার দেওয়া:*\n`;
    loans.forEach(l => {
      msg += `👤 ${l.party || 'অজানা'} — ₹${l.amount}\n`;
    });
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
    msg += `${i + 1}. 💰 ${s.description || 'বিক্রি'} — ₹${s.amount} [${formatTime(s.created_at)}]\n`;
    total += s.amount || 0;
  });

  msg += `\n━━━━━━━━━━\n✅ *মোট: ₹${total}*`;
  return msg;
}

async function showEntries(chatId, period) {
  const { label } = getDateRange(period || 'today');
  const data = await getDataByPeriod(period);

  if (!data.length) {
    await sendMessage(chatId, `📋 ${label} কোনো এন্ট্রি নেই।`);
    return;
  }

  lastEntries = data;

  const typeNames = {
    sale: '💰 বিক্রি', expense_cash: '🛒 নগদ খরচ',
    expense_fixed: '🏠 নির্দিষ্ট খরচ', expense_extra: '➕ বাড়তি খরচ',
    cash_open: '🏪 শুরুর ক্যাশ', credit_given_customer: '👤 কাস্টমার বাকি',
    credit_paid_customer: '✅ বাকি পরিশোধ', credit_taken_supplier: '🏭 সাপ্লায়ার বাকি',
    credit_paid_supplier: '✅ সাপ্লায়ার পরিশোধ', loan_given: '🤝 ধার দেওয়া',
    loan_received: '🤝 ধার পাওয়া', stock_update: '📦 স্টক',
  };

  let msg = `📋 *${label} সব এন্ট্রি:*\n\n`;
  data.forEach((e, i) => {
    const party = e.party ? ` (${e.party})` : '';
    const amount = e.amount ? ` — ₹${e.amount}` : '';
    msg += `${i + 1}. ${typeNames[e.type] || e.type}${party}${amount} [${formatTime(e.created_at)}]\n`;
  });

  msg += '\n🗑️ মুছতে: "৩ নম্বর মুছে দাও"';
  await sendMessage(chatId, msg, true);
}

async function deleteEntry(chatId, number) {
  if (!lastEntries || !lastEntries.length) {
    await showEntries(chatId, 'today');
    await sendMessage(chatId, '👆 কোন নম্বর মুছতে চাও বলো।');
    return;
  }

  const index = number - 1;
  if (index < 0 || index >= lastEntries.length) {
    await sendMessage(chatId, `⚠️ ${number} নম্বর নেই। ১ থেকে ${lastEntries.length} এর মধ্যে বলো।`);
    return;
  }

  const entry = lastEntries[index];
  await supabase.from('transactions').delete().eq('id', entry.id);
  lastEntries.splice(index, 1);
  await sendMessage(chatId, `✅ মুছে দেওয়া হয়েছে।\n❌ ${entry.description || entry.type} — ₹${entry.amount || 0}`);
}

function setReminder(chatId, time, text) {
  const [hours, minutes] = time.split(':').map(Number);
  const check = () => {
    const IST = getIST();
    if (IST.getHours() === hours && IST.getMinutes() === minutes) {
      sendMessage(chatId, `⏰ *রিমাইন্ডার!*\n\n${text}`, true);
    }
  };
  reminders.push(setInterval(check, 60000));
  return `⏰ *রিমাইন্ডার সেট হয়েছে!*\n🕐 সময়: ${time}\n📝 বিষয়: ${text}`;
}

async function handleMessage(chatId, text) {
  try {
    const parsed = await parseMessage(text);
    const period = parsed.period || 'today';

    switch (parsed.type) {
      case 'report':
        await sendMessage(chatId, await getReport(period), true);
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
        if (parsed.number) {
          await deleteEntry(chatId, parsed.number);
        } else {
          await showEntries(chatId, 'today');
          await sendMessage(chatId, '👆 কোন নম্বর মুছতে চাও বলো।');
        }
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
    await sendMessage(chatId, '⚠️ একটু সমস্যা হয়েছে, আবার বলো।');
  }
}

async function poll() {
  if (isProcessing) { setTimeout(poll, 1000); return; }
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates?offset=${offset}&timeout=25`);
    const data = await res.json();
    if (!data.ok) { setTimeout(poll, 3000); return; }

    for (const update of data.result || []) {
      offset = update.update_id + 1;
      const msg = update.message;
      if (!msg || !msg.text) continue;
      const chatId = msg.chat.id.toString();
      if (chatId !== MY_CHAT_ID) {
        await sendMessage(chatId, '⛔ এই bot টি private।');
        continue;
      }
      isProcessing = true;
      await handleMessage(chatId, msg.text);
      isProcessing = false;
    }
  } catch (e) {
    console.error('Poll error:', e.message);
    isProcessing = false;
  }
  setTimeout(poll, 1000);
}

console.log('🤖 AI Shop Manager চালু হয়েছে!');
poll();
process.on('SIGTERM', () => setTimeout(poll, 2000));
