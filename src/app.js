const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const { pool } = require('./db');
const { getAdminConsolePath } = require('./adminStatic');
 
const APP_PORT = 8080;
const SENSOR_SHARED_SECRET = '';
const SUPER_ADMIN_NAME = 'Admin User';
const SUPER_ADMIN_EMAIL = 'admin@example.com';
const SUPER_ADMIN_PIN = '123456';
const GEMINI_API_KEY = 'AIzaSyBvo8Sn5aJbELzBqN3UJBNZO9T2vWZOC00';

const app = express();
const port = APP_PORT;
const sensorSecret = SENSOR_SHARED_SECRET;
const DEFAULT_SENSOR_METRIC = 'power';
const superAdminName = SUPER_ADMIN_NAME;
const superAdminEmail = SUPER_ADMIN_EMAIL;
const superAdminPin = SUPER_ADMIN_PIN;
const geminiApiKey = GEMINI_API_KEY;
const adminSessions = new Map();
const ADMIN_SESSION_TTL = 1000 * 60 * 60 * 8; // 8 hours

app.use(bodyParser.json({ limit: '1mb' }));

const adminConsolePath = getAdminConsolePath();
app.use('/admin/console', express.static(adminConsolePath));
app.get('/admin', (_req, res) => res.redirect('/admin/console/'));

const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent';

function buildPrompt(userText) {
  return `You are Smart Home By Nafisa Tabasum voice assistant.
You can answer general questions and also control of doors and devices. Always end your reply with a single JSON command on the last line only.

If the user is asking a general question, use the 'none' action.

Supported JSON schema (choose one):
- {"action":"door.lock|door.unlock|door.lock_all|door.unlock_all","door":"main|front|back|garage|bathroom|room1|hall|kitchen|bedroom|*","say":"..."}
- {"action":"device.set","room":"hall|kitchen|bedroom|bathroom|room1","device":"light|ac|fan","value":"on|off","say":"..."}
- {"action":"none","say":"..."}

Rules:
- Only output one JSON object on the last line (no code fences, no extra text after it).
- Do not prefix the JSON with words like json or wrap it in any quotes or fences.
- For "home light" assume room=hall.
- For generic lights with no room specified, prefer room=hall.

User: ${userText}`;
}

function sanitizeJsonCandidate(candidate = '') {
  return candidate
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .replace(/^json\b[\s:=-]*/i, '')
    .replace(/^`+|`+$/g, '')
    .trim();
}

function parseLooseKeyValues(candidate = '') {
  const cleaned = sanitizeJsonCandidate(candidate);
  if (!cleaned) return null;
  const pairs = [...cleaned.matchAll(/"([a-zA-Z0-9_.-]+)"\s*:?\s*"([^"\n]*)"/g)];
  if (!pairs.length) return null;
  const result = {};
  for (const [, key, value] of pairs) {
    result[key] = value;
  }
  if (!result.action && !result.say) return null;
  return result;
}

function findJsonCommandBlock(text = '') {
  const regex = /\{[\s\S]*?\}/g;
  let match;
  let found = null;
  while ((match = regex.exec(text))) {
    if (match?.index === undefined) continue;
    if (/"action"\s*:/i.test(match[0])) {
      found = { json: match[0], start: match.index, end: match.index + match[0].length };
    }
  }
  return found;
}

