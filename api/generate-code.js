// api/generate-code.js
// Endpoint ADMIN-ONLY buat kamu bikin kode premium baru setiap ada yang beli
// (misalnya setelah dapat notifikasi pembayaran dari Lynk.id/Mayar, sebagai
// alternatif manual kalau webhook otomatis di api/webhook-payment.js belum
// kepasang / gagal mendeteksi email pembeli).
//
// JANGAN dipanggil dari frontend/index.html — ini murni buat kamu panggil
// manual (lewat curl, Postman, atau extension REST client) tiap ada transaksi
// masuk. Dilindungi ADMIN_SECRET supaya orang lain nggak bisa generate kode
// gratis sendiri.
//
// Cara pakai (contoh curl) — email opsional, kalau diisi otomatis dikirimkan:
//   curl -X POST https://domainmu.vercel.app/api/generate-code \
//     -H "Content-Type: application/json" \
//     -H "x-admin-secret: RAHASIA_KAMU" \
//     -d '{"buyer":"Budi","email":"budi@email.com"}'
//
// Response: {"code":"HRT-AB3K-9QXZ","emailed":true}

const { createCode } = require('./_lib/redis');
const { sendCodeEmail } = require('./_lib/email');

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
  const email = body && body.email ? String(body.email).trim() : '';
  // maxUses = 0 berarti unlimited (dipakai berkali-kali seumur hidup produk).
  const maxUses = body && body.maxUses ? Number(body.maxUses) : 0;

  try {
    const code = await createCode({ buyer, maxUses });

    let emailed = false;
    let emailError = null;
    if (email) {
      try {
        await sendCodeEmail({ to: email, code, buyerName: buyer });
        emailed = true;
      } catch (err) {
        console.error('Gagal kirim email dari generate-code:', err);
        emailError = err.message;
      }
    }

    return res.status(200).json({ code, buyer, maxUses, emailed, emailError });
  } catch (err) {
    console.error('generate-code error:', err);
    return res.status(500).json({ error: 'Gagal membuat kode. Cek koneksi Redis (REDIS_REST_URL/REDIS_REST_TOKEN).' });
  }
};
