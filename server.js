const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));

let waitingQueue = [];
let bannedUsers = new Set();
let totalReports = 0;
let onlineUsers = 0;
let reports = {};

function tryMatch() {
  if (waitingQueue.length >= 2) {

    const user1 = waitingQueue.shift();
    const user2 = waitingQueue.shift();

    user1.partner = user2;
    user2.partner = user1;

    user1.emit("matched");
    user2.emit("matched");
  }
}

io.on("connection", (socket) => {

  const userIP = socket.handshake.address;

  // 🔒 Block banned users
  if (bannedUsers.has(userIP)) {
    socket.emit("system", "🚫 You are banned.");
    socket.disconnect();
    return;
  }

  // ✅ Increase online users
  onlineUsers++;
  console.log("User connected");
  console.log("Online users:", onlineUsers);
  io.emit("onlineCount", onlineUsers);

  // 👥 Add to queue and try matching
  waitingQueue.push(socket);
  tryMatch();

  // 💬 Chat messages
  socket.on("chatMessage", (msg) => {
    if (socket.partner) {
      socket.partner.emit("chatMessage", msg);
    }
  });

  // ⌨ Typing indicator
  socket.on("typing", () => {
    if (socket.partner) {
      socket.partner.emit("typing");
    }
  });

  socket.on("stopTyping", () => {
    if (socket.partner) {
      socket.partner.emit("stopTyping");
    }
  });

  // 🚫 Report system
  socket.on("report", () => {

    if (!socket.partner) return;

    const reportedIP = socket.partner.handshake.address;

    if (!reports[reportedIP]) {
      reports[reportedIP] = 0;
    }

    reports[reportedIP]++;
    totalReports++;

    console.log("Reports for", reportedIP, reports[reportedIP]);

    if (reports[reportedIP] >= 3) {
      bannedUsers.add(reportedIP);
      socket.partner.emit("system", "🚫 You are banned (3 reports).");
      socket.partner.disconnect();
    } else {
      socket.partner.emit("system", "⚠ You were reported");
    }

    socket.partner.partner = null;
    socket.partner = null;
  });

  // ⏭ Next button
  socket.on("next", () => {

    if (socket.partner) {
      socket.partner.emit("system", "⚠ Stranger skipped");
      socket.partner.partner = null;
    }

    socket.partner = null;

    waitingQueue.push(socket);
    tryMatch();
  });

  // ❌ Disconnect
  socket.on("disconnect", () => {

    onlineUsers = Math.max(0, onlineUsers - 1);
    io.emit("onlineCount", onlineUsers);

    if (socket.partner) {
      socket.partner.emit("system", "⚠ Stranger disconnected");
      socket.partner.partner = null;
    }

    waitingQueue = waitingQueue.filter(user => user !== socket);

    console.log("User disconnected");
    console.log("Online users:", onlineUsers);
  });

});

// 🔐 Admin panel
app.get("/admin", (req, res) => {

  const password = req.query.password;

  if (password !== "chatrush123") {
    return res.send("<h2>❌ Access Denied</h2>");
  }

  res.send(`
    <h1>ChatRush Admin Panel</h1>
    <p>Online Users: ${onlineUsers}</p>
    <p>Total Reports: ${totalReports}</p>
    <p>Banned Users: ${bannedUsers.size}</p>
  `);
});

// 🚀 Start server
server.listen(3000, () => {
  console.log("🚀 Server running on port 3000");
});