function stripCommandArtifacts(text = '') {
  const lines = text.split('\n');
  while (lines.length) {
    const lastRaw = lines[lines.length - 1];
    if (!lastRaw) {
      lines.pop();
      continue;
    }
    const trimmed = lastRaw.trim();
    if (!trimmed) {
      lines.pop();
      continue;
    }
    const cleaned = sanitizeJsonCandidate(trimmed);
    if (!cleaned) {
      lines.pop();
      continue;
    }
    if (/"action"\s*:/i.test(cleaned) || /"say"\s*:/i.test(cleaned)) {
      lines.pop();
      continue;
    }
    if (/^```/.test(trimmed) || /^json\b/i.test(trimmed)) {
      lines.pop();
      continue;
    }
    break;
  }
  return lines.join('\n').trim();
}

function extractAssistantCommand(partText = '') {
  const trimmed = partText.trim();
  if (!trimmed) return { payload: null, remainder: '' };

  let payload = null;
  let remainder = trimmed;

  const block = findJsonCommandBlock(trimmed);
  if (block) {
    const candidate = sanitizeJsonCandidate(block.json);
    try {
      payload = JSON.parse(candidate);
      remainder = (trimmed.slice(0, block.start) + trimmed.slice(block.end)).trim();
    } catch (error) {
      payload = null;
    }
  }

  if (!payload) {
    const nonEmptyLines = trimmed.split('\n').filter((line) => line.trim().length > 0);
    const lastLineRaw = nonEmptyLines[nonEmptyLines.length - 1];
    if (lastLineRaw) {
      const loose = parseLooseKeyValues(lastLineRaw);
      if (loose) {
        payload = loose;
        const lastIndex = trimmed.lastIndexOf(lastLineRaw);
        if (lastIndex >= 0) {
          remainder = (trimmed.slice(0, lastIndex) + trimmed.slice(lastIndex + lastLineRaw.length)).trim();
        }
      }
    }
  }

  if (!payload && /"action"\s*:/i.test(trimmed)) {
    const loose = parseLooseKeyValues(trimmed);
    if (loose) {
      payload = loose;
      remainder = stripCommandArtifacts(trimmed);
    }
  }

  remainder = stripCommandArtifacts(remainder);

  return { payload, remainder };
}

async function fetchGeminiReply(userText, history = []) {
  if (!geminiApiKey) {
    throw new Error('Gemini API key not configured on server');
  }
  const safeHistory = Array.isArray(history) ? history : [];
  const normalizedHistory = safeHistory
    .filter((item) => item && typeof item.content === 'string' && (item.role === 'user' || item.role === 'assistant'))
    .slice(-8);

  const contents = normalizedHistory.map((msg) => ({
    role: msg.role,
    parts: [{ text: msg.content }],
  }));
  contents.push({ role: 'user', parts: [{ text: buildPrompt(userText) }] });

  const body = {
    contents,
    generationConfig: { temperature: 0.6, topP: 0.9, maxOutputTokens: 256 },
  };

  const response = await fetch(`${GEMINI_ENDPOINT}?key=${geminiApiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '') || response.statusText;
    throw new Error(`Gemini error ${response.status}: ${text}`);
  }

  const data = await response.json();
  const candidate = data?.candidates?.[0];
  const partText = candidate?.content?.parts?.[0]?.text;
  if (!partText || typeof partText !== 'string') {
    throw new Error('No response from Gemini');
  }

  const { payload, remainder } = extractAssistantCommand(partText);

  const sayText = (payload && typeof payload.say === 'string' && payload.say.trim())
    ? payload.say.trim()
    : remainder || partText.trim();

  const action = payload && typeof payload.action === 'string' ? payload.action.trim() : 'none';

  return {
    action: action || 'none',
    say: sayText,
    room: payload && typeof payload.room === 'string' ? payload.room.trim() : undefined,
    device: payload && typeof payload.device === 'string' ? payload.device.trim() : undefined,
    value: payload && typeof payload.value === 'string' ? payload.value.trim() : undefined,
    door: payload && typeof payload.door === 'string' ? payload.door.trim() : undefined,
    raw: partText,
  };
}

function hashString(s) {
  let h = 5381; for (let i = 0; i < s.length; i++) { h = ((h << 5) + h) + s.charCodeAt(i); h |= 0; }
  return Math.abs(h).toString(36);
}

function parseTemplate(tpl) {
  try { return JSON.parse(tpl); } catch { return null; }
}

function matchTemplates(a, b) {
  try {
    const ta = typeof a === 'string' ? parseTemplate(a) : a;
    const tb = typeof b === 'string' ? parseTemplate(b) : b;
    if (!ta || !tb) return false;
    if (ta.hash && tb.hash) return ta.hash === tb.hash;
    const va = Array.isArray(ta.vec) ? ta.vec : null;
    const vb = Array.isArray(tb.vec) ? tb.vec : null;
    if (va && vb && va.length === vb.length && va.length > 0) {
      let sum = 0; for (let i = 0; i < va.length; i++) { const d = (va[i] - vb[i]); sum += d*d; }
      const dist = Math.sqrt(sum / va.length);
      return dist < 0.12;
    }
    return false;
  } catch {
    return false;
  }
}

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.post('/api/assistant', async (req, res) => {
  const { text, history } = req.body || {};
  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: 'text required' });
  }
  try {
    const reply = await fetchGeminiReply(text, history);
    res.json({
      action: reply.action,
      say: reply.say,
      room: reply.room,
      device: reply.device,
      value: reply.value,
      door: reply.door,
    });
  } catch (error) {
    const message = error?.message || 'assistant request failed';
    res.status(502).json({ error: message });
  }
});

