// api/job-offer-analyzer.js
// Premium-only. Terima salah satu dari dua: `offerText` (teks yang dipaste
// user) ATAU `fileBase64` + `fileMediaType` (upload PDF/foto offer letter).
// Claude API bisa baca PDF & gambar langsung sebagai content block, jadi
// TIDAK perlu OCR/parsing terpisah -- dikirim apa adanya ke model.

const { isCodeValid } = require('./_lib/redis');
const { makeRateLimiter } = require('./_lib/rateLimit');

const AI_MODEL = 'claude-haiku-4-5-20251001';
const ANTHROPIC_VERSION = '2023-06-01';

const checkLimit = makeRateLimiter({
  maxPerIpPerDay: Number(process.env.MAX_PREMIUM_REQUESTS_PER_IP_PER_DAY || 100),
  maxGlobalPerDay: Number(process.env.MAX_REQUESTS_GLOBAL_PER_DAY || 300),
});

const ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const ALLOWED_DOC_TYPES = ['application/pdf'];

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
  const { offerText, fileBase64, fileMediaType, currentSituation, accessCode } = body || {};

  const hasText = offerText && String(offerText).trim();
  const hasFile = fileBase64 && fileMediaType;

  if (!hasText && !hasFile) {
    return res.status(400).json({ error: 'Isi teks offer letter ATAU upload file dulu ya.' });
  }
  if (hasFile && !ALLOWED_IMAGE_TYPES.includes(fileMediaType) && !ALLOWED_DOC_TYPES.includes(fileMediaType)) {
    return res.status(400).json({ error: 'Tipe file tidak didukung. Pakai PDF, PNG, JPEG, atau WEBP.' });
  }
  // Base64 kasar ~1.37x ukuran asli; batasi ~8MB base64 (~5.8MB file asli) biar aman di limit body Vercel.
  if (hasFile && fileBase64.length > 8 * 1024 * 1024) {
    return res.status(400).json({ error: 'File terlalu besar. Maks sekitar 5MB.' });
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
    return res.status(403).json({ error: 'Job Offer Analyzer khusus Premium. Upgrade dulu ya 🔓', needsUpgrade: true });
  }

  const limitCheck = checkLimit(req);
  if (!limitCheck.allowed) {
    const msg = limitCheck.reason === 'ip'
      ? 'Kamu sudah mencapai batas generate hari ini. Coba lagi besok ya 🙏'
      : 'Layanan sedang penuh untuk hari ini. Coba lagi besok ya 🙏';
    return res.status(429).json({ error: msg });
  }

  const systemPrompt = `Kamu adalah asisten yang membantu pekerja Indonesia menganalisis surat tawaran kerja (offer letter) sebelum mereka menerima/menolak/negosiasi.

ATURAN KETAT:
1. Analisis HANYA berdasarkan isi offer letter yang diberikan. JANGAN mengarang angka, benefit, atau klausul yang tidak ada di dokumen/teks tersebut.
2. Kalau ada bagian yang tidak jelas/ambigu di offer letter, sebutkan itu sebagai hal yang perlu ditanyakan, jangan diasumsikan.
3. "redFlags": klausul yang berpotensi merugikan user atau tidak umum/perlu diwaspadai (misal: masa probation tidak wajar, non-compete terlalu luas, tidak ada penjelasan benefit, dll). Kalau tidak ada, kembalikan array kosong — jangan dipaksakan cari masalah.
4. "recommendedQuestions": pertanyaan konkret yang sebaiknya user tanyakan ke HR sebelum tanda tangan.
5. Bahasa Indonesia natural, singkat per poin, tidak bertele-tele.
6. Balas HANYA dengan JSON valid, TANPA markdown fence, format persis:
{"summary": "ringkasan 2-3 kalimat", "salaryAnalysis": "...", "benefitsAnalysis": "...", "redFlags": ["..."], "recommendedQuestions": ["..."], "verdict": "1-2 kalimat kesimpulan/rekomendasi"}`;

  const contextLine = currentSituation && String(currentSituation).trim()
    ? `Konteks tambahan dari user: ${String(currentSituation).trim()}\n\n`
    : '';

  const contentBlocks = [];
  if (hasFile) {
    const blockType = ALLOWED_DOC_TYPES.includes(fileMediaType) ? 'document' : 'image';
    contentBlocks.push({
      type: blockType,
      source: { type: 'base64', media_type: fileMediaType, data: fileBase64 },
    });
  }
  contentBlocks.push({
    type: 'text',
    text: `${contextLine}${hasFile ? 'Ini adalah file offer letter yang perlu dianalisis.' : `Isi offer letter:\n"""${offerText.trim()}"""`}\n\nAnalisis sesuai aturan di atas.`,
  });

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
        messages: [{ role: 'user', content: contentBlocks }],
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

    if (!parsed || !parsed.summary || !parsed.verdict) {
      return res.status(502).json({ error: 'Respons AI tidak lengkap. Coba regenerate.' });
    }

    return res.status(200).json({
      summary: String(parsed.summary).trim(),
      salaryAnalysis: String(parsed.salaryAnalysis || '').trim(),
      benefitsAnalysis: String(parsed.benefitsAnalysis || '').trim(),
      redFlags: Array.isArray(parsed.redFlags) ? parsed.redFlags : [],
      recommendedQuestions: Array.isArray(parsed.recommendedQuestions) ? parsed.recommendedQuestions : [],
      verdict: String(parsed.verdict).trim(),
    });
  } catch (err) {
    console.error('Handler error:', err);
    return res.status(500).json({ error: 'Terjadi kesalahan di server. Coba lagi.' });
  }
};
