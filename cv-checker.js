// api/cv-checker.js
// Premium-only. User paste teks CV yang SUDAH ADA, AI kasih penilaian +
// saran perbaikan konkret. Beda dari cv-maker.js (yang bikin CV dari nol).

const { isCodeValid } = require('./_lib/redis');
const { makeRateLimiter } = require('./_lib/rateLimit');

const AI_MODEL = 'claude-haiku-4-5-20251001';
const ANTHROPIC_VERSION = '2023-06-01';

const checkLimit = makeRateLimiter({
  maxPerIpPerDay: Number(process.env.MAX_PREMIUM_REQUESTS_PER_IP_PER_DAY || 100),
  maxGlobalPerDay: Number(process.env.MAX_REQUESTS_GLOBAL_PER_DAY || 300),
});

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
  const { cvText, targetPosition, accessCode } = body || {};

  if (!cvText || !String(cvText).trim()) {
    return res.status(400).json({ error: 'Field "cvText" (isi CV kamu) wajib diisi.' });
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
    return res.status(403).json({ error: 'CV Checker khusus Premium. Upgrade dulu ya 🔓', needsUpgrade: true });
  }

  const limitCheck = checkLimit(req);
  if (!limitCheck.allowed) {
    const msg = limitCheck.reason === 'ip'
      ? 'Kamu sudah mencapai batas generate hari ini. Coba lagi besok ya 🙏'
      : 'Layanan sedang penuh untuk hari ini. Coba lagi besok ya 🙏';
    return res.status(429).json({ error: msg });
  }

  const systemPrompt = `Kamu adalah reviewer CV berpengalaman yang membantu pekerja dan fresh graduate Indonesia memperbaiki CV mereka.

ATURAN KETAT:
1. Nilai CV yang diberikan user APA ADANYA — jangan mengarang isi CV yang tidak ada.
2. Kasih skor 1-10 (angka bulat) berdasarkan: kejelasan, penggunaan action verbs & angka konkret, relevansi dengan target posisi (kalau disebutkan), dan format/struktur secara umum (dari teksnya, bukan visual).
3. "strengths": 2-4 poin hal yang SUDAH bagus di CV ini.
4. "improvements": 3-5 poin masalah spesifik + kenapa itu masalah. Jangan generic ("kurang menarik") — bilang spesifik bagian mana dan kenapa.
5. "rewriteSamples": 2-3 contoh KONKRET — ambil 1 kalimat/bullet lemah dari CV asli user, tulis ulang jadi lebih kuat (format: {"before": "...", "after": "..."}). Pakai kalimat ASLI dari user, jangan mengarang kalimat baru yang tidak ada di CV-nya.
6. Bahasa Indonesia natural, langsung ke poin, tidak menggurui berlebihan.
7. Balas HANYA dengan JSON valid, TANPA markdown fence, format persis:
{"score": 7, "strengths": ["...", "..."], "improvements": ["...", "..."], "rewriteSamples": [{"before":"...","after":"..."}]}`;

  const userPrompt = `${targetPosition ? `Target posisi yang dilamar: ${targetPosition}\n` : ''}
Isi CV user:
"""${cvText.trim()}"""

Review CV ini sesuai aturan di atas.`;

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
        max_tokens: 1500,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });

    if (!aiResponse.ok) {
      const errText = await aiResponse.text().catch(() => '');
      console.error('AI API error:', aiResponse.status, errText);
      return res.status(502).json({ error: 'Gagal menghubungi AI API. Coba lagi sebentar lagi.' });
    }

    const data = await aiResponse.json();
    const rawText = (data.content || []).map((b) => b.text || '').join('').trim();

    let parsed;
    try {
      const cleaned = rawText.replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '').trim();
      parsed = JSON.parse(cleaned);
    } catch (e) {
      console.error('Gagal parse JSON dari AI:', rawText);
      return res.status(502).json({ error: 'AI mengembalikan format tidak terduga. Coba regenerate.' });
    }

    if (!parsed || typeof parsed.score === 'undefined' || !parsed.improvements) {
      return res.status(502).json({ error: 'Respons AI tidak lengkap. Coba regenerate.' });
    }

    return res.status(200).json({
      score: Number(parsed.score),
      strengths: Array.isArray(parsed.strengths) ? parsed.strengths : [],
      improvements: Array.isArray(parsed.improvements) ? parsed.improvements : [],
      rewriteSamples: Array.isArray(parsed.rewriteSamples) ? parsed.rewriteSamples : [],
    });
  } catch (err) {
    console.error('Handler error:', err);
    return res.status(500).json({ error: 'Terjadi kesalahan di server. Coba lagi.' });
  }
};
