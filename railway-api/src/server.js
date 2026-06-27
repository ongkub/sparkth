import express from 'express';
import pg from 'pg';

const { Pool } = pg;
const app = express();

const port = Number(process.env.PORT || 3000);
const databaseUrl = process.env.DATABASE_URL;
const lineChannelToken = process.env.LINE_CHANNEL_TOKEN || '';
const checkinLiffUrl = process.env.CHECKIN_LIFF_URL || 'https://liff.line.me/2006674119-Y1d35qvg';

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
const WALL_FRAME_PRESETS = [
  { key: 'classic', label: 'Classic' },
  { key: 'single', label: 'Single' },
  { key: 'bride', label: 'Bride Side' },
  { key: 'groom', label: 'Groom Side' },
  { key: 'lucky', label: 'Lucky / Game' }
];
const WALL_FRAME_KEYS = new Set(WALL_FRAME_PRESETS.map((preset) => preset.key));
const WALL_FRAME_LABELS = new Map(WALL_FRAME_PRESETS.map((preset) => [preset.key, preset.label]));

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
    `ALTER TABLE slip_submissions ADD COLUMN IF NOT EXISTS line_user_id TEXT NOT NULL DEFAULT ''`
  );
  await pool.query(
    `ALTER TABLE slip_submissions ADD COLUMN IF NOT EXISTS display_name TEXT NOT NULL DEFAULT ''`
  );
  await pool.query(
    `ALTER TABLE slip_submissions ADD COLUMN IF NOT EXISTS picture_url TEXT NOT NULL DEFAULT ''`
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
    `ALTER TABLE checkins
     ADD COLUMN IF NOT EXISTS custom_photo TEXT NOT NULL DEFAULT ''`
  );
  await pool.query(
    `ALTER TABLE checkins
     ADD COLUMN IF NOT EXISTS gender TEXT NOT NULL DEFAULT ''`
  );
  await pool.query(
    `ALTER TABLE checkins
     ADD COLUMN IF NOT EXISTS gender_pref TEXT NOT NULL DEFAULT ''`
  );
  await pool.query(
    `ALTER TABLE rsvp_submissions
     ADD COLUMN IF NOT EXISTS custom_photo TEXT NOT NULL DEFAULT ''`
  );
  await pool.query(
    `ALTER TABLE rsvp_submissions
     ADD COLUMN IF NOT EXISTS gender TEXT NOT NULL DEFAULT ''`
  );
  await pool.query(
    `ALTER TABLE rsvp_submissions
     ADD COLUMN IF NOT EXISTS gender_pref TEXT NOT NULL DEFAULT ''`
  );
  await pool.query(
    `CREATE TABLE IF NOT EXISTS swipes (
       id BIGSERIAL PRIMARY KEY,
       from_user_id TEXT NOT NULL,
       to_user_id TEXT NOT NULL,
       liked BOOLEAN NOT NULL DEFAULT false,
       swiped_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`
  );
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_swipes_pair ON swipes (from_user_id, to_user_id)`
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
  await pool.query(
    `CREATE TABLE IF NOT EXISTS frame_templates (
       frame_key TEXT PRIMARY KEY,
       frame_label TEXT NOT NULL DEFAULT '',
       frame_mime TEXT NOT NULL DEFAULT 'image/png',
       frame_data TEXT NOT NULL DEFAULT '',
       updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`
  );
  await pool.query(
    `CREATE TABLE IF NOT EXISTS app_config (
       key TEXT PRIMARY KEY,
       value TEXT NOT NULL DEFAULT '',
       updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`
  );
  await pool.query(
    `CREATE TABLE IF NOT EXISTS payment_qr (
       qr_key TEXT PRIMARY KEY,
       qr_mime TEXT NOT NULL DEFAULT 'image/jpeg',
       qr_data TEXT NOT NULL DEFAULT '',
       updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`
  );
  await pool.query(
    `CREATE TABLE IF NOT EXISTS wedding_run_plays (
       id BIGSERIAL PRIMARY KEY,
       line_uid TEXT NOT NULL,
       display_name TEXT,
       picture_url TEXT,
       score INTEGER NOT NULL DEFAULT 0,
       hearts_collected INTEGER NOT NULL DEFAULT 0,
       collisions INTEGER NOT NULL DEFAULT 0,
       elapsed_seconds NUMERIC(10,2) NOT NULL DEFAULT 0,
       difficulty TEXT NOT NULL DEFAULT 'normal',
       completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_wedding_run_plays_line_uid
     ON wedding_run_plays (line_uid, score DESC)`
  );
  await pool.query(
    `CREATE TABLE IF NOT EXISTS scratch_lottery (
       id INTEGER PRIMARY KEY,
       is_active BOOLEAN NOT NULL DEFAULT false,
       prize_label TEXT NOT NULL DEFAULT 'ของรางวัลพิเศษ',
       winner_uid TEXT,
       winner_display_name TEXT,
       winner_picture_url TEXT,
       won_at TIMESTAMPTZ,
       updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`
  );
  await pool.query(`ALTER TABLE scratch_lottery ADD COLUMN IF NOT EXISTS card_image_url TEXT`);
  await pool.query(`INSERT INTO scratch_lottery (id) VALUES (1) ON CONFLICT DO NOTHING`);
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
      if (safeText(data.source) === 'walkin') {
        const nickname = safeText(data.nickName || data.nickname || data.displayName);
        if (!nickname) {
          res.status(400).json({ success: false, error: 'displayName required for walk-in' });
          return;
        }
        const checkin = await createCheckin({
          lineUserId,
          displayName: nickname,
          nickname,
          pictureUrl: safeText(data.pictureUrl || data.photo),
          source: 'walkin',
          tableName: '',
        });
        res.json({ success: true, checkedIn: true, walkIn: true, checkin });
        return;
      }
      res.status(404).json({ success: false, error: 'rsvp_not_found' });
      return;
    }

    const social = normalizeSocial(data);
    const tableName = safeText(data.tableName || data.table_name || rsvp.table_name);
    const pictureUrl = safeText(data.pictureUrl || data.photo || rsvp.picture_url);
    const customPhoto = safeText(data.customPhoto) || '';
    if (rsvp.checked_in_at) {
      await updateRsvpCheckin(lineUserId, {
        tableName,
        source: safeText(data.source) || rsvp.checkin_source || 'qr',
        ...social,
        customPhoto
      });
      // Broadcast profile update to welcome wall
      const updated = await pool.query(
        `UPDATE checkins
         SET is_single = $2, instagram = $3, show_social_on_wall = $4, wall_frame = $5,
             custom_photo = CASE WHEN $6 <> '' THEN $6 ELSE custom_photo END
         WHERE id = (
           SELECT id FROM checkins WHERE line_user_id = $1 ORDER BY checked_in_at DESC LIMIT 1
         )
         RETURNING id, line_user_id, display_name, nickname, picture_url, source, beacon_type,
                   table_name, is_single, instagram, show_social_on_wall, wall_frame, custom_photo, checked_in_at`,
        [lineUserId, social.isSingle, social.instagram, social.showSocialOnWall, social.wallFrame, customPhoto]
      );
      if (updated.rowCount > 0) broadcastWelcome(formatCheckin(updated.rows[0]));
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
          wall_frame: social.wallFrame,
          custom_photo: customPhoto || rsvp.custom_photo
        })
      });
      return;
    }

    await updateRsvpCheckin(lineUserId, {
      tableName,
      source: safeText(data.source) || 'qr',
      ...social,
      customPhoto
    });

    const checkin = await createCheckin({
      lineUserId,
      displayName: safeText(data.displayName || data.name),
      nickname: safeText(data.nickName || data.nickname),
      pictureUrl,
      source: safeText(data.source) || 'qr',
      tableName,
      ...social,
      customPhoto
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

function safeGender(value) {
  return ['male', 'female', 'other'].includes(safeText(value)) ? safeText(value) : '';
}

function safeGenderPref(value) {
  return ['male', 'female', 'both'].includes(safeText(value)) ? safeText(value) : '';
}

function safeWallFrame(value) {
  const frame = safeText(value).toLowerCase();
  return WALL_FRAME_KEYS.has(frame) ? frame : 'classic';
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
  const cfgResult = await pool.query(
    `SELECT key, value FROM app_config WHERE key IN ('beacon_message', 'beacon_enabled')`
  ).catch(() => ({ rows: [] }));
  const cfg = Object.fromEntries(cfgResult.rows.map(r => [r.key, r.value]));
  if (cfg.beacon_enabled === 'false') return;
  const template = cfg.beacon_message || BEACON_MESSAGE_DEFAULT;
  const text = template.replace('{url}', checkinLiffUrl);
  const response = await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${lineChannelToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      replyToken: event.replyToken,
      messages: [{ type: 'text', text }]
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
    customPhoto: row.custom_photo || '',
    source: row.source,
    beaconType: row.beacon_type,
    tableName: row.table_name || '',
    isSingle: Boolean(row.is_single),
    instagram: row.instagram || '',
    showSocialOnWall: Boolean(row.show_social_on_wall),
    wallFrame: row.wall_frame || 'classic',
    gender: row.gender || '',
    genderPref: row.gender_pref || '',
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
            show_social_on_wall, wall_frame, welcome_announced_at, custom_photo,
            gender, gender_pref
     FROM rsvp_submissions
     WHERE line_user_id = $1`,
    [lineUserId]
  );
  if (result.rows[0]) return result.rows[0];

  // Fallback: walk-in users have a checkins record but no rsvp_submissions row
  const ci = await pool.query(
    `SELECT line_user_id,
            '' AS first_name, '' AS last_name,
            COALESCE(NULLIF(nickname,''), display_name) AS nickname,
            display_name AS full_name,
            picture_url, table_name, checked_in_at,
            source AS checkin_source,
            is_single, instagram, show_social_on_wall, wall_frame,
            NULL AS welcome_announced_at,
            custom_photo, gender, gender_pref
     FROM checkins
     WHERE line_user_id = $1
     ORDER BY checked_in_at DESC
     LIMIT 1`,
    [lineUserId]
  );
  return ci.rows[0] || null;
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
    customPhoto: row.custom_photo || '',
    tableName: row.table_name || '',
    checkedInAt: row.checked_in_at?.toISOString?.() || '',
    checkinSource: row.checkin_source || '',
    isSingle: Boolean(row.is_single),
    instagram: row.instagram || '',
    showSocialOnWall: Boolean(row.show_social_on_wall),
    wallFrame: row.wall_frame || 'classic',
    gender: row.gender || '',
    genderPref: row.gender_pref || '',
    welcomeAnnouncedAt: row.welcome_announced_at?.toISOString?.() || ''
  };
}

async function updateRsvpCheckin(lineUserId, { tableName, source, isSingle, instagram, showSocialOnWall, wallFrame, customPhoto }) {
  await pool.query(
    `UPDATE rsvp_submissions
     SET table_name = $2,
         checked_in_at = COALESCE(checked_in_at, NOW()),
         checkin_source = $3,
         is_single = $4,
         instagram = $5,
         show_social_on_wall = $6,
         wall_frame = $7,
         custom_photo = CASE WHEN $8 <> '' THEN $8 ELSE custom_photo END
     WHERE line_user_id = $1`,
    [
      lineUserId,
      safeText(tableName),
      safeText(source),
      Boolean(isSingle),
      safeInstagram(instagram),
      Boolean(showSocialOnWall),
      safeWallFrame(wallFrame),
      safeText(customPhoto) || ''
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
  wallFrame,
  customPhoto
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
              table_name, is_single, instagram, show_social_on_wall, wall_frame, checked_in_at, custom_photo
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
  const resolvedCustomPhoto = safeText(customPhoto) || '';
  const result = await pool.query(
    `INSERT INTO checkins (
       line_user_id, display_name, nickname, picture_url, source, beacon_type,
       table_name, is_single, instagram, show_social_on_wall, wall_frame, custom_photo, checked_in_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
     RETURNING id, line_user_id, display_name, nickname, picture_url, source, beacon_type,
               table_name, is_single, instagram, show_social_on_wall, wall_frame, custom_photo, checked_in_at`,
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
      resolvedWallFrame,
      resolvedCustomPhoto
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
      `SELECT id, nickname, side, line_user_id, display_name, picture_url, slip_mime, submitted_at
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
      `SELECT id, nickname, side, line_user_id, display_name, picture_url, slip_mime, slip_data, submitted_at
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
  const lineUserId = safeText(data.lineUserId || data.line_user_id);
  const displayName = safeText(data.displayName || data.display_name);
  const pictureUrl = safeText(data.pictureUrl || data.picture_url);
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
      `INSERT INTO slip_submissions
         (nickname, side, line_user_id, display_name, picture_url, slip_mime, slip_data, submitted_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
      [nickname, side, lineUserId, displayName, pictureUrl, slipMime, slipBase64]
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

app.get('/frame-templates', async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT frame_key, frame_label, frame_mime, frame_data, updated_at
       FROM frame_templates
       ORDER BY frame_key`
    );
    const templatesByKey = new Map(result.rows.map((row) => [row.frame_key, row]));
    res.json({
      presets: WALL_FRAME_PRESETS,
      templates: WALL_FRAME_PRESETS.map((preset) => {
        const row = templatesByKey.get(preset.key);
        return {
          frameKey: preset.key,
          label: row?.frame_label || preset.label,
          mime: row?.frame_mime || 'image/png',
          data: row?.frame_data || '',
          updatedAt: row?.updated_at?.toISOString?.() || row?.updated_at || ''
        };
      })
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/frame-templates', async (req, res) => {
  const data = parseBody(req.body);
  const frameKey = safeWallFrame(data.frameKey || data.frame_key);
  const label =
    safeText(data.label || data.frameLabel || data.frame_label) ||
    WALL_FRAME_LABELS.get(frameKey) ||
    frameKey;
  const frameBase64 = typeof data.frameBase64 === 'string' ? data.frameBase64.trim() : '';
  const frameMime = safeText(data.frameMime) || 'image/png';

  if (!frameBase64) {
    res.status(400).json({ success: false, error: 'frame image required' });
    return;
  }
  if (!frameMime.startsWith('image/')) {
    res.status(400).json({ success: false, error: 'image file required' });
    return;
  }
  if (frameBase64.length > 8 * 1024 * 1024) {
    res.status(400).json({ success: false, error: 'frame image too large' });
    return;
  }

  try {
    await pool.query(
      `INSERT INTO frame_templates (frame_key, frame_label, frame_mime, frame_data, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (frame_key) DO UPDATE SET
         frame_label = EXCLUDED.frame_label,
         frame_mime = EXCLUDED.frame_mime,
         frame_data = EXCLUDED.frame_data,
         updated_at = NOW()`,
      [frameKey, label, frameMime, frameBase64]
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/payment-qr', async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT qr_mime, qr_data, updated_at FROM payment_qr WHERE qr_key = 'main' LIMIT 1`
    );
    if (result.rowCount === 0 || !result.rows[0].qr_data) {
      res.json({ qr: null });
      return;
    }
    const row = result.rows[0];
    res.json({
      qr: {
        mime: row.qr_mime,
        data: row.qr_data,
        updatedAt: row.updated_at?.toISOString?.() || row.updated_at || ''
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/payment-qr', async (req, res) => {
  const data = parseBody(req.body);
  const qrBase64 = typeof data.qrBase64 === 'string' ? data.qrBase64.trim() : '';
  const qrMime = safeText(data.qrMime) || 'image/jpeg';

  if (!qrBase64) {
    res.status(400).json({ success: false, error: 'qr image required' });
    return;
  }
  if (!qrMime.startsWith('image/')) {
    res.status(400).json({ success: false, error: 'image file required' });
    return;
  }
  if (qrBase64.length > 8 * 1024 * 1024) {
    res.status(400).json({ success: false, error: 'qr image too large' });
    return;
  }

  try {
    await pool.query(
      `INSERT INTO payment_qr (qr_key, qr_mime, qr_data, updated_at)
       VALUES ('main', $1, $2, NOW())
       ON CONFLICT (qr_key) DO UPDATE SET
         qr_mime = EXCLUDED.qr_mime,
         qr_data = EXCLUDED.qr_data,
         updated_at = NOW()`,
      [qrMime, qrBase64]
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

const BEACON_MESSAGE_DEFAULT = `ยินดีต้อนรับสู่งานแต่งงานของอันอันและอ๋องครับ\nกรุณากดเช็กอินเพื่อดูโต๊ะและขึ้น Welcome Screen:\n{url}`;

app.get('/beacon-config', async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT key, value FROM app_config WHERE key IN ('beacon_message', 'beacon_enabled')`
    );
    const cfg = Object.fromEntries(result.rows.map(r => [r.key, r.value]));
    res.json({
      success: true,
      message: cfg.beacon_message ?? BEACON_MESSAGE_DEFAULT,
      enabled: cfg.beacon_enabled !== 'false',
      checkinUrl: checkinLiffUrl
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/beacon-config', async (req, res) => {
  const data = parseBody(req.body);
  const message = typeof data.message === 'string' ? data.message.slice(0, 1000) : null;
  const enabled = data.enabled !== false && data.enabled !== 'false';
  try {
    if (message !== null) {
      await pool.query(
        `INSERT INTO app_config (key, value, updated_at) VALUES ('beacon_message', $1, NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [message]
      );
    }
    await pool.query(
      `INSERT INTO app_config (key, value, updated_at) VALUES ('beacon_enabled', $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [enabled ? 'true' : 'false']
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ── Singles / Swipe / Matches ──────────────────────────────────────────────

app.get('/singles', async (req, res) => {
  const userId = safeText(req.query.userId);
  if (!userId) return res.status(400).json({ success: false, error: 'userId required' });
  try {
    const me = await lookupRsvp(userId);
    if (!me || !me.is_single) {
      return res.json({ success: true, singles: [], locked: true });
    }
    const genderPref = safeGenderPref(me.gender_pref);
    const params = [userId];
    let genderClause = '';
    if (genderPref && genderPref !== 'both') {
      params.push(genderPref);
      genderClause = `AND c.gender = $${params.length}`;
    }
    const result = await pool.query(
      `SELECT DISTINCT ON (c.line_user_id)
         c.line_user_id    AS "lineUserId",
         c.display_name    AS "displayName",
         c.nickname        AS "nickName",
         c.picture_url     AS "pictureUrl",
         c.custom_photo    AS "customPhoto",
         c.instagram,
         c.gender,
         c.gender_pref     AS "genderPref"
       FROM checkins c
       WHERE c.is_single = true
         AND c.line_user_id <> ''
         AND c.line_user_id <> $1
         ${genderClause}
         AND c.line_user_id NOT IN (
           SELECT to_user_id FROM swipes WHERE from_user_id = $1
         )
       ORDER BY c.line_user_id, c.checked_in_at DESC`,
      params
    );
    const singles = result.rows.sort(() => Math.random() - 0.5);
    res.json({ success: true, singles, locked: false });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/swipe', async (req, res) => {
  const data = parseBody(req.body);
  const fromUserId = safeText(data.fromUserId);
  const toUserId = safeText(data.toUserId);
  const liked = Boolean(data.liked);
  if (!fromUserId || !toUserId) {
    return res.status(400).json({ success: false, error: 'fromUserId and toUserId required' });
  }
  try {
    await pool.query(
      `INSERT INTO swipes (from_user_id, to_user_id, liked)
       VALUES ($1, $2, $3)
       ON CONFLICT (from_user_id, to_user_id)
       DO UPDATE SET liked = EXCLUDED.liked, swiped_at = NOW()`,
      [fromUserId, toUserId, liked]
    );
    let matched = false;
    if (liked) {
      const check = await pool.query(
        `SELECT 1 FROM swipes WHERE from_user_id = $1 AND to_user_id = $2 AND liked = true`,
        [toUserId, fromUserId]
      );
      matched = check.rowCount > 0;
    }
    res.json({ success: true, matched });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/matches', async (req, res) => {
  const userId = safeText(req.query.userId);
  if (!userId) return res.status(400).json({ success: false, error: 'userId required' });
  try {
    const result = await pool.query(
      `SELECT DISTINCT ON (c.line_user_id)
         c.line_user_id    AS "lineUserId",
         c.display_name    AS "displayName",
         c.nickname        AS "nickName",
         c.picture_url     AS "pictureUrl",
         c.custom_photo    AS "customPhoto",
         c.instagram,
         c.show_social_on_wall AS "showSocialOnWall",
         s1.swiped_at      AS "matchedAt"
       FROM swipes s1
       JOIN swipes s2 ON s2.from_user_id = s1.to_user_id
                      AND s2.to_user_id = s1.from_user_id
                      AND s2.liked = true
       JOIN checkins c ON c.line_user_id = s1.to_user_id
       WHERE s1.from_user_id = $1
         AND s1.liked = true
       ORDER BY c.line_user_id, c.checked_in_at DESC`,
      [userId]
    );
    res.json({ success: true, matches: result.rows });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/profile', async (req, res) => {
  const data = parseBody(req.body);
  const lineUserId = safeText(data.lineUserId || data.userId);
  if (!lineUserId) return res.status(400).json({ success: false, error: 'userId required' });
  try {
    const isSingle = Boolean(data.isSingle);
    const gender = safeGender(data.gender);
    const genderPref = safeGenderPref(data.genderPref);
    const instagram = safeInstagram(data.instagram);
    const customPhoto = safeText(data.customPhoto) || '';
    await pool.query(
      `UPDATE rsvp_submissions
       SET is_single = $2, gender = $3, gender_pref = $4, instagram = $5,
           custom_photo = CASE WHEN $6 <> '' THEN $6 ELSE custom_photo END
       WHERE line_user_id = $1`,
      [lineUserId, isSingle, gender, genderPref, instagram, customPhoto]
    );
    const updated = await pool.query(
      `UPDATE checkins
       SET is_single = $2, gender = $3, gender_pref = $4, instagram = $5,
           custom_photo = CASE WHEN $6 <> '' THEN $6 ELSE custom_photo END
       WHERE id = (
         SELECT id FROM checkins WHERE line_user_id = $1 ORDER BY checked_in_at DESC LIMIT 1
       )
       RETURNING id, line_user_id, display_name, nickname, picture_url, source, beacon_type,
                 table_name, is_single, instagram, show_social_on_wall, wall_frame,
                 custom_photo, gender, gender_pref, checked_in_at`,
      [lineUserId, isSingle, gender, genderPref, instagram, customPhoto]
    );
    if (updated.rowCount > 0) broadcastWelcome(formatCheckin(updated.rows[0]));
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ── Scratch: GET /scratch/status ─────────────────────────
app.get('/scratch/status', async (_req, res) => {
  try {
    const r = await pool.query(`SELECT * FROM scratch_lottery WHERE id = 1`);
    const row = r.rows[0];
    if (!row) return res.json({ success: true, is_active: false, prize_label: 'ของรางวัลพิเศษ', has_winner: false });
    res.json({
      success: true,
      is_active: row.is_active,
      prize_label: row.prize_label,
      card_image_url: row.card_image_url || null,
      has_winner: !!row.winner_uid,
      winner_display_name: row.winner_display_name || null,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ── Scratch: POST /scratch/claim ──────────────────────────
app.post('/scratch/claim', async (req, res) => {
  const data = parseBody(req.body);
  const uid         = safeText(data.uid || '');
  const displayName = safeText(data.display_name || '') || null;
  const pictureUrl  = safeText(data.picture_url || '') || null;
  try {
    // Atomic: only update if game is active and no winner yet
    const claim = await pool.query(
      `UPDATE scratch_lottery
       SET winner_uid = $1, winner_display_name = $2, winner_picture_url = $3,
           won_at = NOW(), updated_at = NOW()
       WHERE id = 1 AND is_active = true AND winner_uid IS NULL
       RETURNING prize_label`,
      [uid || null, displayName, pictureUrl]
    );
    if (claim.rowCount > 0) {
      return res.json({ success: true, won: true, prize_label: claim.rows[0].prize_label });
    }
    // Already has a winner — return their name
    const cur = await pool.query(`SELECT winner_display_name, winner_picture_url FROM scratch_lottery WHERE id = 1`);
    const w = cur.rows[0] || {};
    res.json({ success: true, won: false, winner_display_name: w.winner_display_name || null, winner_picture_url: w.winner_picture_url || null });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ── Scratch admin: GET /scratch/admin/info ────────────────
app.get('/scratch/admin/info', async (_req, res) => {
  try {
    const r = await pool.query(`SELECT * FROM scratch_lottery WHERE id = 1`);
    const row = r.rows[0] || {};
    res.json({ success: true, ...row });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ── Scratch admin: POST /scratch/admin/setup ──────────────
app.post('/scratch/admin/setup', async (req, res) => {
  const data = parseBody(req.body);
  const isActive    = Boolean(data.is_active);
  const prizeLabel  = safeText(data.prize_label || 'ของรางวัลพิเศษ') || 'ของรางวัลพิเศษ';
  const hasImage    = 'card_image_url' in data;
  const cardImage   = hasImage ? (data.card_image_url || null) : undefined;
  try {
    if (hasImage) {
      await pool.query(
        `UPDATE scratch_lottery SET is_active = $1, prize_label = $2, card_image_url = $3, updated_at = NOW() WHERE id = 1`,
        [isActive, prizeLabel, cardImage]
      );
    } else {
      await pool.query(
        `UPDATE scratch_lottery SET is_active = $1, prize_label = $2, updated_at = NOW() WHERE id = 1`,
        [isActive, prizeLabel]
      );
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ── Scratch admin: POST /scratch/admin/reset ──────────────
app.post('/scratch/admin/reset', async (_req, res) => {
  try {
    await pool.query(
      `UPDATE scratch_lottery
       SET winner_uid = NULL, winner_display_name = NULL, winner_picture_url = NULL,
           won_at = NULL, updated_at = NOW()
       WHERE id = 1`
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ── Game: POST /game/finish ───────────────────────────────
app.post('/game/finish', async (req, res) => {
  const data = parseBody(req.body);
  const lineUid = safeText(data.line_uid || data.lineUid || '');
  if (!lineUid) return res.status(400).json({ success: false, error: 'line_uid required' });

  const score = Number(data.score ?? 0);
  if (!Number.isFinite(score) || score < 0) return res.status(400).json({ success: false, error: 'invalid score' });

  try {
    await pool.query(
      `INSERT INTO wedding_run_plays
         (line_uid, display_name, picture_url, score, hearts_collected, collisions, elapsed_seconds, difficulty)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        lineUid,
        safeText(data.display_name || '') || null,
        safeText(data.picture_url || '') || null,
        Math.round(score),
        Number(data.hearts_collected ?? 0),
        Number(data.collisions ?? 0),
        Number(data.elapsed_seconds ?? 0),
        ['normal','hard'].includes(data.difficulty) ? data.difficulty : 'normal',
      ]
    );
    const bestRes = await pool.query(
      `SELECT MAX(score) AS best FROM wedding_run_plays WHERE line_uid = $1`,
      [lineUid]
    );
    const bestScore = Number(bestRes.rows[0]?.best ?? score);
    res.json({ success: true, score: Math.round(score), best_score: bestScore });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ── Game: GET /game/leaderboard ───────────────────────────
app.get('/game/leaderboard', async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT DISTINCT ON (line_uid)
         line_uid, display_name, picture_url, score, difficulty, completed_at
       FROM wedding_run_plays
       ORDER BY line_uid, score DESC, completed_at DESC`
    );
    const ranked = result.rows
      .sort((a, b) => b.score - a.score)
      .slice(0, 50)
      .map((r, i) => ({
        rank: i + 1,
        line_uid: r.line_uid,
        display_name: r.display_name || '',
        picture_url: r.picture_url || '',
        score: r.score,
        difficulty: r.difficulty,
        completed_at: r.completed_at?.toISOString?.() || '',
      }));
    res.json({ success: true, leaderboard: ranked });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ── Game: GET /game/status ────────────────────────────────
app.get('/game/status', async (req, res) => {
  const lineUid = safeText(req.query.line_uid || req.query.uid || '');
  if (!lineUid) return res.status(400).json({ success: false, error: 'line_uid required' });
  try {
    const result = await pool.query(
      `SELECT MAX(score) AS best, COUNT(*)::int AS plays
       FROM wedding_run_plays WHERE line_uid = $1`,
      [lineUid]
    );
    const best = Number(result.rows[0]?.best ?? 0);
    const plays = Number(result.rows[0]?.plays ?? 0);
    res.json({ success: true, best_score: best, plays, already_played: plays > 0 });
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
