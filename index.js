require("dotenv").config();

const express = require("express");
const path = require("path");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    console.log(`${req.method} ${req.path} ${res.statusCode} ${Date.now() - start}ms`);
  });
  next();
});

const PORT = process.env.PORT || 3000;
const APP_NAME = process.env.APP_NAME || "todo-app";
const DATABASE_URL = process.env.POSTGRESQL_ADDON_URI;

// -------------------------------------------------------------------
// SSE clients store
// -------------------------------------------------------------------
const sseClients = new Set();

// -------------------------------------------------------------------
// Storage — PostgreSQL si POSTGRESQL_ADDON_URI est défini
// -------------------------------------------------------------------
let storage;
if (DATABASE_URL) {
  const { Pool } = require("pg");
  const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false },
  });

  storage = {
    async init() {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS todos (
          id          SERIAL PRIMARY KEY,
          title       VARCHAR(255) NOT NULL,
          description TEXT,
          due_date    DATE,
          status      VARCHAR(10) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done')),
          created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
    },
    async healthCheck() {
      await pool.query("SELECT 1");
      return "connected";
    },
    async findAll(status) {
      const query = status
        ? { text: "SELECT * FROM todos WHERE status = $1 ORDER BY created_at DESC", values: [status] }
        : { text: "SELECT * FROM todos ORDER BY created_at DESC" };
      const result = await pool.query(query);
      return result.rows;
    },
    async findById(id) {
      const result = await pool.query("SELECT * FROM todos WHERE id = $1", [id]);
      return result.rows[0] || null;
    },
    async insert(title, description, due_date) {
      const result = await pool.query(
        "INSERT INTO todos (title, description, due_date) VALUES ($1, $2, $3) RETURNING *",
        [title, description ?? null, due_date ?? null]
      );
      return result.rows[0];
    },
    async update(id, fields) {
      const allowed = ["title", "description", "due_date", "status"];
      const updates = Object.keys(fields).filter((k) => allowed.includes(k));
      if (updates.length === 0) return null;
      const setClauses = updates.map((key, i) => `${key} = $${i + 1}`).join(", ");
      const values = [...updates.map((k) => fields[k]), id];
      const result = await pool.query(
        `UPDATE todos SET ${setClauses} WHERE id = $${updates.length + 1} RETURNING *`,
        values
      );
      return result.rows[0] || null;
    },
    async remove(id) {
      const result = await pool.query("DELETE FROM todos WHERE id = $1 RETURNING id", [id]);
      return result.rows[0] || null;
    },
    async findOverdue() {
      const result = await pool.query(
        "SELECT * FROM todos WHERE status = 'pending' AND due_date < CURRENT_DATE ORDER BY due_date ASC"
      );
      return result.rows;
    },
  };
} else {
  console.warn("POSTGRESQL_ADDON_URI non défini — stockage en mémoire (données perdues au redémarrage)");
  const todos = [];
  let nextId = 1;

  storage = {
    async init() {},
    async healthCheck() { return "not configured"; },
    async findAll(status) {
      return status ? todos.filter((t) => t.status === status) : [...todos];
    },
    async findById(id) {
      return todos.find((t) => t.id === Number(id)) || null;
    },
    async insert(title, description, due_date) {
      const todo = {
        id: nextId++,
        title,
        description: description ?? null,
        due_date: due_date ?? null,
        status: "pending",
        created_at: new Date().toISOString(),
      };
      todos.push(todo);
      return todo;
    },
    async update(id, fields) {
      const todo = todos.find((t) => t.id === Number(id));
      if (!todo) return null;
      Object.assign(todo, fields);
      return todo;
    },
    async remove(id) {
      const idx = todos.findIndex((t) => t.id === Number(id));
      if (idx === -1) return null;
      return todos.splice(idx, 1)[0];
    },
    async findOverdue() {
      const today = new Date().toISOString().split("T")[0];
      return todos.filter((t) => t.status === "pending" && t.due_date && t.due_date < today);
    },
  };
}

// -------------------------------------------------------------------
// Routes
// -------------------------------------------------------------------

// GET /health
app.get("/health", async (req, res) => {
  const health = { status: "ok", app: APP_NAME, database: "not configured" };
  if (DATABASE_URL) {
    try {
      health.database = await storage.healthCheck();
    } catch {
      return res.status(503).json({ status: "error", app: APP_NAME, database: "unreachable" });
    }
  }
  res.json(health);
});

// GET /todos
app.get("/todos", async (req, res) => {
  try {
    const todos = await storage.findAll(req.query.status);
    res.json(todos);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /todos/overdue — doit être avant /todos/:id
app.get("/todos/overdue", async (req, res) => {
  try {
    const todos = await storage.findOverdue();
    res.json(todos);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /todos
app.post("/todos", async (req, res) => {
  const { title, description, due_date } = req.body;
  if (!title || title.trim() === "") {
    return res.status(400).json({ error: "Le champ 'title' est obligatoire et ne peut pas être vide" });
  }
  try {
    const todo = await storage.insert(title.trim(), description, due_date);
    res.status(201).json(todo);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /todos/:id
app.patch("/todos/:id", async (req, res) => {
  try {
    const todo = await storage.update(req.params.id, req.body);
    if (!todo) return res.status(404).json({ error: "Todo non trouvé" });
    res.json(todo);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /todos/:id
app.delete("/todos/:id", async (req, res) => {
  try {
    const todo = await storage.remove(req.params.id);
    if (!todo) return res.status(404).json({ error: "Todo non trouvé" });
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /alerts — flux SSE
app.get("/alerts", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  sseClients.add(res);
  console.log(`SSE client connecté — total: ${sseClients.size}`);

  const ping = setInterval(() => {
    res.write("event: ping\ndata: {}\n\n");
  }, 30000);

  req.on("close", () => {
    clearInterval(ping);
    sseClients.delete(res);
    console.log(`SSE client déconnecté — total: ${sseClients.size}`);
  });
});

// POST /todos/:id/notify
app.post("/todos/:id/notify", async (req, res) => {
  try {
    const todo = await storage.findById(req.params.id);
    if (!todo) return res.status(404).json({ error: "Todo non trouvé" });

    const payload = JSON.stringify({
      id: todo.id,
      title: todo.title,
      status: todo.status,
      due_date: todo.due_date,
    });

    sseClients.forEach((client) => {
      client.write(`event: todo_alert\ndata: ${payload}\n\n`);
    });

    res.json({ message: "Alerte envoyée", listeners: sseClients.size });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /crash — provoque un arrêt brutal du processus (démo PaaS)
app.get("/crash", (req, res) => {
  res.json({ message: "Crash imminent..." });
  setTimeout(() => process.exit(1), 100);
});

// -------------------------------------------------------------------
// Démarrage
// -------------------------------------------------------------------
storage
  .init()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`App démarrée sur le port ${PORT}`);
      console.log(`Base de données : ${DATABASE_URL ? "PostgreSQL" : "mémoire"}`);
    });
  })
  .catch((err) => {
    console.error("Erreur d'initialisation :", err.message);
    process.exit(1);
  });