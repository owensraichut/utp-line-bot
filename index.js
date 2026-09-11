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
const nodemailer = require('nodemailer');

const app = express();
app.use(express.json());

// ── CORS Middleware (Allow Web App Access) ───────────────────────
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── Email Transporter Setup (Gmail SMTP / Custom SMTP) ───────────
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const SMTP_HOST = process.env.SMTP_HOST || 'smtp.gmail.com';
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '465');

let mailTransporter = null;
if (SMTP_USER && SMTP_PASS) {
  mailTransporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS,
    },
  });
  console.log(`📧 Mail transporter ready for: ${SMTP_USER}`);
} else {
  console.log('ℹ️ SMTP credentials not set. Running email in sandbox/preview mode.');
}

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
const unknownMsgCooldown = new Map();     // userId -> lastReplyTimestamp (Anti-Spam Throttling)

// ── Helper: สร้าง Magic Link (One-Tap Auto Login) ───────────────
function generateAdminMagicLink(role = 'super', staffId = '') {
  const timestamp = Date.now();
  const aid = role === 'super' ? 'super' : staffId;
  const raw = `${WEBHOOK_SECRET}:${aid}:${timestamp}`;
  const sig = crypto.createHash('sha256').update(raw).digest('hex');
  return `${BASE_URL}/?page=admin-verify&aid=${encodeURIComponent(aid)}&t=${timestamp}&sig=${sig}`;
}

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

