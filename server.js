require("dotenv").config();
const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { hashPw, checkPw, User, Batch, Listing, Order } = require("./models");

const SECRET = process.env.JWT_SECRET || "dev-secret";
const sign = (u) =>
  jwt.sign({ id: u._id, role: u.role, name: u.name }, SECRET, {
    expiresIn: "7d",
  });
const pub = (u) => ({ id: u._id, name: u.name, role: u.role });
const auth = (role) => (req, res, next) => {
  try {
    req.user = jwt.verify((req.headers.authorization || "").slice(7), SECRET);
    if (role && req.user.role !== role)
      return res.status(403).json({ error: "Not allowed for your role" });
    next();
  } catch {
    res.status(401).json({ error: "Please log in" });
  }
};
const wrap = (fn) => (req, res) =>
  fn(req, res).catch((e) => res.status(400).json({ error: e.message }));

const UP = path.join(__dirname, "uploads");
fs.mkdirSync(UP, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: UP,
    filename: (_r, f, cb) =>
      cb(
        null,
        Date.now() +
          "-" +
          Math.random().toString(36).slice(2, 8) +
          path.extname(f.originalname).toLowerCase(),
      ),
  }),
  limits: { fileSize: 3 * 1024 * 1024 },
  fileFilter: (_r, f, cb) =>
    /^image\/(jpe?g|png|webp)$/.test(f.mimetype)
      ? cb(null, true)
      : cb(new Error("Only JPG, PNG or WebP images allowed")),
});

const app = express();
app.use(cors(), express.json());
app.use("/uploads", express.static(UP));

// ---- Auth
app.post(
  "/api/auth/register",
  wrap(async (req, res) => {
    const { name, email, password, role, location } = req.body;
    if (!name || !email || !password || !["buyer", "seller"].includes(role))
      throw new Error("Fill all fields");
    const u = await User.create({
      name,
      email,
      role,
      location,
      password: hashPw(password),
    });
    res.status(201).json({ token: sign(u), user: pub(u) });
  }),
);
app.post(
  "/api/auth/login",
  wrap(async (req, res) => {
    const u = await User.findOne({
      email: (req.body.email || "").toLowerCase(),
    });
    if (!u || !checkPw(req.body.password || "", u.password))
      return res.status(401).json({ error: "Wrong email or password" });
    if (u.suspended)
      return res.status(403).json({ error: "This account has been suspended" });
    res.json({ token: sign(u), user: pub(u) });
  }),
);

// ---- Public: marketplace + traceability
app.get(
  "/api/listings",
  wrap(async (req, res) => {
    const q = (req.query.q || "").toString();

    const ls = await Listing.find({ availableKg: { $gt: 0 } })
      .populate("batch", "code crop emoji image farmer farmLocation")
      .populate("seller", "name phone location");

    res.json(
      q
        ? ls.filter((l) => l.batch.crop.toLowerCase().includes(q.toLowerCase()))
        : ls,
    );
  }),
);

app.get(
  "/api/trace/:code",
  wrap(async (req, res) => {
    const b = await Batch.findOne({ code: req.params.code });
    if (!b) return res.status(404).json({ error: "Batch not found" });
    res.json({ ...b.toObject(), verified: b.verifyChain() });
  }),
);

