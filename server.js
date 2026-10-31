const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const dbPath = process.env.DATABASE_PATH || path.join(__dirname, 'clinic.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
const visitEventClients = new Set();

function publishVisitUpdate() {
  const message = 'event: visits-updated\ndata: {}\n\n';
  for (const client of visitEventClients) {
    try {
      client.write(message);
    } catch (err) {
      visitEventClients.delete(client);
    }
  }
}

const GRADES = ['Grade 11', 'Grade 12'];
const STRANDS = ['STEM', 'ABM', 'HUMSS'];
const PURPOSES = ['Feeding', 'Consultation'];
const ILLNESSES = [
  'Headache',
  'Fever',
  'Stomachache',
  'Minor Injury',
  'Cough/Colds',
  'Allergy',
  'Dizziness',
  'Menstrual Cramps',
  'Vomiting',
  'Others'
];

const SECTIONS = {
  'Grade 11': [
    'Advocates', 'Ambassadors', 'Analysts', 'Aspirers', 'Builders',
    'Catalysists', 'Conquerors', 'Designers', 'Developers', 'Diplomats',
    'Empericists', 'Innovators', 'Luminaries', 'Pathfinders', 'Practitioners',
    'Strategists', 'Thinkers', 'Voyagers'
  ],
  'Grade 12': [
    'Einstein', 'Fibonacci', 'Laplace', 'Leibniz', 'Euler',
    'Descartes', 'Euclid', 'Pascal', 'Pearson', 'Newton',
    'McGregor', 'Crosby', 'Mayo', 'Pacioli', 'Aquinas',
    'Aurelius', 'Confucius', 'Mencius', 'Freud', 'Shakespeare'
  ]
};


/* Adviser portal — one password per section (change anytime) */
const SECTION_PASSWORDS = {};
(function buildSectionPasswords() {
  const all = [].concat(SECTIONS['Grade 11'] || [], SECTIONS['Grade 12'] || []);
  all.forEach(function (sec) {
    // Default: SectionName + 2026, lowercase, no spaces  e.g. Laplace -> laplace2026
    const key = String(sec).toLowerCase().replace(/\s+/g, '');
    SECTION_PASSWORDS[sec] = key + '2026';
  });
})();

const adviserSessions = new Map(); // token -> { section, grade, exp }

function createAdviserToken() {
  return crypto.randomBytes(24).toString('hex');
}

function getGradeForSection(section) {
  for (const g of GRADES) {
    if ((SECTIONS[g] || []).includes(section)) return g;
  }
  return null;
}

function cleanExpiredAdviserSessions() {
  const now = Date.now();
  for (const [t, s] of adviserSessions.entries()) {
    if (!s || s.exp < now) adviserSessions.delete(t);
  }
}


/* Default clinic stocks (PH common meds) — used when inventory is empty */
const DEFAULT_INVENTORY = [
  ['Kremil-S', 50],
  ['Buscopan', 40],
  ['Diatabs', 40],
  ['Buscopan (Venus)', 30],
  ['Mefenamic Acid', 50],
  ['Cetirizine', 40],
  ['Neozep', 45],
  ['Symdex-D', 35],
  ['Paracetamol / Biogesic', 80],
  ['Alcohol Swabs', 60],
  ['Solmux', 40],
  ['Allecure', 35],
  ['Levocetirizine', 30],
  ['Mecid', 25],
  ['Bandaid', 70],
  ['Gauze Pad', 50],
  ['Salonpas', 40],
  ['Loperamide', 35],
  ['Silver Sulfadiazine', 20],
  ['Povidone-iodide', 30],
  ['Vicks Vaporub', 25],
  ['White Flower', 25],
  ['Efficascent Oil', 30],
  ['Blood Glucose Test Strip', 20],
  ['Aceite De Manzanilla', 25],
  ['Facemask', 100],
  ['Hot Compress', 15]
];

/* ============== SCHEMA ============== */

db.exec(`
  CREATE TABLE IF NOT EXISTS visits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    purpose TEXT NOT NULL DEFAULT 'Consultation',
    student_name TEXT NOT NULL DEFAULT '',
    grade TEXT NOT NULL,
    section TEXT DEFAULT '',
    strand TEXT DEFAULT '',
    illness TEXT DEFAULT '',
    severity TEXT DEFAULT '',
    action_taken TEXT,
    visit_time TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS inventory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_name TEXT NOT NULL UNIQUE,
    level INTEGER NOT NULL DEFAULT 0 CHECK(level >= 0),
    status TEXT GENERATED ALWAYS AS (
      CASE
        WHEN level <= 0 THEN 'critical'
        WHEN level <= 10 THEN 'low'
        WHEN level <= 25 THEN 'low'
        ELSE 'ok'
      END
    ) VIRTUAL
  );
`);

/* ============== MIGRATE OLD DB ============== */

(function migrateVisits() {
  let cols = db.prepare('PRAGMA table_info(visits)').all().map(c => c.name);

  if (!cols.includes('purpose') || !cols.includes('section')) {
    db.exec(`
      BEGIN;
      CREATE TABLE IF NOT EXISTS visits_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        purpose TEXT NOT NULL DEFAULT 'Consultation',
        student_name TEXT NOT NULL DEFAULT '',
        grade TEXT NOT NULL,
        section TEXT DEFAULT '',
        strand TEXT DEFAULT '',
        illness TEXT DEFAULT '',
        severity TEXT DEFAULT '',
        action_taken TEXT,
        visit_time TEXT DEFAULT (datetime('now','localtime'))
      );
      INSERT INTO visits_new
        (id, purpose, student_name, grade, section, strand, illness, severity, action_taken, visit_time)
      SELECT
        id,
        'Consultation',
        '',
        grade,
        '',
        strand,
        illness,
        severity,
        action_taken,
        visit_time
      FROM visits;
      DROP TABLE visits;
      ALTER TABLE visits_new RENAME TO visits;
      COMMIT;
    `);
    console.log('✅ Migrated visits table: added purpose + section');
    cols = db.prepare('PRAGMA table_info(visits)').all().map(c => c.name);
  }

  if (!cols.includes('student_name')) {
    db.exec("ALTER TABLE visits ADD COLUMN student_name TEXT NOT NULL DEFAULT ''");
    console.log('✅ Migrated visits table: added student_name');
  }
})();

/* Migrate inventory: remove 0-100 cap, allow unlimited stock */
(function migrateInventory() {
  try {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='inventory'").get();
    if (row && row.sql && row.sql.includes('BETWEEN 0 AND 100')) {
      db.exec(`
        BEGIN;
        CREATE TABLE inventory_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          item_name TEXT NOT NULL UNIQUE,
          level INTEGER NOT NULL DEFAULT 0 CHECK(level >= 0),
          status TEXT GENERATED ALWAYS AS (
            CASE
              WHEN level <= 0 THEN 'critical'
              WHEN level <= 25 THEN 'low'
              ELSE 'ok'
            END
          ) VIRTUAL
        );
        INSERT INTO inventory_new (id, item_name, level)
          SELECT id, item_name, level FROM inventory;
        DROP TABLE inventory;
        ALTER TABLE inventory_new RENAME TO inventory;
        COMMIT;
      `);
      console.log('✅ Migrated inventory: removed 0–100 cap (unlimited stock)');
    }
  } catch (e) {
    console.warn('Inventory migration skipped:', e.message);
  }
})();



/* ============== SEED INVENTORY (always if empty) ============== */

(function seedInventory() {
  const ins = db.prepare(
    'INSERT OR IGNORE INTO inventory (item_name, level) VALUES (?, ?)'
  );
  let added = 0;
  const tx = db.transaction(rows => {
    rows.forEach(row => {
      const info = ins.run(...row);
      if (info.changes) added += 1;
    });
  });
  tx(DEFAULT_INVENTORY);
  if (added > 0) {
    console.log('✅ Inventory: added', added, 'missing clinic items (total list', DEFAULT_INVENTORY.length + ')');
  }
})();

/* ============== SEED DEMO VISITS ============== */

if (process.env.SEED_DEMO_DATA === 'true' && db.prepare('SELECT COUNT(*) c FROM visits').get().c === 0) {
  const ins = db.prepare(`
    INSERT INTO visits
    (purpose, grade, section, strand, illness, severity, action_taken, visit_time)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now','localtime','-' || ? || ' hours'))
  `);

  const tx = db.transaction(rows => {
    rows.forEach(row => ins.run(...row));
  });

  tx([
    ['Consultation', 'Grade 11', 'Innovators', 'STEM', 'Headache', 'mild', 'Rested, given water', 3],
    ['Consultation', 'Grade 12', 'Einstein', 'STEM', 'Fever', 'moderate', 'Temp checked, sent home', 6],
    ['Consultation', 'Grade 11', 'Thinkers', 'HUMSS', 'Minor Injury', 'mild', 'Cleaned & bandaged', 9],
    ['Consultation', 'Grade 12', 'Pacioli', 'ABM', 'Stomachache', 'moderate', 'Given rest, monitored', 20],
    ['Feeding', 'Grade 11', 'Builders', '', '', '', '', 25],
    ['Feeding', 'Grade 12', 'Newton', '', '', '', '', 30],
    ['Consultation', 'Grade 12', 'Shakespeare', 'HUMSS', 'Headache', 'mild', 'Rested 15 mins', 50],
    ['Consultation', 'Grade 11', 'Developers', 'STEM', 'Cough/Colds', 'mild', 'Advised rest', 70],
    ['Consultation', 'Grade 12', 'Mayo', 'ABM', 'Headache', 'mild', 'Rested', 100],
    ['Consultation', 'Grade 11', 'Pathfinders', 'STEM', 'Fever', 'moderate', 'Sent home', 150],
    ['Feeding', 'Grade 11', 'Advocates', '', '', '', '', 200],
    ['Consultation', 'Grade 11', 'Ambassadors', 'ABM', 'Headache', 'mild', 'Rested', 250],
    ['Consultation', 'Grade 12', 'Descartes', 'STEM', 'Fever', 'moderate', 'Sent home', 300],
    ['Consultation', 'Grade 11', 'Diplomats', 'HUMSS', 'Allergy', 'mild', 'Antihistamine given', 340]
  ]);
}

/* ============== HELPERS ============== */

function isValidSection(grade, section) {
  const list = SECTIONS[grade] || [];
  return list.includes(section);
}

/* ============== VISITS ============== */

app.get('/api/visits', (req, res) => {
  res.json(
    db.prepare(
      'SELECT * FROM visits ORDER BY visit_time DESC'
    ).all()
  );
});

app.get('/api/events', (req, res) => {
  res.status(200);
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  // Cloudflare-friendly: short retry + immediate comment so the stream is not buffered idle
  res.write('retry: 3000\n\n');
  res.write(': connected\n\n');
  visitEventClients.add(res);

  const heartbeat = setInterval(() => {
    try {
      if (!res.writableEnded) res.write(': keep-alive\n\n');
    } catch (e) {
      clearInterval(heartbeat);
      visitEventClients.delete(res);
    }
  }, 12000);

  res.on('close', () => {
    clearInterval(heartbeat);
    visitEventClients.delete(res);
  });
});

app.post('/api/visits', (req, res) => {
  let {
    purpose,
    student_name,
    grade,
    section,
    strand,
    illness,
    severity,
    action_taken
  } = req.body;

  purpose = purpose || 'Consultation';

  if (!PURPOSES.includes(purpose)) {
    return res.status(400).json({
      error: 'purpose must be Feeding or Consultation.'
    });
  }

  student_name = String(student_name || '').trim();
  if (purpose === 'Feeding' && !student_name) {
    return res.status(400).json({
      error: 'Student name is required for Feeding.'
    });
  }
  if (purpose !== 'Feeding') {
    // Consultation: name optional (kiosk privacy) — still saved if provided
    student_name = student_name || '';
  }
  if (student_name.length > 120) {
    return res.status(400).json({
      error: 'Student name must be 120 characters or fewer.'
    });
  }

  if (!GRADES.includes(grade)) {
    return res.status(400).json({
      error: 'grade must be Grade 11 or Grade 12.'
    });
  }

  section = section || '';
  if (section && !isValidSection(grade, section)) {
    return res.status(400).json({
      error: 'invalid section for the selected grade.'
    });
  }

  strand = strand || '';
  if (strand && !STRANDS.includes(strand)) {
    return res.status(400).json({
      error: 'invalid strand.'
    });
  }

  if (purpose === 'Feeding') {
    illness = '';
    severity = '';
  } else {
    if (!ILLNESSES.includes(illness)) {
      return res.status(400).json({
        error: 'invalid illness type.'
      });
    }
    if (!['mild', 'moderate', 'severe'].includes(severity)) {
      return res.status(400).json({
        error: 'invalid severity.'
      });
    }
  }

  const info = db.prepare(`
    INSERT INTO visits
    (purpose, student_name, grade, section, strand, illness, severity, action_taken)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    purpose,
    student_name,
    grade,
    section,
    strand,
    illness || '',
    severity || '',
    action_taken || ''
  );

  publishVisitUpdate();
  res.status(201).json(
    db.prepare(
      'SELECT * FROM visits WHERE id = ?'
    ).get(info.lastInsertRowid)
  );
});

app.delete('/api/visits/:id', (req, res) => {
  db.prepare(
    'DELETE FROM visits WHERE id = ?'
  ).run(req.params.id);

  publishVisitUpdate();
  res.json({ success: true });
});

/* ============== SUMMARIES ============== */

app.get('/api/summary/daily', (req, res) => {
  res.json(
    db.prepare(`
      SELECT
        date(visit_time) AS day,
        COUNT(*) AS count
      FROM visits
      WHERE visit_time >= datetime('now','-14 days')
      GROUP BY day
      ORDER BY day ASC
    `).all()
  );
});

app.get('/api/summary/illness', (req, res) => {
  res.json(
    db.prepare(`
      SELECT
        illness,
        COUNT(*) AS count
      FROM visits
      WHERE purpose = 'Consultation'
        AND illness IS NOT NULL
        AND illness != ''
      GROUP BY illness
      ORDER BY count DESC
    `).all()
  );
});

app.get('/api/summary/grade', (req, res) => {
  res.json(
    db.prepare(`
      SELECT
        grade,
        COUNT(*) AS count
      FROM visits
      GROUP BY grade
      ORDER BY grade ASC
    `).all()
  );
});

app.get('/api/summary/purpose', (req, res) => {
  res.json(
    db.prepare(`
      SELECT
        purpose,
        COUNT(*) AS count
      FROM visits
      GROUP BY purpose
      ORDER BY count DESC
    `).all()
  );
});

app.get('/api/summary/section', (req, res) => {
  res.json(
    db.prepare(`
      SELECT
        grade,
        section,
        COUNT(*) AS count
      FROM visits
      WHERE section IS NOT NULL AND section != ''
      GROUP BY grade, section
      ORDER BY count DESC
    `).all()
  );
});

app.get('/api/summary/strand-daily', (req, res) => {
  res.json(
    db.prepare(`
      SELECT
        date(visit_time) AS day,
        strand,
        COUNT(*) AS count
      FROM visits
      WHERE visit_time >= datetime('now','-7 days')
        AND strand IS NOT NULL
        AND strand != ''
      GROUP BY day, strand
      ORDER BY day ASC
    `).all()
  );
});

app.get('/api/summary/illness-weekly', (req, res) => {
  res.json(
    db.prepare(`
      SELECT
        strftime('%Y-W%W', visit_time) AS week,
        illness,
        COUNT(*) AS count
      FROM visits
      WHERE visit_time >= datetime('now','-42 days')
        AND purpose = 'Consultation'
        AND illness IS NOT NULL
        AND illness != ''
      GROUP BY week, illness
      ORDER BY week ASC
    `).all()
  );
});

/* ============== TREND ============== */

app.get('/api/trend', (req, res) => {

  const thisWeek = db.prepare(`
    SELECT COUNT(*) AS c
    FROM visits
    WHERE visit_time >= datetime('now','-7 days')
  `).get().c;

  const lastWeek = db.prepare(`
    SELECT COUNT(*) AS c
    FROM visits
    WHERE visit_time < datetime('now','-7 days')
      AND visit_time >= datetime('now','-14 days')
  `).get().c;

  const pct =
    lastWeek === 0
      ? (thisWeek > 0 ? 100 : 0)
      : Math.round(((thisWeek - lastWeek) / lastWeek) * 100);

  const perGrade = GRADES.map(grade => {

    const now = db.prepare(`
      SELECT COUNT(*) AS c
      FROM visits
      WHERE grade = ?
        AND visit_time >= datetime('now','-7 days')
    `).get(grade).c;

    const prev = db.prepare(`
      SELECT COUNT(*) AS c
      FROM visits
      WHERE grade = ?
        AND visit_time < datetime('now','-7 days')
        AND visit_time >= datetime('now','-14 days')
    `).get(grade).c;

    const gPct =
      prev === 0
        ? (now > 0 ? 100 : 0)
        : Math.round(((now - prev) / prev) * 100);

    return {
      grade,
      thisWeek: now,
      lastWeek: prev,
      pct: gPct
    };
  });

  res.json({
    thisWeek,
    lastWeek,
    pct,
    direction: thisWeek >= lastWeek ? 'up' : 'down',
    perGrade
  });
});

/* ============== ALERTS ============== */

app.get('/api/alerts', (req, res) => {

  const rows = db.prepare(`
    SELECT
      illness,
      SUM(
        CASE
          WHEN visit_time >= datetime('now','-30 days')
          THEN 1 ELSE 0
        END
      ) AS recent,
      SUM(
        CASE
          WHEN visit_time < datetime('now','-30 days')
           AND visit_time >= datetime('now','-60 days')
          THEN 1 ELSE 0
        END
      ) AS prior
    FROM visits
    WHERE purpose = 'Consultation'
      AND illness IS NOT NULL
      AND illness != ''
    GROUP BY illness
  `).all();

  const alerts = rows
    .filter(row => row.prior > 0 && row.recent > row.prior)
    .map(row => ({
      illness: row.illness,
      pctIncrease: Math.round(
        ((row.recent - row.prior) / row.prior) * 100
      ),
      recent: row.recent,
      prior: row.prior
    }))
    .sort((a, b) => b.pctIncrease - a.pctIncrease);

  res.json(alerts);
});

/* ============== CAMPAIGN SUGGESTION ============== */

app.get('/api/campaign-suggestion', (req, res) => {

  const top = db.prepare(`
    SELECT
      illness,
      COUNT(*) AS count
    FROM visits
    WHERE purpose = 'Consultation'
      AND illness IS NOT NULL
      AND illness != ''
    GROUP BY illness
    ORDER BY count DESC
    LIMIT 1
  `).get();

  const map = {
    'Headache': {
      title: 'Hydration Awareness Campaign',
      reason: 'High number of headache cases, often linked to dehydration.'
    },
    'Fever': {
      title: 'Flu & Fever Prevention Drive',
      reason: 'Rising fever cases suggest a possible viral spread on campus.'
    },
    'Stomachache': {
      title: 'Food Safety & Canteen Hygiene Campaign',
      reason: 'Frequent stomachaches may point to canteen food/water quality.'
    },
    'Minor Injury': {
      title: 'Campus Safety Awareness Week',
      reason: 'Repeated minor injuries suggest hazards in walkways or PE areas.'
    },
    'Cough/Colds': {
      title: 'Respiratory Hygiene Campaign',
      reason: 'Increase in cough/colds suggests airborne spread in classrooms.'
    },
    'Allergy': {
      title: 'Allergen Awareness Campaign',
      reason: 'Recurring allergy cases may need environmental/food allergen review.'
    },
    'Dizziness': {
      title: 'Nutrition & Skipped-Meals Campaign',
      reason: 'Dizziness cases may relate to skipped meals.'
    },
    'Menstrual Cramps': {
      title: 'Menstrual Health Awareness Campaign',
      reason: 'Frequent menstrual cramp cases suggest a need for menstrual health education and support.'
    },
    'Others': {
      title: 'General Wellness Check Campaign',
      reason: 'Varied cases suggest a broad wellness check may help.'
    }
  };

  if (!top) {
    return res.json(null);
  }

  res.json({
    illness: top.illness,
    count: top.count,
    ...map[top.illness]
  });
});

/* ============== INVENTORY ============== */

app.get('/api/inventory', (req, res) => {
  res.json(
    db.prepare(
      'SELECT * FROM inventory ORDER BY item_name ASC'
    ).all()
  );
});

app.post('/api/inventory', (req, res) => {
  const name = String(req.body.item_name || req.body.name || '').trim();
  let level = req.body.level;
  if (level === undefined || level === null) level = 50;
  level = Math.max(0, parseInt(level, 10) || 0);

  if (!name || name.length > 120) {
    return res.status(400).json({ error: 'item_name is required (max 120 chars).' });
  }

  try {
    const info = db.prepare(
      'INSERT INTO inventory (item_name, level) VALUES (?, ?)'
    ).run(name, level);
    res.status(201).json(
      db.prepare('SELECT * FROM inventory WHERE id = ?').get(info.lastInsertRowid)
    );
  } catch (err) {
    if (String(err.message || '').includes('UNIQUE')) {
      return res.status(409).json({ error: 'Item already exists.' });
    }
    throw err;
  }
});

app.put('/api/inventory/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'invalid id.' });

  // Support both absolute level and delta adjustment
  let level = req.body.level;
  if (req.body.delta !== undefined) {
    const row = db.prepare('SELECT level FROM inventory WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ error: 'Item not found.' });
    level = row.level + (parseInt(req.body.delta, 10) || 0);
  }

  level = parseInt(level, 10);
  if (Number.isNaN(level) || level < 0) {
    return res.status(400).json({ error: 'level must be 0 or greater (unlimited max).' });
  }

  const result = db.prepare(
    'UPDATE inventory SET level = ? WHERE id = ?'
  ).run(level, id);

  if (result.changes === 0) {
    return res.status(404).json({ error: 'Item not found.' });
  }

  res.json(
    db.prepare('SELECT * FROM inventory WHERE id = ?').get(id)
  );
});

app.delete('/api/inventory/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const result = db.prepare('DELETE FROM inventory WHERE id = ?').run(id);
  if (result.changes === 0) {
    return res.status(404).json({ error: 'Item not found.' });
  }
  res.json({ success: true });
});

/* ============== META ============== */

app.get('/api/meta', (req, res) => {
  res.json({
    GRADES,
    STRANDS,
    PURPOSES,
    ILLNESSES,
    SECTIONS
  });
});


/* ============== ADVISER PORTAL ============== */

app.get('/api/adviser/sections', (req, res) => {
  res.json({
    GRADES,
    SECTIONS
  });
});

app.post('/api/adviser/login', (req, res) => {
  cleanExpiredAdviserSessions();
  const section = String((req.body && req.body.section) || '').trim();
  const password = String((req.body && req.body.password) || '');
  if (!section || !SECTION_PASSWORDS[section]) {
    return res.status(400).json({ error: 'Unknown section.' });
  }
  if (password !== SECTION_PASSWORDS[section]) {
    return res.status(401).json({ error: 'Incorrect password.' });
  }
  const token = createAdviserToken();
  const grade = getGradeForSection(section);
  adviserSessions.set(token, {
    section,
    grade,
    exp: Date.now() + 8 * 60 * 60 * 1000 // 8 hours
  });
  res.json({ token, section, grade });
});

app.post('/api/adviser/logout', (req, res) => {
  const token = String((req.body && req.body.token) || req.headers['x-adviser-token'] || '');
  if (token) adviserSessions.delete(token);
  res.json({ ok: true });
});

app.get('/api/adviser/visits', (req, res) => {
  cleanExpiredAdviserSessions();
  const token = String(req.query.token || req.headers['x-adviser-token'] || '');
  const session = adviserSessions.get(token);
  if (!session || session.exp < Date.now()) {
    if (token) adviserSessions.delete(token);
    return res.status(401).json({ error: 'Session expired. Please log in again.' });
  }
  const rows = db.prepare(
    `SELECT id, purpose, student_name, grade, section, illness, severity, action_taken, visit_time
     FROM visits
     WHERE section = ?
     ORDER BY visit_time DESC
     LIMIT 500`
  ).all(session.section);
  res.json({
    section: session.section,
    grade: session.grade,
    visits: rows
  });
});


app.patch('/api/adviser/visits/:id', (req, res) => {
  cleanExpiredAdviserSessions();
  const token = String(req.body.token || req.headers['x-adviser-token'] || req.query.token || '');
  const session = adviserSessions.get(token);
  if (!session || session.exp < Date.now()) {
    return res.status(401).json({ error: 'Session expired. Please log in again.' });
  }
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM visits WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Visit not found.' });
  if (row.section !== session.section) {
    return res.status(403).json({ error: 'This visit is not in your section.' });
  }

  let student_name = req.body.student_name !== undefined
    ? String(req.body.student_name || '').trim()
    : row.student_name;
  if (student_name.length > 120) {
    return res.status(400).json({ error: 'Student name must be 120 characters or fewer.' });
  }

  // Advisers may set name (and optional notes) on consultation/feeding records of their section
  db.prepare('UPDATE visits SET student_name = ? WHERE id = ?').run(student_name, id);
  publishVisitUpdate();
  res.json(db.prepare('SELECT * FROM visits WHERE id = ?').get(id));
});

app.post('/api/adviser/visits', (req, res) => {
  cleanExpiredAdviserSessions();
  const token = String(req.body.token || req.headers['x-adviser-token'] || '');
  const session = adviserSessions.get(token);
  if (!session || session.exp < Date.now()) {
    return res.status(401).json({ error: 'Session expired. Please log in again.' });
  }

  let purpose = req.body.purpose || 'Consultation';
  if (!PURPOSES.includes(purpose)) {
    return res.status(400).json({ error: 'purpose must be Feeding or Consultation.' });
  }
  const student_name = String(req.body.student_name || '').trim();
  if (!student_name) {
    return res.status(400).json({ error: 'Student name is required.' });
  }
  if (student_name.length > 120) {
    return res.status(400).json({ error: 'Student name must be 120 characters or fewer.' });
  }

  let illness = '';
  let severity = '';
  if (purpose === 'Consultation') {
    illness = String(req.body.illness || 'Others');
    if (!ILLNESSES.includes(illness)) illness = 'Others';
    severity = String(req.body.severity || 'mild');
    if (!['mild', 'moderate', 'severe'].includes(severity)) severity = 'mild';
  }

  const info = db.prepare(`
    INSERT INTO visits
    (purpose, student_name, grade, section, strand, illness, severity, action_taken)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    purpose,
    student_name,
    session.grade || '',
    session.section,
    '',
    illness,
    severity,
    String(req.body.action_taken || '')
  );
  publishVisitUpdate();
  res.status(201).json(db.prepare('SELECT * FROM visits WHERE id = ?').get(info.lastInsertRowid));
});


app.get('/adviser', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'adviser.html'));
});


/* ============== CHECK-IN ============== */

app.get('/checkin', (req, res) => {
  res.sendFile(
    path.join(__dirname, 'public', 'checkin.html')
  );
});

/* ============== START SERVER ============== */

app.use((err, req, res, next) => {
  console.error('Request error:', err);
  if (res.headersSent) return next(err);
  const status = err.status || 500;
  res.status(status).json({
    error: status === 413 ? 'Request body is too large.' : 'The server could not complete the request.'
  });
});

app.listen(PORT, () => {
  console.log(`✅ SCADS running at http://localhost:${PORT}`);
});