// ── Flex Card: เมนูหลัก (Main Menu - Multi-Role Support) ──────────────────────
function buildMainMenuFlex(userId, userState = {}) {
  const { linkedTeacher, linkedStudent, linkedStaff, isSuperAdmin } = userState;

  let roleBadges = [];
  if (linkedTeacher) roleBadges.push(`🟢 ครู: ${linkedTeacher.name}`);
  if (isSuperAdmin) roleBadges.push('🛡️ Super Admin');
  if (linkedStaff) roleBadges.push(`👤 จนท. ${linkedStaff.name}`);
  if (linkedStudent) roleBadges.push(`🔵 นักเรียน: ${linkedStudent.name}`);

  let statusText = roleBadges.length > 0 ? roleBadges.join(' | ') : 'ยังไม่ได้ผูกบัญชี';
  let statusColor = roleBadges.length > 0 ? '#0B6623' : '#E65100';

  const menuButtons = [];

  // Teacher actions
  if (linkedTeacher) {
    menuButtons.push({
      type: 'button', style: 'primary', color: '#0B6623', height: 'sm',
      action: { type: 'message', label: '📋 ตรวจคำร้องค้าง (วิชาที่สอน)', text: 'คำร้องค้าง' }
    });
    menuButtons.push({
      type: 'button', style: 'secondary', height: 'sm',
      action: { type: 'uri', label: '🌐 เข้าห้องทำงานครู (Auto-Login)', uri: generateMagicLink(linkedTeacher.id) }
    });
  }

  // Admin / Staff actions
  if (isSuperAdmin || linkedStaff) {
    menuButtons.push({
      type: 'button', style: 'primary', color: '#1E293B', height: 'sm',
      action: { type: 'message', label: '📊 ดูสถิติภาพรวมโรงเรียน', text: 'สถิติ' }
    });
    menuButtons.push({
      type: 'button', style: 'primary', color: '#2563EB', height: 'sm',
      action: { type: 'message', label: '🔵 รายการรอวัดผลดำเนินการ', text: 'รอวัดผล' }
    });
    menuButtons.push({
      type: 'button', style: 'secondary', height: 'sm',
      action: {
        type: 'uri',
        label: '🛠️ เข้า Dashboard แอดมิน (Auto-Login)',
        uri: isSuperAdmin ? generateAdminMagicLink('super') : generateAdminMagicLink('staff', linkedStaff?.id || '')
      }
    });
  }

  // Student actions
  if (linkedStudent) {
    menuButtons.push({
      type: 'button', style: 'primary', color: '#1976D2', height: 'sm',
      action: { type: 'message', label: '📊 เช็คผลการเรียน (นักเรียน)', text: 'เช็คเกรด' }
    });
  }

  // Fallback if not linked
  if (!linkedTeacher && !isSuperAdmin && !linkedStaff && !linkedStudent) {
    menuButtons.push({
      type: 'button', style: 'primary', color: '#0B6623', height: 'sm',
      action: { type: 'message', label: '🟢 วิธีผูกบัญชีครู', text: 'วิธีผูกบัญชี' }
    });
    menuButtons.push({
      type: 'button', style: 'secondary', height: 'sm',
      action: { type: 'message', label: '🔵 วิธีผูกบัญชีนักเรียน', text: 'วิธีผูกบัญชี' }
    });
    menuButtons.push({
      type: 'button', style: 'secondary', height: 'sm',
      action: { type: 'message', label: '🛡️ วิธีผูกบัญชีแอดมิน/วัดผล', text: 'วิธีผูกบัญชี' }
    });
  } else {
    menuButtons.push({
      type: 'button', style: 'link', height: 'sm',
      action: { type: 'message', label: '📖 ดูคำสั่งทั้งหมด', text: 'วิธีผูกบัญชี' }
    });
  }

  return {
    type: 'bubble', size: 'mega',
    header: {
      type: 'box', layout: 'vertical', backgroundColor: isSuperAdmin ? '#BE123C' : (linkedTeacher ? '#0B6623' : '#1E293B'), paddingAll: '16px',
      contents: [
        { type: 'text', text: '🏫 UTP Smart — อุเทนพัฒนา', color: '#FFFFFF', size: 'lg', weight: 'bold' },
        { type: 'text', text: 'ระบบแก้ไขผลการเรียนดิจิทัล (0, ร, มส)', color: '#E8F5E9', size: 'xs' }
      ]
    },
    body: {
      type: 'box', layout: 'vertical', spacing: 'md', paddingAll: '16px',
      contents: [
        {
          type: 'box', layout: 'vertical', backgroundColor: '#F8FAFC', paddingAll: '10px', cornerRadius: 'md',
          contents: [
            { type: 'text', text: '📌 สถานะบัญชีของคุณ (Multi-Role Portal)', size: 'xs', color: '#64748B' },
            { type: 'text', text: statusText, size: 'sm', weight: 'bold', color: statusColor, wrap: true },
            { type: 'text', text: `ID: ${userId.substring(0, 8)}...${userId.substring(userId.length - 4)}`, size: 'xxs', color: '#94A3B8' }
          ]
        },
        {
          type: 'box', layout: 'vertical', spacing: 'sm',
          contents: menuButtons
        }
      ]
    },
    footer: {
      type: 'box', layout: 'vertical', paddingAll: '10px',
      contents: [
        { type: 'text', text: 'พิมพ์ "สถิติ", "รอวัดผล", "คำร้องค้าง" หรือ "เช็คเกรด" เพื่อใช้งานด่วน', size: 'xxs', color: '#888888', align: 'center' }
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
              { type: 'text', text: 'พิมพ์ "ครู [ชื่อ] [PIN]" เช่น: ครู สมชาย 1234 เพื่อรับแจ้งเตือนและอนุมัติเกรดในแชต', size: 'xs', wrap: true },
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

        // แจ้งเตือนฝ่ายวัดผลและผู้ดูแลระบบว่ามีเกรดรอลงทะเบียน
        try {
          const adminDoc = await db.collection('system_config').doc('admin').get();
          const adminUsers = (adminDoc.exists && adminDoc.data()?.lineUserIds) || (adminDoc.exists && adminDoc.data()?.lineUserId ? [adminDoc.data().lineUserId] : []);
          const staffSnap = await db.collection('admin_users').where('isActive', '==', true).get();
          const staffUsers = [];
          staffSnap.forEach(d => { if (d.data().lineUserId) staffUsers.push(d.data().lineUserId); });
          const allStaff = Array.from(new Set([...adminUsers, ...staffUsers]));
          for (const sId of allStaff) {
            if (sId === userId) continue;
            await sendLineFlexMessage(sId, `📢 ฝ่ายวัดผล: ครู ${teacherName} อนุมัติเกรด ${reqData.subjectCode} (${reqData.studentName}) แล้ว!`, {
              type: 'bubble', size: 'kilo',
              header: { type: 'box', layout: 'vertical', backgroundColor: '#2563EB', paddingAll: '12px', contents: [{ type: 'text', text: '📢 มีคำร้องรอฝ่ายวัดผลดำเนินการ', color: '#FFFFFF', weight: 'bold', size: 'sm' }] },
              body: {
                type: 'box', layout: 'vertical', spacing: 'xs', paddingAll: '12px',
                contents: [
                  { type: 'text', text: `👤 ${reqData.studentName}`, weight: 'bold', size: 'sm' },
                  { type: 'text', text: `🆔 รหัส: ${reqData.studentId || '-'} • ชั้น ม.${reqData.studentClass || '-'}`, size: 'xs', color: '#2563EB', weight: 'bold' },
                  { type: 'text', text: `วิชา ${reqData.subjectCode} • ผู้ตรวจ: ${teacherName}`, size: 'xs', color: '#4B5563' },
                  { type: 'text', text: `เกรดที่อนุมัติ: ${grade}`, size: 'sm', weight: 'bold', color: '#2563EB' }
                ]
              },
              footer: {
                type: 'box', layout: 'vertical', paddingAll: '10px',
                contents: [
                  { type: 'button', style: 'primary', color: '#2563EB', height: 'sm', action: { type: 'message', label: '🔵 ตรวจสอบงานรอวัดผล', text: 'รอวัดผล' } }
                ]
              }
            });
          }
        } catch(aErr) { console.warn('Admin notify error:', aErr.message); }

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

    // C: ฝ่ายวัดผลบันทึกเสร็จสิ้นผ่านแชต (In-Chat Completion)
    if (action === 'admin_complete') {
      const reqId = params.get('reqId');
      if (!db || !reqId) return;

      // ตรวจสอบสิทธิ์ admin / staff
      let isSuper = false;
      let staffUser = null;
      const adminDoc = await db.collection('system_config').doc('admin').get();
      if (adminDoc.exists) {
        const aData = adminDoc.data();
        const aList = aData.lineUserIds || (aData.lineUserId ? [aData.lineUserId] : []);
        if (aList.includes(userId)) isSuper = true;
      }
      const staffSnap = await db.collection('admin_users').where('lineUserId', '==', userId).where('isActive', '==', true).limit(1).get();
      if (!staffSnap.empty) staffUser = staffSnap.docs[0].data();

      if (!isSuper && !staffUser) {
        await sendLineReply(event.replyToken, [{ type: 'text', text: '⚠️ ขออภัยครับ ท่านไม่มีสิทธิ์ทำรายการนี้ (สงวนสิทธิ์สำหรับฝ่ายวัดผลและแอดมิน)' }]);
        return;
      }

      const actorName = isSuper ? 'Super Admin (ผู้ดูแลระบบ)' : (staffUser.name + ' (เจ้าหน้าที่วัดผล)');
      const actorRole = isSuper ? 'super_admin' : 'staff';

      try {
        const reqDoc = await db.collection('requests').doc(reqId).get();
        if (!reqDoc.exists) {
          await sendLineReply(event.replyToken, [{ type: 'text', text: '❌ ไม่พบข้อมูลคำร้องนี้' }]);
          return;
        }
        const reqData = reqDoc.data();
        const updatedLogs = [
          ...(reqData.auditLogs || []),
          {
            action: 'completed',
            actorName: actorName,
            actorRole: actorRole,
            details: 'ฝ่ายวัดผลบันทึกดำเนินการแก้ไขผลการเรียนเสร็จสิ้นผ่าน LINE OA (In-Chat Completion)',
            timestamp: new Date().toISOString()
          }
        ];

        await db.collection('requests').doc(reqId).update({
          status: 'completed',
          completedAt: new Date().toISOString(),
          completedByName: actorName,
          auditLogs: updatedLogs
        });

        // ส่งแจ้งเตือนนักเรียน
        try {
          const studentDoc = await db.collection('students').doc(reqData.studentId).get();
          if (studentDoc.exists && studentDoc.data().lineUserId) {
            await sendLineFlexMessage(
              studentDoc.data().lineUserId,
              `🎉 ผลการเรียนวิชา ${reqData.subjectCode} แก้ไขเสร็จสิ้นแล้ว! (เกรดใหม่: ${reqData.newGrade})`,
              {
                type: 'bubble', size: 'kilo',
                header: { type: 'box', layout: 'vertical', backgroundColor: '#059669', paddingAll: '14px', contents: [{ type: 'text', text: '🎉 แก้ไขผลการเรียนสำเร็จแล้ว!', color: '#FFFFFF', weight: 'bold', size: 'md' }] },
                body: {
                  type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '14px',
                  contents: [
                    { type: 'text', text: `👤 ${reqData.studentName}`, weight: 'bold', size: 'sm' },
                    { type: 'text', text: `วิชา: ${reqData.subjectCode} (${reqData.subjectName || '-'})`, size: 'xs', color: '#4B5563' },
                    { type: 'text', text: `เกรดเดิม: ${reqData.gradeType} ➡️ เกรดใหม่: ${reqData.newGrade}`, size: 'sm', weight: 'bold', color: '#059669' },
                    { type: 'separator', margin: 'sm' },
                    { type: 'text', text: 'ฝ่ายวัดผลได้ลงบันทึกในระบบเรียบร้อยแล้วครับ', size: 'xs', color: '#6B7280' }
                  ]
                }
              }
            );
          }
        } catch(sErr) { console.warn('Student notify error:', sErr.message); }

        await sendLineReply(event.replyToken, [{
          type: 'flex', altText: 'บันทึกเสร็จสิ้นสำเร็จ',
          contents: {
            type: 'bubble', size: 'kilo',
            header: { type: 'box', layout: 'vertical', backgroundColor: '#059669', paddingAll: '14px', contents: [{ type: 'text', text: '✅ บันทึกจบผลการเรียนเรียบร้อย!', color: '#FFFFFF', weight: 'bold', size: 'md' }] },
            body: {
              type: 'box', layout: 'vertical', spacing: 'xs', paddingAll: '14px',
              contents: [
                { type: 'text', text: `วิชา: ${reqData.subjectCode} (${reqData.studentName})`, weight: 'bold', size: 'sm' },
                { type: 'text', text: `เกรดที่ได้: ${reqData.newGrade} (แก้ไขจาก ${reqData.gradeType})`, size: 'xs', color: '#059669' },
                { type: 'text', text: `ผู้บันทึก: ${actorName}`, size: 'xs', color: '#6B7280' }
              ]
            }
          }
        }]);
        return;
      } catch(err) {
        console.error('admin_complete err:', err);
        await sendLineReply(event.replyToken, [{ type: 'text', text: 'เกิดข้อผิดพลาดในการบันทึก: ' + err.message }]);
        return;
      }
    }

    // D: ฝ่ายวัดผลปฏิเสธคำร้องผ่านแชต (In-Chat Rejection)
    if (action === 'admin_reject') {
      const reqId = params.get('reqId');
      if (!db || !reqId) return;

      let isSuper = false;
      let staffUser = null;
      const adminDoc = await db.collection('system_config').doc('admin').get();
      if (adminDoc.exists) {
        const aData = adminDoc.data();
        const aList = aData.lineUserIds || (aData.lineUserId ? [aData.lineUserId] : []);
        if (aList.includes(userId)) isSuper = true;
      }
      const staffSnap = await db.collection('admin_users').where('lineUserId', '==', userId).where('isActive', '==', true).limit(1).get();
      if (!staffSnap.empty) staffUser = staffSnap.docs[0].data();

      if (!isSuper && !staffUser) {
        await sendLineReply(event.replyToken, [{ type: 'text', text: '⚠️ ขออภัยครับ ท่านไม่มีสิทธิ์ทำรายการนี้ (สงวนสิทธิ์สำหรับฝ่ายวัดผลและแอดมิน)' }]);
        return;
      }

      const actorName = isSuper ? 'Super Admin (ผู้ดูแลระบบ)' : (staffUser.name + ' (เจ้าหน้าที่วัดผล)');
      const actorRole = isSuper ? 'super_admin' : 'staff';

      try {
        const reqDoc = await db.collection('requests').doc(reqId).get();
        if (!reqDoc.exists) {
          await sendLineReply(event.replyToken, [{ type: 'text', text: '❌ ไม่พบข้อมูลคำร้องนี้' }]);
          return;
        }
        const reqData = reqDoc.data();
        const updatedLogs = [
          ...(reqData.auditLogs || []),
          {
            action: 'rejected',
            actorName: actorName,
            actorRole: actorRole,
            details: 'ฝ่ายวัดผลปฏิเสธคำร้องผ่าน LINE OA (In-Chat Rejection)',
            timestamp: new Date().toISOString()
          }
        ];

        await db.collection('requests').doc(reqId).update({
          status: 'rejected',
          rejectedAt: new Date().toISOString(),
          adminNote: 'เจ้าหน้าที่วัดผลปฏิเสธคำร้องผ่าน LINE OA',
          auditLogs: updatedLogs
        });

        // ส่งแจ้งเตือนนักเรียน (ถ้ามี lineUserId)
        try {
          const studentDoc = await db.collection('students').doc(reqData.studentId).get();
          if (studentDoc.exists && studentDoc.data().lineUserId) {
            const studentFlex = buildStudentFlex({
              ...reqData,
              status: 'rejected'
            });
            await sendLineFlexMessage(
              studentDoc.data().lineUserId,
              `📢 คำร้องแก้ไขผลการเรียนวิชา ${reqData.subjectCode} ถูกปฏิเสธ`,
              studentFlex
            );
          }
        } catch (sErr) {
          console.warn('Notify student err:', sErr.message);
        }

        await sendLineReply(event.replyToken, [{
          type: 'text',
          text: `❌ ปฏิเสธคำร้องวิชา ${reqData.subjectCode} ของ ${reqData.studentName} (รหัส: ${reqData.studentId}) เรียบร้อยแล้วครับ`
        }]);
        return;
      } catch (err) {
        console.error('admin_reject err:', err);
        await sendLineReply(event.replyToken, [{ type: 'text', text: 'เกิดข้อผิดพลาดในการปฏิเสธคำร้อง: ' + err.message }]);
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

          if ((await effectiveTeacherPin(matchedTeacher.id)) === inputPin) {
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

          const storedPin = await studentSecret(matchedStudent.id, 'pin');
          if (!storedPin || storedPin === inputPin || session.isSetup) {
            pendingStudentPinVerification.delete(userId);

            await db.collection('students').doc(matchedStudent.id).update({
              lineUserId: userId,
              lineLinkedAt: new Date().toISOString()
            });
            if (!storedPin || session.isSetup) {
              await writeSecret('student_secrets', matchedStudent.id, { pin: inputPin });
            }

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

    // ── ตรวจสอบว่าบัญชีนี้ผูกกับใครอยู่แล้วหรือยัง (Multi-Role Support) ──
    let linkedTeacher = null;
    let linkedStudent = null;
    let linkedStaff = null;
    let isSuperAdmin = false;

    if (db) {
      // 1. ตรวจสอบครู
      const teacherMatch = await db.collection('teachers').where('lineUserId', '==', userId).limit(1).get();
      if (!teacherMatch.empty) {
        linkedTeacher = { id: teacherMatch.docs[0].id, role: 'teacher', ...teacherMatch.docs[0].data() };
      }
      // 2. ตรวจสอบนักเรียน (เรียงลำดับเอาบัญชีที่ผูกล่าสุด)
      const studentMatch = await db.collection('students').where('lineUserId', '==', userId).get();
      if (!studentMatch.empty) {
        const sortedStudentDocs = studentMatch.docs.sort((a, b) => (b.data().lineLinkedAt || '').localeCompare(a.data().lineLinkedAt || ''));
        linkedStudent = { id: sortedStudentDocs[0].id, role: 'student', ...sortedStudentDocs[0].data() };
      }
      // 3. ตรวจสอบเจ้าหน้าที่วัดผล
      const staffMatch = await db.collection('admin_users').where('lineUserId', '==', userId).where('isActive', '==', true).limit(1).get();
      if (!staffMatch.empty) {
        linkedStaff = { id: staffMatch.docs[0].id, role: 'staff', ...staffMatch.docs[0].data() };
      }
      // 4. ตรวจสอบ Super Admin
      const adminDoc = await db.collection('system_config').doc('admin').get();
      if (adminDoc.exists) {
        const aData = adminDoc.data();
        const aUsers = aData.lineUserIds || (aData.lineUserId ? [aData.lineUserId] : []);
        if (aUsers.includes(userId)) {
          isSuperAdmin = true;
        }
      }
    }

    const isAdminUser = isSuperAdmin || !!linkedStaff;
    const userState = { linkedTeacher, linkedStudent, linkedStaff, isSuperAdmin, isAdminUser };
    const linkedUser = linkedTeacher || linkedStudent || (isSuperAdmin ? { role: 'admin', name: 'Super Admin' } : (linkedStaff ? { role: 'staff', name: linkedStaff.name } : null));

    // ── Command: ผูกบัญชี Super Admin ──
    // รูปแบบ: "แอดมิน [password]" หรือ "admin [password]"
    if (rawText.startsWith('แอดมิน') || rawText.startsWith('admin') || rawText.startsWith('ผู้ดูแลระบบ')) {
      const pass = rawText.replace(/^(แอดมิน|admin|ผู้ดูแลระบบ)s*/i, '').trim();
      if (!pass) {
        await sendLineReply(event.replyToken, [{
          type: 'text',
          text: "🔐 กรุณาระบุรหัสผ่าน Super Admin เช่น:\n\"แอดมิน [รหัสผ่าน]\""
        }]);
        return;
      }
      if (!db) {
        await sendLineReply(event.replyToken, [{ type: 'text', text: 'ระบบฐานข้อมูลขัดข้อง กรุณาลองใหม่ภายหลัง' }]);
        return;
      }
      const adminDoc = await db.collection('system_config').doc('admin').get();
      const defaultHash = '6d5997a61f29e3755c163457a70ed8873b451f53ddc925a72254e330db6126ea';
      const currentHash = adminDoc.exists && adminDoc.data()?.passwordHash ? adminDoc.data().passwordHash : defaultHash;
      const enteredHash = crypto.createHash('sha256').update(pass).digest('hex');

      if (enteredHash === currentHash) {
        const existing = (adminDoc.exists && adminDoc.data()?.lineUserIds) || (adminDoc.exists && adminDoc.data()?.lineUserId ? [adminDoc.data().lineUserId] : []);
        const updatedUsers = Array.from(new Set([...existing, userId]));
        await db.collection('system_config').doc('admin').set({
          lineUserIds: updatedUsers,
          lineLinkedAt: new Date().toISOString()
        }, { merge: true });

        const adminFlex = {
          type: 'bubble', size: 'mega',
          header: {
            type: 'box', layout: 'vertical', backgroundColor: '#BE123C', paddingAll: '16px',
            contents: [
              { type: 'text', text: '🛡️ ยืนยันสิทธิ์ Super Admin สำเร็จ!', color: '#FFFFFF', size: 'lg', weight: 'bold' },
              { type: 'text', text: 'โรงเรียนอุเทนพัฒนา (UTP Smart)', color: '#FFE4E6', size: 'xs' }
            ]
          },
          body: {
            type: 'box', layout: 'vertical', spacing: 'md', paddingAll: '16px',
            contents: [
              { type: 'text', text: 'ยินดีต้อนรับผู้ดูแลระบบสูงสุด', size: 'md', weight: 'bold' },
              { type: 'text', text: 'ท่านได้รับสิทธิ์บริหารจัดการระบบ, ตรวจสอบสถิติทั้งโรงเรียน และอนุมัติผลการเรียนผ่าน LINE OA เรียบร้อยแล้วครับ', size: 'xs', color: '#666666', wrap: true }
            ]
          },
          footer: {
            type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '12px',
            contents: [
              { type: 'button', style: 'primary', color: '#BE123C', height: 'sm', action: { type: 'message', label: '📊 สรุปสถิติภาพรวม', text: 'สถิติ' } },
              { type: 'button', style: 'secondary', height: 'sm', action: { type: 'message', label: '🔵 รายการรอวัดผลดำเนินการ', text: 'รอวัดผล' } },
              { type: 'button', style: 'link', height: 'sm', action: { type: 'uri', label: '🌐 เปิด Dashboard แอดมิน (Auto-Login)', uri: generateAdminMagicLink('super') } }
            ]
          }
        };
        await sendLineReply(event.replyToken, [{ type: 'flex', altText: 'ผูกบัญชี Super Admin สำเร็จ', contents: adminFlex }]);
        return;
      } else {
        await sendLineReply(event.replyToken, [{ type: 'text', text: '❌ รหัสผ่าน Super Admin ไม่ถูกต้อง กรุณาลองใหม่อีกครั้งครับ' }]);
        return;
      }
    }

    // ── Command: ผูกบัญชีเจ้าหน้าที่วัดผล ──
    // รูปแบบ: "เจ้าหน้าที่ [username] [password]" หรือ "จนท [username] [password]"
    if (rawText.startsWith('เจ้าหน้าที่') || rawText.startsWith('จนท') || rawText.startsWith('วัดผล')) {
      const cleaned = rawText.replace(/^(เจ้าหน้าที่|จนท|วัดผล)s*/, '').trim();
      const parts = cleaned.split(/\s+/);
      const uname = parts[0] ? parts[0].toLowerCase() : '';
      const pass = parts[1] || '';

      if (!uname || !pass) {
        await sendLineReply(event.replyToken, [{
          type: 'text',
          text: "👤 กรุณาระบุ Username และรหัสผ่าน เช่น:\n\"เจ้าหน้าที่ somchai 123456\""
        }]);
        return;
      }
      if (!db) {
        await sendLineReply(event.replyToken, [{ type: 'text', text: 'ระบบฐานข้อมูลขัดข้อง กรุณาลองใหม่ภายหลัง' }]);
        return;
      }
      const snap = await db.collection('admin_users').where('username', '==', uname).where('isActive', '==', true).limit(1).get();
      if (snap.empty) {
        await sendLineReply(event.replyToken, [{ type: 'text', text: `❌ ไม่พบบัญชีเจ้าหน้าที่ Username "${uname}" ที่เปิดใช้งานในระบบ` }]);
        return;
      }
      const staffData = snap.docs[0].data();
      const staffId = snap.docs[0].id;
      const enteredHash = crypto.createHash('sha256').update(pass).digest('hex');

      if (enteredHash === staffData.passwordHash) {
        await db.collection('admin_users').doc(staffId).update({
          lineUserId: userId,
          lineLinkedAt: new Date().toISOString()
        });

        const staffFlex = {
          type: 'bubble', size: 'mega',
          header: {
            type: 'box', layout: 'vertical', backgroundColor: '#4338CA', paddingAll: '16px',
            contents: [
              { type: 'text', text: '👤 ยืนยันสิทธิ์เจ้าหน้าที่สำเร็จ!', color: '#FFFFFF', size: 'lg', weight: 'bold' },
              { type: 'text', text: 'โรงเรียนอุเทนพัฒนา (UTP Smart)', color: '#E0E7FF', size: 'xs' }
            ]
          },
          body: {
            type: 'box', layout: 'vertical', spacing: 'md', paddingAll: '16px',
            contents: [
              { type: 'text', text: `ยินดีต้อนรับ ${staffData.name}`, size: 'md', weight: 'bold' },
              { type: 'text', text: `Username: @${staffData.username} (เจ้าหน้าที่วัดผล)`, size: 'xs', color: '#666666' },
              { type: 'text', text: 'ท่านสามารถตรวจสอบคำร้องและอนุมัติจบผลการเรียนผ่าน LINE OA ได้ทันทีครับ', size: 'xs', color: '#4338CA' }
            ]
          },
          footer: {
            type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '12px',
            contents: [
              { type: 'button', style: 'primary', color: '#4338CA', height: 'sm', action: { type: 'message', label: '🔵 รายการรอวัดผลดำเนินการ', text: 'รอวัดผล' } },
              { type: 'button', style: 'secondary', height: 'sm', action: { type: 'message', label: '📊 สรุปสถิติภาพรวม', text: 'สถิติ' } },
              { type: 'button', style: 'link', height: 'sm', action: { type: 'uri', label: '🌐 เปิดระบบวัดผล (Auto-Login)', uri: generateAdminMagicLink('staff', staffId) } }
            ]
          }
        };
        await sendLineReply(event.replyToken, [{ type: 'flex', altText: 'ผูกบัญชีเจ้าหน้าที่สำเร็จ', contents: staffFlex }]);
        return;
      } else {
        await sendLineReply(event.replyToken, [{ type: 'text', text: '❌ รหัสผ่านของเจ้าหน้าที่ไม่ถูกต้อง กรุณาลองใหม่อีกครั้งครับ' }]);
        return;
      }
    }

    // ── Command: ดูสถิติภาพรวมโรงเรียน ──
    if (text === 'สถิติ' || text === 'สรุป' || text === 'ภาพรวม' || text === 'รายงาน') {
      if (!isAdminUser) {
        await sendLineReply(event.replyToken, [{
          type: 'text',
          text: '⚠️ ข้อมูลสถิติสงวนสิทธิ์สำหรับฝ่ายวัดผลและผู้ดูแลระบบเท่านั้นครับ\nกรุณาผูกบัญชีด้วยคำสั่ง "แอดมิน [รหัสผ่าน]" หรือ "เจ้าหน้าที่ [username] [รหัสผ่าน]"'
        }]);
        return;
      }
      if (!db) return;
      const reqSnap = await db.collection('requests').get();
      const total = reqSnap.size;
      let pendingTeacher = 0;
      let assignedWork = 0;
      let teacherApproved = 0;
      let completed = 0;
      let rejected = 0;

      reqSnap.forEach(d => {
        const st = d.data().status;
        if (st === 'pending' || st === 'pending_teacher') pendingTeacher++;
        else if (st === 'assigned_work') assignedWork++;
        else if (st === 'teacher_approved') teacherApproved++;
        else if (st === 'completed') completed++;
        else if (st === 'rejected') rejected++;
      });
      const percent = total > 0 ? Math.round((completed / total) * 100) : 0;

      const statFlex = {
        type: 'bubble', size: 'mega',
        header: {
          type: 'box', layout: 'vertical', backgroundColor: '#1E293B', paddingAll: '16px',
          contents: [
            { type: 'text', text: '📊 สรุปสถิติผลการเรียนดิจิทัล', color: '#FFFFFF', size: 'lg', weight: 'bold' },
            { type: 'text', text: `โรงเรียนอุเทนพัฒนา • คำร้องทั้งหมด ${total} รายการ`, color: '#94A3B8', size: 'xs' }
          ]
        },
        body: {
          type: 'box', layout: 'vertical', spacing: 'md', paddingAll: '16px',
          contents: [
            {
              type: 'box', layout: 'vertical', backgroundColor: '#F8FAFC', paddingAll: '12px', cornerRadius: 'md', spacing: 'sm',
              contents: [
                { type: 'box', layout: 'horizontal', contents: [{ type: 'text', text: '🟡 รอครูสั่งงาน:', size: 'sm', color: '#475569', flex: 3 }, { type: 'text', text: `${pendingTeacher} รายการ`, size: 'sm', weight: 'bold', color: '#D97706', align: 'end', flex: 2 }] },
                { type: 'box', layout: 'horizontal', contents: [{ type: 'text', text: '🟣 รอนักเรียนส่งงาน:', size: 'sm', color: '#475569', flex: 3 }, { type: 'text', text: `${assignedWork} รายการ`, size: 'sm', weight: 'bold', color: '#7C3AED', align: 'end', flex: 2 }] },
                { type: 'box', layout: 'horizontal', contents: [{ type: 'text', text: '🔵 รอฝ่ายวัดผลดำเนินการ:', size: 'sm', color: '#475569', flex: 3 }, { type: 'text', text: `${teacherApproved} รายการ`, size: 'sm', weight: 'bold', color: '#2563EB', align: 'end', flex: 2 }] },
                { type: 'box', layout: 'horizontal', contents: [{ type: 'text', text: '🟢 ดำเนินการเสร็จสิ้น:', size: 'sm', color: '#475569', flex: 3 }, { type: 'text', text: `${completed} รายการ`, size: 'sm', weight: 'bold', color: '#059669', align: 'end', flex: 2 }] },
                { type: 'box', layout: 'horizontal', contents: [{ type: 'text', text: '🔴 ปฏิเสธคำร้อง:', size: 'sm', color: '#475569', flex: 3 }, { type: 'text', text: `${rejected} รายการ`, size: 'sm', weight: 'bold', color: '#DC2626', align: 'end', flex: 2 }] }
              ]
            },
            {
              type: 'box', layout: 'vertical', backgroundColor: '#ECFDF5', paddingAll: '10px', cornerRadius: 'md',
              contents: [
                { type: 'text', text: `🎉 อัตราการแก้ไขสำเร็จ: ${percent}%`, size: 'sm', weight: 'bold', color: '#047857', align: 'center' }
              ]
            }
          ]
        },
        footer: {
          type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '12px',
          contents: [
            ...(teacherApproved > 0 ? [{
              type: 'button', style: 'primary', color: '#2563EB', height: 'sm',
              action: { type: 'message', label: `🔵 จัดการงานรอวัดผล (${teacherApproved})`, text: 'รอวัดผล' }
            }] : []),
            {
              type: 'button', style: 'secondary', height: 'sm',
              action: {
                type: 'uri',
                label: '🌐 เข้าดู Dashboard แอดมินเต็ม',
                uri: isSuperAdmin ? generateAdminMagicLink('super') : generateAdminMagicLink('staff', linkedStaff?.id || '')
              }
            }
          ]
        }
      };
      await sendLineReply(event.replyToken, [{ type: 'flex', altText: 'สรุปสถิติภาพรวม', contents: statFlex }]);
      return;
    }

    // ── Command: ดูคำร้องรอฝ่ายวัดผลดำเนินการ ──
    if (text === 'รอวัดผล' || text === 'งานวัดผล' || text === 'ฝ่ายวัดผล') {
      if (!isAdminUser) {
        await sendLineReply(event.replyToken, [{
          type: 'text',
          text: '⚠️ เมนูนี้สงวนสิทธิ์สำหรับฝ่ายวัดผลและผู้ดูแลระบบเท่านั้นครับ'
        }]);
        return;
      }
      if (!db) return;
      const snap = await db.collection('requests').where('status', '==', 'teacher_approved').get();
      if (snap.empty) {
        await sendLineReply(event.replyToken, [{
          type: 'text',
          text: '🎉 ไม่มีคำร้องค้างของฝ่ายวัดผลในขณะนี้ครับ! (ครูยังไม่มีการส่งเกรดใหม่ที่รอลงบันทึก)'
        }]);
        return;
      }

      const bubbles = [];
      let count = 0;
      snap.forEach(doc => {
        if (count >= 5) return;
        const r = { id: doc.id, ...doc.data() };
        bubbles.push({
          type: 'bubble', size: 'kilo',
          header: {
            type: 'box', layout: 'vertical', backgroundColor: '#2563EB', paddingAll: '12px',
            contents: [
              { type: 'text', text: '🔵 รอฝ่ายวัดผลบันทึกผล', color: '#FFFFFF', weight: 'bold', size: 'sm' },
              { type: 'text', text: `วิชา ${r.subjectCode || '-'} • เกรดเดิม ${r.gradeType || '-'}`, color: '#DBEAFE', size: 'xxs' }
            ]
          },
          body: {
            type: 'box', layout: 'vertical', spacing: 'xs', paddingAll: '12px',
            contents: [
              { type: 'text', text: `👤 ${r.studentName || '-'}`, weight: 'bold', size: 'sm' },
              {
                type: 'box', layout: 'horizontal', margin: 'xs',
                contents: [
                  { type: 'text', text: `🆔 รหัส: ${r.studentId || '-'}`, size: 'xs', color: '#2563EB', weight: 'bold', flex: 1 },
                  { type: 'text', text: `ชั้น ม.${r.studentClass || '-'}${r.studentNo ? ' (เลขที่ ' + r.studentNo + ')' : ''}`, size: 'xs', color: '#666666', align: 'end', flex: 1 }
                ]
              },
              { type: 'text', text: `ครูผู้ตรวจ: ${r.teacherName || '-'}`, size: 'xs', color: '#555555' },
              { type: 'separator', margin: 'xs' },
              {
                type: 'box', layout: 'horizontal', margin: 'xs',
                contents: [
                  { type: 'text', text: 'ผลการเรียนใหม่:', size: 'xs', color: '#666666' },
                  { type: 'text', text: `เกรด ${r.newGrade || '-'}`, size: 'sm', weight: 'bold', color: '#059669', align: 'end' }
                ]
              }
            ]
          },
          footer: {
            type: 'box', layout: 'vertical', spacing: 'xs', paddingAll: '10px',
            contents: [
              {
                type: 'button', style: 'primary', color: '#059669', height: 'sm',
                action: {
                  type: 'postback',
                  label: '✅ บันทึกเสร็จสิ้น (จบงาน)',
                  data: `action=admin_complete&reqId=${r.id}`
                }
              },
              {
                type: 'button', style: 'secondary', color: '#DC2626', height: 'sm',
                action: {
                  type: 'postback',
                  label: '❌ ปฏิเสธคำร้องนี้',
                  data: `action=admin_reject&reqId=${r.id}`,
                  displayText: `ปฏิเสธคำร้องวิชา ${r.subjectCode}`
                }
              },
              {
                type: 'button', style: 'link', height: 'sm',
                action: {
                  type: 'uri',
                  label: '🌐 เปิดดูในระบบ',
                  uri: isSuperAdmin ? generateAdminMagicLink('super') : generateAdminMagicLink('staff', linkedStaff?.id || '')
                }
              }
            ]
          }
        });
        count++;
      });

      await sendLineReply(event.replyToken, [
        { type: 'text', text: `📋 พบคำร้องรอฝ่ายวัดผลดำเนินการ ${snap.size} รายการ (สามารถกดปุ่ม [✅ บันทึกเสร็จสิ้น] ได้เลยที่การ์ดด้านล่างครับ):` },
        { type: 'flex', altText: 'รายการรอฝ่ายวัดผล', contents: { type: 'carousel', contents: bubbles } }
      ]);
      return;
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
    // รูปแบบ 1: "ครู สมชาย 1234"
    // รูปแบบ 2: "ครู สมชาย" -> แล้วบอทถาม PIN
    if (rawText.startsWith('ครู') || rawText.startsWith('ผูกบัญชีครู') || rawText.startsWith('ลงทะเบียนครู') || rawText.startsWith('อาจารย์')) {
      const cleaned = rawText.replace(/^(ครู|ผูกบัญชีครู|ลงทะเบียนครู|อาจารย์)\s*/, '').trim();
      
      // ดึงรหัส PIN ออกมาหากพิมพ์มาด้วย เช่น "สมชาย 1234"
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
          text: 'กรุณาระบุชื่อของคุณครูด้วยครับ เช่น:\n"ครู สมชาย 1234" หรือ "ครู สมศรี"'
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

      // กรณีครูพิมพ์ PIN มาพร้อมกันในคำสั่งเดียว เช่น "ครู สมชาย 1234"
      if (inlinePin) {
        if ((await effectiveTeacherPin(matchedTeacher.id)) === inlinePin) {
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

      const knownStudentPin = await studentSecret(matchedStudent.id, 'pin');

      // กรณีที่ 1: นักเรียนพิมพ์ PIN มาพร้อมกันในคำสั่งเดียว เช่น "นักเรียน 12345 1234"
      if (inlinePin) {
        if (!knownStudentPin || knownStudentPin === inlinePin) {
          await db.collection('students').doc(matchedStudent.id).update({
            lineUserId: userId,
            lineLinkedAt: new Date().toISOString()
          });
          if (!knownStudentPin) {
            await writeSecret('student_secrets', matchedStudent.id, { pin: inlinePin });
          }
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
      if (knownStudentPin) {
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
      if (!linkedTeacher) {
        await sendLineReply(event.replyToken, [{
          type: 'text',
          text: '⚠️ ท่านยังไม่ได้ผูกบัญชีครู กรุณาพิมพ์:\n"ครู [ชื่อ] [PIN]"\nเช่น "ครู สมชาย 1234" เพื่อยืนยันตัวตนก่อนครับ'
        }]);
        return;
      }

      if (!db) return;
      const pendingSnap = await db.collection('requests')
        .where('teacherId', '==', linkedTeacher.id)
        .where('status', 'in', ['pending', 'assigned_work', 'pending_teacher'])
        .get();

      if (pendingSnap.empty) {
        await sendLineReply(event.replyToken, [{
          type: 'text',
          text: `🎉 คุณครู${linkedTeacher.name || ''} ไม่มีคำร้องค้างตรวจในขณะนี้ครับ!`
        }]);
        return;
      }

      // สร้าง Flex Carousel แสดงคำร้องค้าง (สูงสุด 5 รายการ) พร้อมปุ่มอนุมัติ
      const bubbles = [];
      let count = 0;
      pendingSnap.forEach(doc => {
        if (count >= 5) return;
        const r = { id: doc.id, ...doc.data() };
        const magicUrl = generateMagicLink(linkedTeacher.id, r.id);
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
    if (text === 'เช็คเกรด' || text === 'สถานะ' || text === 'เช็คสถานะ' || text === 'ผลการเรียน' || text === 'ดูเกรด' || text === 'เกรด') {
      if (!linkedStudent) {
        await sendLineReply(event.replyToken, [{
          type: 'text',
          text: '💡 กรุณาผูกบัญชีนักเรียนก่อน โดยพิมพ์:\n"นักเรียน [รหัส 5 หลัก] [PIN]"\nเช่น "นักเรียน 12345 1234" หรือพิมพ์ "นักเรียน 12345" แล้วรอระบบถาม PIN ครับ'
        }]);
        return;
      }

      if (!db) return;
      const sId = linkedStudent.studentId || linkedStudent.id;
      let reqSnap = await db.collection('requests')
        .where('studentId', '==', sId)
        .get();

      if (reqSnap.empty && linkedStudent.id && linkedStudent.id !== sId) {
        reqSnap = await db.collection('requests')
          .where('studentId', '==', linkedStudent.id)
          .get();
      }

      if (reqSnap.empty) {
        await sendLineReply(event.replyToken, [{
          type: 'text',
          text: `น้อง ${linkedStudent.name} ยังไม่มีประวัติการยื่นคำร้องแก้ผลการเรียนในระบบครับ\n(หรืออาจยังไม่ได้ส่งคำร้องแก้ 0, ร, มส เข้ามาครับ)`
        }, {
          type: 'flex', altText: 'ยื่นคำร้องแก้ผลการเรียน',
          contents: {
            type: 'bubble', size: 'kilo',
            body: {
              type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '14px',
              contents: [
                { type: 'text', text: `👤 ${linkedStudent.name} (รหัส ${sId})`, weight: 'bold', size: 'sm' },
                { type: 'text', text: 'หากมีวิชาที่ติด 0, ร, มส สามารถคลิกเข้าสู่ระบบเพื่อยื่นคำร้องได้เลยครับ:', size: 'xs', color: '#666666' },
                { type: 'button', style: 'primary', color: '#1976D2', height: 'sm', action: { type: 'uri', label: '📝 ยื่นคำร้องผ่านเว็บ', uri: BASE_URL } }
              ]
            }
          }
        }]);
        return;
      }

      const statusMap = {
        pending: '🟡 รอครูตรวจสอบ/สั่งงาน',
        pending_teacher: '🟡 รอครูตรวจสอบ/สั่งงาน',
        assigned_work: '🟣 ครูสั่งงานแล้ว (ส่งงานด่วน)',
        teacher_approved: '🔵 ครูอนุมัติแล้ว (รอวัดผล)',
        completed: '🟢 แก้ไขสำเร็จเรียบร้อย',
        rejected: '🔴 คำร้องถูกปฏิเสธ'
      };

      let statusMsg = `📊 ประวัติคำร้องของ ${linkedStudent.name} (${reqSnap.size} รายการ):\n`;
      reqSnap.forEach(doc => {
        const r = doc.data();
        const st = statusMap[r.status] || r.status;
        statusMsg += `\n• ${r.subjectCode || '-'} ${r.subjectName ? '(' + r.subjectName + ')' : ''} [${r.gradeType || '-'}] : ${st}`;
        if (r.newGrade) statusMsg += ` ➡️ เกรดใหม่: ${r.newGrade}`;
        if (r.assignmentDetails) statusMsg += `\n  📝 งาน: ${r.assignmentDetails}`;
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
        text: `📱 วิธีผูกบัญชีกับ UTP Smart\n\n🟢 สำหรับคุณครู (ปลอดภัยด้วย PIN):\nพิมพ์: ครู [ชื่อ] [PIN 4 หลัก]\nตัวอย่าง: ครู สมชาย 1234\n\n🔵 สำหรับนักเรียน (PDPA ป้องกันแอบดูเกรด):\nพิมพ์: นักเรียน [รหัส 5 หลัก] [PIN 4 หลัก]\nตัวอย่าง: นักเรียน 12345 1234\n(หรือพิมพ์ "นักเรียน 12345" แล้วรอระบบถาม PIN ครับ)\n\nเมื่อผูกแล้ว ระบบจะแจ้งเตือนเมื่อครูอนุมัติเกรด/สั่งงาน และเช็คผลการแก้ตัวได้ตลอด 24 ชม. ครับ!`
      }]);
      return;
    }

    // G: เมนูหลัก / Help / Anti-Spam Throttling
    const lower = text.toLowerCase().trim();
    const isMenuKeyword = ['เมนู', 'menu', 'ช่วยเหลือ', 'help', 'สอบถาม', 'เริ่ม', 'สวัสดี', 'hello', 'hi', 'คำสั่ง', 'บอท', 'bot'].includes(lower);

    if (isMenuKeyword) {
      const menuFlex = buildMainMenuFlex(userId, userState);
      await sendLineReply(event.replyToken, [{ type: 'flex', altText: 'เมนูระบบ UTP Smart', contents: menuFlex }]);
      return;
    }

    // กรณีพิมพ์ข้อความอื่นทั่วไปที่บอทไม่เข้าใจ:
    // Anti-Spam Throttling: หากเพิ่งตอบไปภายใน 15 วินาที จะเงียบ (Silent Ignore) เพื่อไม่ให้สแปมและไม่รกหน้าจอแชต
    const lastReply = unknownMsgCooldown.get(userId) || 0;
    const now = Date.now();
    if (now - lastReply < 15000) {
      // อยู่ในช่วง cooldown 15 วินาที -> เมินเฉย (ไม่ตอบกลับ ป้องกันคนพิมพ์แชตกวน หรือส่งข้อความรัวๆ)
      return;
    }
    unknownMsgCooldown.set(userId, now);

    // ตอบแจ้งสั้นๆ 1 ครั้ง พร้อมแนะนำคำว่า "เมนู"
    await sendLineReply(event.replyToken, [{
      type: 'text',
      text: '🤖 ขออภัยครับ UTP Smart เป็นระบบอัตโนมัติ ไม่เข้าใจข้อความนี้\n\n📌 หากต้องการดูคำสั่งหรือเมนูการใช้งาน พิมพ์ "เมนู" ได้ตลอด 24 ชม. ครับ'
    }]);
  }
}

// ── ตรวจผู้เรียกจาก Firebase ID token (Authorization: Bearer ...) ──
//    แทน shared secret เดิมที่เคยฝังอยู่ในหน้าเว็บ
async function callerClaims(req) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) return null;
  try {
    return await admin.auth().verifyIdToken(h.slice(7));
  } catch (e) {
    return null;
  }
}

// รับได้ทั้ง secret (เรียกจากเซิร์ฟเวอร์ด้วยกัน) และ ID token (เรียกจากหน้าเว็บ)
async function authorizeNotify(req) {
  if (req.body?.secret && req.body.secret === WEBHOOK_SECRET) return { via: 'secret' };
  const claims = await callerClaims(req);
  return claims ? { via: 'token', claims } : null;
}

// ════════════════════════════════════════════════════════════════
// ROUTE: POST /notify-teacher (เรียกจาก Web App เมื่อนักเรียนยื่นคำร้อง)
// Body: { secret, requestId, teacherId, request: {...} }
// ════════════════════════════════════════════════════════════════
app.post('/notify-teacher', async (req, res) => {
  const { requestId, teacherId, request: body } = req.body;

  const auth = await authorizeNotify(req);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });
  if (!teacherId || !body) {
    return res.status(400).json({ error: 'Missing teacherId or request data' });
  }

  try {
    if (!db) return res.status(500).json({ error: 'Firebase not connected' });

    // อ่านคำร้องจากฐานข้อมูลเอง ไม่เชื่อเนื้อหาที่หน้าเว็บส่งมา
    const reqId = requestId || body.id;
    const reqSnap = reqId ? await db.collection('requests').doc(reqId).get() : null;
    if (!reqSnap || !reqSnap.exists) return res.status(404).json({ error: 'Request not found' });
    const reqData = reqSnap.data();

    if (reqData.teacherId !== teacherId) {
      return res.status(400).json({ error: 'teacherId ไม่ตรงกับคำร้อง' });
    }
    // ผู้เรียกต้องเป็นเจ้าของคำร้อง ครูของวิชานั้น หรือแอดมิน
    if (auth.via === 'token') {
      const c = auth.claims;
      const allowed = (c.role === 'student' && c.sid === reqData.studentId)
        || (c.role === 'teacher' && c.tid === reqData.teacherId)
        || c.role === 'admin' || c.role === 'staff';
      if (!allowed) return res.status(403).json({ error: 'Forbidden' });
    }

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
  const { studentId, request: body } = req.body;

  const auth = await authorizeNotify(req);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });
  if (!studentId || !body) return res.status(400).json({ error: 'Missing studentId or request data' });

  try {
    if (!db) return res.status(500).json({ error: 'Firebase not connected' });

    // อ่านคำร้องจากฐานข้อมูลเอง ไม่เชื่อเนื้อหาที่หน้าเว็บส่งมา
    const reqSnap = body.id ? await db.collection('requests').doc(body.id).get() : null;
    if (!reqSnap || !reqSnap.exists) return res.status(404).json({ error: 'Request not found' });
    const reqData = reqSnap.data();

    if (reqData.studentId !== studentId) {
      return res.status(400).json({ error: 'studentId ไม่ตรงกับคำร้อง' });
    }
    // ผู้เรียกต้องเป็นครูของวิชานั้น หรือแอดมิน
    if (auth.via === 'token') {
      const c = auth.claims;
      const allowed = (c.role === 'teacher' && c.tid === reqData.teacherId)
        || c.role === 'admin' || c.role === 'staff';
      if (!allowed) return res.status(403).json({ error: 'Forbidden' });
    }

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

// ════════════════════════════════════════════════════════════════
// EMAIL HELPERS & TEMPLATES
// ════════════════════════════════════════════════════════════════
async function sendSystemEmail({ to, subject, htmlText }) {
  const fromName = 'โรงเรียนอุเทนพัฒนา (SGS Smart)';
  const fromAddress = SMTP_USER || 'sgs.utenpatten@gmail.com';

  if (!mailTransporter) {
    console.log(`[EMAIL SANDBOX] To: ${to} | Subject: ${subject}`);
    logEvent('EMAIL_SANDBOX', { to, subject });
    return { sent: true, mode: 'sandbox', to, subject };
  }

  try {
    const info = await mailTransporter.sendMail({
      from: `"${fromName}" <${fromAddress}>`,
      to,
      subject,
      html: htmlText,
    });
    console.log(`✅ Email sent successfully: ${info.messageId}`);
    logEvent('EMAIL_SENT', { to, subject, messageId: info.messageId });
    return { sent: true, messageId: info.messageId };
  } catch (err) {
    console.error(`❌ Failed to send email to ${to}:`, err.message);
    logEvent('EMAIL_ERROR', { to, error: err.message });
    throw err;
  }
}

function buildPinResetEmailHtml({ name, role, otp, resetUrl }) {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: 'Kanit', sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #0f172a; color: #f8fafc; margin: 0; padding: 20px; }
    .container { max-width: 540px; margin: 0 auto; background: #1e293b; border-radius: 16px; border: 1px solid #334155; overflow: hidden; }
    .header { background: linear-gradient(135deg, #064e3b, #047857); padding: 24px; text-align: center; }
    .header h1 { color: #ffffff; margin: 0; font-size: 20px; font-weight: bold; }
    .header p { color: #a7f3d0; margin: 4px 0 0 0; font-size: 13px; }
    .content { padding: 24px; line-height: 1.6; }
    .otp-box { background: #0f172a; border: 2px dashed #10b981; border-radius: 12px; padding: 18px; text-align: center; margin: 20px 0; }
    .otp-code { font-size: 34px; font-weight: 800; letter-spacing: 6px; color: #34d399; font-family: monospace; }
    .btn { display: inline-block; background: #10b981; color: #ffffff !important; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: bold; font-size: 15px; margin: 10px 0; }
    .footer { background: #0f172a; padding: 16px; text-align: center; font-size: 12px; color: #64748b; border-top: 1px solid #334155; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>🏫 โรงเรียนอุเทนพัฒนา</h1>
      <p>ระบบแก้ไขผลการเรียนดิจิทัล (SGS อุเทนพัฒนา)</p>
    </div>
    <div class="content">
      <p style="font-size: 16px; color: #e2e8f0; margin-top: 0;">เรียน <strong>${name}</strong> (${role === 'teacher' ? 'คุณครู' : 'นักเรียน'}),</p>
      <p style="color: #94a3b8; font-size: 14px;">
        ระบบได้รับคำขอตั้งค่ารหัส PIN ใหม่สำหรับเข้าสู่ระบบแก้ไขผลการเรียน กรุณานำรหัสยืนยันตัวตน (OTP) ด้านล่างนี้ไปกรอกในหน้าต่างรีเซ็ตรหัส:
      </p>
      <div class="otp-box">
        <div style="font-size: 12px; color: #94a3b8; margin-bottom: 6px;">รหัสยืนยัน OTP (หมดอายุใน 15 นาที)</div>
        <div class="otp-code">${otp}</div>
      </div>
      <div style="text-align: center; margin: 20px 0;">
        <a href="${resetUrl}" class="btn" target="_blank">🌐 หรือคลิกเพื่อเปลี่ยน PIN บนเว็บไซต์ทันที</a>
      </div>
      <p style="color: #64748b; font-size: 12px; line-height: 1.5;">
        ⚠️ หากท่านไม่ได้เป็นผู้ส่งคำขอนี้ โปรดเพิกเฉยต่ออีเมลฉบับนี้ รหัส PIN เดิมของท่านจะยังคงปลอดภัยและไม่มีการเปลี่ยนแปลงใดๆ
      </p>
    </div>
    <div class="footer">
      กลุ่มบริหารวิชาการและงานวัดผล โรงเรียนอุเทนพัฒนา<br>
      สำนักงานเขตพื้นที่การศึกษามัธยมศึกษานครพนม
    </div>
  </div>
</body>
</html>`;
}

// ════════════════════════════════════════════════════════════════
// ROUTE: POST /api/request-pin-reset (ขอรหัส OTP ทางอีเมล)
// Body: { role: 'teacher'|'student', identifier: phone|studentId, email: string }
// ════════════════════════════════════════════════════════════════
app.post('/api/request-pin-reset', async (req, res) => {
  const { role, identifier, email } = req.body;
  if (!role || !identifier || !email) {
    return res.status(400).json({ error: 'กรุณาระบุข้อมูลให้ครบถ้วน' });
  }

  try {
    if (!db) return res.status(500).json({ error: 'Firebase not connected' });

    let matchedUser = null;
    if (role === 'teacher') {
      // อีเมลอาจย้ายไป teacher_secrets แล้ว — ตรวจทั้งสองที่
      const [tSnap, sSnap] = await Promise.all([
        db.collection('teachers').get(),
        db.collection('teacher_secrets').get()
      ]);
      const secrets = {};
      sSnap.forEach(d => { secrets[d.id] = d.data(); });
      const wantedEmail = String(email).trim().toLowerCase();

      tSnap.forEach(doc => {
        const d = doc.data();
        const sec = secrets[doc.id] || {};
        const mail = String(sec.email || d.email || '').toLowerCase();
        if (doc.id === identifier || d.phone === identifier || (mail && mail === wantedEmail)) {
          matchedUser = { id: doc.id, ...d };
        }
      });
    } else {
      const docSnap = await db.collection('students').doc(identifier).get();
      if (docSnap.exists) {
        matchedUser = { id: docSnap.id, ...docSnap.data() };
      } else {
        const q = await db.collection('students').where('studentId', '==', identifier).limit(1).get();
        if (!q.empty) matchedUser = { id: q.docs[0].id, ...q.docs[0].data() };
      }
    }

    if (!matchedUser) {
      return res.status(404).json({ error: `ไม่พบข้อมูลผู้ใช้ในระบบ กรุณาตรวจสอบ${role === 'teacher' ? 'เบอร์โทรศัพท์' : 'รหัสนักเรียน'}` });
    }

    // สร้าง OTP 6 หลัก และ Reset Token
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const token = crypto.randomBytes(24).toString('hex');
    const expiresAt = Date.now() + 15 * 60 * 1000; // 15 นาที

    await db.collection('pin_resets').doc(token).set({
      token,
      otp,
      role,
      targetId: matchedUser.id,
      name: matchedUser.name || matchedUser.teacherName || 'ผู้ใช้งาน',
      email: email.trim().toLowerCase(),
      expiresAt,
      used: false,
      createdAt: new Date().toISOString()
    });

    const resetUrl = `${BASE_URL}/?page=reset-pin&token=${token}`;
    const emailHtml = buildPinResetEmailHtml({
      name: matchedUser.name || matchedUser.teacherName || 'ผู้ใช้งาน',
      role,
      otp,
      resetUrl
    });

    const emailRes = await sendSystemEmail({
      to: email.trim(),
      subject: `[UTP SGS] รหัสยืนยัน OTP สำหรับตั้งค่า PIN ใหม่ (${otp})`,
      htmlText: emailHtml
    });

    res.json({
      success: true,
      message: `ส่งรหัส OTP 6 หลักไปยัง ${email} เรียบร้อยแล้ว (รหัสมีอายุ 15 นาที)`,
      token,
      expiresAt,
      // กรณี sandbox mode แสดง OTP ให้ทดสอบได้สะดวก
      ...(emailRes.mode === 'sandbox' ? { previewOtp: otp, isSandbox: true } : {})
    });
  } catch (err) {
    console.error('request-pin-reset error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════
// ROUTE: POST /api/verify-pin-reset (ยืนยัน OTP / Token และเปลี่ยน PIN ใหม่)
// Body: { token?: string, otp?: string, identifier?: string, newPin: string }
// ════════════════════════════════════════════════════════════════
app.post('/api/verify-pin-reset', async (req, res) => {
  const { token, otp, identifier, newPin } = req.body;
  if (!newPin || !/^\d{4}$/.test(newPin)) {
    return res.status(400).json({ error: 'รหัส PIN ใหม่ต้องเป็นตัวเลข 4 หลักเท่านั้น' });
  }

  try {
    if (!db) return res.status(500).json({ error: 'Firebase not connected' });

    let resetDoc = null;
    let resetDocId = null;

    if (token) {
      const snap = await db.collection('pin_resets').doc(token).get();
      if (snap.exists) {
        resetDoc = snap.data();
        resetDocId = snap.id;
      }
    } else if (otp) {
      const q = await db.collection('pin_resets')
        .where('otp', '==', otp.trim())
        .where('used', '==', false)
        .limit(1)
        .get();
      if (!q.empty) {
        resetDoc = q.docs[0].data();
        resetDocId = q.docs[0].id;
      }
    }

    if (!resetDoc) {
      return res.status(400).json({ error: 'รหัสยืนยัน OTP หรือ Token ไม่ถูกต้อง' });
    }

    if (resetDoc.used) {
      return res.status(400).json({ error: 'รหัสยืนยันนี้ถูกใช้งานไปแล้ว กรุณาขอใหม่อีกครั้ง' });
    }

    if (Date.now() > resetDoc.expiresAt) {
      return res.status(400).json({ error: 'รหัสยืนยันนี้หมดอายุแล้ว (เกิน 15 นาที) กรุณาขอใหม่อีกครั้ง' });
    }

    // อัปเดต PIN ใน Firestore (เก็บใน *_secrets ที่หน้าเว็บอ่านไม่ได้)
    const targetSecrets = resetDoc.role === 'teacher' ? 'teacher_secrets' : 'student_secrets';
    await writeSecret(targetSecrets, resetDoc.targetId, {
      pin: newPin,
      pinUpdatedAt: new Date().toISOString()
    });

    // มาร์ก resetDoc เป็น used
    await db.collection('pin_resets').doc(resetDocId).update({
      used: true,
      usedAt: new Date().toISOString()
    });

    // บันทึก audit log
    await db.collection('auditLogs').add({
      action: 'PIN_RESET_EMAIL',
      role: resetDoc.role,
      targetId: resetDoc.targetId,
      name: resetDoc.name,
      email: resetDoc.email,
      timestamp: new Date().toISOString()
    });

    res.json({
      success: true,
      message: `เปลี่ยนรหัส PIN สำหรับ ${resetDoc.name} สำเร็จเรียบร้อยแล้ว ท่านสามารถเข้าสู่ระบบด้วยรหัส PIN ใหม่ได้ทันทีครับ`,
      role: resetDoc.role,
      targetId: resetDoc.targetId
    });
  } catch (err) {
    console.error('verify-pin-reset error:', err);
    res.status(500).json({ error: err.message });
  }
});


// ═══════════════════════════════════════════════════════════════════
//  AUTH API — ตรวจ PIN / รหัสผ่านทั้งหมดที่ฝั่งเซิร์ฟเวอร์เท่านั้น
//  หน้าเว็บไม่อ่าน PIN เองอีกต่อไป และได้ Firebase custom token กลับไป
//  เพื่อให้ firestore.rules บังคับสิทธิ์ได้จริง
// ═══════════════════════════════════════════════════════════════════

// PIN ตั้งต้นของคุณครู — ใช้เข้าระบบครั้งแรกได้ทันทีโดยไม่ต้องตั้งค่า
// และเปลี่ยนเป็นรหัสส่วนตัวได้ทุกเมื่อจากเมนู "PIN" ในห้องทำงานครู
const DEFAULT_TEACHER_PIN = process.env.DEFAULT_TEACHER_PIN || '2026';

// อ่านความลับจาก *_secrets ก่อน ถ้ายังไม่มีค่อย fallback ไปเอกสารเดิม
// (รองรับช่วงทยอย migrate โดยระบบไม่ล่ม)
async function readSecret(secretCol, legacyCol, id, field) {
  if (!db || !id) return undefined;
  const s = await db.collection(secretCol).doc(String(id)).get();
  if (s.exists && s.data()[field] !== undefined && s.data()[field] !== '') {
    return s.data()[field];
  }
  const l = await db.collection(legacyCol).doc(String(id)).get();
  if (l.exists && l.data()[field] !== undefined && l.data()[field] !== '') {
    return l.data()[field];
  }
  return undefined;
}

async function writeSecret(secretCol, id, patch) {
  await db.collection(secretCol).doc(String(id)).set(
    { ...patch, updatedAt: new Date().toISOString() },
    { merge: true }
  );
}

const teacherSecret = (id, field) => readSecret('teacher_secrets', 'teachers', id, field);
const studentSecret = (id, field) => readSecret('student_secrets', 'students', id, field);

// PIN ครูที่ใช้ได้จริง ณ ตอนนี้ — ถ้ายังไม่เคยตั้ง ให้ถือว่าเป็น PIN ตั้งต้น
async function effectiveTeacherPin(id) {
  const stored = await teacherSecret(id, 'pin');
  return stored || DEFAULT_TEACHER_PIN;
}

// สร้าง Firebase custom token พร้อม claims ให้ rules ใช้ตัดสินสิทธิ์
async function mintToken(uid, claims) {
  return admin.auth().createCustomToken(uid, claims);
}

const isPin = (v) => typeof v === 'string' && /^\d{4}$/.test(v);
const sha256hex = (s) => crypto.createHash('sha256').update(s).digest('hex');

// กันเดา PIN แบบสุ่ม — จำกัดจำนวนครั้งต่อ identifier
const failCounts = new Map();
const MAX_FAILS = 8;
const FAIL_WINDOW_MS = 10 * 60 * 1000;

function tooManyFails(key) {
  const rec = failCounts.get(key);
  if (!rec) return false;
  if (Date.now() - rec.first > FAIL_WINDOW_MS) { failCounts.delete(key); return false; }
  return rec.count >= MAX_FAILS;
}
function noteFail(key) {
  const rec = failCounts.get(key);
  if (!rec || Date.now() - rec.first > FAIL_WINDOW_MS) {
    failCounts.set(key, { count: 1, first: Date.now() });
  } else {
    rec.count++;
  }
}
const clearFails = (key) => failCounts.delete(key);

const LOCKED_MSG = 'กรอกผิดหลายครั้งเกินไป กรุณารอ 10 นาทีแล้วลองใหม่';

// บันทึกลงฟีดกิจกรรมของแอดมิน — ผู้ที่ยังไม่ล็อกอินเขียน system_logs เองไม่ได้แล้ว
// จึงต้องให้เซิร์ฟเวอร์เป็นคนบันทึกเหตุการณ์ล็อกอินล้มเหลวแทน
async function logServer(type, title, details = '', meta = {}) {
  try {
    if (!db) return;
    await db.collection('system_logs').add({
      type, title, details, meta,
      source: 'server',
      timestamp: new Date().toISOString()
    });
  } catch (e) {
    console.warn('logServer:', e.message);
  }
}

// ── นักเรียน: เข้าสู่ระบบ ─────────────────────────────────────────
app.post('/api/auth/student', async (req, res) => {
  try {
    const { studentId, pin } = req.body || {};
    const id = String(studentId || '').trim();
    if (!/^\d{5}$/.test(id) || !isPin(pin)) {
      return res.status(400).json({ error: 'ข้อมูลไม่ครบถ้วน' });
    }
    const key = 'stu:' + id;
    if (tooManyFails(key)) return res.status(429).json({ error: LOCKED_MSG });

    const doc = await db.collection('students').doc(id).get();
    if (!doc.exists) return res.status(404).json({ error: 'ไม่พบรหัสนักเรียนนี้ในระบบ', notFound: true });

    const stored = await studentSecret(id, 'pin');
    if (!stored) return res.status(409).json({ error: 'ยังไม่ได้ตั้ง PIN', needsPin: true });
    if (stored !== pin) {
      noteFail(key);
      logServer('login_fail', 'นักเรียนกรอก PIN ผิด', 'รหัสนักเรียน ' + id + ' (' + (doc.data().name || '-') + ')', { studentId: id });
      return res.status(401).json({ error: 'รหัส PIN ไม่ถูกต้อง' });
    }
    clearFails(key);

    const data = doc.data();
    const token = await mintToken('stu_' + id, { role: 'student', sid: id });
    res.json({
      ok: true,
      token,
      student: {
        id,
        name: data.name || '',
        studentClass: data.studentClass || data.class || '',
        studentNo: data.studentNo || ''
      }
    });
  } catch (err) {
    console.error('auth/student:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── นักเรียน: ลงทะเบียนครั้งแรก + ตั้ง PIN ────────────────────────
app.post('/api/auth/student-register', async (req, res) => {
  try {
    const { studentId, pin, name, studentClass, studentNo } = req.body || {};
    const id = String(studentId || '').trim();
    if (!/^\d{5}$/.test(id) || !isPin(pin) || !String(name || '').trim()) {
      return res.status(400).json({ error: 'ข้อมูลไม่ครบถ้วน' });
    }
    // ถ้ามี PIN อยู่แล้ว ห้ามตั้งทับ — ต้องไปทางรีเซ็ตเท่านั้น
    const existing = await studentSecret(id, 'pin');
    if (existing) {
      return res.status(409).json({ error: 'รหัสนี้มี PIN แล้ว กรุณาเข้าสู่ระบบ หรือใช้เมนูลืม PIN' });
    }

    const clean = {
      id,
      name: String(name).trim(),
      studentClass: String(studentClass || '').trim(),
      studentNo: String(studentNo || '').trim()
    };
    await db.collection('students').doc(id).set(
      { ...clean, createdAt: new Date().toISOString() },
      { merge: true }
    );
    await writeSecret('student_secrets', id, { pin });

    const token = await mintToken('stu_' + id, { role: 'student', sid: id });
    res.json({ ok: true, token, student: clean });
  } catch (err) {
    console.error('auth/student-register:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── ครู: ค้นหาจากเบอร์โทร (ไม่คืน PIN) ────────────────────────────
app.post('/api/auth/teacher-lookup', async (req, res) => {
  try {
    const phone = String(req.body?.phone || '').replace(/\D/g, '');
    if (!phone) return res.status(400).json({ error: 'กรุณากรอกเบอร์โทรศัพท์' });

    const snap = await db.collection('teachers').where('phone', '==', phone).limit(1).get();
    if (snap.empty) {
      return res.status(404).json({ error: 'ไม่พบเบอร์โทรนี้ในระบบ กรุณาติดต่อฝ่ายวัดผลเพื่อเปิดสิทธิ์' });
    }
    const tDoc = snap.docs[0];
    const teacherId = tDoc.id;

    // ครูเข้าได้เสมอ — ยังไม่เคยตั้ง PIN ก็ใช้ PIN ตั้งต้นได้เลย
    const stored = await teacherSecret(teacherId, 'pin');
    res.json({
      ok: true,
      usingDefaultPin: !stored || stored === DEFAULT_TEACHER_PIN,
      teacher: { id: teacherId, name: tDoc.data().name || '', department: tDoc.data().department || '' }
    });
  } catch (err) {
    console.error('auth/teacher-lookup:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── ครู: เข้าสู่ระบบด้วย PIN (รับ PIN ตั้งต้นได้ถ้ายังไม่เคยเปลี่ยน) ──
app.post('/api/auth/teacher', async (req, res) => {
  try {
    const { teacherId, pin } = req.body || {};
    const id = String(teacherId || '').trim();
    if (!id || !isPin(pin)) return res.status(400).json({ error: 'ข้อมูลไม่ครบถ้วน' });

    const key = 'tch:' + id;
    if (tooManyFails(key)) return res.status(429).json({ error: LOCKED_MSG });

    const tDoc = await db.collection('teachers').doc(id).get();
    if (!tDoc.exists) return res.status(404).json({ error: 'ไม่พบข้อมูลคุณครู' });

    const stored = await teacherSecret(id, 'pin');
    const expected = stored || DEFAULT_TEACHER_PIN;
    if (expected !== pin) {
      noteFail(key);
      logServer('login_fail', 'ครูกรอก PIN ผิด', (tDoc.data().name || id), { teacherId: id });
      return res.status(401).json({ error: 'รหัส PIN ไม่ถูกต้อง' });
    }
    clearFails(key);

    // ครูที่ยังไม่เคยมีระเบียน PIN — บันทึกค่าตั้งต้นไว้ให้เป็นหลักฐาน
    if (!stored) await writeSecret('teacher_secrets', id, { pin: DEFAULT_TEACHER_PIN });

    const token = await mintToken('tch_' + id, { role: 'teacher', tid: id });
    res.json({
      ok: true,
      token,
      usingDefaultPin: pin === DEFAULT_TEACHER_PIN,
      teacher: { id, name: tDoc.data().name || '', department: tDoc.data().department || '' }
    });
  } catch (err) {
    console.error('auth/teacher:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── ครู: เปลี่ยน PIN ──────────────────────────────────────────────
app.post('/api/auth/teacher-change-pin', async (req, res) => {
  try {
    const { teacherId, currentPin, newPin } = req.body || {};
    const id = String(teacherId || '').trim();
    if (!id || !isPin(currentPin) || !isPin(newPin)) {
      return res.status(400).json({ error: 'กรุณากรอก PIN 4 หลักให้ครบถ้วน' });
    }
    const key = 'tch:' + id;
    if (tooManyFails(key)) return res.status(429).json({ error: LOCKED_MSG });

    const expected = await effectiveTeacherPin(id);
    if (expected !== currentPin) {
      noteFail(key);
      return res.status(401).json({ error: 'PIN ปัจจุบันไม่ถูกต้อง' });
    }
    clearFails(key);
    await writeSecret('teacher_secrets', id, { pin: newPin });
    res.json({ ok: true });
  } catch (err) {
    console.error('auth/teacher-change-pin:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── ครู: เปิดคำร้องจาก QR/ลิงก์ แล้วยืนยันด้วย PIN ─────────────────
//   คืนทั้ง token และตัวคำร้อง เพราะหน้าเว็บยังอ่าน requests ไม่ได้จนกว่าจะ login
app.post('/api/auth/teacher-by-qr', async (req, res) => {
  try {
    const { qrToken, pin } = req.body || {};
    const tok = String(qrToken || '').trim().toUpperCase().replace('REQ-', '');
    if (!tok || !isPin(pin)) return res.status(400).json({ error: 'ข้อมูลไม่ครบถ้วน' });

    const snap = await db.collection('requests').where('qrToken', '==', tok).limit(1).get();
    if (snap.empty) return res.status(404).json({ error: 'ไม่พบคำร้องนี้' });

    const reqData = snap.docs[0].data();
    const id = reqData.teacherId;
    const key = 'tch:' + id;
    if (tooManyFails(key)) return res.status(429).json({ error: LOCKED_MSG });

    const expected = await effectiveTeacherPin(id);
    if (expected !== pin) {
      noteFail(key);
      return res.status(401).json({ error: 'รหัส PIN ไม่ถูกต้อง' });
    }
    clearFails(key);

    const tDoc = await db.collection('teachers').doc(id).get();
    const token = await mintToken('tch_' + id, { role: 'teacher', tid: id });
    res.json({
      ok: true,
      token,
      teacher: {
        id,
        name: tDoc.exists ? tDoc.data().name || '' : reqData.teacherName || '',
        department: tDoc.exists ? tDoc.data().department || '' : ''
      },
      request: reqData
    });
  } catch (err) {
    console.error('auth/teacher-by-qr:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Magic Link: ตรวจลายเซ็นที่เซิร์ฟเวอร์ (secret ไม่อยู่ในหน้าเว็บแล้ว) ──
app.post('/api/auth/magic', async (req, res) => {
  try {
    const { tid, t, sig, req: reqId } = req.body || {};
    if (!tid || !t || !sig) return res.status(400).json({ error: 'ลิงก์ไม่สมบูรณ์' });

    const elapsed = Date.now() - parseInt(t, 10);
    if (isNaN(elapsed) || elapsed < 0 || elapsed > 7 * 24 * 60 * 60 * 1000) {
      return res.status(401).json({ error: 'ลิงก์หมดอายุแล้ว กรุณาเข้าสู่ระบบด้วย PIN' });
    }
    const expected = sha256hex(`${WEBHOOK_SECRET}:${tid}:${t}:${reqId || ''}`);
    if (expected !== sig) return res.status(401).json({ error: 'ลายเซ็นลิงก์ไม่ถูกต้อง' });

    const tDoc = await db.collection('teachers').doc(String(tid)).get();
    if (!tDoc.exists) return res.status(404).json({ error: 'ไม่พบข้อมูลคุณครู' });

    const token = await mintToken('tch_' + tid, { role: 'teacher', tid: String(tid) });
    res.json({
      ok: true,
      token,
      teacher: { id: String(tid), name: tDoc.data().name || '', department: tDoc.data().department || '' }
    });
  } catch (err) {
    console.error('auth/magic:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Magic Link ฝั่งแอดมิน ─────────────────────────────────────────
app.post('/api/auth/admin-magic', async (req, res) => {
  try {
    const { aid, at, sig } = req.body || {};
    if (!aid || !at || !sig) return res.status(400).json({ error: 'ลิงก์ไม่สมบูรณ์' });

    const elapsed = Date.now() - parseInt(at, 10);
    if (isNaN(elapsed) || elapsed < 0 || elapsed > 7 * 24 * 60 * 60 * 1000) {
      return res.status(401).json({ error: 'ลิงก์หมดอายุแล้ว' });
    }
    if (sha256hex(`${WEBHOOK_SECRET}:${aid}:${at}`) !== sig) {
      logServer('security_warn', 'ลายเซ็น Magic Link แอดมินไม่ถูกต้อง', 'พยายามเข้าระบบด้วยลิงก์ที่ลายเซ็นไม่ตรง (aid=' + aid + ')', { aid });
      return res.status(401).json({ error: 'ลายเซ็นลิงก์ไม่ถูกต้อง' });
    }

    if (aid === 'super') {
      const token = await mintToken('adm_super', { role: 'admin', aid: 'super' });
      return res.json({ ok: true, token, role: 'super' });
    }
    const staff = await db.collection('admin_users').doc(String(aid)).get();
    if (!staff.exists || !staff.data().isActive) {
      return res.status(403).json({ error: 'บัญชีเจ้าหน้าที่ถูกปิดใช้งาน' });
    }
    const token = await mintToken('adm_' + aid, { role: 'staff', aid: String(aid) });
    res.json({
      ok: true, token, role: 'sub',
      staff: { id: staff.data().id, name: staff.data().name, username: staff.data().username }
    });
  } catch (err) {
    console.error('auth/admin-magic:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Super Admin: เข้าสู่ระบบ ──────────────────────────────────────
app.post('/api/auth/admin', async (req, res) => {
  try {
    const password = String(req.body?.password || '').trim();
    if (!password) return res.status(400).json({ error: 'กรุณากรอกรหัสผ่าน' });
    if (tooManyFails('adm:super')) return res.status(429).json({ error: LOCKED_MSG });

    const sec = await db.collection('admin_secrets').doc('super').get();
    let stored = sec.exists ? sec.data().passwordHash : '';
    if (!stored) {
      const cfg = await db.collection('system_config').doc('admin').get();
      stored = cfg.exists ? cfg.data().passwordHash || '' : '';
    }
    if (!stored) {
      return res.status(503).json({ error: 'ยังไม่ได้ตั้งรหัสผ่าน Super Admin กรุณาติดต่อผู้ดูแลระบบ' });
    }
    if (sha256hex(password) !== stored) {
      noteFail('adm:super');
      logServer('security_warn', 'พยายามเข้า Super Admin ด้วยรหัสผิด', 'มีการกรอกรหัสผ่าน Super Admin ไม่ถูกต้อง');
      return res.status(401).json({ error: 'รหัสผ่านไม่ถูกต้อง' });
    }
    clearFails('adm:super');

    const token = await mintToken('adm_super', { role: 'admin', aid: 'super' });
    res.json({ ok: true, token, role: 'super' });
  } catch (err) {
    console.error('auth/admin:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── เจ้าหน้าที่วัดผล: เข้าสู่ระบบ ──────────────────────────────────
app.post('/api/auth/staff', async (req, res) => {
  try {
    const username = String(req.body?.username || '').trim().toLowerCase();
    const password = String(req.body?.password || '').trim();
    if (!username || !password) return res.status(400).json({ error: 'กรุณากรอกข้อมูลให้ครบถ้วน' });
    if (tooManyFails('stf:' + username)) return res.status(429).json({ error: LOCKED_MSG });

    const snap = await db.collection('admin_users').where('username', '==', username).limit(1).get();
    if (snap.empty) {
      noteFail('stf:' + username);
      return res.status(401).json({ error: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
    }
    const staffId = snap.docs[0].id;
    const staff = snap.docs[0].data();
    if (!staff.isActive) return res.status(403).json({ error: 'บัญชีนี้ถูกปิดใช้งาน กรุณาติดต่อ Super Admin' });

    const stored = await readSecret('admin_secrets', 'admin_users', staffId, 'passwordHash');
    if (!stored || sha256hex(password) !== stored) {
      noteFail('stf:' + username);
      logServer('login_fail', 'เจ้าหน้าที่กรอกรหัสผ่านผิด', (staff.name || '-') + ' (@' + username + ')', { username, userId: staffId });
      return res.status(401).json({ error: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
    }
    clearFails('stf:' + username);

    const token = await mintToken('adm_' + staffId, { role: 'staff', aid: staffId });
    res.json({ ok: true, token, role: 'sub', staff: { id: staff.id, name: staff.name, username: staff.username } });
  } catch (err) {
    console.error('auth/staff:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── แอดมิน/เจ้าหน้าที่: เปลี่ยนรหัสผ่านตนเอง ───────────────────────
app.post('/api/auth/admin-change-password', async (req, res) => {
  try {
    const { aid, currentPassword, newPassword } = req.body || {};
    const id = String(aid || '').trim();
    const curr = String(currentPassword || '').trim();
    const next = String(newPassword || '').trim();
    if (!id || !curr || next.length < 8) {
      return res.status(400).json({ error: 'รหัสผ่านใหม่ต้องยาวอย่างน้อย 8 ตัวอักษร' });
    }
    if (tooManyFails('pwd:' + id)) return res.status(429).json({ error: LOCKED_MSG });

    // ทั้ง Super Admin และเจ้าหน้าที่ใช้ชื่อฟิลด์ passwordHash เหมือนกัน
    const isSuper = id === 'super';
    const field = 'passwordHash';
    const stored = await readSecret(
      'admin_secrets',
      isSuper ? 'system_config' : 'admin_users',
      isSuper ? 'admin' : id,
      field
    );
    if (!stored || sha256hex(curr) !== stored) {
      noteFail('pwd:' + id);
      return res.status(401).json({ error: 'รหัสผ่านปัจจุบันไม่ถูกต้อง' });
    }
    clearFails('pwd:' + id);

    await writeSecret('admin_secrets', id, { [field]: sha256hex(next) });
    res.json({ ok: true });
  } catch (err) {
    console.error('auth/admin-change-password:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── ครู: รีเซ็ต PIN นักเรียน (ยืนยันด้วย PIN ครูเอง) ────────────────
app.post('/api/auth/reset-student-pin', async (req, res) => {
  try {
    const { teacherId, teacherPin, studentId } = req.body || {};
    const tid = String(teacherId || '').trim();
    const sid = String(studentId || '').trim();
    if (!tid || !isPin(teacherPin) || !sid) return res.status(400).json({ error: 'ข้อมูลไม่ครบถ้วน' });

    const key = 'tch:' + tid;
    if (tooManyFails(key)) return res.status(429).json({ error: LOCKED_MSG });
    const expected = await effectiveTeacherPin(tid);
    if (expected !== teacherPin) {
      noteFail(key);
      return res.status(401).json({ error: 'PIN คุณครูไม่ถูกต้อง' });
    }
    clearFails(key);

    const del = admin.firestore.FieldValue.delete();
    await db.collection('student_secrets').doc(sid).set({ pin: del }, { merge: true });
    await db.collection('students').doc(sid).set({ pin: del }, { merge: true });
    res.json({ ok: true });
  } catch (err) {
    console.error('auth/reset-student-pin:', err);
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
