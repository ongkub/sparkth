import express from 'express';
import pg from 'pg';

const { Pool } = pg;
const app = express();

const port = Number(process.env.PORT || 3000);
const databaseUrl = process.env.DATABASE_URL;
const lineChannelToken = process.env.LINE_CHANNEL_TOKEN || '';

if (!databaseUrl) {
  console.error('Missing DATABASE_URL');
  process.exit(1);
}

const isLocalDb =
  databaseUrl.includes('localhost') || databaseUrl.includes('127.0.0.1');

const pool = new Pool({
  connectionString: databaseUrl,
  ssl: isLocalDb ? false : { rejectUnauthorized: false }
});

async function ensureSchema() {
  await pool.query(
    `ALTER TABLE rsvp_submissions
     ADD COLUMN IF NOT EXISTS nickname TEXT NOT NULL DEFAULT ''`
  );
  await pool.query(
    `CREATE TABLE IF NOT EXISTS slip_submissions (
       id BIGSERIAL PRIMARY KEY,
       nickname TEXT NOT NULL DEFAULT '',
       side TEXT NOT NULL DEFAULT '',
       slip_mime TEXT NOT NULL DEFAULT 'image/jpeg',
       slip_data TEXT NOT NULL DEFAULT '',
       submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`
  );
  await pool.query(
    `ALTER TABLE slip_submissions ADD COLUMN IF NOT EXISTS side TEXT NOT NULL DEFAULT ''`
  );
}

app.use(express.json({ limit: '10mb' }));
app.use(express.text({ type: 'text/plain', limit: '10mb' }));

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
});

