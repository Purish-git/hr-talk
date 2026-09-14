// api/generate-code.js
// Endpoint ADMIN-ONLY buat kamu bikin kode premium baru setiap ada yang beli
// (misalnya setelah dapat notifikasi pembayaran dari Lynk.id/Mayar).
//
// JANGAN dipanggil dari frontend/index.html — ini murni buat kamu panggil
// manual (lewat curl, Postman, atau extension REST client) tiap ada transaksi
// masuk. Dilindungi ADMIN_SECRET supaya orang lain nggak bisa generate kode
// gratis sendiri.
//
// Cara pakai (contoh curl):
//   curl -X POST https://domainmu.vercel.app/api/generate-code \
//     -H "Content-Type: application/json" \
//     -H "x-admin-secret: RAHASIA_KAMU" \
//     -d '{"buyer":"Budi - budi@email.com"}'
//
// Response: {"code":"HRT-AB3K-9QXZ"} <- ini yang kamu kirim ke pembeli.

const { createCode } = require('./_lib/redis');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method tidak diizinkan. Gunakan POST.' });
  }

  const adminSecret = process.env.ADMIN_SECRET;
  if (!adminSecret) {
    return res.status(500).json({ error: 'ADMIN_SECRET belum diset di environment variables.' });
  }

  const providedSecret = req.headers['x-admin-secret'];
  if (!providedSecret || providedSecret !== adminSecret) {
    return res.status(403).json({ error: 'Tidak diizinkan. Header x-admin-secret salah/tidak ada.' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  const buyer = body && body.buyer ? String(body.buyer).slice(0, 200) : '';
  // maxUses = 0 berarti unlimited (dipakai berkali-kali seumur hidup produk).
  const maxUses = body && body.maxUses ? Number(body.maxUses) : 0;

  try {
    const code = await createCode({ buyer, maxUses });
    return res.status(200).json({ code, buyer, maxUses });
  } catch (err) {
    console.error('generate-code error:', err);
    return res.status(500).json({ error: 'Gagal membuat kode. Cek koneksi Redis (REDIS_REST_URL/REDIS_REST_TOKEN).' });
  }
};
