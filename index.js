/**
 * LINE OA Notification & Interactive Bot Server
 * ระบบแจ้งเตือนและแชตบอท LINE OA สำหรับโรงเรียนอุเทนพัฒนา (UTP Smart @911zewge)
 * 
 * ความสามารถ:
 *  1. 🔔 แจ้งเตือนครูแบบ Flex Card เมื่อมีคำร้องใหม่ (POST /notify-teacher)
 *  2. 🔔 แจ้งเตือนนักเรียนเมื่อครูอนุมัติหรือสถานะเปลี่ยน (POST /notify-student)
 *  3. 🤖 Webhook 2 ทาง (POST /webhook):
 *     - แอดเพื่อน (Follow) ทักทายพร้อมปุ่มแนะนำ
 *     - พิมพ์ "ครู [ชื่อ]" หรือ "ผูกบัญชีครู [ชื่อ]" -> เชื่อมโยงบัญชีครูกับ LINE อัตโนมัติทันที
 *     - พิมพ์ "นักเรียน [รหัส 5 หลัก]" -> เชื่อมโยงบัญชีนักเรียนอัตโนมัติ
 *     - พิมพ์ "คำร้องค้าง" หรือ "งานค้าง" -> ครูเช็ครายการที่รอตรวจ พร้อมปุ่มกดอนุมัติ
 *     - พิมพ์ "เช็คเกรด" หรือ "สถานะ" -> นักเรียนเช็คสถานะคำร้องของตนเอง
 *     - พิมพ์ "id" -> ดู LINE User ID ของตนเอง
 *     - พิมพ์ "เมนู" หรือ "help" -> เมนูลัดสวยงาม
 */

require('dotenv').config();
const express = require('express');
const admin = require('firebase-admin');
const axios = require('axios');

const app = express();
app.use(express.json());

// ── Firebase Admin Init ─────────────────────────────────────────
let db;
try {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
  if (serviceAccount.project_id) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    db = admin.firestore();
    console.log('✅ Firebase connected successfully');
  } else {
    console.warn('⚠️ FIREBASE_SERVICE_ACCOUNT not configured or empty');
  }
} catch (e) {
  console.error('❌ Firebase init error:', e.message);
}

// ── Config ──────────────────────────────────────────────────────
const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const BASE_URL = process.env.APP_BASE_URL || 'https://utenpatten-sgs.web.app';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'utenpatten2024';

// ── Helper: ส่ง LINE Push Message ──────────────────────────────
async function sendLineFlexMessage(lineUserId, altText, flexContents) {
  if (!LINE_TOKEN) { console.error('No LINE token'); return; }
  try {
    const res = await axios.post(
      'https://api.line.me/v2/bot/message/push',
      { to: lineUserId, messages: [{ type: 'flex', altText, contents: flexContents }] },
      { headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + LINE_TOKEN } }
    );
    console.log('✅ LINE Push message sent to ' + lineUserId);
    return res.data;
  } catch (err) {
    console.error('❌ LINE push error:', err.response ? JSON.stringify(err.response.data) : err.message);
  }
}

// ── Helper: ส่ง LINE Reply Message (ฟรี ไม่คิดโควต้า Push) ───────
async function sendLineReply(replyToken, messages) {
  if (!LINE_TOKEN || !replyToken) return;
  try {
    const payload = Array.isArray(messages) ? messages : [messages];
    await axios.post(
      'https://api.line.me/v2/bot/message/reply',
      { replyToken, messages: payload },
      { headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + LINE_TOKEN } }
    );
    console.log('✅ LINE Reply sent');
  } catch (err) {
    console.error('❌ LINE reply error:', err.response ? JSON.stringify(err.response.data) : err.message);
  }
}

