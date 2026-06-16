import TelegramBot from 'node-telegram-bot-api';
import { createClient } from '@supabase/supabase-js';
import fetch from 'node-fetch';

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const MY_CHAT_ID = process.env.MY_CHAT_ID;

async function parseMessage(text) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [{
            text: `তুমি একটি ফাস্ট ফুড দোকানের AI হিসাব সহকারী। পশ্চিমবঙ্গের বাংলায় উত্তর দেবে। মুদ্রা ₹।
শুধু JSON দাও, অন্য কিছু না:
{"type":"sale|expense_cash|expense_fixed|expense_extra|cash_open|credit_given_customer|credit_paid_customer|credit_taken_supplier|credit_paid_supplier|loan_given|loan_received|stock_update|report|unknown","amount":100,"description":"বিবরণ","party":"নাম বা null","item":"মালের নাম বা null","quantity":10,"unit":"কেজি বা null","reply":"পশ্চিমবঙ্গের বাংলায় ছোট confirm, ₹ চিহ্ন সহ"}

মেসেজ: "${text}"`
          }]
        }]
      })
    }
  );
  const data = await res.json();
  const raw = data.candidates[0].content.parts[0].text;
  return JSON.parse(raw.replace(/```json|```/g, '').trim());
}

async function getTodayReport() {
  const today = new Date().toISOString().split('T')[0];
  const { data } = await supabase
    .from('transactions')
    .select('*')
    .gte('created_at', today);

  const sum = (type) => data.filter(r => r.type === type).reduce((s, r) => s + (r.amount || 0), 0);

  const sales = sum('sale');
  const expCash = sum('expense_cash');
  const expFixed = sum('expense_fixed');
  const expExtra = sum('expense_extra');
  const totalExp = expCash + expFixed + expExtra;
  const profit = sales - totalExp;
  const custOwed = sum('credit_given_customer') - sum('credit_paid_customer');
  const suppOwed = sum('credit_taken_supplier') - sum('credit_paid_supplier');
  const loans = sum('loan_given') - sum('loan_received');

  const custCredits = data.filter(r => r.type === 'credit_given_customer');
  let creditList = '';
  if (custCredits.length > 0) {
    creditList = '\n\n⚠️ কাস্টমারের বাকি:\n';
    custCredits.forEach(c => {
      creditList += `👤 ${c.party || 'অজানা'} — ₹${c.amount}\n`;
    });
  }

  const date = new Date().toLocaleDateString('bn-IN', { day: 'numeric', month: 'long', year: 'numeric' });

  return `📊 *AI Shop Manager — দৈনিক রিপোর্ট*\n📅 ${date}\n\n` +
    `💰 *আয়*\n✅ মোট বিক্রি: ₹${sales}\n\n` +
    `❌ *খরচ*\nনগদ খরচ: ₹${expCash}\nনির্দিষ্ট খরচ: ₹${expFixed}\nবাড়তি খরচ: ₹${expExtra}\nমোট খরচ: ₹${totalExp}\n\n` +
    `🏆 *নিট লাভ: ₹${profit}*\n\n` +
    `⚠️ *বাকি ও ধার*\nকাস্টমারের কাছে পাওনা: ₹${custOwed}\nসাপ্লায়ারকে দেওয়া বাকি: ₹${suppOwed}\nধার দেওয়া: ₹${loans}` +
    creditList;
}

bot.on('message', async (msg) => {
  const chatId = msg.chat.id.toString();
  const text = msg.text;

  if (chatId !== MY_CHAT_ID) {
    bot.sendMessage(chatId, '⛔ এই bot টি private।');
    return;
  }

  if (!text) return;

  try {
    await bot.sendChatAction(chatId, 'typing');
    const parsed = await parseMessage(text);

    if (parsed.type === 'report') {
      const report = await getTodayReport();
      bot.sendMessage(chatId, report, { parse_mode: 'Markdown' });
      return;
    }

    if (parsed.type !== 'unknown') {
      if (parsed.type === 'stock_update' && parsed.item) {
        await supabase.from('stock').upsert({
          item: parsed.item,
          quantity: parsed.quantity,
          unit: parsed.unit,
          updated_at: new Date().toISOString()
        }, { onConflict: 'item' });
      } else {
        await supabase.from('transactions').insert({
          type: parsed.type,
          amount: parsed.amount,
          description: parsed.description,
          party: parsed.party,
          item: parsed.item,
          quantity: parsed.quantity,
          unit: parsed.unit
        });
      }
    }

    bot.sendMessage(chatId, parsed.reply || '✅ লিখে রাখলাম!');

  } catch (err) {
    console.error(err);
    bot.sendMessage(chatId, '⚠️ একটু সমস্যা হয়েছে, আবার বলো।');
  }
});

console.log('🤖 AI Shop Manager চালু হয়েছে!');