function defaultPolicies(role) {
  const isAdmin = role === 'admin';
  const hasFull = role === 'parent' || isAdmin;
  const base = {
    controls: { devices: true, doors: true, unlockDoors: hasFull, voice: true, power: true },
    areas: {
      hall: { light: hasFull || isAdmin, fan: hasFull || isAdmin, ac: hasFull || isAdmin, door: hasFull || isAdmin },
      kitchen: { light: hasFull || isAdmin, fan: hasFull || isAdmin, ac: hasFull || isAdmin, door: hasFull || isAdmin },
      bedroom: { light: hasFull || isAdmin, fan: hasFull || isAdmin, ac: hasFull || isAdmin, door: hasFull || isAdmin },
      bathroom: { light: hasFull || isAdmin, fan: hasFull || isAdmin, ac: hasFull || isAdmin, door: hasFull || isAdmin },
      main: { door: hasFull || isAdmin },
    },
  };
  return base;
}

function normalizePolicies(role, policies) {
  const defaults = defaultPolicies(role);
  if (!policies) return defaults;
  const normalized = {
    controls: { ...defaults.controls, ...(policies.controls || {}) },
    areas: {},
  };
  const defaultAreas = defaults.areas || {};
  const providedAreas = policies.areas || {};
  const areaKeys = new Set([...Object.keys(defaultAreas), ...Object.keys(providedAreas)]);
  areaKeys.forEach((key) => {
    const base = defaultAreas[key] || {};
    const provided = providedAreas[key] || {};
    normalized.areas[key] = { ...base, ...provided };
    if (base.fan !== undefined && normalized.areas[key].fan === undefined) {
      normalized.areas[key].fan = base.fan;
    }
  });
  return normalized;
}

function createAdminSession(user) {
  const token = crypto.randomBytes(32).toString('hex');
  adminSessions.set(token, { id: user.id, email: user.email, name: user.name, created: Date.now() });
  return token;
}

function requireAdmin(req, res, next) {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token || !adminSessions.has(token)) {
    return res.status(401).json({ error: 'admin auth required' });
  }
  const session = adminSessions.get(token);
  if (!session) {
    return res.status(401).json({ error: 'admin auth required' });
  }
  if (Date.now() - session.created > ADMIN_SESSION_TTL) {
    adminSessions.delete(token);
    return res.status(401).json({ error: 'session expired' });
  }
  req.adminSession = session;
  req.adminToken = token;
  next();
}

async function ensureSuperAdmin() {
  if (!superAdminEmail || !superAdminPin) {
    console.log('[backend] SUPER_ADMIN_EMAIL or PIN not set; skipping bootstrap');
    return;
  }
  try {
    await pool.query(
      `INSERT INTO users (name, email, role, relation, pin, preferred_login)
       VALUES (?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE
         name=VALUES(name),
         role='admin',
         relation='superadmin',
         pin=VALUES(pin),
         preferred_login='pin'`,
      [superAdminName || 'Super Admin', superAdminEmail, 'admin', 'superadmin', superAdminPin, 'pin']
    );
    console.log('[backend] Super admin ensured for', superAdminEmail);
  } catch (e) {
    console.error('[backend] Failed to ensure super admin:', e?.message || e);
  }
}

