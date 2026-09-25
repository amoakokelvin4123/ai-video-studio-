import "dotenv/config";
import express from "express";
import session from "express-session";
import pg from "pg";
import connectPgSimple from "connect-pg-simple";
import multer from "multer";
import bcrypt from "bcryptjs";
import RunwayML, { TaskFailedError } from "@runwayml/sdk";
import crypto from "node:crypto";

const { Pool } = pg;
const PgStore = connectPgSimple(session);
const app = express();
const port = Number(process.env.PORT || 3000);
const MODEL = process.env.RUNWAY_MODEL || "gen4.5";
const STARTER_CREDITS = Number(process.env.APP_STARTER_CREDITS || 120);
// This is the app's internal credit system, not Runway billing.
const CREDITS_PER_SECOND = Number(process.env.APP_CREDITS_PER_SECOND || 12);

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required.");
}
if (!process.env.SESSION_SECRET) {
  throw new Error("SESSION_SECRET is required.");
}
if (!process.env.RUNWAYML_API_SECRET) {
  console.warn("WARNING: RUNWAYML_API_SECRET is not set. Video generation will be unavailable.");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.DB_POOL_MAX || 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000
});

const runway = new RunwayML({ apiKey: process.env.RUNWAYML_API_SECRET });

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      credits INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS generations (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      runway_task_id TEXT NOT NULL UNIQUE,
      prompt TEXT NOT NULL,
      mode TEXT NOT NULL,
      duration INTEGER NOT NULL,
      ratio TEXT NOT NULL,
      status TEXT NOT NULL,
      video_url TEXT,
      input_image_name TEXT,
      credits_charged INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    );

    CREATE INDEX IF NOT EXISTS idx_generations_user_id_id
      ON generations(user_id, id DESC);
  `);
}

await initDb();

app.set("trust proxy", 1);
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(session({
  store: new PgStore({
    pool,
    createTableIfMissing: true
  }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 1000 * 60 * 60 * 24 * 7
  }
}));
app.use(express.static("public"));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ["image/png", "image/jpeg", "image/webp"];
    cb(null, allowed.includes(file.mimetype));
  }
});

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: "Please log in." });
  next();
}

function cleanEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function validPrompt(value) {
  return typeof value === "string" && value.trim().length >= 3 && value.trim().length <= 2000;
}

function allowedDuration(value) {
  return [5, 10].includes(Number(value));
}

function allowedRatio(value, hasImage) {
  const ratios = hasImage
    ? ["1280:720", "720:1280", "960:960", "1584:672", "1104:832", "832:1104", "672:1584"]
    : ["1280:720", "720:1280"];
  return ratios.includes(value);
}

function creditsFor(duration) {
  return Number(duration) * CREDITS_PER_SECOND;
}

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    credits: Number(user.credits),
    createdAt: user.created_at
  };
}

async function currentUser(req) {
  if (!req.session.userId) return null;
  const { rows } = await pool.query("SELECT * FROM users WHERE id = $1", [req.session.userId]);
  return rows[0] || null;
}

app.get("/api/me", async (req, res) => {
  try {
    const user = await currentUser(req);
    res.json({ user: user ? publicUser(user) : null });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Could not load your account." });
  }
});

app.post("/api/auth/register", async (req, res) => {
  try {
    const name = String(req.body.name || "").trim();
    const email = cleanEmail(req.body.email);
    const password = String(req.body.password || "");

    if (name.length < 2 || name.length > 60) {
      return res.status(400).json({ error: "Name must be 2–60 characters." });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: "Enter a valid email address." });
    }
    if (password.length < 8 || password.length > 128) {
      return res.status(400).json({ error: "Password must be 8–128 characters." });
    }

    const existing = await pool.query("SELECT id FROM users WHERE email = $1", [email]);
    if (existing.rowCount) {
      return res.status(409).json({ error: "An account with that email already exists." });
    }

    const hash = await bcrypt.hash(password, 12);
    const result = await pool.query(`
      INSERT INTO users (name, email, password_hash, credits)
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `, [name, email, hash, STARTER_CREDITS]);

    req.session.userId = result.rows[0].id;
    res.status(201).json({ user: publicUser(result.rows[0]) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Could not create the account." });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const email = cleanEmail(req.body.email);
    const password = String(req.body.password || "");
    const result = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
    const user = result.rows[0];

    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: "Email or password is incorrect." });
    }

    req.session.userId = user.id;
    res.json({ user: publicUser(user) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Could not log in." });
  }
});

app.post("/api/auth/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get("/api/dashboard", requireAuth, async (req, res) => {
  try {
    const user = await currentUser(req);
    if (!user) return res.status(401).json({ error: "Please log in." });

    const historyResult = await pool.query(`
      SELECT id, prompt, mode, duration, ratio, status, video_url,
             input_image_name, credits_charged, created_at, completed_at
      FROM generations
      WHERE user_id = $1
      ORDER BY id DESC
      LIMIT 50
    `, [user.id]);

    const statsResult = await pool.query(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status = 'SUCCEEDED' THEN 1 ELSE 0 END) AS completed,
        SUM(CASE WHEN status IN ('PENDING','RUNNING') THEN 1 ELSE 0 END) AS processing,
        COALESCE(SUM(credits_charged), 0) AS "creditsUsed"
      FROM generations
      WHERE user_id = $1
    `, [user.id]);

    const stats = statsResult.rows[0];
    res.json({
      user: publicUser(user),
      stats: {
        total: Number(stats.total || 0),
        completed: Number(stats.completed || 0),
        processing: Number(stats.processing || 0),
        creditsUsed: Number(stats.creditsUsed || 0)
      },
      history: historyResult.rows
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Could not load the dashboard." });
  }
});

