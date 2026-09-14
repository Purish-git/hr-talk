// api/_lib/redis.js
// Helper tipis untuk Upstash Redis lewat REST API (tanpa npm package tambahan,
// cukup pakai fetch bawaan Node di Vercel). File ini diawali underscore (_lib)
// supaya Vercel TIDAK menjadikannya endpoint sendiri — murni dipakai import
// oleh file lain di folder /api.
//
// SETUP YANG DIPERLUKAN DI VERCEL:
// 1. Vercel Dashboard -> project kamu -> tab "Storage" -> "Marketplace Database"
//    -> cari & install "Upstash Redis" (ada tier gratis).
// 2. Setelah connect ke project, buka detail database itu -> cari REST URL &
//    REST TOKEN-nya.
// 3. Di Project Settings -> Environment Variables, tambahkan (nama BEBAS kamu
//    pilih sendiri, asal cocok dengan yang dibaca di bawah ini):
//      REDIS_REST_URL   = (isi dengan REST URL dari Upstash)
//      REDIS_REST_TOKEN = (isi dengan REST TOKEN dari Upstash)

const REDIS_URL = process.env.REDIS_REST_URL;
const REDIS_TOKEN = process.env.REDIS_REST_TOKEN;

// Menjalankan satu perintah Redis lewat Upstash REST API.
// Contoh: redisCmd('HSET', 'code:ABCD', 'active', '1')
async function redisCmd(...args) {
  if (!REDIS_URL || !REDIS_TOKEN) {
    throw new Error('REDIS_REST_URL / REDIS_REST_TOKEN belum diset di environment variables.');
  }
  const res = await fetch(REDIS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${REDIS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Redis error (${res.status}): ${text}`);
  }
  const data = await res.json();
  return data.result;
}

// Ubah hasil HGETALL (array flat [field1,val1,field2,val2,...]) jadi object biasa.
function flatArrayToObject(arr) {
  const obj = {};
  if (!Array.isArray(arr)) return obj;
  for (let i = 0; i < arr.length; i += 2) {
    obj[arr[i]] = arr[i + 1];
  }
  return obj;
}

// Ambil detail 1 kode dari Redis. Return null kalau tidak ditemukan.
async function getCodeRecord(code) {
  if (!code) return null;
  const raw = await redisCmd('HGETALL', `code:${code}`);
  const obj = flatArrayToObject(raw);
  if (Object.keys(obj).length === 0) return null;
  return {
    active: obj.active === '1' || obj.active === 'true',
    buyer: obj.buyer || '',
    maxUses: obj.maxUses ? Number(obj.maxUses) : 0, // 0 = unlimited
    usedCount: obj.usedCount ? Number(obj.usedCount) : 0,
    createdAt: obj.createdAt || '',
  };
}

// Cek apakah kode valid & masih boleh dipakai.
async function isCodeValid(code) {
  const record = await getCodeRecord(code);
  if (!record) return { valid: false, reason: 'not_found' };
  if (!record.active) return { valid: false, reason: 'inactive' };
  if (record.maxUses > 0 && record.usedCount >= record.maxUses) {
    return { valid: false, reason: 'limit_reached' };
  }
  return { valid: true, record };
}

// Tambah counter pemakaian kode (dipanggil setiap kode ini berhasil dipakai
// generate). Sengaja "fire-and-forget friendly": kalau gagal, jangan sampai
// bikin seluruh request /api/chat ikut gagal.
async function incrementCodeUsage(code) {
  try {
    await redisCmd('HINCRBY', `code:${code}`, 'usedCount', 1);
  } catch (e) {
    console.error('Gagal increment usedCount untuk kode', code, e);
  }
}

// Bikin kode baru. `maxUses = 0` artinya unlimited (dipakai berkali-kali,
// cocok untuk model "beli sekali, akses premium selamanya").
async function createCode({ buyer, maxUses }) {
  const code = generateRandomCode();
  await redisCmd(
    'HSET', `code:${code}`,
    'active', '1',
    'buyer', buyer || '',
    'maxUses', String(maxUses || 0),
    'usedCount', '0',
    'createdAt', new Date().toISOString(),
  );
  return code;
}

async function deactivateCode(code) {
  await redisCmd('HSET', `code:${code}`, 'active', '0');
}

function generateRandomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // tanpa 0/O/1/I biar gak ambigu dibaca
  const part = () => Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  return `HRT-${part()}-${part()}`;
}

module.exports = {
  redisCmd,
  getCodeRecord,
  isCodeValid,
  incrementCodeUsage,
  createCode,
  deactivateCode,
};