// Register user with face template
app.post('/api/register', async (req, res) => {
  const { name, email, role = 'member', relation = '', pin = '', preferred_login = 'pin', template, faceId } = req.body || {};
  if (!name || !template) return res.status(400).json({ error: 'name and template required' });
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    // Duplicate face check
    const [ftRows] = await conn.query('SELECT ft.*, u.name as user_name FROM face_templates ft JOIN users u ON u.id=ft.user_id');
    for (const r of ftRows) {
      if (matchTemplates(template, r.template)) {
        await conn.rollback();
        return res.status(409).json({ error: 'Face already registered', user: { id: r.user_id, name: r.user_name, faceId: r.face_id } });
      }
    }
    // Insert user
    const [ur] = await conn.query('INSERT INTO users (name, email, role, relation, pin, preferred_login) VALUES (?,?,?,?,?,?)', [name, email || null, role, relation, pin || null, preferred_login]);
    const userId = ur.insertId;
    // Insert template
    const storedFaceId = faceId || hashString(template).slice(0, 16);
    await conn.query('INSERT INTO face_templates (user_id, face_id, template) VALUES (?,?,?)', [userId, storedFaceId, template]);
    await conn.commit();
    res.json({ success: true, user: { id: userId, name, email, role, relation, faceId: storedFaceId } });
  } catch (e) {
    await conn.rollback();
    res.status(500).json({ error: e.message || 'register failed' });
  } finally {
    conn.release();
  }
});

// Authenticate by face
app.post('/api/auth/face', async (req, res) => {
  const { template } = req.body || {};
  if (!template) return res.status(400).json({ error: 'template required' });
  try {
    const [rows] = await pool.query('SELECT u.*, ft.template as tpl, ft.face_id FROM users u JOIN face_templates ft ON ft.user_id=u.id');
    for (const r of rows) {
      if (matchTemplates(template, r.tpl)) {
        return res.json({ success: true, user: { id: r.id, name: r.name, email: r.email, role: r.role, relation: r.relation, faceId: r.face_id } });
      }
    }
    res.status(404).json({ success: false, error: 'Face not recognized' });
  } catch (e) {
    res.status(500).json({ error: e.message || 'auth failed' });
  }
});

// Authenticate by PIN
app.post('/api/auth/pin', async (req, res) => {
  const { pin } = req.body || {};
  if (!pin) return res.status(400).json({ error: 'pin required' });
  try {
    const [rows] = await pool.query('SELECT id, name, email, role, relation FROM users WHERE pin = ? LIMIT 1', [pin]);
    if (rows.length) return res.json({ success: true, user: rows[0] });
    res.status(401).json({ success: false, error: 'Invalid PIN' });
  } catch (e) {
    res.status(500).json({ error: e.message || 'auth failed' });
  }
});

// List users with policies
app.get('/api/users', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT u.*, p.policies FROM users u LEFT JOIN user_policies p ON p.user_id=u.id ORDER BY u.id DESC');
  const mapped = rows.map(r => ({ id: r.id, name: r.name, email: r.email, role: r.role, relation: r.relation, registered_at: r.registered_at, policies: normalizePolicies(r.role, r.policies ? JSON.parse(r.policies) : null) }));
    res.json(mapped);
  } catch (e) {
    res.status(500).json({ error: e.message || 'query failed' });
  }
});

// Add member
app.post('/api/members', async (req, res) => {
  const { name, email, role = 'member', relation = 'member', pin = '' } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [ur] = await conn.query('INSERT INTO users (name, email, role, relation, pin, preferred_login) VALUES (?,?,?,?,?,?)', [name, email || null, role, relation, pin || null, 'pin']);
    const id = ur.insertId;
    await conn.query('INSERT INTO user_policies (user_id, policies) VALUES (?,?)', [id, JSON.stringify(defaultPolicies(role))]);
    await conn.commit();
    res.json({ id, name, email, role, relation, policies: defaultPolicies(role) });
  } catch (e) {
    await conn.rollback();
    res.status(500).json({ error: e.message || 'add member failed' });
  } finally { conn.release(); }
});

