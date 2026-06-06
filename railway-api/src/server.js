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

const welcomeClients = new Set();
const checkinCooldownMs = Number(process.env.CHECKIN_COOLDOWN_MS || 5 * 60 * 1000);

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
  await pool.query(
    `CREATE TABLE IF NOT EXISTS checkins (
       id BIGSERIAL PRIMARY KEY,
       line_user_id TEXT NOT NULL DEFAULT '',
       display_name TEXT NOT NULL DEFAULT '',
       nickname TEXT NOT NULL DEFAULT '',
       picture_url TEXT NOT NULL DEFAULT '',
       source TEXT NOT NULL DEFAULT '',
       beacon_type TEXT NOT NULL DEFAULT '',
       checked_in_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_checkins_checked_in_at ON checkins (checked_in_at DESC)`
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_checkins_line_user_id ON checkins (line_user_id)`
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

app.get('/welcome/recent', async (req, res) => {
  const limit = Math.max(1, Math.min(80, Number(req.query.limit) || 40));
  try {
    const result = await pool.query(
      `SELECT id, line_user_id, display_name, nickname, picture_url, source, beacon_type, checked_in_at
       FROM checkins
       ORDER BY checked_in_at DESC
       LIMIT $1`,
      [limit]
    );
    res.json({ checkins: result.rows.map(formatCheckin).reverse() });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/welcome-stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.write('event: ready\n');
  res.write(`data: ${JSON.stringify({ ok: true, now: new Date().toISOString() })}\n\n`);

  welcomeClients.add(res);
  const heartbeat = setInterval(() => {
    res.write('event: ping\n');
    res.write(`data: ${JSON.stringify({ now: new Date().toISOString() })}\n\n`);
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    welcomeClients.delete(res);
  });
});

app.post('/welcome-checkin', async (req, res) => {
  const data = parseBody(req.body);
  const lineUserId = safeText(data.lineUserId || data.userId);
  try {
    const checkin = await createCheckin({
      lineUserId,
      displayName: safeText(data.displayName || data.name),
      nickname: safeText(data.nickName || data.nickname),
      pictureUrl: safeText(data.pictureUrl || data.photo),
      source: safeText(data.source) || 'manual',
      beaconType: safeText(data.beaconType)
    });
    res.json({ success: true, checkin });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/webhook/line', async (req, res) => {
  const data = parseBody(req.body);
  const events = Array.isArray(data.events) ? data.events : [];
  res.json({ success: true });

  for (const event of events) {
    if (event?.type !== 'beacon') continue;
    const lineUserId = safeText(event.source?.userId);
    if (!lineUserId) continue;
    createCheckin({
      lineUserId,
      source: 'line-beacon',
      beaconType: safeText(event.beacon?.type)
    }).catch((error) => {
      console.error('LINE beacon check-in failed', error);
    });
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

function formatCheckin(row) {
  return {
    id: row.id,
    lineUserId: row.line_user_id,
    displayName: row.display_name,
    nickName: row.nickname,
    nickname: row.nickname,
    pictureUrl: row.picture_url,
    photo: row.picture_url,
    source: row.source,
    beaconType: row.beacon_type,
    checkedInAt: row.checked_in_at?.toISOString?.() || row.checked_in_at || ''
  };
}

function broadcastWelcome(checkin) {
  const payload = JSON.stringify(checkin);
  for (const client of welcomeClients) {
    client.write('event: checkin\n');
    client.write(`data: ${payload}\n\n`);
  }
}

async function lookupRsvp(lineUserId) {
  if (!lineUserId) return null;
  const result = await pool.query(
    `SELECT line_user_id, first_name, last_name, nickname, full_name, picture_url
     FROM rsvp_submissions
     WHERE line_user_id = $1`,
    [lineUserId]
  );
  return result.rows[0] || null;
}

async function lookupLineProfile(lineUserId) {
  if (!lineChannelToken || !lineUserId) return null;
  try {
    const response = await fetch(`https://api.line.me/v2/bot/profile/${encodeURIComponent(lineUserId)}`, {
      headers: { Authorization: `Bearer ${lineChannelToken}` }
    });
    if (!response.ok) return null;
    return await response.json();
  } catch (_error) {
    return null;
  }
}

async function createCheckin({ lineUserId, displayName, nickname, pictureUrl, source, beaconType }) {
  const rsvp = await lookupRsvp(lineUserId);
  const profile = (!rsvp && lineUserId) ? await lookupLineProfile(lineUserId) : null;

  const resolvedNickname = safeText(nickname) || safeText(rsvp?.nickname);
  const resolvedDisplayName =
    safeText(displayName) ||
    resolvedNickname ||
    safeText(rsvp?.full_name) ||
    safeText(profile?.displayName) ||
    'Guest';
  const resolvedPictureUrl =
    safeText(pictureUrl) ||
    safeText(rsvp?.picture_url) ||
    safeText(profile?.pictureUrl);

  if (lineUserId) {
    const recent = await pool.query(
      `SELECT id, line_user_id, display_name, nickname, picture_url, source, beacon_type, checked_in_at
       FROM checkins
       WHERE line_user_id = $1
         AND checked_in_at > NOW() - ($2::int * INTERVAL '1 millisecond')
       ORDER BY checked_in_at DESC
       LIMIT 1`,
      [lineUserId, checkinCooldownMs]
    );
    if (recent.rowCount > 0) {
      return formatCheckin(recent.rows[0]);
    }
  }

  const result = await pool.query(
    `INSERT INTO checkins (line_user_id, display_name, nickname, picture_url, source, beacon_type, checked_in_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())
     RETURNING id, line_user_id, display_name, nickname, picture_url, source, beacon_type, checked_in_at`,
    [
      safeText(lineUserId),
      resolvedDisplayName,
      resolvedNickname,
      resolvedPictureUrl,
      safeText(source),
      safeText(beaconType)
    ]
  );

  const checkin = formatCheckin(result.rows[0]);
  broadcastWelcome(checkin);
  return checkin;
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
