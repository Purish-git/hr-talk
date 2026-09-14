// api/_lib/email.js
// Helper tipis untuk kirim email lewat Resend (https://resend.com) pakai
// REST API langsung (fetch), tanpa perlu install SDK/npm package tambahan.
//
// SETUP:
// 1. Daftar di resend.com (gratis, 3.000 email/bulan di tier free).
// 2. Ambil API key dari dashboard -> API Keys -> Create API Key.
// 3. Di Vercel, tambahkan environment variable RESEND_API_KEY.
// 4. (Opsional tapi disarankan) Verifikasi domain kamu sendiri di Resend
//    supaya email nggak dikirim dari alamat generik. Kalau belum sempat,
//    Resend kasih domain testing "onboarding@resend.dev" yang bisa dipakai
//    sementara (tapi cuma bisa kirim ke email yang kamu daftarkan sendiri di
//    akun Resend selama domain belum diverifikasi — cek dokumentasi Resend
//    untuk batasan pastinya).

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.EMAIL_FROM || 'HR Talk <onboarding@resend.dev>';

async function sendCodeEmail({ to, code, buyerName }) {
  if (!RESEND_API_KEY) {
    throw new Error('RESEND_API_KEY belum diset di environment variables.');
  }
  if (!to) {
    throw new Error('Alamat email tujuan kosong.');
  }

  const greetName = buyerName ? buyerName.split(' ')[0] : '';

  const html = `
    <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px;">
      <h2 style="margin-bottom:4px;">Terima kasih sudah upgrade ke HR Talk Premium! 🎉</h2>
      <p>${greetName ? `Halo ${greetName},` : 'Halo,'}</p>
      <p>Ini kode akses premium kamu — masukkan di halaman "Upgrade" pada aplikasi HR Talk:</p>
      <div style="background:#F3F1FB;border-radius:12px;padding:16px 20px;text-align:center;margin:16px 0;">
        <span style="font-size:22px;font-weight:700;letter-spacing:1px;">${code}</span>
      </div>
      <p style="font-size:13px;color:#666;">Simpan email ini baik-baik. Kode ini berlaku selamanya untuk 1 perangkat/browser dan cukup dimasukkan sekali.</p>
      <p style="font-size:13px;color:#666;">Ada kendala? Balas email ini.</p>
    </div>
  `;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: FROM_EMAIL,
      to: [to],
      subject: 'Kode akses Premium HR Talk kamu',
      html,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Resend error (${res.status}): ${text}`);
  }

  return res.json();
}

module.exports = { sendCodeEmail };
