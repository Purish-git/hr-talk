// api/webhook-payment.js
// Endpoint yang kamu daftarkan sebagai "Webhook URL" / "Payment Notification
// URL" di dashboard Lynk.id, Mayar, atau platform pembayaran lain. Setiap ada
// transaksi sukses, platform itu akan POST ke sini -> kita generate kode
// premium -> kirim ke email pembeli otomatis lewat Resend.
//
// PENTING - INI BELUM 100% "PASANG LANGSUNG JADI":
// Setiap platform pembayaran punya format payload webhook yang beda-beda,
// dan saya tidak punya dokumentasi pasti untuk Lynk.id/Mayar. Kode di bawah
// ini MENCOBA beberapa kemungkinan nama field yang umum dipakai (email,
// buyer_email, customer.email, dst). Kalau nanti webhook masuk tapi email
// gagal terkirim / ke-skip, buka Vercel -> Deployments -> function ini ->
// Logs. Payload ASLI dari platform kamu akan selalu ter-log di sana (lihat
// console.log('RAW WEBHOOK PAYLOAD', ...) di bawah). Screenshot/copy log itu
// dan kasih ke saya, nanti saya sesuaikan field mapping-nya persis.
//
// KEAMANAN:
// Supaya orang lain nggak bisa hit endpoint ini sembarangan buat generate
// kode gratis, kita wajibkan query string ?secret=... yang cocok dengan
// WEBHOOK_SECRET. Waktu setting webhook URL di Lynk.id/Mayar, isi URL-nya
// dengan format:
//   https://domainmu.vercel.app/api/webhook-payment?secret=RAHASIA_KAMU

const { createCode } = require('./_lib/redis');
const { sendCodeEmail } = require('./_lib/email');

// Coba ambil email pembeli dari beberapa kemungkinan struktur payload umum.
function extractEmail(body) {
  const candidates = [
    body?.email,
    body?.buyer_email,
    body?.customer_email,
    body?.payer_email,
    body?.data?.email,
    body?.data?.buyer_email,
    body?.data?.customer?.email,
    body?.customer?.email,
    body?.buyer?.email,
    body?.order?.email,
    body?.order?.customer?.email,
  ];
  return candidates.find((v) => typeof v === 'string' && v.includes('@')) || null;
}

function extractName(body) {
  const candidates = [
    body?.name,
    body?.buyer_name,
    body?.customer_name,
    body?.data?.name,
    body?.data?.buyer_name,
    body?.data?.customer?.name,
    body?.customer?.name,
    body?.buyer?.name,
    body?.order?.customer?.name,
  ];
  return candidates.find((v) => typeof v === 'string' && v.trim()) || '';
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method tidak diizinkan. Gunakan POST.' });
  }

  const webhookSecret = process.env.WEBHOOK_SECRET;
  if (!webhookSecret) {
    return res.status(500).json({ error: 'WEBHOOK_SECRET belum diset di environment variables.' });
  }
  const providedSecret = (req.query && req.query.secret) || '';
  if (providedSecret !== webhookSecret) {
    return res.status(403).json({ error: 'Secret tidak cocok.' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  body = body || {};

  // SELALU log payload mentah — ini kunci buat debugging mapping field nanti.
  console.log('RAW WEBHOOK PAYLOAD:', JSON.stringify(body));

  const email = extractEmail(body);
  const buyerName = extractName(body);

  if (!email) {
    console.error('Webhook masuk tapi email pembeli tidak ditemukan di payload. Cek log di atas untuk struktur aslinya.');
    // Tetap balas 200 supaya platform pembayaran tidak terus retry —
    // tapi kamu HARUS cek log & follow up manual buat transaksi ini.
    return res.status(200).json({
      received: true,
      warning: 'Email pembeli tidak ditemukan di payload. Cek Vercel logs & kirim kode manual untuk transaksi ini.',
    });
  }

  try {
    const code = await createCode({ buyer: `${buyerName} <${email}>`.trim() });
    await sendCodeEmail({ to: email, code, buyerName });
    console.log(`Kode ${code} berhasil dibuat & dikirim ke ${email}`);
    return res.status(200).json({ received: true, emailed: true });
  } catch (err) {
    console.error('Gagal generate/kirim kode dari webhook:', err);
    // Tetap 200 biar platform tidak retry berkali-kali, tapi log error-nya
    // supaya kamu tahu ada transaksi yang butuh follow-up manual.
    return res.status(200).json({
      received: true,
      emailed: false,
      warning: 'Gagal kirim email otomatis. Cek Vercel logs, lalu generate & kirim kode manual untuk pembeli ini.',
    });
  }
};
