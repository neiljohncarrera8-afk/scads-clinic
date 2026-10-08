const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const dbPath = process.env.DATABASE_PATH || path.join(__dirname, 'clinic.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

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

/* ============== SCHEMA ============== */

db.exec(`
  CREATE TABLE IF NOT EXISTS visits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    purpose TEXT NOT NULL DEFAULT 'Consultation',
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
    level INTEGER NOT NULL CHECK(level BETWEEN 0 AND 100),
    status TEXT GENERATED ALWAYS AS (
      CASE
        WHEN level <= 10 THEN 'critical'
        WHEN level <= 25 THEN 'low'
        ELSE 'ok'
      END
    ) VIRTUAL
  );
`);

/* ============== MIGRATE OLD DB ============== */
/* Existing clinic.db may have old CHECK constraints on strand/illness/severity.
   Rebuild the visits table once if purpose/section columns are missing. */

(function migrateVisits() {
  const cols = db.prepare('PRAGMA table_info(visits)').all().map(c => c.name);

  if (!cols.includes('purpose') || !cols.includes('section')) {
    db.exec(`
      BEGIN;
      CREATE TABLE IF NOT EXISTS visits_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        purpose TEXT NOT NULL DEFAULT 'Consultation',
        grade TEXT NOT NULL,
        section TEXT DEFAULT '',
        strand TEXT DEFAULT '',
        illness TEXT DEFAULT '',
        severity TEXT DEFAULT '',
        action_taken TEXT,
        visit_time TEXT DEFAULT (datetime('now','localtime'))
      );
      INSERT INTO visits_new
        (id, purpose, grade, section, strand, illness, severity, action_taken, visit_time)
      SELECT
        id,
        'Consultation',
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
  }
})();

/* ============== SEED INVENTORY ============== */

if (process.env.SEED_DEMO_DATA === 'true' && db.prepare('SELECT COUNT(*) c FROM inventory').get().c === 0) {
  const ins = db.prepare(
    'INSERT INTO inventory (item_name, level) VALUES (?, ?)'
  );

  const tx = db.transaction(rows => {
    rows.forEach(row => ins.run(...row));
  });

  tx([
    ['Paracetamol (500mg)', 78],
    ['Povidone Iodine', 45],
    ['Bandages / Gauze', 18],
    ['Cotton Balls', 60],
    ['Oral Rehydration Salts', 12],
    ['Alcohol / Antiseptic', 8]
  ]);
}

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

app.post('/api/visits', (req, res) => {
  let {
    purpose,
    grade,
    section,
    strand,
    illness,
    severity,
    action_taken
  } = req.body;

  // Default purpose for older clients
  purpose = purpose || 'Consultation';

  if (!PURPOSES.includes(purpose)) {
    return res.status(400).json({
      error: 'purpose must be Feeding or Consultation.'
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

  // Strand is optional (kept for older dashboard form / charts)
  strand = strand || '';
  if (strand && !STRANDS.includes(strand)) {
    return res.status(400).json({
      error: 'invalid strand.'
    });
  }

  if (purpose === 'Feeding') {
    // Feeding: no illness/severity required
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
    (purpose, grade, section, strand, illness, severity, action_taken)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    purpose,
    grade,
    section,
    strand,
    illness || '',
    severity || '',
    action_taken || ''
  );

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
  // Only consultation visits with an illness
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

/* ============== STRAND DAILY ============== */

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

/* ============== ILLNESS WEEKLY ============== */

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

app.put('/api/inventory/:id', (req, res) => {

  const { level } = req.body;

  if (
    level === undefined ||
    level < 0 ||
    level > 100
  ) {
    return res.status(400).json({
      error: 'level must be 0-100.'
    });
  }

  db.prepare(
    'UPDATE inventory SET level = ? WHERE id = ?'
  ).run(level, req.params.id);

  res.json(
    db.prepare(
      'SELECT * FROM inventory WHERE id = ?'
    ).get(req.params.id)
  );
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
;