// Update member
app.patch('/api/members/:id', async (req, res) => {
  const id = Number(req.params.id);
  const { name, email, role, relation, pin, preferred_login, policies } = req.body || {};
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    if (name || email || role || relation || pin || preferred_login) {
      const fields = [];
      const vals = [];
      if (name !== undefined) { fields.push('name=?'); vals.push(name); }
      if (email !== undefined) { fields.push('email=?'); vals.push(email); }
      if (role !== undefined) { fields.push('role=?'); vals.push(role); }
      if (relation !== undefined) { fields.push('relation=?'); vals.push(relation); }
      if (pin !== undefined) { fields.push('pin=?'); vals.push(pin); }
      if (preferred_login !== undefined) { fields.push('preferred_login=?'); vals.push(preferred_login); }
      if (fields.length) {
        vals.push(id);
        await conn.query(`UPDATE users SET ${fields.join(', ')} WHERE id=?`, vals);
      }
    }
    if (policies !== undefined) {
      const pjson = JSON.stringify(policies);
      await conn.query('INSERT INTO user_policies (user_id, policies) VALUES (?,?) ON DUPLICATE KEY UPDATE policies=VALUES(policies)', [id, pjson]);
    }
    await conn.commit();
    res.json({ success: true });
  } catch (e) {
    await conn.rollback();
    res.status(500).json({ error: e.message || 'update failed' });
  } finally { conn.release(); }
});

// Delete member
app.delete('/api/members/:id', async (req, res) => {
  const id = Number(req.params.id);
  try {
    await pool.query('DELETE FROM users WHERE id=?', [id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message || 'delete failed' });
  }
});

// Door state endpoints
const defaultDoors = ['main','front','back','garage'];

async function ensureDoors() {
  const [rows] = await pool.query('SELECT door FROM door_state');
  const have = new Set(rows.map(r => r.door));
  for (const d of defaultDoors) if (!have.has(d)) await pool.query('INSERT INTO door_state (door, locked) VALUES (?,1) ON DUPLICATE KEY UPDATE door=door', [d]);
}

app.get('/api/door', async (req, res) => {
  try { await ensureDoors(); const [rows] = await pool.query('SELECT door, locked FROM door_state'); res.json(Object.fromEntries(rows.map(r => [r.door, !!r.locked]))); }
  catch (e) { res.status(500).json({ error: e.message || 'door query failed' }); }
});

app.post('/api/door/toggle', async (req, res) => {
  const { door } = req.body || {};
  if (!door) return res.status(400).json({ error: 'door required' });
  try {
    const [[row]] = await pool.query('SELECT locked FROM door_state WHERE door=?', [door]);
    const next = row ? (row.locked ? 0 : 1) : 0;
    await pool.query('INSERT INTO door_state (door, locked) VALUES (?,?) ON DUPLICATE KEY UPDATE locked=VALUES(locked)', [door, next]);
    res.json({ success: true, locked: !!next });
  } catch (e) { res.status(500).json({ error: e.message || 'toggle failed' }); }
});

app.post('/api/door/lock_all', async (_req, res) => {
  try { await ensureDoors(); await pool.query('UPDATE door_state SET locked=1'); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message || 'lock all failed' }); }
});

app.post('/api/door/unlock_all', async (_req, res) => {
  try { await ensureDoors(); await pool.query('UPDATE door_state SET locked=0'); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message || 'unlock all failed' }); }
});

function checkSensorSecret(req, res) {
  if (!sensorSecret) return true;
  const provided = (req.headers['x-device-secret'] || req.headers['x-sensor-secret'] || req.query.secret || '').toString();
  if (provided && provided === sensorSecret) return true;
  res.status(401).json({ error: 'unauthorized device' });
  return false;
}

function normalizeMetadata(metadata) {
  if (metadata === undefined || metadata === null) return null;
  if (typeof metadata === 'string') {
    try { return JSON.stringify(JSON.parse(metadata)); }
    catch { return JSON.stringify(metadata); }
  }
  try { return JSON.stringify(metadata); }
  catch { return null; }
}

function parseRow(row) {
  const recordedAt = row.recorded_at instanceof Date ? row.recorded_at.toISOString() : row.recorded_at;
  let metadata = row.metadata;
  if (metadata && Buffer.isBuffer(metadata)) {
    metadata = metadata.toString('utf8');
  }
  if (typeof metadata === 'string' && metadata.length) {
    try { metadata = JSON.parse(metadata); }
    catch { /* leave as string */ }
  }
  return {
    id: row.id,
    deviceId: row.device_id,
    metric: row.metric,
    value: typeof row.value === 'number' ? row.value : Number(row.value),
    unit: row.unit,
    metadata: metadata ?? null,
    recordedAt,
  };
}

