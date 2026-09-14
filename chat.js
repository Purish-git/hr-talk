// api/chat.js
// Vercel Serverless Function.
// Menerima { message, situation, tone, media, accessCode? } dari frontend,
// meneruskan ke Claude API (Anthropic), lalu mengembalikan 3 opsi pesan:
// safe, confident, strategic.
//
// MODEL FREEMIUM:
// - Tanpa accessCode (atau kode tidak valid): user "free" — cuma boleh akses
//   situasi yang ada di FREE_SITUATIONS, dan dibatasi MAX_FREE_PER_IP_PER_DAY
//   generate/hari.
// - Dengan accessCode yang valid (dicek ke Redis lewat api/_lib/redis.js):
//   user "premium" — semua 13 situasi kebuka, limit hariannya jauh lebih
//   longgar (MAX_PREMIUM_PER_IP_PER_DAY), bukan berarti benar-benar tanpa
//   batas — ini cuma jaring pengaman kalau ada 1 kode bocor/disalahgunakan.
//
// PENTING: API key TIDAK PERNAH dikirim ke frontend. Kunci dibaca di sini,
// di server, dari environment variable ANTHROPIC_API_KEY.

const { isCodeValid, incrementCodeUsage } = require('./_lib/redis');

const AI_MODEL = 'claude-haiku-4-5-20251001';
const ANTHROPIC_VERSION = '2023-06-01';

// --- FREEMIUM: situasi yang boleh diakses tanpa bayar ---------------------
// Nilai di sini HARUS cocok persis dengan `situation.toLowerCase()` yang
// dikirim frontend (frontend mengirim label situasi dalam huruf kecil).
const FREE_SITUATIONS = [
  'negosiasi gaji',
  'follow up interview',
  'menanyakan hasil interview',
];

// --- RATE LIMITER (sederhana, in-memory) ---------------------------------
// Sama seperti sebelumnya: ini lapis kedua, bukan pengganti hard spend limit
// di console.anthropic.com. In-memory berarti counter bisa reset kalau
// function di-restart Vercel — cukup untuk skala awal, upgrade ke Redis
// penuh nanti kalau traffic sudah besar.
const usageStore = new Map(); // key: "ip|YYYY-MM-DD|tier" -> jumlah request hari itu
const globalUsageStore = new Map(); // key: "YYYY-MM-DD" -> jumlah request semua orang hari itu

const MAX_FREE_PER_IP_PER_DAY = Number(process.env.MAX_FREE_REQUESTS_PER_IP_PER_DAY || 3);
const MAX_PREMIUM_PER_IP_PER_DAY = Number(process.env.MAX_PREMIUM_REQUESTS_PER_IP_PER_DAY || 100);
const MAX_GLOBAL_PER_DAY = Number(process.env.MAX_REQUESTS_GLOBAL_PER_DAY || 300);

function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim();
  return req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : 'unknown';
}

function todayKey() {
  return new Date().toISOString().slice(0, 10); // "2026-09-14"
}

function checkAndIncrementLimit(req, isPremium) {
  const day = todayKey();
  const ip = getClientIp(req);
  const tier = isPremium ? 'premium' : 'free';
  const ipKey = `${ip}|${day}|${tier}`;
  const perIpMax = isPremium ? MAX_PREMIUM_PER_IP_PER_DAY : MAX_FREE_PER_IP_PER_DAY;

  const globalCount = globalUsageStore.get(day) || 0;
  if (globalCount >= MAX_GLOBAL_PER_DAY) {
    return { allowed: false, reason: 'global' };
  }

  const ipCount = usageStore.get(ipKey) || 0;
  if (ipCount >= perIpMax) {
    return { allowed: false, reason: isPremium ? 'ip_premium' : 'ip_free' };
  }

  usageStore.set(ipKey, ipCount + 1);
  globalUsageStore.set(day, globalCount + 1);

  if (usageStore.size > 5000) usageStore.clear();

  return { allowed: true, remaining: perIpMax - (ipCount + 1) };
}
// ---------------------------------------------------------------------------

module.exports = async function handler(req, res) {
  // --- 1. Hanya izinkan POST ---
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method tidak diizinkan. Gunakan POST.' });
  }

  // --- 2. Ambil API key dari environment variable ---
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
  const { message, situation, tone, media, accessCode } = body || {};

  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'Field "message" wajib diisi.' });
  }
  if (!situation || typeof situation !== 'string' || !situation.trim()) {
    return res.status(400).json({ error: 'Field "situation" wajib diisi.' });
  }

  const safeTone = typeof tone === 'string' && tone.trim() ? tone.trim() : 'safe';
  const safeMedia = typeof media === 'string' && media.trim() ? media.trim() : 'whatsapp';
  const situationLower = situation.trim().toLowerCase();
  const cleanCode = typeof accessCode === 'string' ? accessCode.trim().toUpperCase() : '';

  // --- 3b. Cek status premium (kalau ada kode yang dikirim) ---
  let isPremium = false;
  if (cleanCode) {
    try {
      const codeCheck = await isCodeValid(cleanCode);
      isPremium = codeCheck.valid;
    } catch (err) {
      // Kalau Redis belum diset / error koneksi, JANGAN block seluruh app —
      // anggap saja user ini free untuk request ini, tapi catat di log biar
      // kamu tahu ada masalah konfigurasi.
      console.error('Gagal cek kode premium (dianggap free):', err.message);
      isPremium = false;
    }
  }

  // --- 3c. Kalau bukan premium, cek apakah situasi ini termasuk gratisan ---
  if (!isPremium && !FREE_SITUATIONS.includes(situationLower)) {
    return res.status(403).json({
      error: 'Situasi ini khusus untuk user premium. Upgrade dulu untuk akses semua fitur ya 🔓',
      needsUpgrade: true,
    });
  }

  // --- 3d. Cek rate limit sesuai tier ---
  const limitCheck = checkAndIncrementLimit(req, isPremium);
  if (!limitCheck.allowed) {
    let msg;
    if (limitCheck.reason === 'ip_free') {
      msg = 'Kuota gratis kamu hari ini sudah habis. Upgrade buat generate lebih banyak, atau coba lagi besok ya 🙏';
    } else if (limitCheck.reason === 'ip_premium') {
      msg = 'Kamu sudah mencapai batas generate hari ini. Coba lagi besok ya 🙏';
    } else {
      msg = 'Layanan sedang penuh untuk hari ini. Coba lagi besok ya 🙏';
    }
    return res.status(429).json({ error: msg, needsUpgrade: limitCheck.reason === 'ip_free' });
  }

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

    // --- 6. Parse JSON dari jawaban model ---
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

    // --- 6b. Kalau user premium, catat pemakaian kodenya ---
    if (isPremium && cleanCode) {
      incrementCodeUsage(cleanCode); // sengaja tidak di-await ketat, jangan sampai gagalin response utama
    }

    // --- 7. Kirim hasil bersih ke frontend ---
    return res.status(200).json({
      safe: String(parsed.safe).trim(),
      confident: String(parsed.confident).trim(),
      strategic: String(parsed.strategic).trim(),
      isPremium,
      remainingToday: limitCheck.remaining,
    });
  } catch (err) {
    console.error('Handler error:', err);
    return res.status(500).json({ error: 'Terjadi kesalahan di server. Coba lagi.' });
  }
};
