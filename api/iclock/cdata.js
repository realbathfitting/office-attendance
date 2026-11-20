const admin = require('firebase-admin');

function initFirebase() {
  if (!admin.apps.length) {
    if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
      throw new Error('FIREBASE_SERVICE_ACCOUNT environment variable is missing on Vercel!');
    }
    const rawJson = process.env.FIREBASE_SERVICE_ACCOUNT.trim();
    const serviceAccount = JSON.parse(rawJson);

    // Fix escaped newlines in private_key if Vercel altered them
    if (serviceAccount.private_key) {
      serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
    }

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
  }
  return admin.firestore();
}

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

  try {
    const db = initFirebase();
    const { SN, table } = req.query;

    if (req.method === 'GET') {
      if (SN) {
        await db.collection('devices').doc(SN).set({
          serialNumber: SN,
          lastPing: admin.firestore.FieldValue.serverTimestamp(),
          status: 'Online'
        }, { merge: true });
      }
      return res.status(200).send(
        'GET OPTION FROM: ' + (SN || 'DEVICE') +
        '\nStamp=9999\nOpStamp=9999\nErrorDelay=30\nDelay=10\nTransTimes=00:00;14:05\nTransInterval=1\nTransFlag=1111000000\nRealtime=1\nEncrypt=0\n'
      );
    }

    if (req.method === 'POST') {
      const rawBody = await getRawBody(req);

      if (table === 'ATTLOG' && rawBody) {
        const lines = rawBody.trim().split('\n');
        const batch = db.batch();

        for (const line of lines) {
          const parts = line.trim().split('\t');
          if (parts.length >= 2) {
            const biometricId = parts[0].trim();
            const timestampStr = parts[1].trim();
            const statusCode = parts[2] ? parts[2].trim() : '0';
            const [datePart, timePart] = timestampStr.split(' ');

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

      return res.status(200).send('OK');
    }

    return res.status(200).send('OK');
  } catch (error) {
    console.error('ADMS Function Error:', error);
    return res.status(500).send('ERROR: ' + error.message);
  }
};