async function insertSensorReading({ deviceId, metric, value, unit, metadata, recordedAt }) {
  const numericValue = Number(value);
  const ts = recordedAt instanceof Date ? recordedAt : (recordedAt ? new Date(recordedAt) : new Date());
  if (Number.isNaN(ts.getTime())) throw new Error('invalid recordedAt');
  const metaJson = normalizeMetadata(metadata);
  const [result] = await pool.query(
    'INSERT INTO sensor_readings (device_id, metric, value, unit, metadata, recorded_at) VALUES (?,?,?,?,?,?)',
    [deviceId, metric, numericValue, unit || null, metaJson, ts]
  );
  return {
    id: result?.insertId,
    deviceId,
    metric,
    value: numericValue,
    unit: unit || null,
    metadata: metadata ?? null,
    recordedAt: ts.toISOString(),
  };
}

async function ensureDeviceStateRow(deviceId) {
  const [[row]] = await pool.query(
    'SELECT id FROM sensor_readings WHERE device_id=? AND metric=? ORDER BY recorded_at DESC, id DESC LIMIT 1',
    [deviceId, DEFAULT_SENSOR_METRIC]
  );
  if (row) return;
  try {
    await insertSensorReading({ deviceId, metric: DEFAULT_SENSOR_METRIC, value: 0, unit: null, metadata: null, recordedAt: new Date() });
  } catch (e) {
    console.warn('[device-state] ensure default failed for', deviceId, e?.message || e);
  }
}

// Ingest a sensor reading from a hardware device
app.post('/api/sensors/:deviceId/readings', async (req, res) => {
  if (!checkSensorSecret(req, res)) return;
  const deviceId = (req.params.deviceId || '').trim();
  const { metric, value, unit, recordedAt, metadata } = req.body || {};
  if (!deviceId) return res.status(400).json({ error: 'deviceId required' });
  const finalMetric = typeof metric === 'string' && metric.trim().length ? metric : DEFAULT_SENSOR_METRIC;
  if (value === undefined || value === null || Number.isNaN(Number(value))) return res.status(400).json({ error: 'numeric value required' });
  try {
    const reading = await insertSensorReading({ deviceId, metric: finalMetric, value, unit, metadata, recordedAt });
    res.json({ success: true, reading });
  } catch (e) {
    if (e.message === 'invalid recordedAt') return res.status(400).json({ error: 'invalid recordedAt' });
    res.status(500).json({ error: e.message || 'sensor ingest failed' });
  }
});

// Fetch historical readings
app.get('/api/sensors/:deviceId/readings', async (req, res) => {
  const deviceId = (req.params.deviceId || '').trim();
  if (!deviceId) return res.status(400).json({ error: 'deviceId required' });
  const metric = typeof req.query.metric === 'string' ? req.query.metric : undefined;
  const limitRaw = typeof req.query.limit === 'string' ? req.query.limit : undefined;
  const sinceRaw = typeof req.query.since === 'string' ? req.query.since : undefined;
  const untilRaw = typeof req.query.until === 'string' ? req.query.until : undefined;
  const limit = Math.min(Math.max(Number(limitRaw) || 50, 1), 500);
  const params = [deviceId];
  let sql = 'SELECT id, device_id, metric, value, unit, metadata, recorded_at FROM sensor_readings WHERE device_id=?';
  if (metric) { sql += ' AND metric=?'; params.push(metric); }
  if (sinceRaw) {
    const since = new Date(sinceRaw);
    if (Number.isNaN(since.getTime())) return res.status(400).json({ error: 'invalid since' });
    sql += ' AND recorded_at >= ?';
    params.push(since);
  }
  if (untilRaw) {
    const until = new Date(untilRaw);
    if (Number.isNaN(until.getTime())) return res.status(400).json({ error: 'invalid until' });
    sql += ' AND recorded_at <= ?';
    params.push(until);
  }
  sql += ' ORDER BY recorded_at DESC, id DESC LIMIT ?';
  params.push(limit);
  try {
    const [rows] = await pool.query(sql, params);
    const readings = rows.map(parseRow);
    res.json({ deviceId, metric: metric || null, count: readings.length, readings });
  } catch (e) {
    res.status(500).json({ error: e.message || 'sensor history failed' });
  }
});

