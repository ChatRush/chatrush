require("dotenv").config();

const express = require("express");
const bodyParser = require("body-parser");
const crypto = require("crypto");
const nodemailer = require("nodemailer");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.static("public"));

let users = []; // Temporary storage (resets on server restart)

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

    if (users.find(u => u.username === username)) {
      return res.send("Username already exists.");
    }

    const verificationToken = crypto.randomBytes(32).toString("hex");

    const newUser = {
      username,
      email,
      password,
      verified: false,
      verificationToken
    };

    users.push(newUser);

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

  res.send("Account verified successfully! You can now login.");
});

// ================= LOGIN =================
app.post("/login", (req, res) => {
  const { username, password } = req.body;

  const user = users.find(
    u => u.username === username && u.password === password
  );

  if (!user) {
    return res.send("Invalid username or password.");
  }

  if (!user.verified) {
    return res.send("Please verify your email before logging in.");
  }

  res.redirect("/chat.html");
});

// ================= START SERVER =================
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
