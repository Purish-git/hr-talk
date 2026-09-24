// api/verify-google.js
// Verifikasi token "Sign in with Google" (ID token / credential) yang
// dikirim frontend. HANYA dipakai untuk identitas/personalisasi tampilan
// (nama & foto profil) — BUKAN untuk gating fitur premium. Status premium
// tetap lewat sistem kode akses terpisah (lihat api/verify-code.js), sesuai
// keputusan awal: dua sistem ini sengaja dipisah.
//
// Pakai endpoint resmi Google (tokeninfo) buat verifikasi, jadi TIDAK perlu
// install package google-auth-library — konsisten dengan pola zero-dependency
// di seluruh project ini (cuma pakai fetch bawaan).

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method tidak diizinkan. Gunakan POST.' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  const credential = body && body.credential;
  if (!credential || typeof credential !== 'string') {
    return res.status(400).json({ error: 'Field "credential" wajib diisi.' });
  }

  try {
    const verifyRes = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`
    );
    if (!verifyRes.ok) {
      return res.status(401).json({ error: 'Token Google tidak valid atau kedaluwarsa.' });
    }
    const payload = await verifyRes.json();

    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (clientId && payload.aud !== clientId) {
      console.error('Google token aud mismatch. Expected:', clientId, 'Got:', payload.aud);
      return res.status(401).json({ error: 'Token Google tidak cocok dengan aplikasi ini.' });
    }
    if (!clientId) {
      console.warn('GOOGLE_CLIENT_ID belum diset — verifikasi audience dilewati (kurang aman, tapi tetap jalan).');
    }

    return res.status(200).json({
      email: payload.email || '',
      name: payload.name || '',
      picture: payload.picture || '',
      emailVerified: payload.email_verified === 'true' || payload.email_verified === true,
    });
  } catch (err) {
    console.error('verify-google error:', err);
    return res.status(500).json({ error: 'Gagal memverifikasi login Google. Coba lagi.' });
  }
};
