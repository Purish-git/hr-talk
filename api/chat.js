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

module.exports = async function handler(req, res) {
  // --- 1. Hanya izinkan POST ---
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method tidak diizinkan. Gunakan POST.' });
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
4. Sesuaikan gaya dengan media pengiriman:
   - WhatsApp: ringkas, tidak terlalu formal, boleh pakai emoji secukupnya HANYA kalau nadanya santai/percaya diri dan konteksnya bukan topik berat (misalnya resign atau komplain serius).
   - Email: ada pembuka dan penutup yang rapi, tanpa emoji.
   - LinkedIn: sopan dan profesional, tanpa emoji, tidak sekaku email resmi.
5. Hasil harus siap copy-paste langsung, tanpa placeholder seperti "[Nama]" atau "[Perusahaan]" kecuali detail itu memang ada di input user.
6. Setiap versi maksimal sekitar 3-5 kalimat pendek.
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
        max_tokens: 800,
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
