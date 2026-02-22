require("dotenv").config();

const express = require("express");
const bodyParser = require("body-parser");
const crypto = require("crypto");
const nodemailer = require("nodemailer");
const path = require("path");

// socket.io
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const PORT = process.env.PORT || 3000;

// ================= MIDDLEWARE =================
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

// ================= TEMP USERS (resets on restart) =================
// NOTE: For real production, use DB (MongoDB/SQLite). For now OK.
let users = [];

// ================= EMAIL SETUP =================
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

// ================= REGISTER =================
app.post("/register", async (req, res) => {
  try {
    const { username, email, password } = req.body;

    if (!username || !email || !password) {
      return res.send("All fields are required.");
    }

    if (users.find(u => u.username === username)) {
      return res.send("Username already exists.");
    }

    const verificationToken = crypto.randomBytes(32).toString("hex");

    users.push({
      username,
      email,
      password,
      verified: false,
      verificationToken
    });

    const verifyLink = `${process.env.BASE_URL}/verify/${verificationToken}`;

    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: email,
      subject: "Verify your ChatRush account",
      html: `
        <h2>Welcome to ChatRush 🔥</h2>
        <p>Click below to verify your account:</p>
        <a href="${verifyLink}">${verifyLink}</a>
      `
    });

    res.send("Registered successfully! Check your email to verify your account.");
  } catch (error) {
    console.error(error);
    res.send("Error sending email. Check server logs.");
  }
});

// ================= VERIFY =================
app.get("/verify/:token", (req, res) => {
  const user = users.find(u => u.verificationToken === req.params.token);

  if (!user) {
    return res.send("Invalid or expired token.");
  }

  user.verified = true;
  user.verificationToken = null;

  // ✅ Since you only have index.html, show a link back to home
  res.send(`
    <h2>✅ Account verified successfully!</h2>
    <p>Now go back and login.</p>
    <a href="/">Go to Home</a>
  `);
});

// ================= LOGIN =================
app.post("/login", (req, res) => {
  const { username, password } = req.body;

  const user = users.find(u => u.username === username && u.password === password);

  if (!user) return res.send("Invalid username or password.");
  if (!user.verified) return res.send("Please verify your email before logging in.");

  // ✅ Go to chat.html
  res.redirect("/chat.html");
});

// ================= SOCKET.IO RANDOM CHAT =================
const server = http.createServer(app);
const io = new Server(server);

let waitingUser = null;      // socket id of the waiting user
const partner = {};          // partner[socketId] = otherSocketId

function unpair(socketId) {
  const p = partner[socketId];
  if (p) {
    delete partner[p];
    io.to(p).emit("partner_left");
  }
  delete partner[socketId];
}

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  socket.on("find_partner", () => {
    if (partner[socket.id]) return;

    if (waitingUser && waitingUser !== socket.id) {
      const other = waitingUser;

      partner[socket.id] = other;
      partner[other] = socket.id;

      io.to(socket.id).emit("matched");
      io.to(other).emit("matched");

      waitingUser = null;
    } else {
      waitingUser = socket.id;
      socket.emit("waiting");
    }
  });

  socket.on("chat_message", (msg) => {
    const p = partner[socket.id];
    if (!p) return;
    io.to(p).emit("chat_message", msg);
  });

  socket.on("next", () => {
    unpair(socket.id);
    if (waitingUser === socket.id) waitingUser = null;

    socket.emit("clear_chat");
    socket.emit("waiting");
    socket.emit("status", "Searching...");
    socket.emit("re_find");
  });

  socket.on("disconnect", () => {
    if (waitingUser === socket.id) waitingUser = null;
    unpair(socket.id);
    console.log("User disconnected:", socket.id);
  });
});

// ================= START SERVER =================
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});