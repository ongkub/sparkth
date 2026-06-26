import express from 'express';
import pg from 'pg';

const { Pool } = pg;
const app = express();

const port = Number(process.env.PORT || 3000);
const databaseUrl = process.env.DATABASE_URL;
const lineChannelToken = process.env.LINE_CHANNEL_TOKEN || '';
const checkinLiffUrl = process.env.CHECKIN_LIFF_URL || 'https://page.sparkth.io/checkin.html';

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
    `ALTER TABLE rsvp_submissions
     ADD COLUMN IF NOT EXISTS table_name TEXT NOT NULL DEFAULT ''`
  );
  await pool.query(
    `ALTER TABLE rsvp_submissions
     ADD COLUMN IF NOT EXISTS checked_in_at TIMESTAMPTZ`
  );
  await pool.query(
    `ALTER TABLE rsvp_submissions
     ADD COLUMN IF NOT EXISTS checkin_source TEXT NOT NULL DEFAULT ''`
  );
  await pool.query(
    `ALTER TABLE rsvp_submissions
     ADD COLUMN IF NOT EXISTS is_single BOOLEAN NOT NULL DEFAULT false`
  );
  await pool.query(
    `ALTER TABLE rsvp_submissions
     ADD COLUMN IF NOT EXISTS instagram TEXT NOT NULL DEFAULT ''`
  );
  await pool.query(
    `ALTER TABLE rsvp_submissions
     ADD COLUMN IF NOT EXISTS show_social_on_wall BOOLEAN NOT NULL DEFAULT false`
  );
  await pool.query(
    `ALTER TABLE rsvp_submissions
     ADD COLUMN IF NOT EXISTS wall_frame TEXT NOT NULL DEFAULT 'classic'`
  );
  await pool.query(
    `ALTER TABLE rsvp_submissions
     ADD COLUMN IF NOT EXISTS welcome_announced_at TIMESTAMPTZ`
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
  await pool.query(
    `ALTER TABLE checkins
     ADD COLUMN IF NOT EXISTS table_name TEXT NOT NULL DEFAULT ''`
  );
  await pool.query(
    `ALTER TABLE checkins
     ADD COLUMN IF NOT EXISTS is_single BOOLEAN NOT NULL DEFAULT false`
  );
  await pool.query(
    `ALTER TABLE checkins
     ADD COLUMN IF NOT EXISTS instagram TEXT NOT NULL DEFAULT ''`
  );
  await pool.query(
    `ALTER TABLE checkins
     ADD COLUMN IF NOT EXISTS show_social_on_wall BOOLEAN NOT NULL DEFAULT false`
  );
  await pool.query(
    `ALTER TABLE checkins
     ADD COLUMN IF NOT EXISTS wall_frame TEXT NOT NULL DEFAULT 'classic'`
  );
  await pool.query(
    `CREATE TABLE IF NOT EXISTS line_webhook_events (
       id BIGSERIAL PRIMARY KEY,
       event_type TEXT NOT NULL DEFAULT '',
       line_user_id TEXT NOT NULL DEFAULT '',
       beacon_type TEXT NOT NULL DEFAULT '',
       destination TEXT NOT NULL DEFAULT '',
       event_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
       raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
       received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_line_webhook_events_received_at
     ON line_webhook_events (received_at DESC)`
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_line_webhook_events_line_user_id
     ON line_webhook_events (line_user_id)`
  );
  await pool.query(
    `CREATE TABLE IF NOT EXISTS seating_maps (
       map_key TEXT PRIMARY KEY,
       map_mime TEXT NOT NULL DEFAULT 'image/jpeg',
       map_data TEXT NOT NULL DEFAULT '',
       updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`
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
      `SELECT
         c.id, c.line_user_id, c.display_name, c.nickname,
         COALESCE(NULLIF(c.picture_url,''), r.picture_url, '') AS picture_url,
         c.source, c.beacon_type, c.checked_in_at,
         COALESCE(NULLIF(c.table_name,''), r.table_name, '') AS table_name,
         COALESCE(c.is_single, r.is_single, false) AS is_single,
         COALESCE(NULLIF(c.instagram,''), r.instagram, '') AS instagram,
         COALESCE(c.show_social_on_wall, r.show_social_on_wall, false) AS show_social_on_wall,
         COALESCE(NULLIF(c.wall_frame,''), r.wall_frame, 'classic') AS wall_frame
       FROM checkins c
       LEFT JOIN rsvp_submissions r ON r.line_user_id = c.line_user_id
       WHERE c.source NOT IN ('codex-smoke', 'screen-test', 'line-beacon')
       ORDER BY c.checked_in_at DESC
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

  recordLineWebhookEvents(data, events).catch((error) => {
    console.error('LINE webhook debug log failed', error);
  });

  for (const event of events) {
    if (event?.type !== 'beacon') continue;
    const lineUserId = safeText(event.source?.userId);
    if (!lineUserId) continue;
    sendCheckinLink(event).catch((error) => {
      console.error('LINE beacon check-in link failed', error);
    });
  }
});

app.get('/checkin', async (req, res) => {
  const userId = safeText(req.query.userId);
  if (!userId) {
    res.status(400).json({ success: false, error: 'userId required' });
    return;
  }

  try {
    const rsvp = await getCheckinRsvp(userId);
    if (!rsvp) {
      res.json({ success: true, submitted: false, checkedIn: false });
      return;
    }
    res.json({
      success: true,
      submitted: true,
      checkedIn: Boolean(rsvp.checked_in_at),
      data: formatCheckinRsvp(rsvp)
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/checkin', async (req, res) => {
  const data = parseBody(req.body);
  const lineUserId = safeText(data.lineUserId || data.userId);
  if (!lineUserId) {
    res.status(400).json({ success: false, error: 'lineUserId required' });
    return;
  }

  try {
    const rsvp = await getCheckinRsvp(lineUserId);
    if (!rsvp) {
      res.status(404).json({ success: false, error: 'rsvp_not_found' });
      return;
    }

    const social = normalizeSocial(data);
    const tableName = safeText(data.tableName || data.table_name || rsvp.table_name);
    const pictureUrl = safeText(data.pictureUrl || data.photo || rsvp.picture_url);
    if (rsvp.checked_in_at) {
      await updateRsvpCheckin(lineUserId, {
        tableName,
        source: safeText(data.source) || rsvp.checkin_source || 'qr',
        ...social
      });
      res.json({
        success: true,
        checkedIn: true,
        alreadyCheckedIn: true,
        data: formatCheckinRsvp({
          ...rsvp,
          table_name: tableName,
          is_single: social.isSingle,
          instagram: social.instagram,
          show_social_on_wall: social.showSocialOnWall,
          wall_frame: social.wallFrame
        })
      });
      return;
    }

    await updateRsvpCheckin(lineUserId, {
      tableName,
      source: safeText(data.source) || 'qr',
      ...social
    });

    const checkin = await createCheckin({
      lineUserId,
      displayName: safeText(data.displayName || data.name),
      nickname: safeText(data.nickName || data.nickname),
      pictureUrl,
      source: safeText(data.source) || 'qr',
      tableName,
      ...social
    });

    res.json({ success: true, checkedIn: true, checkin });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/checkin/manual', async (req, res) => {
  const data = parseBody(req.body);
  const lineUserId = safeText(data.lineUserId || data.userId);
  const firstName = safeText(data.firstName);
  const lastName = safeText(data.lastName);
  const nickname = safeText(data.nickName || data.nickname);
  const displayName = safeText(data.name || data.displayName) || nickname || `${firstName} ${lastName}`.trim();
  if (!lineUserId && !displayName) {
    res.status(400).json({ success: false, error: 'name or lineUserId required' });
    return;
  }

  try {
    const source = safeText(data.source) || 'staff';
    const social = normalizeSocial(data);
    const tableName = safeText(data.tableName || data.table_name);

    if (lineUserId) {
      await pool.query(
        `INSERT INTO rsvp_submissions (
           line_user_id, first_name, last_name, nickname, full_name, phone, side,
           relationship, guests, dietary, message, session, picture_url, submitted_at,
           table_name, checked_in_at, checkin_source, is_single, instagram,
           show_social_on_wall, wall_frame
         )
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW(),$14,NOW(),$15,$16,$17,$18,$19)
         ON CONFLICT (line_user_id) DO UPDATE SET
           first_name = CASE WHEN EXCLUDED.first_name <> '' THEN EXCLUDED.first_name ELSE rsvp_submissions.first_name END,
           last_name = CASE WHEN EXCLUDED.last_name <> '' THEN EXCLUDED.last_name ELSE rsvp_submissions.last_name END,
           nickname = CASE WHEN EXCLUDED.nickname <> '' THEN EXCLUDED.nickname ELSE rsvp_submissions.nickname END,
           full_name = CASE WHEN EXCLUDED.full_name <> '' THEN EXCLUDED.full_name ELSE rsvp_submissions.full_name END,
           phone = CASE WHEN EXCLUDED.phone <> '' THEN EXCLUDED.phone ELSE rsvp_submissions.phone END,
           side = CASE WHEN EXCLUDED.side <> '' THEN EXCLUDED.side ELSE rsvp_submissions.side END,
           relationship = CASE WHEN EXCLUDED.relationship <> '' THEN EXCLUDED.relationship ELSE rsvp_submissions.relationship END,
           guests = EXCLUDED.guests,
           dietary = CASE WHEN EXCLUDED.dietary <> '' THEN EXCLUDED.dietary ELSE rsvp_submissions.dietary END,
           message = CASE WHEN EXCLUDED.message <> '' THEN EXCLUDED.message ELSE rsvp_submissions.message END,
           session = CASE WHEN EXCLUDED.session <> '' THEN EXCLUDED.session ELSE rsvp_submissions.session END,
           picture_url = CASE WHEN EXCLUDED.picture_url <> '' THEN EXCLUDED.picture_url ELSE rsvp_submissions.picture_url END,
           table_name = EXCLUDED.table_name,
           checked_in_at = COALESCE(rsvp_submissions.checked_in_at, NOW()),
           checkin_source = EXCLUDED.checkin_source,
           is_single = EXCLUDED.is_single,
           instagram = EXCLUDED.instagram,
           show_social_on_wall = EXCLUDED.show_social_on_wall,
           wall_frame = EXCLUDED.wall_frame`,
        [
          lineUserId,
          firstName,
          lastName,
          nickname,
          displayName,
          safeText(data.phone),
          safeText(data.side),
          safeText(data.relationship),
          safeGuests(data.guests),
          safeText(data.dietary),
          safeText(data.message),
          safeText(data.session),
          safeText(data.pictureUrl || data.photo),
          tableName,
          source,
          social.isSingle,
          social.instagram,
          social.showSocialOnWall,
          social.wallFrame
        ]
      );
    }

    const checkin = await createCheckin({
      lineUserId,
      displayName,
      nickname,
      pictureUrl: safeText(data.pictureUrl || data.photo),
      source,
      tableName,
      ...social
    });
    res.json({ success: true, checkedIn: true, checkin });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/debug/line-webhook', async (req, res) => {
  const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50));
  const userId = safeText(req.query.userId);
  const eventType = safeText(req.query.type);
  const beaconType = safeText(req.query.beaconType);
  const conditions = [];
  const params = [];

  if (userId) {
    params.push(userId);
    conditions.push(`line_user_id = $${params.length}`);
  }
  if (eventType) {
    params.push(eventType);
    conditions.push(`event_type = $${params.length}`);
  }
  if (beaconType) {
    params.push(beaconType);
    conditions.push(`beacon_type = $${params.length}`);
  }

  params.push(limit);
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  try {
    const result = await pool.query(
      `SELECT id, event_type, line_user_id, beacon_type, destination,
              event_payload, raw_payload, received_at
       FROM line_webhook_events
       ${where}
       ORDER BY received_at DESC
       LIMIT $${params.length}`,
      params
    );
    res.json({
      events: result.rows.map((row) => ({
        id: row.id,
        eventType: row.event_type,
        lineUserId: row.line_user_id,
        beaconType: row.beacon_type,
        destination: row.destination,
        receivedAt: row.received_at?.toISOString?.() || row.received_at || '',
        receivedAtBkk: formatBkk(row.received_at),
        event: row.event_payload,
        raw: row.raw_payload
      }))
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/seating/assign', async (req, res) => {
  const data = parseBody(req.body);
  const rawAssignments = Array.isArray(data.assignments) ? data.assignments : [data];
  const assignments = rawAssignments
    .map((item) => ({
      lineUserId: safeText(item.lineUserId || item.userId || item.lineUid),
      tableName: safeText(item.tableName || item.table_name)
    }))
    .filter((item) => item.lineUserId);

  if (!assignments.length) {
    res.status(400).json({ success: false, error: 'assignments required' });
    return;
  }

  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const item of assignments) {
        await client.query(
          `UPDATE rsvp_submissions
           SET table_name = $2
           WHERE line_user_id = $1`,
          [item.lineUserId, item.tableName]
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    res.json({ success: true, updated: assignments.length });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
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
           table_name,
           checked_in_at,
           checkin_source,
           is_single,
           instagram,
           show_social_on_wall,
           wall_frame,
           welcome_announced_at,
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
          tableName: row.table_name,
          checkedInAt: row.checked_in_at?.toISOString?.() || '',
          checkinSource: row.checkin_source,
          isSingle: row.is_single,
          instagram: row.instagram,
          showSocialOnWall: row.show_social_on_wall,
          wallFrame: row.wall_frame || 'classic',
          welcomeAnnouncedAt: row.welcome_announced_at?.toISOString?.() || '',
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
           table_name,
           checked_in_at,
           checkin_source,
           is_single,
           instagram,
           show_social_on_wall,
           wall_frame,
           welcome_announced_at,
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
        photo: r.picture_url || '',
        tableName: r.table_name,
        checkedInAt: r.checked_in_at?.toISOString?.() || '',
        checkinSource: r.checkin_source,
        isSingle: r.is_single,
        instagram: r.instagram,
        showSocialOnWall: r.show_social_on_wall,
        wallFrame: r.wall_frame || 'classic',
        welcomeAnnouncedAt: r.welcome_announced_at?.toISOString?.() || ''
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

function safeBool(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1;
  if (typeof value !== 'string') return false;
  return ['1', 'true', 'yes', 'y', 'on'].includes(value.trim().toLowerCase());
}

function safeInstagram(value) {
  return safeText(value).replace(/^@+/, '').replace(/[^a-zA-Z0-9._]/g, '').slice(0, 30);
}

function safeWallFrame(value) {
  const frame = safeText(value).toLowerCase();
  return ['classic', 'single', 'bride', 'groom', 'lucky'].includes(frame) ? frame : 'classic';
}

function normalizeSocial(data) {
  return {
    isSingle: safeBool(data.isSingle ?? data.is_single),
    instagram: safeInstagram(data.instagram),
    showSocialOnWall: safeBool(data.showSocialOnWall ?? data.show_social_on_wall),
    wallFrame: safeWallFrame(data.wallFrame ?? data.wall_frame)
  };
}

function formatBkk(value) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('th-TH', {
    timeZone: 'Asia/Bangkok',
    hour12: false
  });
}

async function recordLineWebhookEvents(data, events) {
  const destination = safeText(data?.destination);
  if (!events.length) {
    await pool.query(
      `INSERT INTO line_webhook_events
         (event_type, line_user_id, beacon_type, destination, event_payload, raw_payload)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)`,
      ['no-events', '', '', destination, '{}', JSON.stringify(data || {})]
    );
    return;
  }

  for (const event of events) {
    await pool.query(
      `INSERT INTO line_webhook_events
         (event_type, line_user_id, beacon_type, destination, event_payload, raw_payload)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)`,
      [
        safeText(event?.type),
        safeText(event?.source?.userId),
        safeText(event?.beacon?.type),
        destination,
        JSON.stringify(event || {}),
        JSON.stringify(data || {})
      ]
    );
  }
}

async function sendCheckinLink(event) {
  if (!lineChannelToken || !checkinLiffUrl || !event?.replyToken) return;
  const response = await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${lineChannelToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      replyToken: event.replyToken,
      messages: [
        {
          type: 'text',
          text: `ยินดีต้อนรับสู่งานแต่งงานของอันอันและอ๋องครับ\nกรุณากดเช็กอินเพื่อดูโต๊ะและขึ้น Welcome Screen:\n${checkinLiffUrl}`
        }
      ]
    })
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`LINE reply failed ${response.status}${text ? `: ${text}` : ''}`);
  }
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
    tableName: row.table_name || '',
    isSingle: Boolean(row.is_single),
    instagram: row.instagram || '',
    showSocialOnWall: Boolean(row.show_social_on_wall),
    wallFrame: row.wall_frame || 'classic',
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
    `SELECT line_user_id, first_name, last_name, nickname, full_name, picture_url,
            table_name, checked_in_at, checkin_source, is_single, instagram,
            show_social_on_wall, wall_frame, welcome_announced_at
     FROM rsvp_submissions
     WHERE line_user_id = $1`,
    [lineUserId]
  );
  return result.rows[0] || null;
}

async function getCheckinRsvp(lineUserId) {
  return lookupRsvp(lineUserId);
}

function formatCheckinRsvp(row) {
  return {
    lineUserId: row.line_user_id,
    firstName: row.first_name,
    lastName: row.last_name,
    nickName: row.nickname,
    nickname: row.nickname,
    name: row.full_name,
    photo: row.picture_url || '',
    tableName: row.table_name || '',
    checkedInAt: row.checked_in_at?.toISOString?.() || '',
    checkinSource: row.checkin_source || '',
    isSingle: Boolean(row.is_single),
    instagram: row.instagram || '',
    showSocialOnWall: Boolean(row.show_social_on_wall),
    wallFrame: row.wall_frame || 'classic',
    welcomeAnnouncedAt: row.welcome_announced_at?.toISOString?.() || ''
  };
}

async function updateRsvpCheckin(lineUserId, { tableName, source, isSingle, instagram, showSocialOnWall, wallFrame }) {
  await pool.query(
    `UPDATE rsvp_submissions
     SET table_name = $2,
         checked_in_at = COALESCE(checked_in_at, NOW()),
         checkin_source = $3,
         is_single = $4,
         instagram = $5,
         show_social_on_wall = $6,
         wall_frame = $7
     WHERE line_user_id = $1`,
    [
      lineUserId,
      safeText(tableName),
      safeText(source),
      Boolean(isSingle),
      safeInstagram(instagram),
      Boolean(showSocialOnWall),
      safeWallFrame(wallFrame)
    ]
  );
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

async function createCheckin({
  lineUserId,
  displayName,
  nickname,
  pictureUrl,
  source,
  beaconType,
  tableName,
  isSingle,
  instagram,
  showSocialOnWall,
  wallFrame
}) {
  const rsvp = await lookupRsvp(lineUserId);
  const rsvpPicture = safeText(rsvp?.picture_url);
  // Fetch LINE profile if we still need a picture (rsvp missing or no picture)
  const needsLineLookup = lineUserId && (!rsvp || !rsvpPicture);
  const profile = needsLineLookup ? await lookupLineProfile(lineUserId) : null;

  const resolvedNickname = safeText(nickname) || safeText(rsvp?.nickname);
  const resolvedDisplayName =
    safeText(displayName) ||
    resolvedNickname ||
    safeText(rsvp?.full_name) ||
    safeText(profile?.displayName) ||
    'Guest';
  const resolvedPictureUrl =
    safeText(pictureUrl) ||
    rsvpPicture ||
    safeText(profile?.pictureUrl);
  const resolvedTableName = safeText(tableName) || safeText(rsvp?.table_name);
  const resolvedInstagram = safeInstagram(instagram || rsvp?.instagram);
  const resolvedIsSingle = Boolean(isSingle ?? rsvp?.is_single);
  const resolvedShowSocialOnWall = Boolean(showSocialOnWall ?? rsvp?.show_social_on_wall);
  const resolvedWallFrame = safeWallFrame(wallFrame || rsvp?.wall_frame);

  if (lineUserId) {
    const recent = await pool.query(
      `SELECT id, line_user_id, display_name, nickname, picture_url, source, beacon_type,
              table_name, is_single, instagram, show_social_on_wall, wall_frame, checked_in_at
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

  const shouldBroadcast = !lineUserId || !rsvp?.welcome_announced_at;
  const result = await pool.query(
    `INSERT INTO checkins (
       line_user_id, display_name, nickname, picture_url, source, beacon_type,
       table_name, is_single, instagram, show_social_on_wall, wall_frame, checked_in_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
     RETURNING id, line_user_id, display_name, nickname, picture_url, source, beacon_type,
               table_name, is_single, instagram, show_social_on_wall, wall_frame, checked_in_at`,
    [
      safeText(lineUserId),
      resolvedDisplayName,
      resolvedNickname,
      resolvedPictureUrl,
      safeText(source),
      safeText(beaconType),
      resolvedTableName,
      resolvedIsSingle,
      resolvedInstagram,
      resolvedShowSocialOnWall,
      resolvedWallFrame
    ]
  );

  const checkin = formatCheckin(result.rows[0]);
  if (shouldBroadcast) {
    broadcastWelcome(checkin);
    if (lineUserId) {
      await pool.query(
        `UPDATE rsvp_submissions
         SET welcome_announced_at = COALESCE(welcome_announced_at, NOW())
         WHERE line_user_id = $1`,
        [lineUserId]
      );
    }
  }
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

app.get('/seating-map', async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT map_mime, map_data, updated_at
       FROM seating_maps
       WHERE map_key = 'main'
       LIMIT 1`
    );
    if (result.rowCount === 0 || !result.rows[0].map_data) {
      res.json({ map: null });
      return;
    }
    const row = result.rows[0];
    res.json({
      map: {
        mime: row.map_mime,
        data: row.map_data,
        updatedAt: row.updated_at?.toISOString?.() || row.updated_at || ''
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/seating-map', async (req, res) => {
  const data = parseBody(req.body);
  const mapBase64 = typeof data.mapBase64 === 'string' ? data.mapBase64.trim() : '';
  const mapMime = safeText(data.mapMime) || 'image/jpeg';

  if (!mapBase64) {
    res.status(400).json({ success: false, error: 'map image required' });
    return;
  }
  if (!mapMime.startsWith('image/')) {
    res.status(400).json({ success: false, error: 'image file required' });
    return;
  }
  if (mapBase64.length > 8 * 1024 * 1024) {
    res.status(400).json({ success: false, error: 'map image too large' });
    return;
  }

  try {
    await pool.query(
      `INSERT INTO seating_maps (map_key, map_mime, map_data, updated_at)
       VALUES ('main', $1, $2, NOW())
       ON CONFLICT (map_key) DO UPDATE SET
         map_mime = EXCLUDED.map_mime,
         map_data = EXCLUDED.map_data,
         updated_at = NOW()`,
      [mapMime, mapBase64]
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