// ── Flex Card: แจ้งครูเมื่อมีคำร้องใหม่ ──────────────────────────
function buildTeacherFlex(req, verifyUrl) {
  const gradeEmoji = req.gradeType === '0' ? '🔴' : req.gradeType === 'ร' ? '🟡' : '🟠';
  const gradeLabel = req.gradeType === '0' ? 'ผลการเรียน 0' : req.gradeType === 'ร' ? 'ร (รอส่งงาน)' : 'มส (ขาดสอบ/เวลาไม่พอ)';
  const submittedAt = req.studentSubmittedAt
    ? new Date(req.studentSubmittedAt).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' })
    : '-';

  return {
    type: 'bubble', size: 'mega',
    header: {
      type: 'box', layout: 'vertical', backgroundColor: '#0B6623', paddingAll: '16px',
      contents: [
        { type: 'text', text: '📋 คำร้องขอแก้ไขผลการเรียน', color: '#FFFFFF', size: 'md', weight: 'bold' },
        { type: 'text', text: 'โรงเรียนอุเทนพัฒนา (UTP Smart)', color: '#FFFFFFAA', size: 'xs' },
      ],
    },
    body: {
      type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '16px',
      contents: [
        { type: 'box', layout: 'horizontal', contents: [
          { type: 'text', text: '👤 นักเรียน', color: '#888888', size: 'sm', flex: 2 },
          { type: 'text', text: (req.studentName || '-') + '\n' + (req.studentClass || '') + ' เลขที่ ' + (req.studentNo || ''), size: 'sm', weight: 'bold', flex: 4, wrap: true },
        ]},
        { type: 'box', layout: 'horizontal', contents: [
          { type: 'text', text: '📚 วิชา', color: '#888888', size: 'sm', flex: 2 },
          { type: 'text', text: (req.subjectCode || '') + '\n' + (req.subjectName || ''), size: 'sm', weight: 'bold', flex: 4, wrap: true },
        ]},
        { type: 'box', layout: 'horizontal', contents: [
          { type: 'text', text: gradeEmoji + ' ผลเดิม', color: '#888888', size: 'sm', flex: 2 },
          { type: 'text', text: gradeLabel, size: 'sm', weight: 'bold', flex: 4, color: '#CC0000' },
        ]},
        { type: 'box', layout: 'horizontal', contents: [
          { type: 'text', text: '📅 ภาคเรียน', color: '#888888', size: 'sm', flex: 2 },
          { type: 'text', text: req.semester || '-', size: 'sm', flex: 4 },
        ]},
        { type: 'separator', margin: 'md' },
        { type: 'text', text: 'ยื่นเมื่อ: ' + submittedAt, size: 'xs', color: '#888888', wrap: true },
      ],
    },
    footer: {
      type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '12px',
      contents: [
        { type: 'button', style: 'primary', color: '#0B6623', height: 'sm',
          action: { type: 'uri', label: '✅ เปิดตรวจสอบคำร้อง', uri: verifyUrl } },
        { type: 'button', style: 'secondary', height: 'sm',
          action: { type: 'uri', label: '🏠 เข้าสู่ระบบหลัก', uri: BASE_URL } },
      ],
    },
  };
}

// ── Flex Card: แจ้งนักเรียน ─────────────────────────────────────
function buildStudentFlex(req) {
  const statusMap = {
    teacher_approved: { color: '#1976D2', label: 'ครูอนุมัติเกรดแล้ว รอฝ่ายวัดผล' },
    completed: { color: '#0B6623', label: 'ดำเนินการเสร็จสิ้น!' },
    rejected: { color: '#CC0000', label: 'คำร้องถูกปฏิเสธ' },
    assigned_work: { color: '#7B1FA2', label: 'ครูสั่งงานแล้ว รอนักเรียนส่ง' },
  };
  const s = statusMap[req.status] || { color: '#666666', label: req.status };

  return {
    type: 'bubble', size: 'kilo',
    header: {
      type: 'box', layout: 'vertical', backgroundColor: s.color, paddingAll: '12px',
      contents: [{ type: 'text', text: '📢 อัปเดตคำร้องของคุณ', color: '#FFFFFF', weight: 'bold', size: 'md' }],
    },
    body: {
      type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '14px',
      contents: [
        { type: 'text', text: 'วิชา: ' + req.subjectCode + ' ' + (req.subjectName || ''), size: 'sm', wrap: true },
        { type: 'text', text: 'สถานะ: ' + s.label, size: 'sm', weight: 'bold', color: s.color, wrap: true },
        ...(req.newGrade ? [{ type: 'text', text: 'เกรดใหม่: ' + req.newGrade, size: 'sm', weight: 'bold', color: '#0B6623' }] : []),
        ...(req.adminNote ? [{ type: 'text', text: 'หมายเหตุ: ' + req.adminNote, size: 'xs', color: '#666666', wrap: true }] : []),
      ],
    },
    footer: {
      type: 'box', layout: 'vertical', paddingAll: '10px',
      contents: [
        { type: 'button', style: 'primary', color: s.color, height: 'sm',
          action: { type: 'uri', label: '📊 ดูสถานะทั้งหมด', uri: BASE_URL + '/?page=student-status' } },
      ],
    },
  };
}

