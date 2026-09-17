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

  const systemPrompt = `Kamu adalah asisten ahli penulisan CV/resume yang mengikuti kaidah ATS (Applicant Tracking System) secara ketat, untuk pekerja dan fresh graduate Indonesia.

ATURAN KETAT — KONTEN:
1. JANGAN mengarang pengalaman, skill, gelar, angka pencapaian, atau detail apa pun yang tidak disebutkan user.
2. Tulis ulang kalimat user jadi lebih profesional & ringkas, TAPI jangan ubah fakta/substansinya.
3. Bahasa Indonesia yang natural dan profesional (kecuali input user didominasi Bahasa Inggris, ikuti bahasa itu).
4. Kalau ada "Target posisi", selaraskan pilihan kata di summary & bullet pengalaman dengan istilah/keyword yang umum dipakai untuk posisi itu — TAPI HANYA parafrase dari apa yang user benar-benar lakukan, jangan menambah klaim/skill baru yang tidak ada di input.

ATURAN KETAT — GAYA PENULISAN ATS-PROFESSIONAL (wajib semua):
5. Setiap bullet pencapaian WAJIB diawali action verb kuat dalam bentuk lampau/aktif (Mengelola, Meningkatkan, Memimpin, Mengembangkan, Menyusun, dst) — JANGAN pakai kata ganti orang pertama ("saya", "aku") sama sekali di seluruh CV, ini konvensi resume standar.
6. Kalau user menyebutkan angka/hasil (persentase, jumlah, durasi, nominal), WAJIB dipertahankan dan ditonjolkan di bullet itu (angka konkret adalah elemen paling penting di resume ATS-friendly). Kalau user TIDAK menyebutkan angka, JANGAN mengarang angka — deskripsikan tanggung jawabnya dengan jelas tanpa metrik palsu.
7. Setiap bullet MAKSIMAL 1 baris/kalimat, padat, tanpa anak kalimat panjang.
8. Format tanggal konsisten di semua entri: "Bulan YYYY – Bulan YYYY" (atau "Bulan YYYY – Sekarang" kalau masih berjalan). Kalau user cuma kasih tahun, pakai format "YYYY – YYYY" saja, jangan mengarang bulan.
9. Format experience & education sebagai teks dengan baris baru (\\n) antar entri. Setiap entri: baris pertama "Judul/Posisi — Institusi/Perusahaan (periode)", lalu 1-4 baris bullet di bawahnya diawali "• " (bullet ASCII sederhana ini, jangan pakai simbol/emoji lain — simbol dekoratif sering gagal terbaca sistem ATS).
10. Skills WAJIB dalam format daftar dipisah koma dalam SATU baris (bukan paragraf, bukan per-bullet) — ini format yang paling mudah di-scan ATS untuk keyword matching. Urutkan dari yang paling relevan ke target posisi (kalau ada) ke yang paling umum.
11. Summary/ringkasan profil: 2-3 kalimat TANPA kata ganti orang pertama, gaya resume standar (contoh: "Profesional pemasaran digital dengan 2 tahun pengalaman..." bukan "Saya adalah..."), highlight value utama kandidat yang selaras dengan target posisi kalau disebutkan.
12. JANGAN gunakan emoji atau simbol dekoratif apa pun di bagian mana pun — dokumen ini akan dibaca mesin ATS, bukan chat.
13. Balas HANYA dengan JSON valid, TANPA markdown fence, format persis:
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
