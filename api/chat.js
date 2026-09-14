// api/chat.js
// Vercel Serverless Function.
// Menerima { message, situation, tone, media? } dari frontend, meneruskan
// ke Claude API (Anthropic) dengan system prompt yang sudah disiapkan, lalu
// mengembalikan 3 opsi pesan: safe, confident, strategic.
//
// PENTING: API key TIDAK PERNAH dikirim ke frontend. Kunci dibaca di sini,
// di server, dari environment variable ANTHROPIC_API_KEY yang kamu set di
// Vercel (Project Settings → Environment Variables). Kalau variabel ini
// belum diset, endpoint akan otomatis menolak request dengan pesan error
// yang jelas.

// Claude Haiku 4.5: model tercepat & termurah di lineup Claude saat ini,
// cukup kuat untuk tugas menyusun/menyunting pesan singkat berbasis konteks
// seperti ini — cocok untuk aplikasi career/HR tools dengan volume request
// yang bisa tinggi tapi tiap task-nya relatif ringan. Ganti ke
// 'claude-sonnet-5' di sini kalau ke depannya butuh nalar/nuansa yang lebih
// dalam (mis. situasi negosiasi yang sangat kompleks) dan biaya bukan
// prioritas utama.
const AI_MODEL = 'claude-haiku-4-5-20251001';
const ANTHROPIC_VERSION = '2023-06-01';

// --- RATE LIMITER (sederhana, in-memory) ---------------------------------
// Kenapa in-memory dan bukan database: supaya nggak perlu setup infra
// tambahan dulu di tahap awal. Vercel bisa menjaga 1 instance function tetap
// "hangat" selama beberapa menit kalau traffic-nya stabil, jadi counter ini
// lumayan efektif menahan orang yang spam klik generate. TAPI ini BUKAN
// jaminan sempurna — kalau function di-restart (deploy baru, idle lama,
// atau traffic dari banyak region sekaligus) counter bisa reset ke 0.
// Anggap ini lapis kedua; lapis pertama & yang PALING penting tetap hard
// spend limit yang kamu set di console.anthropic.com.
//
// Kalau nanti traffic sudah lumayan ramai, ganti Map ini dengan penyimpanan
// yang persisten lintas request, misalnya Vercel KV / Upstash Redis.
const usageStore = new Map(); // key: "ip|YYYY-MM-DD" -> jumlah request hari itu
const globalUsageStore = new Map(); // key: "YYYY-MM-DD" -> jumlah request semua orang hari itu

const MAX_PER_IP_PER_DAY = Number(process.env.MAX_REQUESTS_PER_IP_PER_DAY || 15);
const MAX_GLOBAL_PER_DAY = Number(process.env.MAX_REQUESTS_GLOBAL_PER_DAY || 300);

function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim();
  return req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : 'unknown';
}

function todayKey() {
  return new Date().toISOString().slice(0, 10); // "2026-09-14"
}

function checkAndIncrementLimit(req) {
  const day = todayKey();
  const ip = getClientIp(req);
  const ipKey = `${ip}|${day}`;

  const globalCount = globalUsageStore.get(day) || 0;
  if (globalCount >= MAX_GLOBAL_PER_DAY) {
    return { allowed: false, reason: 'global' };
  }

  const ipCount = usageStore.get(ipKey) || 0;
  if (ipCount >= MAX_PER_IP_PER_DAY) {
    return { allowed: false, reason: 'ip' };
  }

  usageStore.set(ipKey, ipCount + 1);
  globalUsageStore.set(day, globalCount + 1);

  // Beres-beres kecil biar Map tidak membengkak tanpa batas kalau function
  // hidup lama (bukan mekanisme wajib, cuma jaga-jaga).
  if (usageStore.size > 5000) usageStore.clear();

  return { allowed: true };
}
// ---------------------------------------------------------------------------