// ── Flex Card: เมนูหลัก (Main Menu) ──────────────────────────────
function buildMainMenuFlex(userId, linkedUser) {
  let statusText = 'ยังไม่ได้ผูกบัญชี';
  let statusColor = '#E65100';
  if (linkedUser) {
    statusText = `ผูกกับ: ${linkedUser.name} (${linkedUser.role === 'teacher' ? 'คุณครู' : 'นักเรียน'})`;
    statusColor = '#0B6623';
  }

  return {
    type: 'bubble', size: 'mega',
    header: {
      type: 'box', layout: 'vertical', backgroundColor: '#0B6623', paddingAll: '16px',
      contents: [
        { type: 'text', text: '🏫 UTP Smart — อุเทนพัฒนา', color: '#FFFFFF', size: 'lg', weight: 'bold' },
        { type: 'text', text: 'ระบบแก้ไขผลการเรียนดิจิทัล (0, ร, มส)', color: '#E8F5E9', size: 'xs' },
      ]
    },
    body: {
      type: 'box', layout: 'vertical', spacing: 'md', paddingAll: '16px',
      contents: [
        {
          type: 'box', layout: 'vertical', backgroundColor: '#F1F8E9', paddingAll: '10px', cornerRadius: 'md',
          contents: [
            { type: 'text', text: '📌 สถานะบัญชีของคุณ', size: 'xs', color: '#555555' },
            { type: 'text', text: statusText, size: 'sm', weight: 'bold', color: statusColor, wrap: true },
            { type: 'text', text: `ID: ${userId.substring(0, 8)}...${userId.substring(userId.length - 4)}`, size: 'xxs', color: '#888888' },
          ]
        },
        {
          type: 'box', layout: 'vertical', spacing: 'sm',
          contents: [
            {
              type: 'button', style: 'primary', color: '#0B6623', height: 'sm',
              action: { type: 'message', label: '📋 ตรวจสอบคำร้องค้าง (สำหรับครู)', text: 'คำร้องค้าง' }
            },
            {
              type: 'button', style: 'secondary', height: 'sm',
              action: { type: 'message', label: '📊 เช็คผลการเรียน (สำหรับนักเรียน)', text: 'เช็คเกรด' }
            },
            {
              type: 'button', style: 'secondary', height: 'sm',
              action: { type: 'message', label: '🔗 วิธีผูกบัญชีครู/นักเรียน', text: 'วิธีผูกบัญชี' }
            },
            {
              type: 'button', style: 'link', height: 'sm',
              action: { type: 'uri', label: '🌐 เปิดเว็บไซต์หลัก', uri: BASE_URL }
            }
          ]
        }
      ]
    },
    footer: {
      type: 'box', layout: 'vertical', paddingAll: '10px',
      contents: [
        { type: 'text', text: 'พิมพ์ "คำร้องค้าง" หรือ "เช็คเกรด" เพื่อใช้งานด่วน', size: 'xxs', color: '#888888', align: 'center' }
      ]
    }
  };
}

// ════════════════════════════════════════════════════════════════
// ROUTE: POST /webhook (LINE Messaging API Webhook)
// ════════════════════════════════════════════════════════════════
app.post('/webhook', async (req, res) => {
  // ตอบกลับ 200 OK ทันที เพื่อป้องกัน LINE timeout
  res.status(200).send('OK');

  const events = req.body.events || [];
  for (const event of events) {
    try {
      await handleLineEvent(event);
    } catch (err) {
      console.error('Error handling event:', err);
    }
  }
});

