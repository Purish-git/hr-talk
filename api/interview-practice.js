// api/interview-practice.js
// Premium-only. Simulasi wawancara interaktif (chat bolak-balik).
// STATELESS: tidak ada penyimpanan sesi di server. Frontend yang menyimpan
// seluruh histori percakapan (array {role, content}) dan mengirim ULANG
// semuanya setiap kali user membalas — persis pola yang disarankan buat
// stateful app pakai Claude API tanpa backend database.
//
// Cara kerja "mulai" vs "lanjut" vs "selesai" SENGAJA tidak dibedakan lewat
// parameter khusus -- semuanya lewat isi pesan terakhir di `history`, biar
// endpoint ini tetap satu & simpel. Lihat komentar di frontend buat detail.

const { isCodeValid } = require('./_lib/redis');
const { makeRateLimiter } = require('./_lib/rateLimit');

const AI_MODEL = 'claude-haiku-4-5-20251001';
const ANTHROPIC_VERSION = '2023-06-01';

// Sesi interview biasanya banyak giliran (tiap tanya-jawab = 1 request),
// jadi limitnya sengaja lebih longgar dari fitur single-shot lain.
const checkLimit = makeRateLimiter({
  maxPerIpPerDay: Number(process.env.MAX_INTERVIEW_TURNS_PER_IP_PER_DAY || 60),
  maxGlobalPerDay: Number(process.env.MAX_REQUESTS_GLOBAL_PER_DAY || 300),
});

const MAX_TURNS = 24; // batas panjang histori per sesi (safety, bukan UX limit ketat)

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method tidak diizinkan. Gunakan POST.' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Server belum dikonfigurasi: ANTHROPIC_API_KEY tidak ditemukan.' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { return res.status(400).json({ error: 'Body bukan JSON valid.' }); }
  }
  const { position, level, history, accessCode } = body || {};

  if (!position || !String(position).trim()) {
    return res.status(400).json({ error: 'Field "position" wajib diisi.' });
  }
  if (!Array.isArray(history)) {
    return res.status(400).json({ error: 'Field "history" harus berupa array.' });
  }
  if (history.length > MAX_TURNS) {
    return res.status(400).json({ error: 'Sesi ini sudah terlalu panjang. Mulai sesi baru ya.' });
  }
  for (const turn of history) {
    if (!turn || (turn.role !== 'user' && turn.role !== 'assistant') || typeof turn.content !== 'string') {
      return res.status(400).json({ error: 'Format "history" tidak valid.' });
    }
    if (turn.content.length > 4000) {
      return res.status(400).json({ error: 'Ada pesan yang terlalu panjang di histori.' });
    }
  }

  const cleanCode = typeof accessCode === 'string' ? accessCode.trim().toUpperCase() : '';
  let isPremium = false;
  if (cleanCode) {
    try {
      const check = await isCodeValid(cleanCode);
      isPremium = check.valid;
    } catch (err) {
      console.error('Gagal cek kode premium:', err.message);
    }
  }
  if (!isPremium) {
    return res.status(403).json({ error: 'Interview Practice khusus Premium. Upgrade dulu ya 🔓', needsUpgrade: true });
  }

  const limitCheck = checkLimit(req);
  if (!limitCheck.allowed) {
    const msg = limitCheck.reason === 'ip'
      ? 'Kamu sudah mencapai batas giliran latihan hari ini. Coba lagi besok ya 🙏'
      : 'Layanan sedang penuh untuk hari ini. Coba lagi besok ya 🙏';
    return res.status(429).json({ error: msg });
  }

  const safeLevel = level && String(level).trim() ? String(level).trim() : 'entry-level/fresh graduate';

  const systemPrompt = `Kamu berperan sebagai seorang PEWAWANCARA (interviewer) HR/hiring manager yang sedang mewawancarai kandidat untuk posisi "${position}" level ${safeLevel}, dalam sesi LATIHAN wawancara (bukan wawancara sungguhan) untuk pekerja/fresh graduate Indonesia.

ATURAN KETAT:
1. Selalu balas dalam Bahasa Indonesia natural, seperti pewawancara sungguhan — ramah tapi profesional, TIDAK kaku.
2. Kalau ini pesan PERTAMA di sesi (histori kosong / user cuma bilang "mulai"): sapa singkat, perkenalkan diri sebagai interviewer untuk posisi itu, lalu langsung ajukan SATU pertanyaan pembuka yang umum (misal "coba ceritakan tentang diri kamu" atau sejenisnya, sesuaikan dengan posisi).
3. Setiap giliran setelahnya: beri react SINGKAT (1 kalimat) terhadap jawaban user (bukan penilaian panjang, cukup natural seperti interviewer beneran merespons), LALU ajukan SATU pertanyaan interview berikutnya yang relevan dengan posisi "${position}" dan levelnya. Variasikan jenis pertanyaan (behavioral, teknis dasar, situational) antar giliran.
4. JANGAN mengajukan lebih dari 1 pertanyaan per giliran.
5. Kalau user secara eksplisit minta mengakhiri sesi / minta feedback keseluruhan / minta evaluasi (kata kunci seperti "selesai", "cukup", "gimana penilaiannya", "beri feedback"): JANGAN tanya pertanyaan baru lagi. Sebagai gantinya, berikan evaluasi singkat menyeluruh: 2-3 kekuatan jawaban user sepanjang sesi ini, 2-3 area yang perlu diperbaiki, dan 1 saran konkret buat wawancara asli nanti. Tutup dengan kalimat suportif.
6. Kalau user menjawab dengan sangat singkat/tidak jelas, boleh minta klarifikasi singkat SEBELUM lanjut ke pertanyaan berikutnya (masih dalam 1 giliran).
7. Balas dengan teks biasa (BUKAN JSON), natural seperti chat langsung. Jangan pakai format "Pertanyaan:" atau label apa pun, langsung tulis kalimatnya.`;

  const messages = history.length > 0
    ? history.map((t) => ({ role: t.role, content: t.content }))
    : [{ role: 'user', content: 'Mulai sesi latihan wawancara.' }];

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
        max_tokens: 500,
        system: systemPrompt,
        messages,
      }),
    });

    if (!aiResponse.ok) {
      const errText = await aiResponse.text().catch(() => '');
      console.error('AI API error:', aiResponse.status, errText);
      return res.status(502).json({ error: 'Gagal menghubungi AI API. Coba lagi sebentar lagi.' });
    }

    const data = await aiResponse.json();
    const replyText = (data.content || []).map((b) => b.text || '').join('').trim();

    if (!replyText) {
      return res.status(502).json({ error: 'AI tidak memberikan balasan. Coba lagi.' });
    }

    return res.status(200).json({ reply: replyText });
  } catch (err) {
    console.error('Handler error:', err);
    return res.status(500).json({ error: 'Terjadi kesalahan di server. Coba lagi.' });
  }
};
