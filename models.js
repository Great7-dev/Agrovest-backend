const mongoose = require("mongoose");
const crypto = require("crypto");
const { Schema, model } = mongoose;
const ref = (m) => ({ type: Schema.Types.ObjectId, ref: m });

const hashPw = (pw, salt = crypto.randomBytes(8).toString("hex")) =>
  salt + ":" + crypto.scryptSync(pw, salt, 32).toString("hex");
const checkPw = (pw, stored) => hashPw(pw, stored.split(":")[0]) === stored;

const hashOf = (prev, e) =>
  crypto
    .createHash("sha256")
    .update(
      [
        prev,
        e.stage,
        e.actor,
        e.location,
        e.note,
        new Date(e.at).toISOString(),
      ].join("|"),
    )
    .digest("hex");

const User = model(
  "User",
  new Schema({
    name: String,
    phone: String,
    email: { type: String, unique: true, lowercase: true },
    password: String,
    role: { type: String, enum: ["buyer", "seller", "admin"] },
    location: String,
    suspended: { type: Boolean, default: false },
  }),
);

const EventSchema = new Schema(
  {
    stage: String,
    actor: String,
    location: String,
    note: { type: String, default: "" },
    at: { type: Date, default: Date.now },
    prevHash: String,
    hash: String,
  },
  { _id: false },
);

const BatchSchema = new Schema({
  code: { type: String, unique: true },
  owner: ref("User"),
  crop: String,
  emoji: { type: String, default: "🌾" },
  image: String,
  farmer: String,
  farmLocation: String,
  quantityKg: Number,
  harvestDate: Date,
  events: [EventSchema],
});
BatchSchema.methods.addEvent = function (stage, actor, location, note = "") {
  const prevHash = this.events.length
    ? this.events[this.events.length - 1].hash
    : "GENESIS";
  const e = { stage, actor, location, note, at: new Date(), prevHash };
  e.hash = hashOf(prevHash, e);
  this.events.push(e);
};
BatchSchema.methods.verifyChain = function () {
  let prev = "GENESIS";
  return this.events.every((e) => {
    const ok = e.prevHash === prev && e.hash === hashOf(prev, e);
    prev = e.hash;
    return ok;
  });
};

module.exports = {
  hashPw,
  checkPw,
  User,
  Batch: model("Batch", BatchSchema),
  Listing: model(
    "Listing",
    new Schema({
      batch: ref("Batch"),
      seller: ref("User"),
      pricePerKg: Number,
      availableKg: Number,
    }),
  ),
  Order: model(
    "Order",
    new Schema({
      listing: ref("Listing"),
      batch: ref("Batch"),
      buyer: ref("User"),
      seller: ref("User"),
      quantityKg: Number,
      total: Number,
      address: String,
      contactName: String,
      contactPhone: String,
      status: {
        type: String,
        enum: ["placed", "shipped", "delivered"],
        default: "placed",
      },
      createdAt: { type: Date, default: Date.now },
    }),
  ),
};
