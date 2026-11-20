const admin = require('firebase-admin');

// Initialize Firebase Admin once
if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

const db = admin.firestore();

// Read raw text body from biometric machine
function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', err => reject(err));
  });
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'text/plain');

  const { SN, table } = req.query;

  // 1. Machine Handshake / Heartbeat (GET Request)
  if (req.method === 'GET') {
    if (SN) {
      await db.collection('devices').doc(SN).set({
        serialNumber: SN,
        lastPing: admin.firestore.FieldValue.serverTimestamp(),
        status: 'Online'
      }, { merge: true });
    }
    // Standard ADMS handshake response
    return res.status(200).send('GET OPTION FROM: ' + (SN || 'DEVICE') + '\nStamp=9999\nOpStamp=9999\nErrorDelay=30\nDelay=10\nTransTimes=00:00;14:05\nTransInterval=1\nTransFlag=1111000000\nRealtime=1\nEncrypt=0\n');
  }

  // 2. Receive Attendance Logs (POST Request)
  if (req.method === 'POST') {
    try {
      const rawBody = await getRawBody(req);

      if (table === 'ATTLOG' && rawBody) {
        // Biometric machine sends tab-separated lines:
        // Example: 101	2026-11-20 09:32:10	0	1	0	0
        const lines = rawBody.trim().split('\n');
        const batch = db.batch();

        for (const line of lines) {
          const parts = line.trim().split('\t');
          if (parts.length >= 2) {
            const biometricId = parts[0].trim();
            const timestampStr = parts[1].trim(); // YYYY-MM-DD HH:mm:ss
            const statusCode = parts[2] ? parts[2].trim() : '0'; // 0 = Check-In, 1 = Check-Out
            const [datePart, timePart] = timestampStr.split(' ');

            // Unique doc ID prevents duplicate entries if machine retries
            const logId = `${biometricId}_${timestampStr.replace(/[:\s-]/g, '')}`;
            const logRef = db.collection('attendance_logs').doc(logId);

            batch.set(logRef, {
              biometricId,
              date: datePart,
              time: timePart,
              timestamp: timestampStr,
              punchType: statusCode === '1' ? 'OUT' : 'IN',
              deviceSN: SN || 'UNKNOWN',
              createdAt: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
          }
        }

        await batch.commit();
        return res.status(200).send(`OK: ${lines.length}`);
      }

      // Acknowledge other tables (OPERLOG, USERINFO, etc.) so machine doesn't hang
      return res.status(200).send('OK');
    } catch (error) {
      console.error('ADMS Error:', error);
      return res.status(500).send('ERROR');
    }
  }

  return res.status(200).send('OK');
};