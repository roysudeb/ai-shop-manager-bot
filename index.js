import { createClient } from '@supabase/supabase-js';
import fetch from 'node-fetch';

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const MY_CHAT_ID = process.env.MY_CHAT_ID;
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

let offset = 0;
let isProcessing = false;
let lastEntries = [];

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
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.GROQ_KEY}`
        },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: [{
            role: 'system',
            content: `তুমি একটি ফাস্ট ফুড দোকানের AI হিসাব সহকারী। পশ্চিমবঙ্গের বাংলায় উত্তর দেবে। মুদ্রা ₹।
শুধু JSON দাও, অন্য কিছু না।

type এর মান:
- sale: বিক্রি
- expense_cash: নগদ খরচ
- expense_fixed: নির্দিষ্ট খরচ (ভাড়া, বিল, কিস্তি)
- expense_extra: বাড়তি খরচ
- cash_open: দোকান খোলার ক্যাশ
- credit_given_customer: কাস্টমারকে বাকি দিলাম
- credit_paid_customer: কাস্টমার বাকি মেটাল
- credit_taken_supplier: সাপ্লায়ার থেকে বাকিতে আনলাম
- credit_paid_supplier: সাপ্লায়ারকে বাকি দিলাম
- loan_given: ধার দিলাম
- loan_received: ধার ফেরত পেলাম
- stock_update: স্টক আপডেট
- show_entries: আজকের entry দেখতে চাই
- delete_entry: কোনো entry মুছতে চাই (number field এ কোন নম্বর মুছবে)
- report: রিপোর্ট চাই
- unknown: বুঝতে পারিনি

