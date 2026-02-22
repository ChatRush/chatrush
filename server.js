require("dotenv").config();

const express = require("express");
const bodyParser = require("body-parser");
const path = require("path");

const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const cookieParser = require("cookie-parser");

const http = require("http");
const { Server } = require("socket.io");

const multer = require("multer");
const streamifier = require("streamifier");
const cloudinary = require("cloudinary").v2;
const { nanoid } = require("nanoid");

const app = express();
const PORT = process.env.PORT || 3000;

app.set("trust proxy", 1);
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json({ limit: "2mb" }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public")));

// ================= Cloudinary =================
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME || "",
  api_key: process.env.CLOUDINARY_API_KEY || "",
  api_secret: process.env.CLOUDINARY_API_SECRET || "",
});

function cloudinaryReady() {
  return (
    !!process.env.CLOUDINARY_CLOUD_NAME &&
    !!process.env.CLOUDINARY_API_KEY &&
    !!process.env.CLOUDINARY_API_SECRET
  );
}

// ================= MongoDB =================
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

// ================= Models =================
const userSchema = new mongoose.Schema(
  {
    username: { type: String, required: true, unique: true, trim: true },
    email: { type: String, required: true, unique: true, trim: true, lowercase: true },
    passwordHash: { type: String, required: true },
  },
  { timestamps: true }
);
const User = mongoose.model("User", userSchema);

const groupSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 40 },
    code: { type: String, required: true, unique: true, index: true }, // join code
    createdBy: { type: String, required: true }, // username
  },
  { timestamps: true }
);
const Group = mongoose.model("Group", groupSchema);

const messageSchema = new mongoose.Schema(
  {
    groupId: { type: mongoose.Schema.Types.ObjectId, ref: "Group", index: true },
    sender: { type: String, required: true },
    type: { type: String, enum: ["text", "sticker", "image", "video", "audio"], default: "text" },
    text: { type: String, default: "" },
    url: { type: String, default: "" },
  },
  { timestamps: true }
);
const Message = mongoose.model("Message", messageSchema);

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

// ================= Pages =================
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("/chat.html", authMiddleware, (req, res) => res.sendFile(path.join(__dirname, "public", "chat.html")));
app.get("/groups.html", authMiddleware, (req, res) => res.sendFile(path.join(__dirname, "public", "groups.html")));
app.get("/group.html", authMiddleware, (req, res) => res.sendFile(path.join(__dirname, "public", "group.html")));

// ================= Auth Routes =================
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

    return res.redirect("/groups.html");
  } catch (e) {
    console.error(e);
    return res.status(500).send("Register failed.");
  }
});

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

    return res.redirect("/groups.html");
  } catch (e) {
    console.error(e);
    return res.status(500).send("Login failed.");
  }
});

app.post("/logout", (req, res) => {
  res.clearCookie("chatrush_token");
  res.redirect("/");
});

app.get("/me", authMiddleware, (req, res) => {
  res.json({ ok: true, user: req.user });
});

// ================= Group API =================
app.post("/api/groups", authMiddleware, async (req, res) => {
  try {
    const name = String(req.body?.name || "").trim();
    if (!name) return res.status(400).json({ ok: false, error: "Group name required" });

    // 6-char join code, try a few times to avoid collisions
    let code = "";
    for (let i = 0; i < 5; i++) {
      code = nanoid(7).replace(/[-_]/g, "").slice(0, 6).toUpperCase();
      const exists = await Group.findOne({ code });
      if (!exists) break;
      code = "";
    }
    if (!code) return res.status(500).json({ ok: false, error: "Could not generate code" });

    const g = await Group.create({ name, code, createdBy: req.user.username });
    return res.json({ ok: true, group: { id: g._id, name: g.name, code: g.code } });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: "Create group failed" });
  }
});

app.post("/api/groups/join", authMiddleware, async (req, res) => {
  try {
    const code = String(req.body?.code || "").trim().toUpperCase();
    if (!code) return res.status(400).json({ ok: false, error: "Code required" });

    const g = await Group.findOne({ code });
    if (!g) return res.status(404).json({ ok: false, error: "Invalid code" });

    return res.json({ ok: true, group: { id: g._id, name: g.name, code: g.code } });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: "Join failed" });
  }
});

app.get("/api/groups/:id/messages", authMiddleware, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || "50", 10), 100);
    const groupId = req.params.id;
    const msgs = await Message.find({ groupId }).sort({ createdAt: -1 }).limit(limit);
    return res.json({ ok: true, messages: msgs.reverse() });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: "Fetch messages failed" });
  }
});

// ================= Upload API (Cloudinary) =================
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB
});

app.post("/api/upload", authMiddleware, upload.single("file"), async (req, res) => {
  try {
    if (!cloudinaryReady()) {
      return res.status(500).json({ ok: false, error: "Cloudinary env vars missing" });
    }
    if (!req.file) return res.status(400).json({ ok: false, error: "No file" });

    const mime = req.file.mimetype || "";
    const isImage = mime.startsWith("image/");
    const isVideo = mime.startsWith("video/");
    const isAudio = mime.startsWith("audio/");

    const folder = "chatrush_uploads";
    const resource_type = "auto"; // cloudinary will detect

    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder,
        resource_type,
      },
      (err, result) => {
        if (err) {
          console.error(err);
          return res.status(500).json({ ok: false, error: "Upload failed" });
        }
        const url = result.secure_url;
        let type = "file";
        if (isImage) type = "image";
        else if (isVideo) type = "video";
        else if (isAudio) type = "audio";
        return res.json({ ok: true, url, type });
      }
    );

    streamifier.createReadStream(req.file.buffer).pipe(uploadStream);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: "Upload error" });
  }
});

// ================= Socket.IO Group Chat =================
const server = http.createServer(app);
const io = new Server(server);

const socketUser = {}; // socket.id -> username

function safeName(v) {
  return String(v || "User").trim().slice(0, 20);
}

io.on("connection", (socket) => {
  socket.on("hello", (data) => {
    socketUser[socket.id] = safeName(data?.username);
  });

  socket.on("join_group", async (data) => {
    const groupId = String(data?.groupId || "");
    if (!groupId) return;

    socket.join(groupId);
    const u = socketUser[socket.id] || "User";
    io.to(groupId).emit("system", { text: `${u} joined`, ts: Date.now() });
  });

  socket.on("typing_group", (data) => {
    const groupId = String(data?.groupId || "");
    if (!groupId) return;
    const u = socketUser[socket.id] || "User";
    socket.to(groupId).emit("typing_group", { username: u });
  });

  socket.on("group_message", async (data) => {
    try {
      const groupId = String(data?.groupId || "");
      if (!groupId) return;

      const u = socketUser[socket.id] || "User";
      const type = String(data?.type || "text");
      const text = String(data?.text || "").slice(0, 2000);
      const url = String(data?.url || "").slice(0, 2000);

      if (!["text", "sticker", "image", "video", "audio"].includes(type)) return;

      const msg = await Message.create({
        groupId,
        sender: u,
        type,
        text,
        url,
      });

      io.to(groupId).emit("group_message", {
        id: msg._id,
        sender: msg.sender,
        type: msg.type,
        text: msg.text,
        url: msg.url,
        ts: msg.createdAt.getTime(),
      });
    } catch (e) {
      console.error(e);
    }
  });

  socket.on("disconnect", () => {
    delete socketUser[socket.id];
  });
});

server.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});