// ---- Seller
app.get(
  "/api/my/batches",
  auth("seller"),
  wrap(async (req, res) => {
    const [bs, ls] = await Promise.all([
      Batch.find({ owner: req.user.id }).sort("-harvestDate"),
      Listing.find({ seller: req.user.id }),
    ]);
    res.json(
      bs.map((b) => ({
        ...b.toObject(),
        listing: ls.find((l) => String(l.batch) === String(b._id)) || null,
      })),
    );
  }),
);
app.post(
  "/api/batches",
  auth("seller"),
  upload.single("image"),
  wrap(async (req, res) => {
    const { crop, emoji, farmLocation, quantityKg } = req.body;
    const code = "AGC-" + Math.random().toString(36).slice(2, 8).toUpperCase();
    const b = new Batch({
      code,
      owner: req.user.id,
      crop,
      emoji,
      farmer: req.user.name,
      farmLocation,
      quantityKg: +quantityKg,
      harvestDate: new Date(),
      image: req.file && "/uploads/" + req.file.filename,
    });
    b.addEvent(
      "Harvested",
      req.user.name,
      farmLocation,
      `${quantityKg}kg of ${crop} harvested`,
    );
    await b.save();
    res.status(201).json(b);
  }),
);
app.post(
  "/api/batches/:code/image",
  auth("seller"),
  upload.single("image"),
  wrap(async (req, res) => {
    if (!req.file) throw new Error("No image received");
    const b = await Batch.findOneAndUpdate(
      { code: req.params.code, owner: req.user.id },
      { image: "/uploads/" + req.file.filename },
      { new: true },
    );
    if (!b) throw new Error("Not your batch");
    res.json(b);
  }),
);
app.post(
  "/api/batches/:code/events",
  auth("seller"),
  wrap(async (req, res) => {
    const b = await Batch.findOne({
      code: req.params.code,
      owner: req.user.id,
    });
    if (!b) return res.status(404).json({ error: "Not your batch" });
    b.addEvent(
      req.body.stage,
      req.user.name,
      req.body.location || b.farmLocation,
      req.body.note,
    );
    await b.save();
    res.json(b);
  }),
);
app.post(
  "/api/listings",
  auth("seller"),
  wrap(async (req, res) => {
    const b = await Batch.findOne({ code: req.body.code, owner: req.user.id });
    if (!b) throw new Error("Not your batch");
    const l = await Listing.findOneAndUpdate(
      { batch: b._id },
      {
        seller: req.user.id,
        pricePerKg: +req.body.pricePerKg,
        availableKg: +(req.body.availableKg ?? b.quantityKg),
      },
      { upsert: true, new: true },
    );
    res.status(201).json(l);
  }),
);
app.patch(
  "/api/orders/:id/status",
  auth("seller"),
  wrap(async (req, res) => {
    const o = await Order.findOne({
      _id: req.params.id,
      seller: req.user.id,
    }).populate("buyer", "name");
    if (!o) throw new Error("Order not found");
    const next = { placed: "shipped", shipped: "delivered" }[o.status];
    if (!next) throw new Error("Already delivered");
    o.status = next;
    const b = await Batch.findById(o.batch);
    b.addEvent(
      next === "shipped" ? "Shipped" : "Delivered",
      req.user.name,
      "Agrochain Logistics",
      `${o.quantityKg}kg to ${o.buyer.name}`,
    );
    await Promise.all([o.save(), b.save()]);
    res.json(o);
  }),
);

// ---- Orders (both roles)
app.post(
  "/api/orders",
  auth("buyer"),
  wrap(async (req, res) => {
    const { listingId, quantityKg } = req.body;
    const me = await User.findById(req.user.id);
    const contactName = req.body.contactName?.trim() || me.name;
    const contactPhone =
      req.body.contactPhone?.trim() || me.phone || "Not provided";
    const address =
      req.body.address?.trim() || me.location || "To be agreed with seller";
    const q = +quantityKg;
    const l = await Listing.findOneAndUpdate(
      { _id: listingId, availableKg: { $gte: q } },
      { $inc: { availableKg: -q } },
      { new: true },
    );
    if (!l || q <= 0) throw new Error("Not enough stock");
    const o = await Order.create({
      listing: l._id,
      batch: l.batch,
      buyer: req.user.id,
      seller: l.seller,
      quantityKg: q,
      total: q * l.pricePerKg,
      address,
      contactName,
      contactPhone,
    });
    const b = await Batch.findById(l.batch);
    b.addEvent("Sold", req.user.name, "Agrochain Market", `${q}kg purchased`);
    await b.save();
    res.status(201).json({ order: o, code: b.code });
  }),
);

app.get(
  "/api/my/orders",
  auth(),
  wrap(async (req, res) => {
    const filter =
      req.user.role === "seller"
        ? { seller: req.user.id }
        : { buyer: req.user.id };
    res.json(
      await Order.find(filter)
        .sort("-createdAt")
        .populate("batch", "code crop emoji image")
        .populate("buyer", "name")
        .populate("seller", "name"),
    );
  }),
);

