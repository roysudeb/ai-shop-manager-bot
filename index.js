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
let processingIds = new Set();

/* ---------------- SEND MESSAGE ---------------- */
async function sendMessage(chatId, text) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ chat_id: chatId, text })
  });
}

/* ---------------- AI PARSE (FIXED) ---------------- */
async function parseMessage(text) {

  const messages = [
    {
      role: "system",
      content: `
তুমি Smart AI Shop Manager।

STRICT RULE:
- কখনো একই reply repeat করবে না
- short reply
- clean Bengali
- ভুল বানান বুঝবে

OUTPUT JSON ONLY:
{
"type":"sale|expense|report|unknown",
"amount":number,
"description":"text",
"reply":"clean short bengali"
}

Examples:
"মোমো বিক্রি ৪৫০" → sale
"তেল ৫০০" → expense
"হিসাব দাও" → report
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

    const parsed = JSON.parse(raw);

    return parsed;

  } catch (e) {
    return { type: "unknown", reply: "আবার বলো" };
  }
}

/* ---------------- DB ---------------- */

async function add(type, amount, desc) {
  await supabase.from('transactions').insert({
    type,
    amount,
    description: desc
  });
}

async function getReport() {
  const { data } = await supabase.from('transactions').select('*');

  let sales = 0, expense = 0;

  data.forEach(d => {
    if (d.type === 'sale') sales += d.amount;
    if (d.type === 'expense') expense += d.amount;
  });

  return `📊 রিপোর্ট
💰 বিক্রি: ₹${sales}
💸 খরচ: ₹${expense}
🏆 লাভ: ₹${sales - expense}`;
}

/* ---------------- HANDLE ---------------- */

async function handle(chatId, text) {

  const parsed = await parseMessage(text);

  if (parsed.type === 'sale') {
    await add('sale', parsed.amount, parsed.description);
    return sendMessage(chatId, parsed.reply || "বিক্রি যোগ হয়েছে");
  }

  if (parsed.type === 'expense') {
    await add('expense', parsed.amount, parsed.description);
    return sendMessage(chatId, parsed.reply || "খরচ যোগ হয়েছে");
  }

  if (parsed.type === 'report') {
    return sendMessage(chatId, await getReport());
  }

  return sendMessage(chatId, parsed.reply || "বুঝিনি");
}

/* ---------------- POLL (REAL FIX) ---------------- */

async function poll() {
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates?offset=${offset}&timeout=20`
    );

    const data = await res.json();

    for (const update of data.result || []) {

      offset = update.update_id + 1;

      const msg = update.message;
      if (!msg || !msg.text) continue;

      // 🔥 HARD DUPLICATE FIX
      if (processingIds.has(msg.message_id)) continue;
      processingIds.add(msg.message_id);

      const chatId = msg.chat.id.toString();

      if (chatId !== MY_CHAT_ID) {
        await sendMessage(chatId, "Private bot");
        continue;
      }

      await handle(chatId, msg.text);
    }

  } catch (e) {
    console.log("error:", e.message);
  }

  setTimeout(poll, 1000);
}

console.log("🚀 FIXED BOT RUNNING");
poll();
