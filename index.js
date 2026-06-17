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
let isProcessing = false;
let lastEntries = [];

/* ------------------ 🧠 INPUT NORMALIZER ------------------ */
function normalizeInput(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .trim();
}

/* ------------------ 📩 TELEGRAM SEND ------------------ */
async function sendMessage(chatId, text) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'Markdown'
    })
  });
}

/* ------------------ 🧠 AI PARSER ------------------ */
async function parseMessage(text) {
  const cleanText = normalizeInput(text);

  const messages = [
    {
      role: "system",
      content: `
তুমি একটি Smart AI Shop Manager।

User ভুল বানান, slang, bangla+english mix লিখতে পারে।
তুমি intent বুঝে JSON output দিবে।

শুধু JSON:
{
"type": "sale|expense|report|delete|unknown",
"amount": number,
"description": "text",
"number": number,
"reply": "short bengali reply"
}

Examples:
"aj 200 tk cha bechi" → sale
"kal 500 tel kinlam" → expense
"report dao" → report
"3 number delete" → delete
`
    },
    {
      role: "user",
      content: cleanText
    }
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
        temperature: 0.2
      })
    });

    const data = await res.json();

    let raw = data.choices[0].message.content;
    raw = raw.replace(/```json|```/g, '').trim();

    return JSON.parse(raw);

  } catch (e) {
    return { type: "unknown", reply: "বুঝতে পারিনি 😅" };
  }
}

/* ------------------ 🗄️ DATABASE ACTIONS ------------------ */

async function addSale(amount, description) {
  await supabase.from('transactions').insert({
    type: 'sale',
    amount,
    description
  });
}

async function addExpense(amount, description) {
  await supabase.from('transactions').insert({
    type: 'expense',
    amount,
    description
  });
}

async function getReport() {
  const { data } = await supabase.from('transactions').select('*');

  const sales = data.filter(x => x.type === 'sale')
    .reduce((s, x) => s + x.amount, 0);

  const expense = data.filter(x => x.type === 'expense')
    .reduce((s, x) => s + x.amount, 0);

  return `📊 রিপোর্ট

💰 বিক্রি: ₹${sales}
💸 খরচ: ₹${expense}
🏆 লাভ: ₹${sales - expense}`;
}

async function showEntries(chatId) {
  const { data } = await supabase
    .from('transactions')
    .select('*')
    .order('created_at', { ascending: true });

  if (!data.length) {
    return sendMessage(chatId, "কোনো ডাটা নেই");
  }

  lastEntries = data;

  let msg = "📋 সব এন্ট্রি:\n\n";

  data.forEach((e, i) => {
    msg += `${i + 1}. ${e.type} - ₹${e.amount}\n`;
  });

  await sendMessage(chatId, msg);
}

async function deleteEntry(chatId, number) {
  const index = number - 1;

  if (!lastEntries[index]) {
    return sendMessage(chatId, "ভুল নম্বর ❌");
  }

  const entry = lastEntries[index];

  await supabase.from('transactions')
    .delete()
    .eq('id', entry.id);

  await sendMessage(chatId, "মুছে দেওয়া হয়েছে ✅");
}

/* ------------------ ⚙️ TOOL SYSTEM ------------------ */

const tools = {
  sale: async (chatId, data) => {
    await addSale(data.amount, data.description);
    await sendMessage(chatId, data.reply || "সেভ করেছি ✅");
  },

  expense: async (chatId, data) => {
    await addExpense(data.amount, data.description);
    await sendMessage(chatId, data.reply || "খরচ লিখেছি ✅");
  },

  report: async (chatId) => {
    const report = await getReport();
    await sendMessage(chatId, report);
  },

  delete: async (chatId, data) => {
    if (data.number) {
      await deleteEntry(chatId, data.number);
    } else {
      await showEntries(chatId);
      await sendMessage(chatId, "কোনটা মুছবে বলো");
    }
  }
};

/* ------------------ 🧠 MAIN HANDLER ------------------ */

async function handleMessage(chatId, text) {
  const parsed = await parseMessage(text);

  if (!tools[parsed.type]) {
    return sendMessage(chatId, parsed.reply || "বুঝিনি 🤔");
  }

  await tools[parsed.type](chatId, parsed);
}

/* ------------------ 🔄 POLLING ------------------ */

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
    console.log("Error:", e.message);
  }

  setTimeout(poll, 1000);
}

console.log("🤖 AI Shop Manager Started!");
poll();
