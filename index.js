import { createClient } from '@supabase/supabase-js';
import fetch from 'node-fetch';

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const MY_CHAT_ID = process.env.MY_CHAT_ID;
const GROQ_KEY = process.env.GROQ_KEY;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

let offset = 0;

/* ---------------- SEND MESSAGE ---------------- */
async function sendMessage(chatId, text) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ chat_id: chatId, text })
  });
}

/* ---------------- SMART PARSER ---------------- */
async function parseMessage(text) {

  const messages = [
    {
      role: "system",
      content: `
তুমি smart intent detector।

User ভুল বানান / mixed language লিখতে পারে।

ONLY JSON:
{
"type":"sale|expense|report|unknown",
"amount":number,
"description":"text"
}

Examples:
"momo 200" → sale
"tel 500" → expense
"ajker report" → report
`
    },
    { role: "user", content: text }
  ];

  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${GROQ_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages,
        temperature: 0
      })
    });

    const data = await res.json();
    let raw = data.choices[0].message.content;

    raw = raw.replace(/```json|```/g, '').trim();

    return JSON.parse(raw);

  } catch {
    return { type: "unknown" };
  }
}

/* ---------------- DATABASE ---------------- */

async function add(type, amount, description) {
  await supabase.from('transactions').insert({
    type,
    amount,
    description
  });
}

async function getReport() {
  const { data } = await supabase.from('transactions').select('*');

  let sales = 0;
  let expense = 0;

  data.forEach(d => {
    if (d.type === 'sale') sales += d.amount;
    if (d.type === 'expense') expense += d.amount;
  });

  return `📊 আজকের রিপোর্ট

💰 বিক্রি: ₹${sales}
💸 খরচ: ₹${expense}
🏆 লাভ: ₹${sales - expense}`;
}

/* ---------------- AUTO DAILY REPORT ---------------- */

function startAutoReport() {
  setInterval(async () => {
    const report = await getReport();
    await sendMessage(MY_CHAT_ID, "📅 Daily Auto Report\n\n" + report);
  }, 24 * 60 * 60 * 1000);
}

/* ---------------- MAIN LOGIC ---------------- */

async function handle(chatId, text) {

  const parsed = await parseMessage(text);

  if (parsed.type === 'sale') {
    await add('sale', parsed.amount, parsed.description);
    return sendMessage(chatId, `✅ বিক্রি যোগ হয়েছে ₹${parsed.amount}`);
  }

  if (parsed.type === 'expense') {
    await add('expense', parsed.amount, parsed.description);
    return sendMessage(chatId, `💸 খরচ যোগ হয়েছে ₹${parsed.amount}`);
  }

  if (parsed.type === 'report') {
    return sendMessage(chatId, await getReport());
  }

  return sendMessage(chatId, "⚠️ বুঝতে পারিনি, আবার বলো");
}

/* ---------------- POLLING FIX ---------------- */

async function poll() {
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates?offset=${offset}&timeout=30`
    );

    const data = await res.json();

    for (const update of data.result || []) {

      if (update.update_id < offset) continue;

      offset = update.update_id + 1;

      const msg = update.message;
      if (!msg || !msg.text) continue;

      const chatId = msg.chat.id.toString();

      if (chatId !== MY_CHAT_ID) continue;

      await handle(chatId, msg.text);
    }

  } catch (e) {
    console.log("error:", e.message);
  }

  setTimeout(poll, 1500);
}

/* ---------------- START ---------------- */

console.log("🚀 NEXT LEVEL BOT RUNNING...");
startAutoReport();
poll();
