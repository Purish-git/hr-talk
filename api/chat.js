// api/improve-message.js
// Fitur GRATIS (bukan premium) — merapikan draft pesan mentah user jadi 3
// versi tone (aman/profesional/santai), disesuaikan sama media pengiriman.
// Beda dari chat.js: tone-nya bukan soal strategi negosiasi (safe/confident/
// strategic), tapi murni gaya bahasa (aman/profesional/santai) — cocok buat
// pesan APAPUN (resign, izin, komplain, dll), bukan cuma nego gaji.

const { makeRateLimiter } = require('./_lib/rateLimit');
const { parseJsonFromModel } = require('./_lib/aiJson');

const AI_MODEL = 'claude-haiku-4-5-20251001';
const ANTHROPIC_VERSION = '2023-06-01';

// Limit terpisah dari chat.js karena ini endpoint beda — biar nggak dobel
// jatah, angkanya sengaja lebih kecil (fitur pelengkap, bukan fitur utama).
const checkLimit = makeRateLimiter({
  maxPerIpPerDay: Number(process.env.MAX_IMPROVE_REQUESTS_PER_IP_PER_DAY || 5),
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
  const { rawMessage, media } = body || {};

  if (!rawMessage || typeof rawMessage !== 'string' || !rawMessage.trim()) {
    return res.status(400).json({ error: 'Field "rawMessage" wajib diisi.' });
  }

  const safeMedia = typeof media === 'string' && ['whatsapp', 'email', 'linkedin'].includes(media) ? media : 'whatsapp';

  const limitCheck = checkLimit(req);
  if (!limitCheck.allowed) {
    const msg = limitCheck.reason === 'ip'
      ? 'Kuota Improve Message kamu hari ini sudah habis. Coba lagi besok ya 🙏'
      : 'Layanan sedang penuh untuk hari ini. Coba lagi besok ya 🙏';
    return res.status(429).json({ error: msg });
  }

  const systemPrompt = `Kamu adalah asisten yang merapikan draft pesan mentah dari pekerja/fresh graduate Indonesia (biasanya ditulis buru-buru/informal ke HR, atasan, atau rekan kerja) jadi pesan yang lebih rapi dan pantas dikirim — TANPA mengubah maksud utamanya dan TANPA mengarang detail yang tidak ada di draft aslinya.

ATURAN KETAT:
1. JANGAN menambahkan fakta, tanggal, alasan, atau detail apa pun yang tidak disebutkan user. Kalau draft user cuma menanyakan sesuatu (misal "apa yang harus dilengkapi"), hasil akhirnya juga tetap berupa pertanyaan itu, dirapikan — JANGAN diubah jadi pernyataan resmi yang mengarang detail (contoh: jangan mengarang tanggal terakhir kerja kalau user tidak menyebutkannya).
2. JANGAN mengubah maksud/inti permintaan user sama sekali. Kamu hanya merapikan cara penyampaiannya.
3. Bahasa Indonesia natural, TIDAK terdengar seperti tulisan AI (hindari frasa klise seperti "Dengan hormat saya sampaikan", "Demikian pesan ini saya sampaikan", dsb kecuali memang wajar untuk email formal).
4. Sesuaikan gaya DAN struktur dengan media pengiriman:
   - WhatsApp: WAJIB persis 3 paragraf pendek (pembuka singkat, inti pesan, penutup), dipisah baris kosong (\\n\\n). Tetap ringkas per paragrafnya, tidak bertele-tele, tapi jangan cuma 1 paragraf.
   - LinkedIn: sopan dan profesional, 3-5 kalimat, tanpa emoji.
   - Email: HARUS mengikuti format template surat resmi berikut PERSIS (pakai \\n untuk ganti baris, KOSONGKAN 1 baris antar bagian):
     Subjek: [judul singkat sesuai isi] – [Nama Lengkap Anda]

     Kepada Yth.
     [Nama Atasan/Manager Anda]
     [Jabatan Atasan] di tempat

     Dengan hormat,
     [paragraf pembuka: perkenalan singkat + tujuan email]

     [1-2 paragraf isi: detail inti permintaan/konteks]

     [paragraf penutup sebelum salam: kalimat penutup standar surat resmi sesuai konteksnya]

     Hormat saya,
     [Nama Lengkap Anda]
     [Jabatan/Posisi Anda]
     [Nomor Kontak Anda]

     PENTING soal placeholder: kalau user MENYEBUTKAN detail tertentu, WAJIB pakai detail asli itu, JANGAN diganti placeholder. Untuk field struktural yang TIDAK disebutkan (nama atasan, jabatan, nomor kontak, dst), WAJIB tetap diisi placeholder kurung siku seperti contoh — JANGAN dihilangkan, karena email ini berfungsi sebagai template siap-edit. Tanpa emoji.
5. Buat 3 versi dengan tone BERBEDA (bukan strategi, murni gaya bahasa):
   - aman: paling hati-hati, sopan, dan lembut — risiko menyinggung paling kecil.
   - profesional: standar, lugas, formal secukupnya, tidak berlebihan.
   - santai: lebih rileks dan personal, boleh pakai emoji secukupnya HANYA kalau media WhatsApp dan topiknya bukan hal berat (resign/komplain serius tetap tanpa emoji meski tone santai).
6. Untuk WhatsApp dan LinkedIn: hasil harus siap copy-paste langsung TANPA placeholder sama sekali. Untuk Email: IKUTI aturan placeholder khusus di poin format Email di atas.
7. Balas HANYA dengan JSON valid, TANPA markdown fence, format persis:
{"aman": "...", "profesional": "...", "santai": "..."}`;

  const userPrompt = `Media pengiriman: ${safeMedia}

Draft pesan mentah dari user:
"""${rawMessage.trim()}"""

Rapikan jadi 3 versi (aman, profesional, santai) sesuai semua aturan di atas.`;

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
        max_tokens: 2000,
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
    if (!parsed || !parsed.aman || !parsed.profesional || !parsed.santai) {
      console.error('Gagal parse JSON dari AI:', rawText);
      return res.status(502).json({ error: 'AI mengembalikan format tidak terduga. Coba regenerate.' });
    }

    return res.status(200).json({
      aman: String(parsed.aman).trim(),
      profesional: String(parsed.profesional).trim(),
      santai: String(parsed.santai).trim(),
    });
  } catch (err) {
    console.error('Handler error:', err);
    return res.status(500).json({ error: 'Terjadi kesalahan di server. Coba lagi.' });
  }
};
