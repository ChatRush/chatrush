require("dotenv").config();

const express = require("express");
const bodyParser = require("body-parser");
const crypto = require("crypto");
const nodemailer = require("nodemailer");
const path = require("path");

// ✅ socket.io
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const PORT = process.env.PORT || 3000;

// ================= MIDDLEWARE =================
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// ✅ your folder must be named: public (lowercase)
app.use(express.static(path.join(__dirname, "public")));

// ✅ Fix home route (prevents Cannot GET /)
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ================= USERS (TEMP) =================
// NOTE: This resets when server restarts. For real app use DB later.
let users = [];

// ================= EMAIL SETUP (FIXED) =================
// Render was timing out on Gmail 465, so we force port 587 + timeouts.
const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 587,
  secure: false, // false for port 587
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
  connectionTimeout: 15000,
  greetingTimeout: 15000,
  socketTimeout: 15000,
});

// ================= REGISTER =================
app.post("/register", async (req, res) => {
  try {
    const { username, email, password } = req.body;

    if (!username || !email || !password) {
      return res.status(400).send("All fields are required.");
    }

    if (users.find((u) => u.username === username)) {
      return res.status(400).send("Username already exists.");
    }

    const verificationToken = crypto.randomBytes(32).toString("hex");

    const newUser = {
      username,
      email,
      password,
      verified: false,
      verificationToken,
    };

    users.push(newUser);

    // ✅ IMPORTANT: BASE_URL must be in Render env
    // Example: https://chatrush-0nsw.onrender.com
    const verifyLink = `${process.env.BASE_URL}/verify/${verificationToken}`;

    // ✅ Try sending email, but if Render blocks SMTP, don't hang forever
    try {
      await transporter.sendMail({
        from: process.env.EMAIL_USER,
        to: email,
        subject: "Verify your ChatRush account",
        html: `
          <h2>Welcome to ChatRush 🔥</h2>
          <p>Click below to verify your account:</p>
          <a href="${verifyLink}">${verifyLink}</a>
        `,
      });

      return res.send(
        "Registered successfully! Check your email to verify your account."
      );
    } catch (mailErr) {
      console.error("MAIL ERROR:", mailErr);

      // ✅ Fallback: show verification link on screen
      return res.send(`
        <h2>Registered ✅</h2>
        <p><b>Email sending failed on server</b> (Render SMTP issue).</p>
        <p>For now, verify using this link:</p>
        <a href="${verifyLink}">${verifyLink}</a>
        <p>After verifying, go back and login.</p>
        <a href="/">Go to Home</a>
      `);
    }
  } catch (error) {
    console.error(error);
    return res.status(500).send("Server error. Check logs.");
  }
});

// ================= VERIFY =================
app.get("/verify/:token", (req, res) => {
  const user = users.find((u) => u.verificationToken === req.params.token);

  if (!user) {
    return res.status(400).send("Invalid or expired token.");
  }

  user.verified = true;
  user.verificationToken = null;

  return res.send(`
    <h2>✅ Account verified successfully!</h2>
    <p>Now go back and login.</p>
    <a href="/">Go to Home</a>
  `);
});

// ================= LOGIN =================
app.post("/login", (req, res) => {
  const { username, password } = req.body;

  const user = users.find((u) => u.username === username && u.password === password);

  if (!user) return res.status(400).send("Invalid username or password.");
  if (!user.verified) return res.status(400).send("Please verify your email before logging in.");

  return res.redirect("/chat.html");
});

// ================= SOCKET.IO RANDOM CHAT =================
const server = http.createServer(app);
const io = new Server(server);

// waiting socket id
let waitingUser = null;
// partner mapping
const partner = {};

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