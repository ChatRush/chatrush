require("dotenv").config();

const express = require("express");
const bodyParser = require("body-parser");
const path = require("path");

// ✅ DB + Auth
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const cookieParser = require("cookie-parser");

// ✅ Socket.io
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const PORT = process.env.PORT || 3000;

app.set("trust proxy", 1);
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public")));

// ================= MongoDB Connect =================
async function connectDB() {
  try {
    if (!process.env.MONGODB_URI) {
      console.log("❌ Missing MONGODB_URI env var");
      return;
    }
    await mongoose.connect(process.env.MONGODB_URI);
    console.log("✅ MongoDB connected");
  } catch (e) {
    console.log("❌ MongoDB connect error:", e.message);
  }
}
connectDB();

// ================= User Model =================
const userSchema = new mongoose.Schema(
  {
    username: { type: String, required: true, unique: true, trim: true },
    email: { type: String, required: true, unique: true, trim: true, lowercase: true },
    passwordHash: { type: String, required: true },
  },
  { timestamps: true }
);
const User = mongoose.model("User", userSchema);

// ================= JWT Helpers =================
function signToken(user) {
  if (!process.env.JWT_SECRET) throw new Error("Missing JWT_SECRET env var");
  return jwt.sign(
    { uid: user._id.toString(), username: user.username },
    process.env.JWT_SECRET,
    { expiresIn: "30d" }
  );
}

function authMiddleware(req, res, next) {
  const token = req.cookies?.chatrush_token;
  if (!token) return res.status(401).send("Not logged in. Go back & login.");

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    return res.status(401).send("Session expired. Please login again.");
  }
}

// ================= Routes =================
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ✅ Protect chat page (only logged users)
app.get("/chat.html", authMiddleware, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "chat.html"));
});

// ✅ Register (saved permanently in MongoDB)
app.post("/register", async (req, res) => {
  try {
    const { username, email, password } = req.body;
    if (!username || !email || !password) return res.status(400).send("All fields required.");

    const exists = await User.findOne({
      $or: [{ username }, { email: email.toLowerCase() }],
    });
    if (exists) return res.status(400).send("Username or email already exists.");

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await User.create({
      username,
      email: email.toLowerCase(),
      passwordHash,
    });

    const token = signToken(user);
    res.cookie("chatrush_token", token, {
      httpOnly: true,
      sameSite: "lax",
      secure: true,
      maxAge: 30 * 24 * 60 * 60 * 1000,
    });

    return res.redirect("/chat.html");
  } catch (e) {
    console.error(e);
    return res.status(500).send("Register failed.");
  }
});

// ✅ Login (persistent)
app.post("/login", async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).send("Enter username & password");

    const user = await User.findOne({ username });
    if (!user) return res.status(400).send("Invalid username or password.");

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return res.status(400).send("Invalid username or password.");

    const token = signToken(user);
    res.cookie("chatrush_token", token, {
      httpOnly: true,
      sameSite: "lax",
      secure: true,
      maxAge: 30 * 24 * 60 * 60 * 1000,
    });

    return res.redirect("/chat.html");
  } catch (e) {
    console.error(e);
    return res.status(500).send("Login failed.");
  }
});

// ✅ Logout
app.post("/logout", (req, res) => {
  res.clearCookie("chatrush_token");
  res.redirect("/");
});

// ✅ Check login (for chat page)
app.get("/me", authMiddleware, (req, res) => {
  res.json({ ok: true, user: req.user });
});

// ================= Socket.IO Random Chat =================
const server = http.createServer(app);
const io = new Server(server);

// Online count broadcast
function broadcastOnline() {
  io.emit("online_count", { online: io.of("/").sockets.size });
}

let waitingUser = null;

const partner = {};        // socketId -> partnerSocketId
const socketUser = {};     // socketId -> username
const lastMsgAt = {};      // socketId -> timestamp (rate limit)

function unpair(socketId) {
  const p = partner[socketId];
  if (p) {
    delete partner[p];
    io.to(p).emit("partner_left");
  }
  delete partner[socketId];
}

io.on("connection", (socket) => {
  broadcastOnline();

  socket.on("register_user", (data) => {
    if (data?.username) socketUser[socket.id] = String(data.username).slice(0, 20);
  });

  socket.on("find_partner", () => {
    if (partner[socket.id]) return;

    if (waitingUser && waitingUser !== socket.id) {
      const other = waitingUser;

      partner[socket.id] = other;
      partner[other] = socket.id;

      io.to(socket.id).emit("matched", { partner: socketUser[other] || "Stranger" });
      io.to(other).emit("matched", { partner: socketUser[socket.id] || "Stranger" });

      waitingUser = null;
    } else {
      waitingUser = socket.id;
      socket.emit("waiting");
    }
  });

  // ✅ NEW: Typing indicator (no spam, just event)
  socket.on("typing", () => {
    const p = partner[socket.id];
    if (!p) return;
    io.to(p).emit("typing");
  });

  // rate limit 1 msg per 700ms + attach username + timestamp
  socket.on("chat_message", (msg) => {
    const now = Date.now();
    if (lastMsgAt[socket.id] && now - lastMsgAt[socket.id] < 700) return;
    lastMsgAt[socket.id] = now;

    const p = partner[socket.id];
    if (!p) return;

    const clean = String(msg || "").slice(0, 500);

    const payload = {
      text: clean,
      from: socketUser[socket.id] || "You",
      ts: now,
    };

    io.to(p).emit("chat_message", payload);
    socket.emit("chat_message_self", payload);
  });

  socket.on("next", () => {
    unpair(socket.id);
    if (waitingUser === socket.id) waitingUser = null;

    socket.emit("clear_chat");
    socket.emit("waiting");
  });

  socket.on("disconnect", () => {
    if (waitingUser === socket.id) waitingUser = null;
    unpair(socket.id);

    delete socketUser[socket.id];
    delete lastMsgAt[socket.id];

    broadcastOnline();
  });
});

// ================= Start Server =================
server.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});