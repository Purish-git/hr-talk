// api/_lib/aiJson.js
// Helper buat parse JSON dari jawaban model dengan lebih tahan banting.
// Kadang model nambahin teks sebelum/sesudah JSON, atau bungkus pakai
// markdown fence yang formatnya dikit beda dari yang kita duga. Daripada
// langsung gagal di satu kali percobaan JSON.parse, coba beberapa cara.

function parseJsonFromModel(rawText) {
  if (!rawText) return null;

  let cleaned = rawText
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/, '')
    .replace(/```\s*$/, '')
    .trim();

  // Percobaan 1: langsung parse
  try {
    return JSON.parse(cleaned);
  } catch (e) { /* lanjut ke percobaan berikutnya */ }

  // Percobaan 2: ambil substring dari '{' pertama sampai '}' terakhir —
  // ini mengatasi kasus model nambahin kalimat pembuka/penutup di luar JSON.
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    const sub = cleaned.slice(start, end + 1);
    try {
      return JSON.parse(sub);
    } catch (e) { /* lanjut */ }
  }

  return null;
}

module.exports = { parseJsonFromModel };
