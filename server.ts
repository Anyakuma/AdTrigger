import express from "express";
import { createServer as createViteServer } from "vite";
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

const dbPath = path.resolve(process.cwd(), "database.sqlite");
const db = new Database(dbPath);

// Initialize database
db.exec(`
  CREATE TABLE IF NOT EXISTS keywords (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    word TEXT UNIQUE NOT NULL
  );
  
  CREATE TABLE IF NOT EXISTS recordings (
    id TEXT PRIMARY KEY,
    triggerWord TEXT NOT NULL,
    duration REAL NOT NULL,
    timestamp TEXT NOT NULL,
    audioBase64 TEXT NOT NULL,
    size INTEGER NOT NULL
  );
`);

// Insert default keywords if empty
const countKeywords = db.prepare("SELECT COUNT(*) as count FROM keywords").get() as { count: number };
if (countKeywords.count === 0) {
  const insertKeyword = db.prepare("INSERT INTO keywords (word) VALUES (?)");
  const defaults = ['Guinness', 'Hennessy', 'Promotion', 'Sale'];
  defaults.forEach(word => insertKeyword.run(word));
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Increase payload limit for audio base64 uploads
  app.use(express.json({ limit: '50mb' }));

  // --- API Routes ---

  // Keywords
  app.get("/api/keywords", (req, res) => {
    try {
      const rows = db.prepare("SELECT word FROM keywords").all() as { word: string }[];
      res.json(rows.map(r => r.word));
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch keywords" });
    }
  });

  app.post("/api/keywords", (req, res) => {
    try {
      const { word } = req.body;
      if (!word) return res.status(400).json({ error: "Word is required" });
      db.prepare("INSERT OR IGNORE INTO keywords (word) VALUES (?)").run(word);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: "Failed to add keyword" });
    }
  });

  app.delete("/api/keywords/:word", (req, res) => {
    try {
      db.prepare("DELETE FROM keywords WHERE word = ?").run(req.params.word);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: "Failed to delete keyword" });
    }
  });

  // Recordings
  app.get("/api/recordings", (req, res) => {
    try {
      const rows = db.prepare("SELECT id, triggerWord, duration, timestamp, audioBase64, size FROM recordings ORDER BY timestamp DESC").all();
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch recordings" });
    }
  });

  app.post("/api/recordings", (req, res) => {
    try {
      const { id, triggerWord, duration, timestamp, audioBase64, size } = req.body;
      db.prepare(
        "INSERT INTO recordings (id, triggerWord, duration, timestamp, audioBase64, size) VALUES (?, ?, ?, ?, ?, ?)"
      ).run(id, triggerWord, duration, timestamp, audioBase64, size);
      res.json({ success: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to save recording" });
    }
  });

  app.delete("/api/recordings/:id", (req, res) => {
    try {
      db.prepare("DELETE FROM recordings WHERE id = ?").run(req.params.id);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: "Failed to delete recording" });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static("dist"));
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