app.get('/health', async (_req, res) => {
  try {
    await pool.query('select 1');
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get('/rsvp', async (req, res) => {
  const action = (req.query.action || '').toString();
  const userId = (req.query.userId || '').toString().trim();

  try {
    if (userId && !action) {
      const result = await pool.query(
        `SELECT
           line_user_id,
           first_name,
           last_name,
           nickname,
           full_name,
           phone,
           side,
           relationship,
           guests,
           dietary,
           message,
           session,
           picture_url,
           submitted_at
         FROM rsvp_submissions
         WHERE line_user_id = $1`,
        [userId]
      );

      if (result.rowCount === 0) {
        res.json({ submitted: false });
        return;
      }

      const row = result.rows[0];
      res.json({
        submitted: true,
        data: {
          firstName: row.first_name,
          lastName: row.last_name,
          nickName: row.nickname,
          nickname: row.nickname,
          name: row.full_name,
          phone: row.phone,
          side: row.side,
          relationship: row.relationship,
          guests: row.guests,
          dietary: row.dietary,
          message: row.message,
          session: row.session,
          photo: row.picture_url || '',
          timestamp: row.submitted_at?.toISOString?.() || ''
        }
      });
      return;
    }

    if (action === 'list') {
      const submittedRes = await pool.query(
        `SELECT
           line_user_id,
           first_name,
           last_name,
           nickname,
           full_name,
           phone,
           side,
           relationship,
           guests,
           dietary,
           message,
           session,
           picture_url,
           submitted_at
         FROM rsvp_submissions
         ORDER BY submitted_at DESC`
      );

      const visitedRes = await pool.query(
        `SELECT
           v.line_user_id,
           v.picture_url,
           v.last_seen_at
         FROM visitors v
         WHERE v.status = 'visited'
           AND NOT EXISTS (
             SELECT 1
             FROM rsvp_submissions s
             WHERE s.line_user_id = v.line_user_id
           )
         ORDER BY v.last_seen_at DESC`
      );

      const submitted = submittedRes.rows.map((r) => ({
        status: 'submitted',
        timestamp: r.submitted_at?.toISOString?.() || '',
        lineUid: r.line_user_id,
        firstName: r.first_name,
        lastName: r.last_name,
        nickName: r.nickname,
        nickname: r.nickname,
        name: r.full_name,
        phone: r.phone,
        side: r.side,
        relationship: r.relationship,
        guests: r.guests,
        dietary: r.dietary,
        message: r.message,
        session: r.session,
        photo: r.picture_url || ''
      }));

      const visited = visitedRes.rows.map((r) => ({
        status: 'visited',
        timestamp: r.last_seen_at?.toISOString?.() || '',
        lineUid: r.line_user_id,
        name: '',
        photo: r.picture_url || ''
      }));

      res.json({ submitted, visited });
      return;
    }

    if (action === 'invites') {
      const result = await pool.query('SELECT COUNT(*)::int AS count FROM invites');
      res.json({ count: result.rows[0]?.count || 0 });
      return;
    }

    res.json({ status: 'ok' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/rsvp', async (req, res) => {
  const data = parseBody(req.body);
  const action = (data.action || 'submit').toString();

  try {
    if (action === 'submit' || action === 'update') {
      const lineUserId = safeText(data.lineUserId);
      if (!lineUserId) {
        res.status(400).json({ success: false, error: 'lineUserId required' });
        return;
      }

      const submittedAt = new Date();
      const firstName = safeText(data.firstName);
      const lastName = safeText(data.lastName);
      const nickname = safeText(data.nickName || data.nickname);
      const fullName =
        safeText(data.name) || `${firstName} ${lastName}`.trim();

      await pool.query(
        `INSERT INTO rsvp_submissions (
           line_user_id, first_name, last_name, nickname, full_name, phone, side,
           relationship, guests, dietary, message, session, picture_url, submitted_at
         )
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         ON CONFLICT (line_user_id) DO UPDATE SET
           first_name = EXCLUDED.first_name,
           last_name = EXCLUDED.last_name,
           nickname = EXCLUDED.nickname,
           full_name = EXCLUDED.full_name,
           phone = EXCLUDED.phone,
           side = EXCLUDED.side,
           relationship = EXCLUDED.relationship,
           guests = EXCLUDED.guests,
           dietary = EXCLUDED.dietary,
           message = EXCLUDED.message,
           session = EXCLUDED.session,
           picture_url = EXCLUDED.picture_url,
           submitted_at = EXCLUDED.submitted_at`,
        [
          lineUserId,
          firstName,
          lastName,
          nickname,
          fullName,
          safeText(data.phone),
          safeText(data.side),
          safeText(data.relationship),
          safeGuests(data.guests),
          safeText(data.dietary),
          safeText(data.message),
          safeText(data.session),
          safeText(data.pictureUrl),
          submittedAt
        ]
      );

      await pool.query(
        `INSERT INTO visitors (line_user_id, status, picture_url, first_seen_at, last_seen_at)
         VALUES ($1, 'submitted', $2, NOW(), NOW())
         ON CONFLICT (line_user_id) DO UPDATE SET
           status = 'submitted',
           picture_url = CASE
             WHEN EXCLUDED.picture_url <> '' THEN EXCLUDED.picture_url
             ELSE visitors.picture_url
           END,
           last_seen_at = NOW()`,
        [lineUserId, safeText(data.pictureUrl)]
      );

      res.json({ success: true });
      return;
    }

    if (action === 'visit') {
      const lineUserId = safeText(data.lineUserId);
      if (!lineUserId) {
        res.json({ success: true });
        return;
      }

      await pool.query(
        `INSERT INTO visitors (line_user_id, status, picture_url, first_seen_at, last_seen_at)
         VALUES ($1, 'visited', $2, NOW(), NOW())
         ON CONFLICT (line_user_id) DO UPDATE SET
           picture_url = CASE
             WHEN EXCLUDED.picture_url <> '' THEN EXCLUDED.picture_url
             ELSE visitors.picture_url
           END,
           last_seen_at = NOW(),
           status = CASE
             WHEN visitors.status = 'submitted' THEN 'submitted'
             ELSE 'visited'
           END`,
        [lineUserId, safeText(data.pictureUrl)]
      );

      res.json({ success: true });
      return;
    }

    if (action === 'invite') {
      await pool.query(
        `INSERT INTO invites (sender_uid, sender_name, sender_picture, sent_at)
         VALUES ($1, $2, $3, NOW())`,
        [
          safeText(data.senderUid),
          safeText(data.senderName),
          safeText(data.senderPicture)
        ]
      );
      res.json({ success: true });
      return;
    }

    if (action === 'validateFlex') {
      if (!lineChannelToken) {
        res.json({ ok: false, error: 'no_token' });
        return;
      }

      const response = await fetch('https://api.line.me/v2/bot/message/validate/push', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${lineChannelToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ messages: [data.flexMessage] })
      });

      if (response.ok) {
        res.json({ ok: true });
        return;
      }

      let payload = {};
      try {
        payload = await response.json();
      } catch (_error) {
        payload = {};
      }

      res.json({
        ok: false,
        message: payload.message || `HTTP ${response.status}`
      });
      return;
    }

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

function parseBody(body) {
  if (!body) return {};
  if (typeof body === 'object') return body;
  if (typeof body === 'string') {
    try {
      return JSON.parse(body);
    } catch (_error) {
      return {};
    }
  }
  return {};
}

function safeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function safeGuests(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 1;
  return Math.max(1, Math.min(10, Math.round(num)));
}

app.get('/slip', async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, nickname, side, slip_mime, submitted_at
       FROM slip_submissions
       ORDER BY submitted_at DESC`
    );
    res.json({ slips: result.rows });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/slip/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) {
    res.status(400).json({ success: false, error: 'invalid id' });
    return;
  }
  try {
    const result = await pool.query(
      `SELECT id, nickname, side, slip_mime, slip_data, submitted_at
       FROM slip_submissions WHERE id = $1`,
      [id]
    );
    if (result.rowCount === 0) {
      res.status(404).json({ success: false, error: 'not found' });
      return;
    }
    res.json({ slip: result.rows[0] });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/slip', async (req, res) => {
  const data = parseBody(req.body);
  const nickname = safeText(data.nickname);
  const side = safeText(data.side);
  const slipBase64 = typeof data.slipBase64 === 'string' ? data.slipBase64.trim() : '';
  const slipMime = safeText(data.slipMime) || 'image/jpeg';

  if (!nickname) {
    res.status(400).json({ success: false, error: 'nickname required' });
    return;
  }
  if (!slipBase64) {
    res.status(400).json({ success: false, error: 'slip image required' });
    return;
  }
  // ~5MB base64 ≈ 6.67MB raw text — guard at 8MB
  if (slipBase64.length > 8 * 1024 * 1024) {
    res.status(400).json({ success: false, error: 'slip image too large' });
    return;
  }

  try {
    await pool.query(
      `INSERT INTO slip_submissions (nickname, side, slip_mime, slip_data, submitted_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [nickname, side, slipMime, slipBase64]
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

ensureSchema()
  .then(() => {
    app.listen(port, () => {
      console.log(`RSVP API listening on :${port}`);
    });
  })
  .catch((error) => {
    console.error('Failed to initialize database schema', error);
    process.exit(1);
  });