module.exports = async function handler(req, res) {
  // --- 1. Hanya izinkan POST ---
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method tidak diizinkan. Gunakan POST.' });
  }

  // --- 1b. Cek rate limit sebelum panggil AI (biar hemat biaya) ---
  const limitCheck = checkAndIncrementLimit(req);
  if (!limitCheck.allowed) {
    const msg = limitCheck.reason === 'ip'
      ? 'Kamu sudah mencapai batas generate hari ini. Coba lagi besok ya 🙏'
      : 'Layanan sedang penuh untuk hari ini. Coba lagi besok ya 🙏';
    return res.status(429).json({ error: msg });
  }

  // --- 2. Ambil API key dari environment variable, bukan dari kode ---
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: 'Server belum dikonfigurasi: environment variable ANTHROPIC_API_KEY tidak ditemukan.',
    });
  }

  // --- 3. Parse & validasi body ---
  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch (e) {
      return res.status(400).json({ error: 'Body request bukan JSON yang valid.' });
    }
  }
  const { message, situation, tone, media } = body || {};

  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'Field "message" wajib diisi.' });
  }
  if (!situation || typeof situation !== 'string' || !situation.trim()) {
    return res.status(400).json({ error: 'Field "situation" wajib diisi.' });
  }

  const safeTone = typeof tone === 'string' && tone.trim() ? tone.trim() : 'safe';
  const safeMedia = typeof media === 'string' && media.trim() ? media.trim() : 'whatsapp';

  // --- 4. Susun prompt ---
  const systemPrompt = `Kamu adalah asisten yang membantu pekerja dan fresh graduate Indonesia usia 20-30 tahun menyusun pesan singkat untuk HR atau recruiter.

ATURAN KETAT (wajib dipatuhi semua):
1. Tulis dalam Bahasa Indonesia yang natural, singkat, tidak kaku, dan TIDAK terdengar seperti tulisan AI. Hindari frasa klise seperti "Berikut adalah", "Semoga pesan ini membantu", "Dengan hormat saya sampaikan", dsb kecuali memang wajar untuk email formal.
2. JANGAN mengarang fakta, angka, nama, atau detail apa pun yang tidak ada di input user. Kalau suatu detail tidak disebutkan, jangan ditambahkan sendiri.
3. JANGAN mengubah maksud utama pesan/permintaan user. Kamu hanya merapikan cara penyampaiannya.
4. Sesuaikan gaya DAN panjang dengan media pengiriman:
   - WhatsApp: ringkas banget, langsung ke inti, sekitar 2-4 kalimat pendek dalam 1 paragraf, tidak terlalu formal. Boleh pakai emoji secukupnya HANYA kalau nadanya santai/percaya diri dan konteksnya bukan topik berat (misalnya resign atau komplain serius).
   - LinkedIn: sopan dan profesional, sekitar 3-5 kalimat, tanpa emoji, tidak sekaku email resmi.
   - Email: HARUS terasa seperti email lengkap yang siap kirim, BUKAN pesan singkat. Sertakan baris subjek (format "Subjek: ..." di baris pertama), lalu salam pembuka, 2-3 paragraf isi (perkenalan singkat konteks, inti permintaan, alasan/detail pendukung), dan salam penutup + nama di baris terakhir (pakai placeholder "[Nama kamu]" untuk nama pengirim karena tidak ada info nama user). Total sekitar 8-14 kalimat. Tanpa emoji.
5. Hasil harus siap copy-paste langsung, tanpa placeholder seperti "[Nama]" atau "[Perusahaan]" kecuali detail itu memang ada di input user — KECUALI untuk baris nama pengirim di penutup email, boleh pakai "[Nama kamu]".
6. Jangan asal memenuhi jumlah kalimat dengan basa-basi kosong; setiap kalimat tambahan (terutama di email) harus menambah informasi atau konteks yang relevan dari input user.
7. Balas HANYA dengan JSON valid berformat persis seperti ini, TANPA teks tambahan apa pun, TANPA markdown code fence, TANPA penjelasan:
{"safe": "...", "confident": "...", "strategic": "..."}

Definisi tiga versi:
- safe: paling hati-hati dan sopan, risiko menyinggung atau memicu konflik paling kecil.
- confident: langsung ke inti, percaya diri, tetap sopan, tidak bertele-tele.
- strategic: mempertimbangkan posisi tawar user, membuka ruang negosiasi atau opsi win-win, tanpa terdengar menuntut.`;

  const userPrompt = `Situasi: ${situation}
Media pengiriman yang dipilih user: ${safeMedia}
Kecenderungan gaya yang disukai user (jadikan referensi, bukan patokan mutlak — tetap buat ketiga versi): ${safeTone}
Konteks / detail dari user:
"""${message.trim()}"""

Buatkan 3 versi pesan (safe, confident, strategic) sesuai semua aturan di atas.`;

  // --- 5. Panggil Claude API ---
  try {
    const aiResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: AI_MODEL,
        max_tokens: 1600,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });

    if (!aiResponse.ok) {
      const errText = await aiResponse.text().catch(() => '');
      console.error('AI API error:', aiResponse.status, errText);
      return res.status(502).json({
        error: 'Gagal menghubungi AI API. Coba lagi sebentar lagi.',
      });
    }

    const data = await aiResponse.json();
    const rawText = (data.content || [])
      .map((block) => block.text || '')
      .join('')
      .trim();

    // --- 6. Parse JSON dari jawaban model (dengan pembersihan ringan jaga-jaga) ---
    let parsed;
    try {
      const cleaned = rawText
        .replace(/^```json\s*/i, '')
        .replace(/^```\s*/, '')
        .replace(/```\s*$/, '')
        .trim();
      parsed = JSON.parse(cleaned);
    } catch (e) {
      console.error('Gagal parse JSON dari AI:', rawText);
      return res.status(502).json({
        error: 'AI mengembalikan format yang tidak terduga. Coba regenerate.',
      });
    }

    if (!parsed || !parsed.safe || !parsed.confident || !parsed.strategic) {
      return res.status(502).json({
        error: 'Respons AI tidak lengkap (ada opsi yang hilang). Coba regenerate.',
      });
    }

    // --- 7. Kirim hasil bersih ke frontend ---
    return res.status(200).json({
      safe: String(parsed.safe).trim(),
      confident: String(parsed.confident).trim(),
      strategic: String(parsed.strategic).trim(),
    });
  } catch (err) {
    console.error('Handler error:', err);
    return res.status(500).json({ error: 'Terjadi kesalahan di server. Coba lagi.' });
  }
};
