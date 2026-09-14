// api/verify-code.js
// Endpoint publik, dipanggil frontend untuk mengecek apakah kode premium yang
// diketik user valid atau tidak. TIDAK memanggil Claude API sama sekali (jadi
// gratis dipanggil berkali-kali, tidak makan kuota Anthropic).

const { isCodeValid } = require('./_lib/redis');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method tidak diizinkan. Gunakan POST.' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  const code = (body && body.code ? String(body.code) : '').trim().toUpperCase();

  if (!code) {
    return res.status(400).json({ valid: false, error: 'Kode tidak boleh kosong.' });
  }

  try {
    const result = await isCodeValid(code);
    if (!result.valid) {
      const messages = {
        not_found: 'Kode tidak ditemukan. Cek lagi penulisannya ya.',
        inactive: 'Kode ini sudah tidak aktif.',
        limit_reached: 'Kode ini sudah mencapai batas pemakaian.',
      };
      return res.status(200).json({
        valid: false,
        error: messages[result.reason] || 'Kode tidak valid.',
      });
    }
    return res.status(200).json({ valid: true });
  } catch (err) {
    console.error('verify-code error:', err);
    return res.status(500).json({ valid: false, error: 'Gagal memverifikasi kode. Coba lagi.' });
  }
};