// ฟังก์ชันประมวลผล event จาก LINE
async function handleLineEvent(event) {
  const userId = event.source && event.source.userId;
  if (!userId) return;

  // ── 1. Event: ผู้ใช้กด Follow หรือ Unblock ──
  if (event.type === 'follow') {
    const welcomeFlex = {
      type: 'bubble', size: 'mega',
      header: {
        type: 'box', layout: 'vertical', backgroundColor: '#0B6623', paddingAll: '16px',
        contents: [
          { type: 'text', text: '🎉 ยินดีต้อนรับสู่ UTP Smart', color: '#FFFFFF', size: 'lg', weight: 'bold' },
          { type: 'text', text: 'ระบบแก้ไขผลการเรียน โรงเรียนอุเทนพัฒนา', color: '#E8F5E9', size: 'xs' },
        ]
      },
      body: {
        type: 'box', layout: 'vertical', spacing: 'md', paddingAll: '16px',
        contents: [
          { type: 'text', text: 'ยินดีต้อนรับคุณครูและนักเรียนทุกท่าน!', weight: 'bold', size: 'md' },
          { type: 'text', text: 'ระบบนี้จะแจ้งเตือนคำร้องแก้ 0, ร, มส และรายงานผลให้ท่านทราบทันทีแบบ Real-time', size: 'sm', color: '#555555', wrap: true },
          {
            type: 'box', layout: 'vertical', backgroundColor: '#F5F5F5', paddingAll: '12px', cornerRadius: 'md', spacing: 'xs',
            contents: [
              { type: 'text', text: '🟢 สำหรับคุณครู:', weight: 'bold', size: 'sm', color: '#0B6623' },
              { type: 'text', text: 'พิมพ์ "ครู [ชื่อ]" เช่น: ครู ศิรชัช เพื่อรับแจ้งเตือนเมื่อมีนักเรียนยื่นคำร้อง', size: 'xs', wrap: true },
              { type: 'separator', margin: 'sm' },
              { type: 'text', text: '🔵 สำหรับนักเรียน:', weight: 'bold', size: 'sm', color: '#1976D2' },
              { type: 'text', text: 'พิมพ์ "นักเรียน [รหัส 5 หลัก]" เช่น: นักเรียน 12345 เพื่อติดตามสถานะ', size: 'xs', wrap: true },
            ]
          }
        ]
      },
      footer: {
        type: 'box', layout: 'vertical', paddingAll: '12px', spacing: 'sm',
        contents: [
          { type: 'button', style: 'primary', color: '#0B6623', height: 'sm', action: { type: 'message', label: '📱 เปิดเมนูหลัก', text: 'เมนู' } },
          { type: 'button', style: 'secondary', height: 'sm', action: { type: 'uri', label: '🌐 เข้าเว็บไซต์หลัก', uri: BASE_URL } }
        ]
      }
    };
    await sendLineReply(event.replyToken, [{ type: 'flex', altText: 'ยินดีต้อนรับสู่ UTP Smart', contents: welcomeFlex }]);
    return;
  }

  // ── 2. Event: ผู้ใช้ส่งข้อความ (Message) ──
  if (event.type === 'message' && event.message.type === 'text') {
    const rawText = (event.message.text || '').trim();
    const text = rawText.toLowerCase();

    // ── ตรวจสอบว่าบัญชีนี้ผูกกับใครอยู่แล้วหรือยัง ──
    let linkedUser = null;
    if (db) {
      const teacherMatch = await db.collection('teachers').where('lineUserId', '==', userId).limit(1).get();
      if (!teacherMatch.empty) {
        linkedUser = { role: 'teacher', id: teacherMatch.docs[0].id, ...teacherMatch.docs[0].data() };
      } else {
        const studentMatch = await db.collection('students').where('lineUserId', '==', userId).limit(1).get();
        if (!studentMatch.empty) {
          linkedUser = { role: 'student', id: studentMatch.docs[0].id, ...studentMatch.docs[0].data() };
        }
      }
    }

    // A: ขอ LINE User ID
    if (text === 'id' || text === 'myid' || text === 'userid' || text === 'ไอดี') {
      await sendLineReply(event.replyToken, [{
        type: 'text',
        text: `👤 LINE User ID ของคุณคือ:\n\n${userId}\n\n(แตะค้างเพื่อคัดลอกได้ครับ)`
      }]);
      return;
    }

    // B: ผูกบัญชีครู (พิมพ์ "ครู [ชื่อ]" หรือ "ผูกบัญชีครู [ชื่อ]" หรือ "ลงทะเบียนครู [ชื่อ]")
    if (rawText.startsWith('ครู') || rawText.startsWith('ผูกบัญชีครู') || rawText.startsWith('ลงทะเบียนครู') || rawText.startsWith('อาจารย์')) {
      const keyword = rawText.replace(/^(ครู|ผูกบัญชีครู|ลงทะเบียนครู|อาจารย์)\s*/, '').trim();
      if (!keyword) {
        await sendLineReply(event.replyToken, [{
          type: 'text',
          text: 'กรุณาระบุชื่อของคุณครูด้วยครับ เช่น:\n"ครู ศิรชัช" หรือ "ครู นุชนารถ"'
        }]);
        return;
      }

      if (!db) {
        await sendLineReply(event.replyToken, [{ type: 'text', text: 'ระบบฐานข้อมูลขัดข้อง กรุณาลองใหม่ภายหลัง' }]);
        return;
      }

      // ค้นหาชื่อครูใน Firestore
      const snap = await db.collection('teachers').get();
      let matchedTeacher = null;
      snap.forEach(doc => {
        const data = doc.data();
        const tName = (data.name || data.teacherName || '');
        if (tName.includes(keyword) || keyword.includes(tName)) {
          matchedTeacher = { id: doc.id, ...data };
        }
      });

      if (!matchedTeacher) {
        await sendLineReply(event.replyToken, [{
          type: 'text',
          text: `❌ ไม่พบข้อมูลคุณครูที่ตรงกับ "${keyword}"\nกรุณาพิมพ์ชื่อ-นามสกุลให้ชัดเจน หรือติดต่อฝ่ายวัดผลครับ`
        }]);
        return;
      }

      // บันทึก lineUserId ลงในเอกสารครู
      await db.collection('teachers').doc(matchedTeacher.id).update({
        lineUserId: userId,
        lineLinkedAt: new Date().toISOString()
      });

      // ตรวจสอบว่ามีคำร้องค้างอยู่กี่รายการ
      const pendingSnap = await db.collection('requests')
        .where('teacherId', '==', matchedTeacher.id)
        .where('status', '==', 'pending')
        .get();
      const pendingCount = pendingSnap.size;

      const successFlex = {
        type: 'bubble', size: 'mega',
        header: {
          type: 'box', layout: 'vertical', backgroundColor: '#0B6623', paddingAll: '16px',
          contents: [
            { type: 'text', text: '✅ ผูกบัญชีครูสำเร็จ!', color: '#FFFFFF', size: 'lg', weight: 'bold' },
            { type: 'text', text: 'โรงเรียนอุเทนพัฒนา (UTP Smart)', color: '#E8F5E9', size: 'xs' },
          ]
        },
        body: {
          type: 'box', layout: 'vertical', spacing: 'md', paddingAll: '16px',
          contents: [
            { type: 'text', text: `ยินดีต้อนรับ ${matchedTeacher.name || matchedTeacher.teacherName}`, size: 'md', weight: 'bold' },
            { type: 'text', text: `รหัสครู: ${matchedTeacher.id}`, size: 'xs', color: '#888888' },
            {
              type: 'box', layout: 'vertical', backgroundColor: pendingCount > 0 ? '#FFF3E0' : '#E8F5E9', paddingAll: '12px', cornerRadius: 'md',
              contents: [
                {
                  type: 'text',
                  text: pendingCount > 0 ? `⚠️ มีคำร้องรอคุณครูตรวจสอบ ${pendingCount} รายการ` : '🎉 ไม่มีคำร้องค้างตรวจในขณะนี้',
                  size: 'sm', weight: 'bold', color: pendingCount > 0 ? '#E65100' : '#0B6623'
                },
                { type: 'text', text: 'ระบบจะส่งการแจ้งเตือนทันทีเมื่อมีนักเรียนยื่นคำร้องใหม่เข้ามาครับ', size: 'xs', color: '#666666' }
              ]
            }
          ]
        },
        footer: {
          type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '12px',
          contents: [
            ...(pendingCount > 0 ? [{
              type: 'button', style: 'primary', color: '#E65100', height: 'sm',
              action: { type: 'message', label: `📋 ดูรายการค้าง (${pendingCount})`, text: 'คำร้องค้าง' }
            }] : []),
            {
              type: 'button', style: 'secondary', height: 'sm',
              action: { type: 'uri', label: '🏠 เข้าสู่ระบบครู', uri: BASE_URL + '/?page=teacher-portal' }
            }
          ]
        }
      };

      await sendLineReply(event.replyToken, [{ type: 'flex', altText: 'ผูกบัญชีครูสำเร็จ', contents: successFlex }]);
      return;
    }

    // C: ผูกบัญชีนักเรียน (พิมพ์ "นักเรียน [รหัส]" หรือพิมพ์รหัส 5 หลัก)
    if (rawText.startsWith('นักเรียน') || rawText.startsWith('ผูกบัญชีนักเรียน') || /^\d{5}$/.test(rawText)) {
      const studentCode = rawText.replace(/^(นักเรียน|ผูกบัญชีนักเรียน)\s*/, '').trim();
      if (!studentCode) {
        await sendLineReply(event.replyToken, [{ type: 'text', text: 'กรุณาระบุรหัสประจำตัวนักเรียน 5 หลัก เช่น: "นักเรียน 12345"' }]);
        return;
      }

      if (!db) {
        await sendLineReply(event.replyToken, [{ type: 'text', text: 'ระบบฐานข้อมูลขัดข้อง กรุณาลองใหม่ภายหลัง' }]);
        return;
      }

      // ค้นหาใน students collection
      let matchedStudent = null;
      const studentDoc = await db.collection('students').doc(studentCode).get();
      if (studentDoc.exists) {
        matchedStudent = { id: studentDoc.id, ...studentDoc.data() };
      } else {
        const querySnap = await db.collection('students').where('studentId', '==', studentCode).limit(1).get();
        if (!querySnap.empty) {
          matchedStudent = { id: querySnap.docs[0].id, ...querySnap.docs[0].data() };
        }
      }

      if (!matchedStudent) {
        await sendLineReply(event.replyToken, [{
          type: 'text',
          text: `❌ ไม่พบข้อมูลนักเรียนรหัส "${studentCode}" ในระบบ\nกรุณาตรวจสอบรหัสประจำตัวอีกครั้งครับ`
        }]);
        return;
      }

      // บันทึก lineUserId
      await db.collection('students').doc(matchedStudent.id).update({
        lineUserId: userId,
        lineLinkedAt: new Date().toISOString()
      });

      const successStudentFlex = {
        type: 'bubble', size: 'kilo',
        header: {
          type: 'box', layout: 'vertical', backgroundColor: '#1976D2', paddingAll: '14px',
          contents: [
            { type: 'text', text: '✅ ผูกบัญชีนักเรียนสำเร็จ', color: '#FFFFFF', weight: 'bold', size: 'md' }
          ]
        },
        body: {
          type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '14px',
          contents: [
            { type: 'text', text: `👤 ${matchedStudent.name}`, weight: 'bold', size: 'sm' },
            { type: 'text', text: `รหัส: ${matchedStudent.studentId || matchedStudent.id} | ชั้น ${matchedStudent.class || matchedStudent.classroom || '-'}`, size: 'xs', color: '#666666' },
            { type: 'separator', margin: 'sm' },
            { type: 'text', text: 'เมื่อคุณครูอนุมัติเกรดใหม่ ระบบจะแจ้งเตือนผลผ่าน LINE ทันที!', size: 'xs', color: '#0B6623' }
          ]
        },
        footer: {
          type: 'box', layout: 'vertical', paddingAll: '10px',
          contents: [
            { type: 'button', style: 'primary', color: '#1976D2', height: 'sm', action: { type: 'message', label: '📊 เช็คสถานะเกรด', text: 'เช็คเกรด' } }
          ]
        }
      };

      await sendLineReply(event.replyToken, [{ type: 'flex', altText: 'ผูกบัญชีนักเรียนสำเร็จ', contents: successStudentFlex }]);
      return;
    }

    // D: ตรวจสอบคำร้องค้าง (สำหรับครู)
    if (text === 'คำร้องค้าง' || text === 'งานค้าง' || text === 'รอตรวจ' || text === 'ตรวจคำร้อง') {
      if (!linkedUser || linkedUser.role !== 'teacher') {
        await sendLineReply(event.replyToken, [{
          type: 'text',
          text: '⚠️ ท่านยังไม่ได้ผูกบัญชีครู กรุณาพิมพ์:\n"ครู [ชื่อของคุณครู]"\nเช่น "ครู ศิรชัช" เพื่อเชื่อมโยงบัญชีก่อนครับ'
        }]);
        return;
      }

      if (!db) return;
      const pendingSnap = await db.collection('requests')
        .where('teacherId', '==', linkedUser.id)
        .where('status', '==', 'pending')
        .get();

      if (pendingSnap.empty) {
        await sendLineReply(event.replyToken, [{
          type: 'text',
          text: `🎉 คุณครู${linkedUser.name || ''} ไม่มีคำร้องค้างตรวจในขณะนี้ครับ!`
        }]);
        return;
      }

      // สร้าง Flex Carousel แสดงคำร้องค้าง (สูงสุด 5 รายการ)
      const bubbles = [];
      let count = 0;
      pendingSnap.forEach(doc => {
        if (count >= 5) return;
        const r = doc.data();
        const verifyUrl = `${BASE_URL}/?page=verify&token=${r.qrToken || ''}`;
        bubbles.push({
          type: 'bubble', size: 'micro',
          header: {
            type: 'box', layout: 'vertical', backgroundColor: '#0B6623', paddingAll: '8px',
            contents: [{ type: 'text', text: `วิชา ${r.subjectCode}`, color: '#FFFFFF', size: 'xs', weight: 'bold' }]
          },
          body: {
            type: 'box', layout: 'vertical', spacing: 'xs', paddingAll: '8px',
            contents: [
              { type: 'text', text: r.studentName || '-', size: 'xxs', weight: 'bold', wrap: true },
              { type: 'text', text: `${r.studentClass || ''} | ผลเดิม ${r.gradeType}`, size: 'xxs', color: '#CC0000' },
              { type: 'text', text: `ภาค ${r.semester || '-'}`, size: 'xxs', color: '#888888' },
            ]
          },
          footer: {
            type: 'box', layout: 'vertical', paddingAll: '6px',
            contents: [
              { type: 'button', style: 'primary', color: '#0B6623', height: 'sm', action: { type: 'uri', label: '✅ ตรวจสอบ', uri: verifyUrl } }
            ]
          }
        });
        count++;
      });

      await sendLineReply(event.replyToken, [
        { type: 'text', text: `📋 พบคำร้องค้างตรวจ ${pendingSnap.size} รายการ (แสดง ${count} รายการล่าสุด):` },
        { type: 'flex', altText: 'รายการคำร้องค้าง', contents: { type: 'carousel', contents: bubbles } }
      ]);
      return;
    }

    // E: เช็คสถานะเกรด (สำหรับนักเรียน)
    if (text === 'เช็คเกรด' || text === 'สถานะ' || text === 'เช็คสถานะ') {
      if (!linkedUser || linkedUser.role !== 'student') {
        await sendLineReply(event.replyToken, [{
          type: 'text',
          text: '💡 กรุณาผูกบัญชีนักเรียนก่อน โดยพิมพ์:\n"นักเรียน [รหัส 5 หลัก]"\nเช่น "นักเรียน 12345" ครับ'
        }]);
        return;
      }

      if (!db) return;
      const reqSnap = await db.collection('requests')
        .where('studentId', '==', linkedUser.id)
        .get();

      if (reqSnap.empty) {
        await sendLineReply(event.replyToken, [{
          type: 'text',
          text: `น้อง ${linkedUser.name} ยังไม่มีประวัติการยื่นคำร้องแก้ผลการเรียนในระบบครับ`
        }]);
        return;
      }

      const statusMap = {
        pending: '🟡 รอครูตรวจสอบ',
        assigned_work: '🟣 ครูสั่งงานแล้ว (ส่งงานด่วน)',
        teacher_approved: '🔵 ครูอนุมัติแล้ว (รอวัดผล)',
        completed: '🟢 แก้ไขสำเร็จเรียบร้อย',
        rejected: '🔴 คำร้องถูกปฏิเสธ'
      };

      let statusMsg = `📊 ประวัติคำร้องของ ${linkedUser.name} (${reqSnap.size} รายการ):\n`;
      reqSnap.forEach(doc => {
        const r = doc.data();
        const st = statusMap[r.status] || r.status;
        statusMsg += `\n• ${r.subjectCode} (${r.gradeType}) : ${st}`;
        if (r.newGrade) statusMsg += ` -> เกรดใหม่: ${r.newGrade}`;
      });

      await sendLineReply(event.replyToken, [
        { type: 'text', text: statusMsg },
        {
          type: 'flex', altText: 'ดูสถานะเต็ม',
          contents: {
            type: 'bubble', size: 'kilo',
            body: {
              type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '12px',
              contents: [
                { type: 'text', text: 'คลิกดูรายละเอียดและใบคำร้องฉบับเต็มได้ที่นี่:', size: 'xs', color: '#666666' },
                { type: 'button', style: 'primary', color: '#0B6623', height: 'sm', action: { type: 'uri', label: '🌐 เปิดดูในเว็บไซต์', uri: BASE_URL + '/?page=student-status' } }
              ]
            }
          }
        }
      ]);
      return;
    }

    // F: วิธีผูกบัญชี
    if (text === 'วิธีผูกบัญชี' || text === 'วิธีใช้งาน' || text === 'ผูกบัญชี') {
      await sendLineReply(event.replyToken, [{
        type: 'text',
        text: `📱 วิธีผูกบัญชีกับ UTP Smart\n\n🟢 สำหรับคุณครู:\nพิมพ์: ครู [ชื่อหรือนามสกุล]\nตัวอย่าง: ครู ศิรชัช\n\n🔵 สำหรับนักเรียน:\nพิมพ์: นักเรียน [รหัส 5 หลัก]\nตัวอย่าง: นักเรียน 12345\n\nเมื่อผูกแล้ว ระบบจะแจ้งเตือนเข้า LINE ของท่านโดยอัตโนมัติทันที!`
      }]);
      return;
    }

    // G: เมนูหลัก / Help / ข้อความอื่นๆ ที่ไม่เข้าเงื่อนไขข้างต้น
    const menuFlex = buildMainMenuFlex(userId, linkedUser);
    await sendLineReply(event.replyToken, [{ type: 'flex', altText: 'เมนูระบบ UTP Smart', contents: menuFlex }]);
  }
}

