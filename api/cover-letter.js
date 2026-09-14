// api/cover-letter.js
// Fitur premium: generate cover letter berdasarkan ringkasan CV/pengalaman
// user + (opsional) deskripsi lowongan. BEDA dari /api/chat: fitur ini SELALU
// butuh accessCode yang valid — tidak ada versi gratisnya sama sekali.

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
  const { cvSummary, jobDescription, position, company, tone, accessCode } = body || {};

  if (!cvSummary || typeof cvSummary !== 'string' || !cvSummary.trim()) {
    return res.status(400).json({ error: 'Field "cvSummary" (ringkasan pengalaman kamu) wajib diisi.' });
  }
  if (!position || typeof position !== 'string' || !position.trim()) {
    return res.status(400).json({ error: 'Field "position" wajib diisi.' });
  }

  // --- Fitur ini SELALU premium-only ---
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
    return res.status(403).json({
      error: 'Cover Letter Generator khusus Premium. Upgrade dulu ya 🔓',
      needsUpgrade: true,
    });
  }

  const limitCheck = checkLimit(req);
  if (!limitCheck.allowed) {
    const msg = limitCheck.reason === 'ip'
      ? 'Kamu sudah mencapai batas generate hari ini. Coba lagi besok ya 🙏'
      : 'Layanan sedang penuh untuk hari ini. Coba lagi besok ya 🙏';
    return res.status(429).json({ error: msg });
  }

  const safeTone = typeof tone === 'string' && tone.trim() ? tone.trim() : 'confident';

  const systemPrompt = `Kamu adalah asisten yang membantu pekerja dan fresh graduate Indonesia menulis cover letter (surat lamaran) yang singkat, natural, dan tidak generik.

ATURAN KETAT:
1. Bahasa Indonesia natural (kecuali user menulis ringkasan CV-nya dalam Bahasa Inggris — dalam kasus itu tulis cover letter dalam Bahasa Inggris). Tidak kaku, tidak terdengar seperti template AI generik ("Dengan hormat, saya yang bertanda tangan di bawah ini..." dan sejenisnya WAJIB dihindari kecuali benar-benar relevan).
2. JANGAN mengarang pengalaman, skill, angka, atau pencapaian yang tidak disebutkan user di ringkasan CV-nya.
3. Fokus ke 2-3 hal paling relevan dari pengalaman user yang cocok dengan posisi/deskripsi lowongan, bukan mendaftar semua pengalaman.
4. Panjang ideal: 3-4 paragraf pendek (pembuka, isi/kecocokan, penutup+call to action). Total sekitar 150-220 kata.
5. Sesuaikan gaya dengan preferensi tone: safe = hangat & rendah hati, confident = percaya diri & langsung, strategic = menonjolkan value spesifik yang ditawarkan ke perusahaan.
6. Balas HANYA dengan JSON valid, TANPA markdown fence, format persis:
{"letter": "isi cover letter lengkap di sini, gunakan \\n\\n untuk pergantian paragraf"}`;

  const userPrompt = `Posisi yang dilamar: ${position}
${company ? `Nama perusahaan: ${company}` : ''}
Tone yang diinginkan: ${safeTone}

Ringkasan pengalaman/CV user:
"""${cvSummary.trim()}"""

${jobDescription && jobDescription.trim() ? `Deskripsi lowongan (kalau ada, sesuaikan cover letter dengan ini):\n"""${jobDescription.trim()}"""` : ''}

Tulis 1 cover letter sesuai semua aturan di atas.`;

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
        max_tokens: 900,
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

    if (!parsed || !parsed.letter) {
      return res.status(502).json({ error: 'Respons AI tidak lengkap. Coba regenerate.' });
    }

    return res.status(200).json({ letter: String(parsed.letter).trim() });
  } catch (err) {
    console.error('Handler error:', err);
    return res.status(500).json({ error: 'Terjadi kesalahan di server. Coba lagi.' });
  }
};
