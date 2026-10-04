/**
 * ปลดระวางแล้ว — เซิร์ฟเวอร์ย้ายไป Firebase Cloud Functions (functions/ ในโปรเจกต์หลัก)
 * และเลิกใช้ LINE OA แล้ว
 *
 * ไฟล์นี้ตั้งใจให้ทำงานน้อยที่สุดจนกว่าจะลบบริการใน Railway:
 * ไม่เชื่อมต่อ Firestore ไม่ส่งอีเมล ไม่ตอบ LINE — ตอบทุกคำขอด้วย 410 Gone
 * โค้ดเดิมอยู่ที่ index.legacy.js (ไม่ถูกรัน)
 */
const express = require('express');
const app = express();

app.all('*', (req, res) => {
  res.status(410).json({
    error: 'เซิร์ฟเวอร์นี้ปลดระวางแล้ว กรุณาใช้ https://utenpatten-sgs.web.app',
  });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log('retired stub listening on ' + PORT));