// ---- Public stats
app.get(
  "/api/stats",
  wrap(async (_q, res) => {
    const [farmers, batches, orders] = await Promise.all([
      User.countDocuments({ role: "seller" }),
      Batch.countDocuments(),
      Order.find(),
    ]);
    res.json({
      farmers,
      batches,
      orders: orders.length,
      kg: orders.reduce((s, o) => s + o.quantityKg, 0),
    });
  }),
);

// ---- Admin
app.get(
  "/api/admin/stats",
  auth("admin"),
  wrap(async (_q, res) => {
    const [users, batches, listings, orders] = await Promise.all([
      User.find(),
      Batch.find(),
      Listing.find(),
      Order.find(),
    ]);
    const cropOf = Object.fromEntries(
      batches.map((b) => [String(b._id), b.crop]),
    );
    const topCrops = {};
    orders.forEach((o) => {
      const c = cropOf[String(o.batch)];
      topCrops[c] = (topCrops[c] || 0) + o.quantityKg;
    });
    const byStatus = { placed: 0, shipped: 0, delivered: 0 };
    orders.forEach((o) => byStatus[o.status]++);
    res.json({
      sellers: users.filter((u) => u.role === "seller").length,
      buyers: users.filter((u) => u.role === "buyer").length,
      batches: batches.length,
      listings: listings.filter((l) => l.availableKg > 0).length,
      orders: orders.length,
      revenue: orders.reduce((s, o) => s + o.total, 0),
      byStatus,
      topCrops,
      tampered: batches.filter((b) => !b.verifyChain()).length,
    });
  }),
);
app.get(
  "/api/admin/users",
  auth("admin"),
  wrap(async (_q, res) =>
    res.json(await User.find().select("-password").sort("-_id")),
  ),
);
app.patch(
  "/api/admin/users/:id/suspend",
  auth("admin"),
  wrap(async (req, res) => {
    const u = await User.findById(req.params.id);
    if (!u || u.role === "admin") throw new Error("Cannot change this user");
    u.suspended = !u.suspended;
    await u.save();
    res.json({ suspended: u.suspended });
  }),
);
app.get(
  "/api/admin/batches",
  auth("admin"),
  wrap(async (_q, res) => {
    const [bs, ls] = await Promise.all([
      Batch.find().sort("-harvestDate"),
      Listing.find(),
    ]);
    res.json(
      bs.map((b) => ({
        code: b.code,
        crop: b.crop,
        emoji: b.emoji,
        farmer: b.farmer,
        quantityKg: b.quantityKg,
        events: b.events.length,
        verified: b.verifyChain(),
        listed: ls.some(
          (l) => String(l.batch) === String(b._id) && l.availableKg > 0,
        ),
      })),
    );
  }),
);
app.post(
  "/api/admin/batches/:code/delist",
  auth("admin"),
  wrap(async (req, res) => {
    const b = await Batch.findOne({ code: req.params.code });
    await Listing.updateOne({ batch: b._id }, { availableKg: 0 });
    res.json({ ok: true });
  }),
);
// Demo helper: edit a past record without re-sealing it, to show tamper detection (call again to undo)
app.post(
  "/api/admin/batches/:code/tamper",
  auth("admin"),
  wrap(async (req, res) => {
    const b = await Batch.findOne({ code: req.params.code });
    const n = b.events[0].note || "";
    b.events[0].note = n.endsWith(" [EDITED]")
      ? n.slice(0, -9)
      : n + " [EDITED]";
    await b.save();
    res.json({ verified: b.verifyChain() });
  }),
);
app.get(
  "/api/admin/orders",
  auth("admin"),
  wrap(async (_q, res) => {
    res.json(
      await Order.find()
        .sort("-createdAt")
        .populate("batch", "code crop emoji")
        .populate("buyer", "name")
        .populate("seller", "name"),
    );
  }),
);

app.use((err, _req, res, _next) =>
  res.status(400).json({ error: err.message }),
);

mongoose
  .connect(process.env.MONGO_URI || "mongodb://127.0.0.1:27017/agrochain")
  .then(() =>
    app.listen(process.env.PORT || 5000, () =>
      console.log("Agrochain API ready"),
    ),
  );
