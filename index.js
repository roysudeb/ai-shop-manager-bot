import { createClient } from '@supabase/supabase-js';
import fetch from 'node-fetch';

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const MY_CHAT_ID = process.env.MY_CHAT_ID;
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function sendMessage(chatId, text, markdown = false) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: markdown ? 'Markdown' : undefined
    })
  });
}

async function parseMessage(text) {
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
          role: 'user',
          content: `তুমি একটি ফাস্ট ফুড দোকানের AI হিসাব সহকারী। পশ্চিমবঙ্গের বাংলায় উত্তর দেবে। মুদ্রা ₹।
শুধু JSON দাও, অন্য কিছু না:
{"type":"sale|expense_cash|expense_fixed|expense_extra|cash_open|credit_given_customer|credit_paid_customer|credit_taken_supplier|credit_paid_supplier|loan_given|loan_received|stock_update|report|unknown","amount":100,"description":"বিবরণ","party":"নাম বা null","item":"মালের নাম বা null","quantity":10,"unit":"কেজি বা null","reply":"পশ্চিমবঙ্গের বাংলায় ছোট confirm, ₹ চিহ্ন সহ"}
মেসেজ: "${text}"`
        }],
        temperature: 0.1
      })
    });
    const data = await res.json();
    console.log('Groq response:', JSON.stringify(data));
    const raw = data.choices[0].message.content;
    return JSON.parse(raw.replace(/```json|```/g, '').trim());
  } catch (e) {
    console.error('parseMessage error:', e.message);
    throw e;
  }
}

async function getTodayReport() {
  try {
    const today = new Date().toISOString().split('T')[0];
    const { data, error } = await supabase.from('transactions').select('*').gte('created_at', today);
    if (error) throw error;
    if (!data || data.length === 0) {
      return `📊 *AI Shop Manager — দৈনিক রিপোর্ট*\n\nআজকে এখনো কোনো এন্ট্রি নেই।`;
    }
    const sum = (type) => data.filter(r => r.type === type).reduce((s, r) => s + (r.amount || 0), 0);
    const sales = sum('sale');
    const expCash = sum('expense_cash');
    const expFixed = sum('expense_fixed');
    const expExtra = sum('expense_extra');
    const totalExp = expCash + expFixed + expExtra;
    const custOwed = sum('credit_given_customer') - sum('credit_paid_customer');
    const suppOwed = sum('credit_taken_supplier') - sum('credit_paid_supplier');
    const loans = sum('loan_given') - sum('loan_received');
    const custCredits = data.filter(r => r.type === 'credit_given_customer');
    let creditList = '';
    if (custCredits.length > 0) {
      creditList = '\n\n⚠️ কাস্টমারের বাকি:\n';
      custCredits.forEach(c => { creditList += `👤 ${c.party || 'অজানা'} — ₹${c.amount}\n`; });
    }
    const date = new Date().toLocaleDateString('bn-IN', { day: 'numeric', month: 'long', year: 'numeric' });
    return `📊 *AI Shop Manager — দৈনিক রিপোর্ট*\n📅 ${date}\n\n✅ মোট বিক্রি: ₹${sales}\n❌ মোট খরচ: ₹${totalExp}\n🏆 নিট লাভ: ₹${sales - totalExp}\n\n⚠️ কাস্টমার পাওনা: ₹${custOwed}\n🏭 সাপ্লায়ার দেনা: ₹${suppOwed}\n🤝 ধার দেওয়া: ₹${loans}${creditList}`;
  } catch (e) {
    console.error('Report error:', e.message);
    throw e;
  }
}

let offset = 0;

async function poll() {
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates?offset=${offset}&timeout=30`);
    const data = await res.json();

    for (const update of data.result || []) {
      offset = update.update_id + 1;
      const msg = update.message;
      if (!msg || !msg.text) continue;
      const chatId = msg.chat.id.toString();
      const text = msg.text;

      if (chatId !== MY_CHAT_ID) {
        await sendMessage(chatId, '⛔ এই bot টি private।');
        continue;
      }

      try {
        const parsed = await parseMessage(text);
        if (parsed.type === 'report') {
          const report = await getTodayReport();
          await sendMessage(chatId, report, true);
        } else {
          if (parsed.type !== 'unknown' && parsed.amount) {
            if (parsed.type === 'stock_update' && parsed.item) {
              await supabase.from('stock').upsert({ item: parsed.item, quantity: parsed.quantity, unit: parsed.unit, updated_at: new Date().toISOString() }, { onConflict: 'item' });
            } else {
              await supabase.from('transactions').insert({ type: parsed.type, amount: parsed.amount, description: parsed.description, party: parsed.party });
            }
          }
          await sendMessage(chatId, parsed.reply || '✅ লিখে রাখলাম!');
        }
      } catch (e) {
        console.error('Message handling error:', e.message);
        await sendMessage(chatId, '⚠️ একটু সমস্যা হয়েছে, আবার বলো।');
      }
    }
  } catch (e) {
    console.error('Poll error:', e.message);
  }
  setTimeout(poll, 1000);
}

console.log('🤖 AI Shop Manager চালু হয়েছে!');
poll();

process.on('SIGTERM', () => {
  console.log('SIGTERM received, restarting poll...');
  setTimeout(poll, 2000);
});
