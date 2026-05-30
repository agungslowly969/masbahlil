import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

function getDb() {
  if (!getApps().length) {
    initializeApp({
      credential: cert({
        projectId:   process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      }),
    });
  }
  return getFirestore();
}

const TG_TOKEN   = process.env.TG_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;

const CLD_CLOUD  = process.env.CLD_CLOUD  || 'dgp84bfby';
const CLD_KEY    = process.env.CLD_KEY    || '484725288299273';
const CLD_SECRET = process.env.CLD_SECRET || 'mi9vq327N3HuoJ3yH0gmSY9LWRM';

async function deleteCloudinaryImage(publicId) {
  if (!publicId) return;
  try {
    const timestamp = Math.floor(Date.now() / 1000);
    const str = `public_id=${publicId}&timestamp=${timestamp}${CLD_SECRET}`;
    // SHA-1 signature
    const msgBuffer = new TextEncoder().encode(str);
    const hashBuffer = await crypto.subtle.digest('SHA-1', msgBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const signature = hashArray.map(b => b.toString(16).padStart(2,'0')).join('');

    const form = new URLSearchParams();
    form.append('public_id', publicId);
    form.append('timestamp', timestamp);
    form.append('api_key', CLD_KEY);
    form.append('signature', signature);

    await fetch(`https://api.cloudinary.com/v1_1/${CLD_CLOUD}/image/destroy`, {
      method: 'POST',
      body: form,
    });
    console.log('Cloudinary image deleted:', publicId);
  } catch(e) {
    console.warn('Cloudinary delete failed:', e.message);
  }
}

async function tgSend(text) {
  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TG_CHAT_ID, text, parse_mode: 'Markdown' }),
  });
}

async function answerCallback(callbackQueryId, text) {
  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text, show_alert: false }),
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const body = req.body;
    if (body.callback_query) {
      const { id: cbId, data, from } = body.callback_query;
      const [action, pendingId] = data.split(':');
      const db = getDb();
      const pendingRef = db.collection('pending').doc(pendingId);
      const pendingSnap = await pendingRef.get();

      if (!pendingSnap.exists) {
        await answerCallback(cbId, 'Donasi tidak ditemukan atau sudah diproses.');
        return res.status(200).json({ ok: true });
      }

      const pending = pendingSnap.data();

      if (action === 'verify') {
        // Simpan ke donations dengan pendingId DULU
        const donationRef = db.collection('donations').doc(pendingId);
        await donationRef.set({
          ...pending,
          pendingId,
          status: 'verified',
          verifiedAt: FieldValue.serverTimestamp(),
          verifiedBy: `telegram:${from.first_name}`,
        });
        // Update statistik
        const statsRef = db.collection('settings').doc('stats');
        await statsRef.set({
          totalDonations: FieldValue.increment(1),
          totalAmount: FieldValue.increment(Number(pending.amt) || 0),
        }, { merge: true });
        // Update pending TERAKHIR (trigger listener frontend)
        await pendingRef.update({ status: 'verified' });
        // Hapus dari pending langsung (serverless tidak support setTimeout)
        try { await pendingRef.delete(); } catch(e) {}

        await answerCallback(cbId, 'Donasi berhasil diverifikasi!');
        await tgSend(`*Donasi Diverifikasi!*\n\n*Nama:* ${pending.name}\n*Nominal:* Rp ${Number(pending.amt).toLocaleString('id-ID')}\nDiverifikasi oleh: ${from.first_name}`);

      } else if (action === 'reject') {
        // Update status rejected dulu (trigger listener frontend)
        await pendingRef.update({ status: 'rejected' });
        // Hapus dari pending langsung (serverless tidak support setTimeout)
        try { await pendingRef.delete(); } catch(e) {}

        // Hapus foto bukti dari Cloudinary
        if (pending.imgPublicId) await deleteCloudinaryImage(pending.imgPublicId);

        await answerCallback(cbId, 'Donasi ditolak.');
        await tgSend(`*Donasi Ditolak*\n\n*Nama:* ${pending.name}\n*Nominal:* Rp ${Number(pending.amt).toLocaleString('id-ID')}\nDitolak oleh: ${from.first_name}`);
      }
      return res.status(200).json({ ok: true });
    }
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Webhook error:', err);
    return res.status(500).json({ error: err.message });
  }
}
