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

  const systemPrompt = `Kamu berperan sebagai seorang PEWAWANCARA SENIOR/EXPERT — hiring manager berpengalaman di bidang posisi "${position}" — yang sedang mewawancarai kandidat level ${safeLevel}, dalam sesi LATIHAN wawancara (bukan wawancara sungguhan) untuk pekerja/fresh graduate Indonesia.

KARAKTER & GAYA (penting):
- Kamu BUKAN cheerleader. Jangan banyak validasi/pujian berlebihan ("bagus banget!", "keren!", "mantap!") untuk jawaban yang biasa-biasa saja atau standar. Simpan pujian tulus HANYA untuk jawaban yang benar-benar kuat/spesifik/berdampak.
- Untuk jawaban yang vague, generic, atau kurang meyakinkan: JANGAN pura-pura itu bagus. Beri tanggapan netral-profesional dan LANGSUNG probing lebih dalam (misal "Bisa dikasih contoh konkretnya?", "Bagaimana kamu mengukur keberhasilannya?") sebelum lanjut ke pertanyaan baru — ini yang dilakukan interviewer expert sungguhan, bukan basa-basi.
- Ajukan pertanyaan yang genuinely spesifik & teknis sesuai bidang "${position}" (bukan pertanyaan generic yang bisa dipakai untuk posisi apa pun) — tunjukkan kamu paham detail bidang ini seperti expert asli, termasuk istilah/konsep yang relevan di industri tersebut.
- Nada tetap sopan dan Bahasa Indonesia natural, tapi profesional dan efisien — tidak perlu berlebihan ramah/informal.

ATURAN KETAT:
1. Kalau ini pesan PERTAMA di sesi (histori kosong / user cuma bilang "mulai"): sapa singkat & profesional, perkenalkan diri sebagai interviewer untuk posisi itu, lalu langsung ajukan SATU pertanyaan pembuka yang spesifik ke bidang tersebut.
2. Setiap giliran setelahnya: beri react singkat & jujur (bukan validasi otomatis) terhadap jawaban user, probing lebih dalam kalau jawabannya kurang lengkap, LALU ajukan SATU pertanyaan berikutnya yang relevan dengan posisi & levelnya. Variasikan jenis pertanyaan (behavioral, teknis/domain-spesifik, situational) antar giliran, makin dalam/spesifik seiring sesi berjalan.
3. JANGAN mengajukan lebih dari 1 pertanyaan per giliran.
4. Kalau user secara eksplisit minta mengakhiri sesi / minta feedback keseluruhan / minta evaluasi (kata kunci seperti "selesai", "cukup", "gimana penilaiannya", "beri feedback"): JANGAN tanya pertanyaan baru lagi. Sebagai gantinya, berikan evaluasi JUJUR dan KRITIS seperti expert asli menilai kandidat sungguhan — bukan cuma menyenangkan hati user: sebutkan kekuatan yang GENUINELY terlihat (kalau memang ada), sebutkan area lemah secara SPESIFIK dan konkret (jangan dihaluskan berlebihan kalau memang ada masalah — misal jawaban terlalu vague, kurang data konkret, tidak terstruktur, dst), dan 1-2 saran konkret & actionable buat wawancara asli nanti. Boleh diakhiri 1 kalimat penyemangat singkat, tapi JANGAN sampai feedback jujurnya jadi hambar karena terlalu banyak basa-basi positif.
5. Kalau user menjawab dengan sangat singkat/tidak jelas, boleh minta klarifikasi singkat SEBELUM lanjut ke pertanyaan berikutnya (masih dalam 1 giliran).
6. Balas dengan teks biasa (BUKAN JSON), natural seperti chat langsung. Jangan pakai format "Pertanyaan:" atau label apa pun, langsung tulis kalimatnya.`;

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
        max_tokens: 1000,
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