// ════════════════════════════════════════════════════════════════
// ROUTE: POST /notify-teacher (เรียกจาก Web App เมื่อนักเรียนยื่นคำร้อง)
// Body: { secret, requestId, teacherId, request: {...} }
// ════════════════════════════════════════════════════════════════
app.post('/notify-teacher', async (req, res) => {
  const { secret, requestId, teacherId, request: reqData } = req.body;

  if (secret !== WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!teacherId || !reqData) {
    return res.status(400).json({ error: 'Missing teacherId or request data' });
  }

  try {
    if (!db) return res.status(500).json({ error: 'Firebase not connected' });

    const teacherDoc = await db.collection('teachers').doc(teacherId).get();
    if (!teacherDoc.exists) return res.status(404).json({ error: 'Teacher not found' });

    const lineUserId = teacherDoc.data().lineUserId;
    if (!lineUserId) {
      console.log(`Teacher ${teacherId} has no LINE User ID set`);
      return res.json({ sent: false, reason: 'Teacher has no LINE User ID set' });
    }

    const verifyUrl = BASE_URL + '/?page=verify&token=' + reqData.qrToken;
    const flex = buildTeacherFlex(reqData, verifyUrl);
    const altText = '📋 คำร้องใหม่: ' + reqData.studentName + ' ขอแก้ไขวิชา ' + reqData.subjectCode + ' (' + reqData.gradeType + ')';

    await sendLineFlexMessage(lineUserId, altText, flex);
    res.json({ sent: true, teacherId, lineUserId });
  } catch (err) {
    console.error('Notify teacher error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════
// ROUTE: POST /notify-student (เรียกจาก Web App เมื่อสถานะคำร้องเปลี่ยน)
// Body: { secret, studentId, request: {...} }
// ════════════════════════════════════════════════════════════════
app.post('/notify-student', async (req, res) => {
  const { secret, studentId, request: reqData } = req.body;

  if (secret !== WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    if (!db) return res.status(500).json({ error: 'Firebase not connected' });

    const studentDoc = await db.collection('students').doc(studentId).get();
    if (!studentDoc.exists) return res.json({ sent: false, reason: 'Student not found' });

    const lineUserId = studentDoc.data().lineUserId;
    if (!lineUserId) {
      return res.json({ sent: false, reason: 'Student has no LINE User ID set' });
    }

    const flex = buildStudentFlex(reqData);
    const statusLabels = {
      teacher_approved: 'ครูอนุมัติเกรดแล้ว',
      completed: 'ดำเนินการเสร็จสิ้น',
      rejected: 'คำร้องถูกปฏิเสธ',
      assigned_work: 'ครูสั่งงานแล้ว',
    };
    const altText = (statusLabels[reqData.status] || reqData.status) + ': วิชา ' + reqData.subjectCode;

    await sendLineFlexMessage(lineUserId, altText, flex);
    res.json({ sent: true, studentId, lineUserId });
  } catch (err) {
    console.error('Notify student error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Health Check ─────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'UTP Smart LINE Bot & Notifier',
    version: '2.0.0',
    school: 'โรงเรียนอุเทนพัฒนา',
    time: new Date().toISOString()
  });
});

// ── Start Server ─────────────────────────────────────────────────
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log('🚀 UTP Smart LINE Bot & Notifier running on port ' + PORT);
  console.log('✅ LINE Token configured:', !!LINE_TOKEN);
  console.log('✅ Base URL:', BASE_URL);
});
