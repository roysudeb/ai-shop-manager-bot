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
let lastMessageId = null;
let isProcessing = false;

/* ------------------ SEND MESSAGE ------------------ */
async function sendMessage(chatId, text) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text
    })
  });
}

/* ------------------ SAFE JSON PARSER ------------------ */
function safeJSON(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/* ------------------ AI PARSE ------------------ */
async function parseMessage(userText) {

  const messages = [
    {
      role: "system",
      content: `
তুমি একটি একদম পারফেক্ট AI Shop Manager।

RULES:
- বানান ভুল থাকলেও বুঝবে
- Bangla + English mix বুঝবে
- কোনো ভুল output দিবে না
- শুধুমাত্র JSON দিবে

FORMAT:
{
"type": "sale|expense|report|delete|unknown",
"amount": number,
"description": "text",
"number": number,
"reply": "short correct bengali"
}

Examples:
"aj 200 tk cha bechi" → sale
"500 tel kinlam" → expense
"ajker report dao" → report
"3 number delete" → delete
`
    },
    { role: "user", content: userText }
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
        temperature: 0.1
      })
    });

    const data = await res.json();
    let raw = data.choices[0].message.content;

    raw = raw.replace(/```json|```/g, '').trim();

    const parsed = safeJSON(raw);

    if (!parsed) throw new Error("Bad JSON");

    return parsed;

  } catch {
    return {
      type: "unknown",
      reply: "ভালভাবে বুঝতে পারিনি 😅 আবার বলো"
    };
  }
}

/* ------------------ DB ------------------ */

async function addSale(amount, desc) {
  await supabase.from('transactions').insert({
    type: 'sale',
    amount,
    description: desc
  });
}

async function addExpense(amount, desc) {
  await supabase.from('transactions').insert({
    type: 'expense',
    amount,
    description: desc
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

  return `📊 রিপোর্ট

💰 বিক্রি: ₹${sales}
💸 খরচ: ₹${expense}
🏆 লাভ: ₹${sales - expense}`;
}

async function deleteEntry(number) {
  const { data } = await supabase
    .from('transactions')
    .select('*')
    .order('created_at', { ascending: true });

  const item = data[number - 1];
  if (!item) return false;

  await supabase.from('transactions').delete().eq('id', item.id);
  return true;
}

/* ------------------ MAIN LOGIC ------------------ */

async function handleMessage(chatId, text) {
  const parsed = await parseMessage(text);

  switch (parsed.type) {

    case 'sale':
      await addSale(parsed.amount, parsed.description);
      return sendMessage(chatId, parsed.reply || "বিক্রি যোগ হয়েছে ✅");

    case 'expense':
      await addExpense(parsed.amount, parsed.description);
      return sendMessage(chatId, parsed.reply || "খরচ যোগ হয়েছে ✅");

    case 'report':
      return sendMessage(chatId, await getReport());

    case 'delete':
      if (!parsed.number) {
        return sendMessage(chatId, "কোন নম্বর মুছবে?");
      }
      const ok = await deleteEntry(parsed.number);
      return sendMessage(chatId, ok ? "মুছে দেওয়া হয়েছে ✅" : "ভুল নম্বর ❌");

    default:
      return sendMessage(chatId, parsed.reply || "বুঝিনি 🤔");
  }
}

/* ------------------ POLL FIXED ------------------ */

async function poll() {
  if (isProcessing) return setTimeout(poll, 1000);

  try {
    const res = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates?offset=${offset}`
    );

    const data = await res.json();

    for (const update of data.result || []) {
      offset = update.update_id + 1;

      const msg = update.message;
      if (!msg || !msg.text) continue;

      // 🔥 duplicate block
      if (msg.message_id === lastMessageId) continue;
      lastMessageId = msg.message_id;

      const chatId = msg.chat.id.toString();

      if (chatId !== MY_CHAT_ID) {
        await sendMessage(chatId, "⛔ Private bot");
        continue;
      }

      isProcessing = true;
      await handleMessage(chatId, msg.text);
      isProcessing = false;
    }

  } catch (e) {
    console.log("Poll error:", e.message);
    isProcessing = false;
  }

  setTimeout(poll, 1000);
}

console.log("🔥 PERFECT BOT RUNNING...");
poll();