// Fetch the latest reading (or one per metric) for a device
app.get('/api/sensors/:deviceId/readings/latest', async (req, res) => {
  const deviceId = (req.params.deviceId || '').trim();
  if (!deviceId) return res.status(400).json({ error: 'deviceId required' });
  const metric = typeof req.query.metric === 'string' ? req.query.metric : undefined;
  try {
    if (metric) {
      const [[row]] = await pool.query(
        'SELECT id, device_id, metric, value, unit, metadata, recorded_at FROM sensor_readings WHERE device_id=? AND metric=? ORDER BY recorded_at DESC, id DESC LIMIT 1',
        [deviceId, metric]
      );
      if (!row) return res.status(404).json({ error: 'no reading found' });
      return res.json({ reading: parseRow(row) });
    }
    const [rows] = await pool.query(
      `SELECT id, device_id, metric, value, unit, metadata, recorded_at
       FROM (
         SELECT sr.*, ROW_NUMBER() OVER (PARTITION BY metric ORDER BY recorded_at DESC, id DESC) AS rn
         FROM sensor_readings sr
         WHERE device_id=?
       ) ranked
       WHERE rn=1
       ORDER BY metric`,
      [deviceId]
    );
    if (!rows.length) return res.status(404).json({ error: 'no readings found' });
    res.json({ readings: rows.map(parseRow) });
  } catch (e) {
    res.status(500).json({ error: e.message || 'latest readings failed' });
  }
});

// Minimal device state endpoints (value 0/1)
app.post('/api/devices/:deviceId/state', async (req, res) => {
  if (!checkSensorSecret(req, res)) return;
  const deviceId = (req.params.deviceId || '').trim();
  if (!deviceId) return res.status(400).json({ error: 'deviceId required' });
  const { value, recordedAt } = req.body || {};
  if (value === undefined || value === null || Number.isNaN(Number(value))) {
    return res.status(400).json({ error: 'numeric value required' });
  }
  const numericValue = Number(value) ? 1 : 0;
  try {
    const reading = await insertSensorReading({ deviceId, metric: DEFAULT_SENSOR_METRIC, value: numericValue, unit: null, metadata: null, recordedAt });
    res.json({ success: true, deviceId, value: reading.value });
  } catch (e) {
    if (e.message === 'invalid recordedAt') return res.status(400).json({ error: 'invalid recordedAt' });
    res.status(500).json({ error: e.message || 'device state update failed' });
  }
});

app.get('/api/devices/state', async (req, res) => {
  const idsParam = req.query.ids;
  let ids;
  if (typeof idsParam === 'string') {
    ids = idsParam.split(',').map((s) => s.trim()).filter(Boolean);
  }
  let sql =
    `SELECT device_id, value, recorded_at FROM (
      SELECT sr.*, ROW_NUMBER() OVER (PARTITION BY device_id, metric ORDER BY recorded_at DESC, id DESC) AS rn
      FROM sensor_readings sr
      WHERE metric = ?
    ) ranked
    WHERE rn = 1`;
  const params = [DEFAULT_SENSOR_METRIC];
  if (ids && ids.length) {
    const placeholders = ids.map(() => '?').join(',');
    sql += ` AND device_id IN (${placeholders})`;
    params.push(...ids);
  }
  sql += ' ORDER BY device_id';
  try {
    const [rows] = await pool.query(sql, params);
    const states = {};
    for (const row of rows) {
      states[row.device_id] = {
        value: Number(row.value) ? 1 : 0,
        recordedAt: row.recorded_at instanceof Date ? row.recorded_at.toISOString() : row.recorded_at,
      };
    }
    if (ids && ids.length) {
      const missing = ids.filter((id) => states[id] === undefined);
      for (const id of missing) {
        await ensureDeviceStateRow(id);
        states[id] = {
          value: 0,
          recordedAt: new Date().toISOString(),
        };
      }
    }
    res.json({ states });
  } catch (e) {
    res.status(500).json({ error: e.message || 'device states query failed' });
  }
});