app.post("/api/videos", requireAuth, upload.single("image"), async (req, res) => {
  const user = await currentUser(req);
  if (!user) return res.status(401).json({ error: "Please log in." });

  const prompt = String(req.body.prompt || "").trim();
  const duration = Number(req.body.duration || 5);
  const ratio = String(req.body.ratio || "1280:720");
  const mode = req.file ? "image-to-video" : "text-to-video";
  const charge = creditsFor(duration);

  if (!validPrompt(prompt)) {
    return res.status(400).json({ error: "Prompt must be 3–2000 characters." });
  }
  if (!allowedDuration(duration)) {
    return res.status(400).json({ error: "Duration must be 5 or 10 seconds." });
  }
  if (!allowedRatio(ratio, Boolean(req.file))) {
    return res.status(400).json({ error: "Choose a supported video format." });
  }
  if (!process.env.RUNWAYML_API_SECRET) {
    return res.status(500).json({ error: "Runway API key is not configured on the server." });
  }
  if (Number(user.credits) < charge) {
    return res.status(402).json({
      error: `You need ${charge} credits, but only have ${user.credits}.`
    });
  }

  try {
    const params = { model: MODEL, promptText: prompt, ratio, duration };

    if (req.file) {
      const base64 = req.file.buffer.toString("base64");
      params.promptImage = `data:${req.file.mimetype};base64,${base64}`;
    }

    const task = await runway.imageToVideo.create(params);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const creditResult = await client.query(
        "UPDATE users SET credits = credits - $1 WHERE id = $2 AND credits >= $1 RETURNING credits",
        [charge, user.id]
      );
      if (!creditResult.rowCount) {
        await client.query("ROLLBACK");
        return res.status(402).json({ error: "You no longer have enough credits." });
      }

      await client.query(`
        INSERT INTO generations
          (user_id, runway_task_id, prompt, mode, duration, ratio, status,
           input_image_name, credits_charged)
        VALUES ($1, $2, $3, $4, $5, $6, 'PENDING', $7, $8)
      `, [user.id, task.id, prompt, mode, duration, ratio, req.file?.originalname || null, charge]);

      await client.query("COMMIT");
      res.status(202).json({
        id: task.id,
        status: "PENDING",
        charged: charge,
        creditsRemaining: Number(creditResult.rows[0].credits)
      });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error(error);
    if (error instanceof TaskFailedError) {
      return res.status(502).json({
        error: "Runway rejected the generation request.",
        details: error.taskDetails ?? null
      });
    }
    res.status(500).json({
      error: "Could not start video generation.",
      details: error?.message || "Unknown error"
    });
  }
});

app.get("/api/videos/:taskId", requireAuth, async (req, res) => {
  const user = await currentUser(req);
  if (!user) return res.status(401).json({ error: "Please log in." });

  const found = await pool.query(`
    SELECT * FROM generations
    WHERE runway_task_id = $1 AND user_id = $2
  `, [req.params.taskId, user.id]);
  const row = found.rows[0];
  if (!row) return res.status(404).json({ error: "Generation not found." });

  try {
    const task = await runway.tasks.retrieve(row.runway_task_id);
    const status = task.status;

    if (status === "SUCCEEDED") {
      const url = task.output?.[0] || null;
      await pool.query(`
        UPDATE generations
        SET status = 'SUCCEEDED', video_url = $1, completed_at = NOW()
        WHERE id = $2
      `, [url, row.id]);
    } else if (status === "FAILED" || status === "CANCELED") {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const refundResult = await client.query(`
          UPDATE generations
          SET status = $1, credits_charged = 0
          WHERE id = $2 AND credits_charged > 0
          RETURNING credits_charged + 0 AS refund
        `, [status, row.id]);
        if (refundResult.rowCount) {
          const refund = Number(refundResult.rows[0].refund);
          await client.query("UPDATE users SET credits = credits + $1 WHERE id = $2", [refund, user.id]);
        } else {
          await client.query("UPDATE generations SET status = $1 WHERE id = $2", [status, row.id]);
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    } else {
      await pool.query("UPDATE generations SET status = $1 WHERE id = $2", [status, row.id]);
    }

    const updatedResult = await pool.query(`
      SELECT id, prompt, mode, duration, ratio, status, video_url,
             input_image_name, credits_charged, created_at, completed_at
      FROM generations WHERE id = $1
    `, [row.id]);
    const updated = updatedResult.rows[0];
    const freshUser = await currentUser(req);

    res.json({ ...updated, credits: Number(freshUser.credits) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Could not retrieve generation status." });
  }
});

app.delete("/api/videos/:id", requireAuth, async (req, res) => {
  const user = await currentUser(req);
  if (!user) return res.status(401).json({ error: "Please log in." });

  const result = await pool.query(
    "DELETE FROM generations WHERE id = $1 AND user_id = $2 RETURNING id",
    [req.params.id, user.id]
  );
  if (!result.rowCount) return res.status(404).json({ error: "Generation not found." });
  res.json({ ok: true });
});

app.get("/api/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({
      ok: true,
      database: true,
      runwayConfigured: Boolean(process.env.RUNWAYML_API_SECRET)
    });
  } catch {
    res.status(503).json({ ok: false, database: false });
  }
});

app.get(/.*/, (req, res) => {
  if (req.path.startsWith("/api/")) return res.status(404).json({ error: "Not found." });
  res.sendFile("index.html", { root: "public" });
});

const server = app.listen(port, "0.0.0.0", () => {
  console.log(`AI Video Studio listening on port ${port}`);
});

async function shutdown(signal) {
  console.log(`${signal} received. Shutting down...`);
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
