const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const session = require("express-session");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
  secret: "chatrush_secret",
  resave: false,
  saveUninitialized: true
}));

app.use(express.static(__dirname));

let users = {}; // username -> password
let waitingQueue = [];
let onlineUsers = 0;

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

/* ======================
   AUTH ROUTES
====================== */

app.post("/register", (req, res) => {
  const { username, password } = req.body;

  if (users[username]) {
    return res.send("User already exists");
  }

  users[username] = password;
  res.send("Registered successfully");
});

app.post("/login", (req, res) => {
  const { username, password } = req.body;

  if (users[username] && users[username] === password) {
    req.session.user = username;
    return res.send("Login successful");
  }

  res.send("Invalid credentials");
});

app.get("/me", (req, res) => {
  res.json({ user: req.session.user || null });
});

/* ======================
   SOCKET
====================== */

io.on("connection", (socket) => {

  onlineUsers++;
  io.emit("onlineCount", onlineUsers);

  waitingQueue.push(socket);
  tryMatch();

  socket.on("chatMessage", (msg) => {
    if (socket.partner) {
      socket.partner.emit("chatMessage", msg);
    }
  });

  socket.on("next", () => {
    if (socket.partner) {
      socket.partner.partner = null;
    }
    socket.partner = null;
    waitingQueue.push(socket);
    tryMatch();
  });

  socket.on("disconnect", () => {
    onlineUsers = Math.max(0, onlineUsers - 1);
    io.emit("onlineCount", onlineUsers);
  });
});

server.listen(3000, () => {
  console.log("Server running");
});