app.get('/api/devices/:deviceId/state', async (req, res) => {
  const deviceId = (req.params.deviceId || '').trim();
  if (!deviceId) return res.status(400).json({ error: 'deviceId required' });
  try {
    const [[row]] = await pool.query(
      'SELECT value FROM sensor_readings WHERE device_id=? AND metric=? ORDER BY recorded_at DESC, id DESC LIMIT 1',
      [deviceId, DEFAULT_SENSOR_METRIC]
    );
    if (!row) {
      await ensureDeviceStateRow(deviceId);
      return res.json({ deviceId, value: 0 });
    }
    res.json({ deviceId, value: Number(row.value) ? 1 : 0 });
  } catch (e) {
    res.status(500).json({ error: e.message || 'device state query failed' });
  }
});

app.post('/api/admin/login', async (req, res) => {
  const { email, pin } = req.body || {};
  if (!email || !pin) return res.status(400).json({ error: 'email and pin required' });
  try {
    const [[row]] = await pool.query(
      'SELECT id, name, email, role, relation, pin as user_pin FROM users WHERE email=? AND role=? LIMIT 1',
      [email, 'admin']
    );
    if (!row || row.user_pin !== pin) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const user = { id: row.id, name: row.name, email: row.email, role: row.role, relation: row.relation };
    const token = createAdminSession(user);
    res.json({ success: true, user, token });
  } catch (e) {
    res.status(500).json({ error: e.message || 'admin login failed' });
  }
});

app.get('/api/admin/users', requireAdmin, async (_req, res) => {
  try {
    const [rows] = await pool.query('SELECT u.*, p.policies FROM users u LEFT JOIN user_policies p ON p.user_id=u.id ORDER BY u.id DESC');
    const mapped = rows.map((r) => ({
      id: r.id,
      name: r.name,
      email: r.email,
      role: r.role,
      relation: r.relation,
      registered_at: r.registered_at,
      policies: normalizePolicies(r.role, r.policies ? JSON.parse(r.policies) : null),
    }));
    res.json({ users: mapped });
  } catch (e) {
    res.status(500).json({ error: e.message || 'admin users fetch failed' });
  }
});

app.post('/api/admin/users', requireAdmin, async (req, res) => {
  const { name, email, role = 'member', relation = '', pin = '' } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [ur] = await conn.query(
      'INSERT INTO users (name, email, role, relation, pin, preferred_login) VALUES (?,?,?,?,?,?)',
      [name, email || null, role, relation, pin || null, 'pin']
    );
    const id = ur.insertId;
    await conn.query('INSERT INTO user_policies (user_id, policies) VALUES (?,?)', [id, JSON.stringify(defaultPolicies(role))]);
    await conn.commit();
    res.json({ success: true, user: { id, name, email, role, relation } });
  } catch (e) {
    await conn.rollback();
    res.status(500).json({ error: e.message || 'admin create user failed' });
  } finally {
    conn.release();
  }
});

app.patch('/api/admin/users/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const { name, email, role, relation, pin } = req.body || {};
  const fields = [];
  const values = [];
  if (name !== undefined) { fields.push('name=?'); values.push(name); }
  if (email !== undefined) { fields.push('email=?'); values.push(email || null); }
  if (role !== undefined) { fields.push('role=?'); values.push(role); }
  if (relation !== undefined) { fields.push('relation=?'); values.push(relation); }
  if (pin !== undefined) { fields.push('pin=?'); values.push(pin || null); }
  if (!fields.length) return res.json({ success: true });
  values.push(id);
  try {
    await pool.query(`UPDATE users SET ${fields.join(', ')} WHERE id=?`, values);
    if (role !== undefined) {
      await pool.query(
        'INSERT INTO user_policies (user_id, policies) VALUES (?,?) ON DUPLICATE KEY UPDATE policies=VALUES(policies)',
        [id, JSON.stringify(defaultPolicies(role))]
      );
    }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message || 'admin update user failed' });
  }
});

app.delete('/api/admin/users/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  try {
    await pool.query('DELETE FROM users WHERE id=?', [id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message || 'admin delete user failed' });
  }
});

ensureSuperAdmin().finally(() => {
  app.listen(port, () => console.log(`[backend] listening on :${port}`));
});
