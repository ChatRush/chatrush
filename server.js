require("dotenv").config();

const express = require("express");
const http = require("http");
const mongoose = require("mongoose");
const socketIO = require("socket.io");
const multer = require("multer");
const axios = require("axios");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = socketIO(server);

// =======================
// Middleware
// =======================
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));

// =======================
// MongoDB Connection
// =======================
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log("MongoDB connected"))
  .catch(err => console.log(err));

// =======================
// Multer (File Upload Setup)
// =======================
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// =======================
// GIPHY API ROUTE
// =======================
app.get("/api/gifs", async (req, res) => {
  const search = req.query.q;

  try {
    const response = await axios.get(
      "https://api.giphy.com/v1/gifs/search",
      {
        params: {
          api_key: process.env.GIPHY_API_KEY,
          q: search,
          limit: 20,
        },
      }
    );

    res.json(response.data.data);
  } catch (error) {
    console.error("GIF error:", error.message);
    res.status(500).json({ error: "GIF fetch failed" });
  }
});

// =======================
// Socket.io Chat
// =======================
io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  socket.on("joinRoom", (room) => {
    socket.join(room);
  });

  socket.on("sendMessage", (data) => {
    io.to(data.room).emit("receiveMessage", data);
  });

  socket.on("disconnect", () => {
    console.log("User disconnected");
  });
});

// =======================
// Start Server
// =======================
const PORT = process.env.PORT || 10000;

server.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});