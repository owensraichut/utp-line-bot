/**
 * LINE OA Notification & Interactive Bot Server v3.0
 * ระบบแจ้งเตือนและแชตบอท LINE OA สำหรับโรงเรียนอุเทนพัฒนา (UTP Smart @911zewge)
 * 
 * ความสามารถใหม่:
 *  1. 🔒 ยืนยันตัวตนครูด้วย PIN 4 หลัก ป้องกันการแอบอ้าง 100%
 *  2. ⚡ Magic Link เข้าระบบเว็บอัตโนมัติ (1-Click Auto-Login) ไม่ต้องพิมพ์ PIN ซ้ำ
 *  3. ⭐ อนุมัติเกรดใหม่ผ่านแชต LINE โดยตรง (In-Chat Approval via Postback)
 *  4. 📝 มอบหมายงานนักเรียนผ่านแชต LINE
 *  5. 📊 นักเรียนเช็คสถานะ / ครูตรวจงานค้าง
 */

require('dotenv').config();
const express = require('express');
const admin = require('firebase-admin');
const axios = require('axios');
const crypto = require('crypto');

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

// ── In-Memory Sessions & Debug Logs ─────────────────────────────
const recentLogs = [];
function logEvent(tag, data) {
  const item = { time: new Date().toISOString(), tag, data };
  recentLogs.push(item);
  if (recentLogs.length > 50) recentLogs.shift();
  console.log(`[${tag}]`, typeof data === 'object' ? JSON.stringify(data) : data);
}

// Session maps for interactive multi-step flows in LINE
const pendingPinVerification = new Map(); // userId -> { teacher, timestamp }
const pendingStudentPinVerification = new Map(); // userId -> { student, isSetup, timestamp }
const pendingWorkAssignment = new Map();  // userId -> { reqId, reqData, timestamp }

// ── Helper: สร้าง Magic Link (One-Tap Auto Login) ───────────────
function generateMagicLink(teacherId, requestId = '') {
  const timestamp = Date.now();
  const raw = `${WEBHOOK_SECRET}:${teacherId}:${timestamp}:${requestId}`;
  const sig = crypto.createHash('sha256').update(raw).digest('hex');
  return `${BASE_URL}/?page=teacher-verify&tid=${encodeURIComponent(teacherId)}&t=${timestamp}&sig=${sig}&req=${encodeURIComponent(requestId)}`;
}

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

