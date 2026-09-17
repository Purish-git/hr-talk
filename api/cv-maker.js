// api/cv-maker.js
// Premium-only. Generate CV terstruktur dari input user (bukan upload CV lama
// -- itu tugasnya cv-checker.js). Output JSON terstruktur per section, biar
// frontend bisa render rapi + convert ke Word.

const { isCodeValid } = require('./_lib/redis');
const { makeRateLimiter } = require('./_lib/rateLimit');
const { parseJsonFromModel } = require('./_lib/aiJson');

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
  const { name, contact, targetPosition, experience, education, skills, summaryHint, accessCode } = body || {};

  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: 'Field "name" wajib diisi.' });
  }
  if (!experience || !String(experience).trim()) {
    return res.status(400).json({ error: 'Field "experience" (pengalaman kerja) wajib diisi.' });
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
    return res.status(403).json({ error: 'CV Maker khusus Premium. Upgrade dulu ya 🔓', needsUpgrade: true });
  }

  const limitCheck = checkLimit(req);
  if (!limitCheck.allowed) {
    const msg = limitCheck.reason === 'ip'
      ? 'Kamu sudah mencapai batas generate hari ini. Coba lagi besok ya 🙏'
      : 'Layanan sedang penuh untuk hari ini. Coba lagi besok ya 🙏';
    return res.status(429).json({ error: msg });
  }

  const systemPrompt = `Kamu adalah asisten yang membantu pekerja dan fresh graduate Indonesia menyusun CV/resume yang rapi, ATS-friendly (mudah dibaca sistem screening otomatis), dan profesional.

ATURAN KETAT:
1. JANGAN mengarang pengalaman, skill, gelar, angka pencapaian, atau detail apa pun yang tidak disebutkan user.
2. Tulis ulang kalimat user jadi lebih profesional & ringkas (pakai action verbs seperti "Mengelola", "Meningkatkan", "Memimpin"), TAPI jangan ubah fakta/substansinya.
3. Bahasa Indonesia yang natural dan profesional (kecuali input user didominasi Bahasa Inggris, ikuti bahasa itu).
4. Format experience & education sebagai teks dengan baris baru (\\n) antar entri, masing-masing entri idealnya: Judul/Posisi — Institusi/Perusahaan (periode), lalu 1-3 bullet pencapaian di bawahnya diawali dengan "• ".
5. Summary/ringkasan profil: 2-3 kalimat, highlight value utama kandidat, sesuaikan dengan target posisi kalau disebutkan.
6. Balas HANYA dengan JSON valid, TANPA markdown fence, format persis:
{"summary": "...", "experience": "...", "education": "...", "skills": "..."}`;

  const userPrompt = `Nama: ${name}
${contact ? `Kontak: ${contact}` : ''}
${targetPosition ? `Target posisi yang dilamar: ${targetPosition}` : ''}

Pengalaman kerja (mentah dari user):
"""${experience.trim()}"""

${education && education.trim() ? `Pendidikan (mentah dari user):\n"""${education.trim()}"""` : ''}

${skills && skills.trim() ? `Skill (mentah dari user):\n"""${skills.trim()}"""` : ''}

${summaryHint && summaryHint.trim() ? `Catatan tambahan dari user buat summary: """${summaryHint.trim()}"""` : ''}

Susun jadi CV terstruktur sesuai aturan di atas.`;

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
        max_tokens: 2200,
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
      parsed = parseJsonFromModel(rawText);
    } catch (e) { /* parsed stays undefined, handled below */ }
    if (!parsed) {
      console.error('Gagal parse JSON dari AI:', rawText);
      return res.status(502).json({ error: 'AI mengembalikan format tidak terduga. Coba regenerate.' });
    }

    if (!parsed || !parsed.summary || !parsed.experience) {
      return res.status(502).json({ error: 'Respons AI tidak lengkap. Coba regenerate.' });
    }

    return res.status(200).json({
      name: String(name).trim(),
      contact: contact ? String(contact).trim() : '',
      summary: String(parsed.summary).trim(),
      experience: String(parsed.experience).trim(),
      education: String(parsed.education || education || '').trim(),
      skills: String(parsed.skills || skills || '').trim(),
    });
  } catch (err) {
    console.error('Handler error:', err);
    return res.status(500).json({ error: 'Terjadi kesalahan di server. Coba lagi.' });
  }
};