JSON format:
{"type":"...","amount":100,"description":"বিবরণ","party":"নাম বা null","item":"মালের নাম বা null","quantity":10,"unit":"কেজি বা null","number":null,"reply":"পশ্চিমবঙ্গের বাংলায় ছোট confirm, ₹ চিহ্ন সহ"}`
          }, {
            role: 'user',
            content: `মেসেজ: "${text}"`
          }],
          temperature: 0.1
        })
      });
      const data = await res.json();
      if (data.error) {
        if (i < 2) { await new Promise(r => setTimeout(r, 3000)); continue; }
        throw new Error(data.error.message);
      }
      const raw = data.choices[0].message.content;
      return JSON.parse(raw.replace(/```json|```/g, '').trim());
    } catch (e) {
      console.error(`Attempt ${i + 1} error:`, e.message);
      if (i < 2) await new Promise(r => setTimeout(r, 3000));
      else throw e;
    }
  }
}

async function getTodayReport() {
  const now = new Date();
  const IST = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
  const today = IST.toISOString().split('T')[0];
  const startOfDay = `${today}T00:00:00+05:30`;

  const { data, error } = await supabase
    .from('transactions')
    .select('*')
    .gte('created_at', startOfDay)
    .order('created_at', { ascending: false });

  if (error) throw error;
  if (!data || data.length === 0) {
    return `📊 *AI Shop Manager — দৈনিক রিপোর্ট*\n📅 ${IST.toLocaleDateString('bn-IN', { day: 'numeric', month: 'long', year: 'numeric' })}\n\nআজকে এখনো কোনো এন্ট্রি নেই।`;
  }

  const sum = (type) => data.filter(r => r.type === type).reduce((s, r) => s + (r.amount || 0), 0);
  const sales = sum('sale');
  const cashOpen = sum('cash_open');
  const totalExp = sum('expense_cash') + sum('expense_fixed') + sum('expense_extra');
  const custOwed = Math.max(0, sum('credit_given_customer') - sum('credit_paid_customer'));
  const suppOwed = Math.max(0, sum('credit_taken_supplier') - sum('credit_paid_supplier'));
  const loans = Math.max(0, sum('loan_given') - sum('loan_received'));

  const custCredits = data.filter(r => r.type === 'credit_given_customer');
  let creditList = '';
  if (custCredits.length > 0) {
    creditList = '\n\n⚠️ *কাস্টমারের বাকি:*\n';
    custCredits.forEach(c => {
      creditList += `👤 ${c.party || 'অজানা'} — ₹${c.amount}\n`;
    });
  }

  const dateStr = IST.toLocaleDateString('bn-IN', { day: 'numeric', month: 'long', year: 'numeric' });
  return `📊 *AI Shop Manager — দৈনিক রিপোর্ট*\n📅 ${dateStr}\n\n` +
    `🏪 শুরুর ক্যাশ: ₹${cashOpen}\n` +
    `✅ মোট বিক্রি: ₹${sales}\n` +
    `❌ মোট খরচ: ₹${totalExp}\n` +
    `🏆 *নিট লাভ: ₹${sales - totalExp}*\n\n` +
    `⚠️ কাস্টমার পাওনা: ₹${custOwed}\n` +
    `🏭 সাপ্লায়ার দেনা: ₹${suppOwed}\n` +
    `🤝 ধার দেওয়া: ₹${loans}` +
    creditList;
}

async function showTodayEntries(chatId) {
  const now = new Date();
  const IST = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
  const today = IST.toISOString().split('T')[0];
  const startOfDay = `${today}T00:00:00+05:30`;

  const { data, error } = await supabase
    .from('transactions')
    .select('*')
    .gte('created_at', startOfDay)
    .order('created_at', { ascending: true });

  if (error) throw error;
  if (!data || data.length === 0) {
    await sendMessage(chatId, '📋 আজকে এখনো কোনো এন্ট্রি নেই।');
    return;
  }

  lastEntries = data;

  const typeNames = {
    sale: '💰 বিক্রি',
    expense_cash: '🛒 নগদ খরচ',
    expense_fixed: '🏠 নির্দিষ্ট খরচ',
    expense_extra: '➕ বাড়তি খরচ',
    cash_open: '🏪 শুরুর ক্যাশ',
    credit_given_customer: '👤 কাস্টমার বাকি',
    credit_paid_customer: '✅ বাকি পরিশোধ',
    credit_taken_supplier: '🏭 সাপ্লায়ার বাকি',
    credit_paid_supplier: '✅ সাপ্লায়ার পরিশোধ',
    loan_given: '🤝 ধার দেওয়া',
    loan_received: '🤝 ধার পাওয়া',
    stock_update: '📦 স্টক',
  };

  let msg = '📋 *আজকের সব এন্ট্রি:*\n\n';
  data.forEach((entry, i) => {
    const typeName = typeNames[entry.type] || entry.type;
    const party = entry.party ? ` (${entry.party})` : '';
    const amount = entry.amount ? ` — ₹${entry.amount}` : '';
    const time = new Date(entry.created_at).toLocaleTimeString('bn-IN', { hour: '2-digit', minute: '2-digit' });
    msg += `${i + 1}. ${typeName}${party}${amount} [${time}]\n`;
  });

  msg += '\n🗑️ মুছতে চাইলে বলো: "৩ নম্বর মুছে দাও"';
  await sendMessage(chatId, msg, true);
}

async function deleteEntry(chatId, number) {
  if (!lastEntries || lastEntries.length === 0) {
    await sendMessage(chatId, '⚠️ আগে "আজকের সব এন্ট্রি দেখাও" বলো।');
    return;
  }

  const index = number - 1;
  if (index < 0 || index >= lastEntries.length) {
    await sendMessage(chatId, `⚠️ ${number} নম্বর entry নেই। সঠিক নম্বর দাও।`);
    return;
  }

  const entry = lastEntries[index];
  const { error } = await supabase.from('transactions').delete().eq('id', entry.id);

  if (error) {
    await sendMessage(chatId, '⚠️ মুছতে সমস্যা হয়েছে।');
    return;
  }

  lastEntries.splice(index, 1);
  await sendMessage(chatId, `✅ ${number} নম্বর entry মুছে দেওয়া হয়েছে।\n❌ মুছা: ${entry.description || entry.type} — ₹${entry.amount || 0}`);
}

async function handleMessage(chatId, text) {
  try {
    const parsed = await parseMessage(text);

    if (parsed.type === 'report') {
      const report = await getTodayReport();
      await sendMessage(chatId, report, true);
      return;
    }

    if (parsed.type === 'show_entries') {
      await showTodayEntries(chatId);
      return;
    }

    if (parsed.type === 'delete_entry' && parsed.number) {
      await deleteEntry(chatId, parsed.number);
      return;
    }

    if (parsed.type === 'unknown') {
      await sendMessage(chatId, '🤔 বুঝতে পারিনি, একটু স্পষ্ট করে বলো।');
      return;
    }

    if (parsed.amount || parsed.type === 'stock_update') {
      if (parsed.type === 'stock_update' && parsed.item) {
        await supabase.from('stock').upsert({
          item: parsed.item,
          quantity: parsed.quantity,
          unit: parsed.unit,
          updated_at: new Date().toISOString()
        }, { onConflict: 'item' });
      } else if (parsed.amount) {
        await supabase.from('transactions').insert({
          type: parsed.type,
          amount: parsed.amount,
          description: parsed.description,
          party: parsed.party
        });
      }
    }

    await sendMessage(chatId, parsed.reply || '✅ লিখে রাখলাম!');

  } catch (e) {
    console.error('handleMessage error:', e.message);
    await sendMessage(chatId, '⚠️ একটু সমস্যা হয়েছে, আবার বলো।');
  }
}

async function poll() {
  if (isProcessing) {
    setTimeout(poll, 1000);
    return;
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates?offset=${offset}&timeout=25`);
    const data = await res.json();

    if (!data.ok) {
      setTimeout(poll, 3000);
      return;
    }

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

process.on('SIGTERM', () => {
  setTimeout(poll, 2000);
});