// ── Flex Card: แจ้งเตือนครู + ปุ่มอนุมัติในแชต + Magic Link ──────
function buildTeacherFlex(req, magicUrl) {
  const gradeEmoji = req.gradeType === '0' ? '🔴' : req.gradeType === 'ร' ? '🟡' : '🟠';
  const gradeLabel = req.gradeType === '0' ? 'ผลการเรียน 0' : req.gradeType === 'ร' ? 'ร (รอส่งงาน)' : 'มส (ขาดสอบ/เวลาไม่พอ)';
  const submittedAt = req.studentSubmittedAt
    ? new Date(req.studentSubmittedAt).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' })
    : '-';

  // ปุ่มแอ็กชันในแชต (In-Chat Postback & Magic Link)
  const actionButtons = [];

  if (req.gradeType === '0' || req.gradeType === 'มส') {
    // แก้ 0 หรือ มส ได้สูงสุดเกรด 1
    actionButtons.push({
      type: 'button', style: 'primary', color: '#0B6623', height: 'sm',
      action: {
        type: 'postback',
        label: '⭐ อนุมัติเกรด 1 ทันที',
        data: `action=approve&reqId=${req.id}&grade=1`,
        displayText: `อนุมัติเกรด 1 วิชา ${req.subjectCode}`
      }
    });
  } else {
    // ผลการเรียน "ร" สามารถเลือกเกรดได้
    actionButtons.push({
      type: 'box', layout: 'horizontal', spacing: 'sm',
      contents: [
        { type: 'button', style: 'primary', color: '#0B6623', height: 'sm', flex: 1, action: { type: 'postback', label: 'เกรด 1', data: `action=approve&reqId=${req.id}&grade=1`, displayText: 'อนุมัติเกรด 1' } },
        { type: 'button', style: 'primary', color: '#1B5E20', height: 'sm', flex: 1, action: { type: 'postback', label: 'เกรด 2', data: `action=approve&reqId=${req.id}&grade=2`, displayText: 'อนุมัติเกรด 2' } },
        { type: 'button', style: 'primary', color: '#2E7D32', height: 'sm', flex: 1, action: { type: 'postback', label: 'เกรด 3', data: `action=approve&reqId=${req.id}&grade=3`, displayText: 'อนุมัติเกรด 3' } },
        { type: 'button', style: 'primary', color: '#388E3C', height: 'sm', flex: 1, action: { type: 'postback', label: 'เกรด 4', data: `action=approve&reqId=${req.id}&grade=4`, displayText: 'อนุมัติเกรด 4' } },
      ]
    });
  }

  // ปุ่มสั่งงานในแชต
  actionButtons.push({
    type: 'button', style: 'secondary', height: 'sm',
    action: {
      type: 'postback',
      label: '📝 สั่งงานนักเรียน',
      data: `action=assign_prompt&reqId=${req.id}`,
      displayText: 'สั่งงานนักเรียน'
    }
  });

  // ปุ่ม Magic Link เข้าระบบเว็บอัตโนมัติ
  actionButtons.push({
    type: 'button', style: 'link', height: 'sm',
    action: {
      type: 'uri',
      label: '🌐 เปิดตรวจบนเว็บ (Auto-Login)',
      uri: magicUrl
    }
  });

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
      contents: actionButtons,
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
        ...(req.assignmentDetails ? [{ type: 'text', text: 'งานที่ได้รับมอบหมาย: ' + req.assignmentDetails, size: 'xs', color: '#7B1FA2', wrap: true }] : []),
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
              action: {
                type: 'uri',
                label: '🌐 เปิดห้องทำงานครู (Auto-Login)',
                uri: linkedUser && linkedUser.role === 'teacher' ? generateMagicLink(linkedUser.id) : BASE_URL
              }
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
  logEvent('WEBHOOK_REQUEST', {
    headers: {
      'user-agent': req.headers['user-agent'],
      'x-line-signature': req.headers['x-line-signature'] ? 'present' : 'none'
    },
    body: req.body
  });

  // ตอบกลับ 200 OK ทันที เพื่อป้องกัน LINE timeout
  res.status(200).send('OK');

  const events = req.body.events || [];
  for (const event of events) {
    try {
      logEvent('HANDLE_EVENT', { type: event.type, source: event.source, text: event.message && event.message.text });
      await handleLineEvent(event);
    } catch (err) {
      logEvent('EVENT_ERROR', { error: err.message });
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
              { type: 'text', text: '🟢 สำหรับคุณครู (ปลอดภัยด้วย PIN 4 หลัก):', weight: 'bold', size: 'sm', color: '#0B6623' },
              { type: 'text', text: 'พิมพ์ "ครู [ชื่อ] [PIN]" เช่น: ครู ศิรชัช 2108 เพื่อรับแจ้งเตือนและอนุมัติเกรดในแชต', size: 'xs', wrap: true },
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

  // ── 2. Event: Postback Action (กดปุ่มอนุมัติเกรด หรือสั่งงานในแชต) ──
  if (event.type === 'postback') {
    const postbackData = event.postback.data || '';
    const params = new URLSearchParams(postbackData);
    const action = params.get('action');

    logEvent('POSTBACK_ACTION', { action, data: postbackData });

    // A: ครูอนุมัติเกรดผ่านแชต
    if (action === 'approve') {
      const reqId = params.get('reqId');
      const grade = params.get('grade');

      if (!db) {
        await sendLineReply(event.replyToken, [{ type: 'text', text: 'ระบบฐานข้อมูลขัดข้อง กรุณาลองใหม่ภายหลัง' }]);
        return;
      }

      try {
        const reqDoc = await db.collection('requests').doc(reqId).get();
        if (!reqDoc.exists) {
          await sendLineReply(event.replyToken, [{ type: 'text', text: '❌ ไม่พบข้อมูลคำร้องนี้ หรือคำร้องอาจถูกลบไปแล้ว' }]);
          return;
        }

        const reqData = reqDoc.data();

        // ตรวจสอบสิทธิ์: ผู้กดต้องเป็นครูประจำวิชานี้
        const teacherDoc = await db.collection('teachers').doc(reqData.teacherId).get();
        if (!teacherDoc.exists || teacherDoc.data().lineUserId !== userId) {
          await sendLineReply(event.replyToken, [{
            type: 'text',
            text: '⚠️ ขออภัยครับ ท่านไม่มีสิทธิ์อนุมัติคำร้องนี้ (คำร้องนี้เป็นของ ' + (reqData.teacherName || 'ครูท่านอื่น') + ')'
          }]);
          return;
        }

        // ตรวจสอบเพดานเกรด (0 และ มส ได้สูงสุดเกรด 1)
        if ((reqData.gradeType === '0' || reqData.gradeType === 'มส') && grade !== '1' && grade !== 'ผ่าน') {
          await sendLineReply(event.replyToken, [{
            type: 'text',
            text: '⚠️ ตามระเบียบ สพฐ. การแก้ไข 0 หรือ มส ได้เกรดสูงสุดไม่เกินเกรด 1 ครับ'
          }]);
          return;
        }

        const teacherName = teacherDoc.data().name || teacherDoc.data().teacherName || 'คุณครู';
        const updatedLogs = [
          ...(reqData.auditLogs || []),
          {
            action: 'teacher_approved',
            actorName: teacherName,
            actorRole: 'teacher',
            details: `อนุมัติผลการเรียนใหม่เป็นเกรด "${grade}" ผ่าน LINE OA (In-Chat Approval)`,
            timestamp: new Date().toISOString()
          }
        ];

        // บันทึกลง Firestore
        await db.collection('requests').doc(reqId).update({
          status: 'teacher_approved',
          newGrade: grade,
          teacherApprovedAt: new Date().toISOString(),
          approvedVia: 'LINE_OA',
          auditLogs: updatedLogs
        });

        // ส่งแจ้งเตือนนักเรียน (ถ้ามี lineUserId)
        try {
          const studentDoc = await db.collection('students').doc(reqData.studentId).get();
          if (studentDoc.exists && studentDoc.data().lineUserId) {
            const studentFlex = buildStudentFlex({
              ...reqData,
              status: 'teacher_approved',
              newGrade: grade
            });
            await sendLineFlexMessage(
              studentDoc.data().lineUserId,
              `📢 ครูอนุมัติเกรดใหม่วิชา ${reqData.subjectCode} แล้ว!`,
              studentFlex
            );
          }
        } catch (sErr) {
          console.warn('Notify student err:', sErr.message);
        }

        // ส่งการ์ดแจ้งผลความสำเร็จให้ครู
        const successCard = {
          type: 'bubble', size: 'mega',
          header: {
            type: 'box', layout: 'vertical', backgroundColor: '#0B6623', paddingAll: '16px',
            contents: [
              { type: 'text', text: '✅ อนุมัติผลการเรียนสำเร็จ!', color: '#FFFFFF', size: 'lg', weight: 'bold' },
              { type: 'text', text: 'โรงเรียนอุเทนพัฒนา (UTP Smart)', color: '#E8F5E9', size: 'xs' }
            ]
          },
          body: {
            type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '16px',
            contents: [
              { type: 'text', text: `👤 นักเรียน: ${reqData.studentName} (${reqData.studentClass || ''})`, size: 'sm', weight: 'bold' },
              { type: 'text', text: `📚 วิชา: ${reqData.subjectCode} ${reqData.subjectName || ''}`, size: 'sm' },
              { type: 'text', text: `⭐ เกรดใหม่: ${grade} (ผลเดิม: ${reqData.gradeType})`, size: 'md', weight: 'bold', color: '#0B6623' },
              { type: 'separator', margin: 'md' },
              { type: 'text', text: '📌 สถานะ: บันทึกลงระบบและส่งต่อฝ่ายวัดผลเรียบร้อยแล้ว ขอบคุณครับ/ค่ะ', size: 'xs', color: '#555555', wrap: true }
            ]
          },
          footer: {
            type: 'box', layout: 'vertical', paddingAll: '10px',
            contents: [
              {
                type: 'button', style: 'primary', color: '#0B6623', height: 'sm',
                action: { type: 'uri', label: '🌐 เปิดห้องทำงานครู (Auto-Login)', uri: generateMagicLink(reqData.teacherId) }
              }
            ]
          }
        };

        await sendLineReply(event.replyToken, [{ type: 'flex', altText: 'อนุมัติเกรดสำเร็จ', contents: successCard }]);
        return;
      } catch (err) {
        console.error('Approve error:', err);
        await sendLineReply(event.replyToken, [{ type: 'text', text: 'เกิดข้อผิดพลาดในการอนุมัติ: ' + err.message }]);
        return;
      }
    }

    // B: ครูต้องการสั่งงานนักเรียนผ่านแชต
    if (action === 'assign_prompt') {
      const reqId = params.get('reqId');
      if (!db) return;

      const reqDoc = await db.collection('requests').doc(reqId).get();
      if (!reqDoc.exists) {
        await sendLineReply(event.replyToken, [{ type: 'text', text: '❌ ไม่พบคำร้องนี้' }]);
        return;
      }

      const reqData = reqDoc.data();
      pendingWorkAssignment.set(userId, { reqId, reqData, timestamp: Date.now() });

      await sendLineReply(event.replyToken, [{
        type: 'text',
        text: `📝 สั่งงานนักเรียน\nวิชา: ${reqData.subjectCode} (${reqData.studentName})\n\nกรุณาพิมพ์รายละเอียดงานที่ต้องการมอบหมายในช่องแชตนี้ได้เลยครับ เช่น:\n"งาน: ให้ทำแบบฝึกหัดบทที่ 3 ข้อ 1-10 ส่งภายในวันศุกร์นี้"`
      }]);
      return;
    }
  }

  // ── 3. Event: ผู้ใช้ส่งข้อความ (Message) ──
  if (event.type === 'message' && event.message.type === 'text') {
    const rawText = (event.message.text || '').trim();
    const text = rawText.toLowerCase();

    // ── ตรวจสอบว่ามี Session สั่งงานค้างอยู่หรือไม่ ──
    if (pendingWorkAssignment.has(userId)) {
      const session = pendingWorkAssignment.get(userId);
      // เช็คหมดอายุ 10 นาที
      if (Date.now() - session.timestamp < 10 * 60 * 1000) {
        if (!rawText.startsWith('ยกเลิก')) {
          const reqId = session.reqId;
          const reqData = session.reqData;
          const assignmentDetails = rawText.replace(/^งาน\s*:\s*/i, '').trim();

          const teacherDoc = await db.collection('teachers').doc(reqData.teacherId).get();
          const teacherName = teacherDoc.exists ? (teacherDoc.data().name || 'คุณครู') : 'คุณครู';

          const updatedLogs = [
            ...(reqData.auditLogs || []),
            {
              action: 'assigned_work',
              actorName: teacherName,
              actorRole: 'teacher',
              details: `มอบหมายงานผ่าน LINE OA: ${assignmentDetails}`,
              timestamp: new Date().toISOString()
            }
          ];

          await db.collection('requests').doc(reqId).update({
            status: 'assigned_work',
            assignmentDetails: assignmentDetails,
            assignedAt: new Date().toISOString(),
            assignedVia: 'LINE_OA',
            auditLogs: updatedLogs
          });

          pendingWorkAssignment.delete(userId);

          // ส่งแจ้งเตือนนักเรียน (ถ้ามี lineUserId)
          try {
            const studentDoc = await db.collection('students').doc(reqData.studentId).get();
            if (studentDoc.exists && studentDoc.data().lineUserId) {
              const studentFlex = buildStudentFlex({
                ...reqData,
                status: 'assigned_work',
                assignmentDetails: assignmentDetails
              });
              await sendLineFlexMessage(
                studentDoc.data().lineUserId,
                `📢 คุณครูสั่งงานวิชา ${reqData.subjectCode} แล้ว!`,
                studentFlex
              );
            }
          } catch (sErr) {
            console.warn('Student notify err:', sErr.message);
          }

          await sendLineReply(event.replyToken, [{
            type: 'text',
            text: `✅ บันทึกการมอบหมายงานเรียบร้อยแล้วครับ!\n\n📚 วิชา: ${reqData.subjectCode}\n👤 นักเรียน: ${reqData.studentName}\n📝 งาน: ${assignmentDetails}\n\nระบบได้ส่งการแจ้งเตือนไปยังนักเรียนแล้วครับ`
          }]);
          return;
        } else {
          pendingWorkAssignment.delete(userId);
          await sendLineReply(event.replyToken, [{ type: 'text', text: 'ยกเลิกการสั่งงานเรียบร้อยแล้วครับ' }]);
          return;
        }
      } else {
        pendingWorkAssignment.delete(userId);
      }
    }

    // ── ตรวจสอบว่ามี Session กรอก PIN ครู ค้างอยู่หรือไม่ ──
    if (pendingPinVerification.has(userId)) {
      const session = pendingPinVerification.get(userId);
      if (Date.now() - session.timestamp < 10 * 60 * 1000) {
        // เช็คว่าผู้ใช้กรอก PIN 4 หลักมาหรือไม่
        const pinMatch = rawText.match(/^\d{4}$/) || rawText.match(/^pin\s*(\d{4})$/i);
        if (pinMatch) {
          const inputPin = pinMatch[1] || pinMatch[0];
          const matchedTeacher = session.teacher;

          if (matchedTeacher.pin === inputPin) {
            // รหัสถูกต้อง! ผูกบัญชีสำเร็จ
            pendingPinVerification.delete(userId);

            await db.collection('teachers').doc(matchedTeacher.id).update({
              lineUserId: userId,
              lineLinkedAt: new Date().toISOString()
            });

            // ตรวจสอบคำร้องค้าง
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
                  { type: 'text', text: '✅ ยืนยันตัวตนสำเร็จ!', color: '#FFFFFF', size: 'lg', weight: 'bold' },
                  { type: 'text', text: 'โรงเรียนอุเทนพัฒนา (UTP Smart)', color: '#E8F5E9', size: 'xs' },
                ]
              },
              body: {
                type: 'box', layout: 'vertical', spacing: 'md', paddingAll: '16px',
                contents: [
                  { type: 'text', text: `ยินดีต้อนรับ ${matchedTeacher.name}`, size: 'md', weight: 'bold' },
                  { type: 'text', text: `กลุ่มสาระฯ: ${matchedTeacher.department || '-'}`, size: 'xs', color: '#888888' },
                  {
                    type: 'box', layout: 'vertical', backgroundColor: pendingCount > 0 ? '#FFF3E0' : '#E8F5E9', paddingAll: '12px', cornerRadius: 'md',
                    contents: [
                      {
                        type: 'text',
                        text: pendingCount > 0 ? `⚠️ มีคำร้องรอคุณครูตรวจสอบ ${pendingCount} รายการ` : '🎉 ไม่มีคำร้องค้างตรวจในขณะนี้',
                        size: 'sm', weight: 'bold', color: pendingCount > 0 ? '#E65100' : '#0B6623'
                      },
                      { type: 'text', text: 'ท่านสามารถอนุมัติเกรด หรือคลิก Auto-Login เข้าห้องทำงานครูได้ทันทีครับ', size: 'xs', color: '#666666' }
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
                    action: {
                      type: 'uri',
                      label: '🌐 เปิดห้องทำงานครู (Auto-Login)',
                      uri: generateMagicLink(matchedTeacher.id)
                    }
                  }
                ]
              }
            };

            await sendLineReply(event.replyToken, [{ type: 'flex', altText: 'ผูกบัญชีครูสำเร็จ', contents: successFlex }]);
            return;
          } else {
            await sendLineReply(event.replyToken, [{
              type: 'text',
              text: `❌ รหัส PIN 4 หลักไม่ถูกต้องครับ\n\nกรุณาตรวจสอบรหัส PIN ของ ${matchedTeacher.name} แล้วลองพิมพ์ใหม่อีกครั้งครับ (หรือพิมพ์ "ยกเลิก")`
            }]);
            return;
          }
        }
      } else {
        pendingPinVerification.delete(userId);
      }
    }

    // ── ตรวจสอบว่ามี Session กรอก PIN นักเรียน ค้างอยู่หรือไม่ (PDPA) ──
    if (pendingStudentPinVerification.has(userId)) {
      const session = pendingStudentPinVerification.get(userId);
      if (Date.now() - session.timestamp < 10 * 60 * 1000) {
        const pinMatch = rawText.match(/^\d{4}$/) || rawText.match(/^pin\s*(\d{4})$/i);
        if (pinMatch) {
          const inputPin = pinMatch[1] || pinMatch[0];
          const matchedStudent = session.student;

          if (!matchedStudent.pin || matchedStudent.pin === inputPin || session.isSetup) {
            pendingStudentPinVerification.delete(userId);

            const updateData = {
              lineUserId: userId,
              lineLinkedAt: new Date().toISOString()
            };
            if (!matchedStudent.pin || session.isSetup) updateData.pin = inputPin;

            await db.collection('students').doc(matchedStudent.id).update(updateData);

            const successStudentFlex = {
              type: 'bubble', size: 'kilo',
              header: {
                type: 'box', layout: 'vertical', backgroundColor: '#1976D2', paddingAll: '14px',
                contents: [
                  { type: 'text', text: '✅ ยืนยันตัวตนสำเร็จ (PDPA)', color: '#FFFFFF', weight: 'bold', size: 'md' }
                ]
              },
              body: {
                type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '14px',
                contents: [
                  { type: 'text', text: `👤 ${matchedStudent.name}`, weight: 'bold', size: 'sm' },
                  { type: 'text', text: `รหัส: ${matchedStudent.studentId || matchedStudent.id} | ชั้น ${matchedStudent.class || matchedStudent.studentClass || '-'}`, size: 'xs', color: '#666666' },
                  { type: 'separator', margin: 'sm' },
                  { type: 'text', text: 'ยืนยันรหัส PIN ถูกต้อง ระบบจะแจ้งเตือนผลผ่าน LINE ทันที!', size: 'xs', color: '#0B6623' }
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
          } else {
            await sendLineReply(event.replyToken, [{
              type: 'text',
              text: `❌ รหัส PIN 4 หลักไม่ถูกต้องครับ\nเพื่อความปลอดภัย (PDPA) กรุณากรอกรหัส PIN ประจำตัวของ "${matchedStudent.name}" ให้ถูกต้องครับ (หรือพิมพ์ "ยกเลิก")`
            }]);
            return;
          }
        } else if (rawText.includes('ยกเลิก')) {
          pendingStudentPinVerification.delete(userId);
          await sendLineReply(event.replyToken, [{
            type: 'text',
            text: 'ยกเลิกการยืนยันตัวตนนักเรียนเรียบร้อยแล้วครับ'
          }]);
          return;
        }
      } else {
        pendingStudentPinVerification.delete(userId);
      }
    }

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

    // B: ผูกบัญชีครู (พร้อม PIN ป้องกันแอบอ้าง)
    // รูปแบบ 1: "ครู ศิรชัช 2108"
    // รูปแบบ 2: "ครู ศิรชัช" -> แล้วบอทถาม PIN
    if (rawText.startsWith('ครู') || rawText.startsWith('ผูกบัญชีครู') || rawText.startsWith('ลงทะเบียนครู') || rawText.startsWith('อาจารย์')) {
      const cleaned = rawText.replace(/^(ครู|ผูกบัญชีครู|ลงทะเบียนครู|อาจารย์)\s*/, '').trim();
      
      // ดึงรหัส PIN ออกมาหากพิมพ์มาด้วย เช่น "ศิรชัช 2108"
      const pinInlineMatch = cleaned.match(/\s+(\d{4})$/);
      let keyword = cleaned;
      let inlinePin = null;
      if (pinInlineMatch) {
        inlinePin = pinInlineMatch[1];
        keyword = cleaned.substring(0, cleaned.length - pinInlineMatch[0].length).trim();
      }

      if (!keyword) {
        await sendLineReply(event.replyToken, [{
          type: 'text',
          text: 'กรุณาระบุชื่อของคุณครูด้วยครับ เช่น:\n"ครู ศิรชัช 2108" หรือ "ครู นุชนารถ"'
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
          text: `❌ ไม่พบข้อมูลคุณครูที่ตรงกับ "${keyword}"\nกรุณาพิมพ์ชื่อจริงให้ชัดเจน หรือติดต่อฝ่ายวัดผลครับ`
        }]);
        return;
      }

      // กรณีครูพิมพ์ PIN มาพร้อมกันในคำสั่งเดียว เช่น "ครู ศิรชัช 2108"
      if (inlinePin) {
        if (matchedTeacher.pin === inlinePin) {
          // ถูกต้อง! ผูกสำเร็จทันที
          await db.collection('teachers').doc(matchedTeacher.id).update({
            lineUserId: userId,
            lineLinkedAt: new Date().toISOString()
          });

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
                { type: 'text', text: '✅ ยืนยันตัวตนสำเร็จ!', color: '#FFFFFF', size: 'lg', weight: 'bold' },
                { type: 'text', text: 'โรงเรียนอุเทนพัฒนา (UTP Smart)', color: '#E8F5E9', size: 'xs' },
              ]
            },
            body: {
              type: 'box', layout: 'vertical', spacing: 'md', paddingAll: '16px',
              contents: [
                { type: 'text', text: `ยินดีต้อนรับ ${matchedTeacher.name}`, size: 'md', weight: 'bold' },
                { type: 'text', text: `กลุ่มสาระฯ: ${matchedTeacher.department || '-'}`, size: 'xs', color: '#888888' },
                {
                  type: 'box', layout: 'vertical', backgroundColor: pendingCount > 0 ? '#FFF3E0' : '#E8F5E9', paddingAll: '12px', cornerRadius: 'md',
                  contents: [
                    {
                      type: 'text',
                      text: pendingCount > 0 ? `⚠️ มีคำร้องรอคุณครูตรวจสอบ ${pendingCount} รายการ` : '🎉 ไม่มีคำร้องค้างตรวจในขณะนี้',
                      size: 'sm', weight: 'bold', color: pendingCount > 0 ? '#E65100' : '#0B6623'
                    },
                    { type: 'text', text: 'ท่านสามารถอนุมัติเกรด หรือคลิก Auto-Login เข้าห้องทำงานครูได้ทันทีครับ', size: 'xs', color: '#666666' }
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
                  action: {
                    type: 'uri',
                    label: '🌐 เปิดห้องทำงานครู (Auto-Login)',
                    uri: generateMagicLink(matchedTeacher.id)
                  }
                }
              ]
            }
          };

          await sendLineReply(event.replyToken, [{ type: 'flex', altText: 'ผูกบัญชีครูสำเร็จ', contents: successFlex }]);
          return;
        } else {
          await sendLineReply(event.replyToken, [{
            type: 'text',
            text: `❌ รหัส PIN 4 หลักไม่ถูกต้องครับ เพื่อความปลอดภัย กรุณาตรวจสอบรหัส PIN ประจำตัวของคุณครูอีกครั้งครับ`
          }]);
          return;
        }
      }

      // กรณีครูยังไม่ได้ใส่ PIN มาด้วย -> บอทถาม PIN เพื่อยืนยันตัวตน 2 ชั้น
      pendingPinVerification.set(userId, { teacher: matchedTeacher, timestamp: Date.now() });
      await sendLineReply(event.replyToken, [{
        type: 'text',
        text: `🔐 เพื่อความปลอดภัยและป้องกันการแอบอ้าง\n\nกรุณาพิมพ์รหัส PIN 4 หลักประจำตัวของ "${matchedTeacher.name}" เพื่อยืนยันตัวตนครับ\n(เช่น พิมพ์ตัวเลข 4 หลักส่งมาได้เลยครับ)`
      }]);
      return;
    }

    // C: ผูกบัญชีนักเรียน (พร้อม PIN ป้องกันแอบดูเกรด PDPA)
    // รูปแบบ 1: "นักเรียน 12345 1234" (รหัส 5 หลัก + PIN 4 หลัก)
    // รูปแบบ 2: "นักเรียน 12345" หรือ "12345" -> บอทถามรหัส PIN 4 หลัก
    if (rawText.startsWith('นักเรียน') || rawText.startsWith('ผูกบัญชีนักเรียน') || /^\d{5}(\s+\d{4})?$/.test(rawText)) {
      const cleaned = rawText.replace(/^(นักเรียน|ผูกบัญชีนักเรียน)\s*/, '').trim();
      const parts = cleaned.split(/\s+/);
      const studentCode = parts[0];
      const inlinePin = parts[1] && /^\d{4}$/.test(parts[1]) ? parts[1] : null;

      if (!studentCode) {
        await sendLineReply(event.replyToken, [{
          type: 'text',
          text: 'กรุณาระบุรหัสประจำตัวนักเรียน 5 หลัก เช่น:\n"นักเรียน 12345 1234" หรือ "นักเรียน 12345"'
        }]);
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
          text: `❌ ไม่พบข้อมูลนักเรียนรหัส "${studentCode}" ในระบบ\nกรุณาตรวจสอบรหัสประจำตัว 5 หลักอีกครั้งครับ`
        }]);
        return;
      }

      // ฟังก์ชันสร้าง Success Flex Card สำหรับนักเรียน
      const buildSuccessFlex = (st) => ({
        type: 'bubble', size: 'kilo',
        header: {
          type: 'box', layout: 'vertical', backgroundColor: '#1976D2', paddingAll: '14px',
          contents: [
            { type: 'text', text: '✅ ยืนยันตัวตนสำเร็จ (PDPA)', color: '#FFFFFF', weight: 'bold', size: 'md' }
          ]
        },
        body: {
          type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '14px',
          contents: [
            { type: 'text', text: `👤 ${st.name}`, weight: 'bold', size: 'sm' },
            { type: 'text', text: `รหัส: ${st.studentId || st.id} | ชั้น ${st.class || st.studentClass || st.classroom || '-'}`, size: 'xs', color: '#666666' },
            { type: 'separator', margin: 'sm' },
            { type: 'text', text: '🔒 ยืนยันรหัส PIN ถูกต้อง ระบบจะแจ้งเตือนผลและงานมอบหมายผ่าน LINE ทันที!', size: 'xs', color: '#0B6623' }
          ]
        },
        footer: {
          type: 'box', layout: 'vertical', paddingAll: '10px',
          contents: [
            { type: 'button', style: 'primary', color: '#1976D2', height: 'sm', action: { type: 'message', label: '📊 เช็คสถานะเกรด', text: 'เช็คเกรด' } }
          ]
        }
      });

      // กรณีที่ 1: นักเรียนพิมพ์ PIN มาพร้อมกันในคำสั่งเดียว เช่น "นักเรียน 12345 1234"
      if (inlinePin) {
        if (!matchedStudent.pin || matchedStudent.pin === inlinePin) {
          const updateData = {
            lineUserId: userId,
            lineLinkedAt: new Date().toISOString()
          };
          if (!matchedStudent.pin) updateData.pin = inlinePin;

          await db.collection('students').doc(matchedStudent.id).update(updateData);
          await sendLineReply(event.replyToken, [{ type: 'flex', altText: 'ผูกบัญชีนักเรียนสำเร็จ', contents: buildSuccessFlex(matchedStudent) }]);
          return;
        } else {
          await sendLineReply(event.replyToken, [{
            type: 'text',
            text: `❌ รหัส PIN 4 หลักไม่ถูกต้องครับ\nเพื่อความปลอดภัยและคุ้มครองข้อมูลส่วนบุคคล (PDPA) กรุณาตรวจสอบรหัส PIN ประจำตัวของ "${matchedStudent.name}" ให้ถูกต้องครับ`
          }]);
          return;
        }
      }

      // กรณีที่ 2: นักเรียนยังไม่ได้ใส่ PIN มาด้วย -> บอทถาม PIN เพื่อความปลอดภัย (PDPA)
      if (matchedStudent.pin) {
        pendingStudentPinVerification.set(userId, { student: matchedStudent, isSetup: false, timestamp: Date.now() });
        await sendLineReply(event.replyToken, [{
          type: 'text',
          text: `🔐 เพื่อความปลอดภัยและคุ้มครองข้อมูลส่วนบุคคล (PDPA)\n\nกรุณาพิมพ์รหัส PIN 4 หลักประจำตัวของ "${matchedStudent.name}" เพื่อยืนยันตัวตนครับ\n(พิมพ์ตัวเลข 4 หลักส่งมาได้เลยครับ หรือพิมพ์ "ยกเลิก")`
        }]);
        return;
      } else {
        // บัญชีนี้ในระบบยังไม่เคยตั้ง PIN
        pendingStudentPinVerification.set(userId, { student: matchedStudent, isSetup: true, timestamp: Date.now() });
        await sendLineReply(event.replyToken, [{
          type: 'text',
          text: `🔐 บัญชีของ "${matchedStudent.name}" ยังไม่ได้ตั้งรหัส PIN ในระบบ\n\nเพื่อความปลอดภัย (PDPA) กรุณาพิมพ์ตัวเลข 4 หลักที่ต้องการใช้ เพื่อตั้งเป็นรหัส PIN ประจำตัวของคุณครับ (หรือพิมพ์ "ยกเลิก")`
        }]);
        return;
      }
    }

    // D: ตรวจสอบคำร้องค้าง (สำหรับครู พร้อมปุ่ม Magic Link & อนุมัติในแชต)
    if (text === 'คำร้องค้าง' || text === 'งานค้าง' || text === 'รอตรวจ' || text === 'ตรวจคำร้อง') {
      if (!linkedUser || linkedUser.role !== 'teacher') {
        await sendLineReply(event.replyToken, [{
          type: 'text',
          text: '⚠️ ท่านยังไม่ได้ผูกบัญชีครู กรุณาพิมพ์:\n"ครู [ชื่อ] [PIN]"\nเช่น "ครู ศิรชัช 2108" เพื่อยืนยันตัวตนก่อนครับ'
        }]);
        return;
      }

      if (!db) return;
      const pendingSnap = await db.collection('requests')
        .where('teacherId', '==', linkedUser.id)
        .where('status', 'in', ['pending', 'assigned_work', 'pending_teacher'])
        .get();

      if (pendingSnap.empty) {
        await sendLineReply(event.replyToken, [{
          type: 'text',
          text: `🎉 คุณครู${linkedUser.name || ''} ไม่มีคำร้องค้างตรวจในขณะนี้ครับ!`
        }]);
        return;
      }

      // สร้าง Flex Carousel แสดงคำร้องค้าง (สูงสุด 5 รายการ) พร้อมปุ่มอนุมัติ
      const bubbles = [];
      let count = 0;
      pendingSnap.forEach(doc => {
        if (count >= 5) return;
        const r = { id: doc.id, ...doc.data() };
        const magicUrl = generateMagicLink(linkedUser.id, r.id);
        const card = buildTeacherFlex(r, magicUrl);
        bubbles.push(card);
        count++;
      });

      await sendLineReply(event.replyToken, [
        { type: 'text', text: `📋 พบคำร้องรอคุณครูตรวจ ${pendingSnap.size} รายการ (สามารถกดปุ่มอนุมัติเกรดได้เลยที่การ์ดด้านล่างนี้ครับ):` },
        { type: 'flex', altText: 'รายการคำร้องค้าง', contents: { type: 'carousel', contents: bubbles } }
      ]);
      return;
    }

    // E: เช็คสถานะเกรด (สำหรับนักเรียน)
    if (text === 'เช็คเกรด' || text === 'สถานะ' || text === 'เช็คสถานะ') {
      if (!linkedUser || linkedUser.role !== 'student') {
        await sendLineReply(event.replyToken, [{
          type: 'text',
          text: '💡 กรุณาผูกบัญชีนักเรียนก่อน โดยพิมพ์:\n"นักเรียน [รหัส 5 หลัก] [PIN]"\nเช่น "นักเรียน 12345 1234" หรือพิมพ์ "นักเรียน 12345" แล้วรอระบบถาม PIN ครับ'
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
        pending_teacher: '🟡 รอครูตรวจสอบ',
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
        if (r.assignmentDetails) statusMsg += `\n  (งานที่สั่ง: ${r.assignmentDetails})`;
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
        text: `📱 วิธีผูกบัญชีกับ UTP Smart\n\n🟢 สำหรับคุณครู (ปลอดภัยด้วย PIN):\nพิมพ์: ครู [ชื่อ] [PIN 4 หลัก]\nตัวอย่าง: ครู ศิรชัช 2108\n\n🔵 สำหรับนักเรียน (PDPA ป้องกันแอบดูเกรด):\nพิมพ์: นักเรียน [รหัส 5 หลัก] [PIN 4 หลัก]\nตัวอย่าง: นักเรียน 12345 1234\n(หรือพิมพ์ "นักเรียน 12345" แล้วรอระบบถาม PIN ครับ)\n\nเมื่อผูกแล้ว ระบบจะแจ้งเตือนเมื่อครูอนุมัติเกรด/สั่งงาน และเช็คผลการแก้ตัวได้ตลอด 24 ชม. ครับ!`
      }]);
      return;
    }

    // G: เมนูหลัก / Help
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

    // สร้าง Magic Link เฉพาะของครูคนนี้ พร้อมเจาะจง request ID
    const magicUrl = generateMagicLink(teacherId, requestId || reqData.id);
    const flex = buildTeacherFlex(reqData, magicUrl);
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
    version: '3.0.0',
    school: 'โรงเรียนอุเทนพัฒนา',
    time: new Date().toISOString()
  });
});

// ── Realtime Logs for Debugging ──────────────────────────────────
app.get('/logs', (req, res) => {
  res.json({
    count: recentLogs.length,
    firebaseConnected: !!db,
    lineTokenSet: !!LINE_TOKEN,
    logs: recentLogs
  });
});

// ── Start Server ─────────────────────────────────────────────────
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log('🚀 UTP Smart LINE Bot & Notifier v3.0 running on port ' + PORT);
  console.log('✅ LINE Token configured:', !!LINE_TOKEN);
  console.log('✅ Base URL:', BASE_URL);
});
