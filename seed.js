require("dotenv").config();
const mongoose = require("mongoose");
const { hashPw, User, Batch, Listing, Order } = require("./models");
const farms = [
  ["AGC-TOM001", "Roma Tomatoes", "🍅", "Kano, NG", 400, 650],
  ["AGC-YAM002", "Puna Yam", "🍠", "Benue, NG", 900, 480],
  ["AGC-PEP003", "Scotch Bonnet", "🌶️", "Ogun, NG", 250, 900],
];
(async () => {
  await mongoose.connect(
    process.env.MONGO_URI || "mongodb://127.0.0.1:27017/agrochain",
  );
  await Promise.all([User, Batch, Listing, Order].map((m) => m.deleteMany()));
  const seller = await User.create({
    name: "Amina Yusuf",
    email: "seller@demo.com",
    role: "seller",
    location: "Kano, NG",
    phone: "08012345678",
    password: hashPw("demo1234"),
  });
  await User.create({
    name: "Agrovest Admin",
    email: "admin@demo.com",
    role: "admin",
    location: "Lagos",
    password: hashPw("demo1234"),
  });
  const buyer = await User.create({
    name: "Tunde Buyer",
    email: "buyer@demo.com",
    role: "buyer",
    location: "Lagos",
    phone: "08098765432",
    password: hashPw("demo1234"),
  });
  for (const [code, crop, emoji, loc, qty, price] of farms) {
    const b = new Batch({
      code,
      crop,
      emoji,
      owner: seller._id,
      farmer: seller.name,
      farmLocation: loc,
      quantityKg: qty,
      harvestDate: new Date(),
    });
    b.addEvent("Harvested", seller.name, loc, `${qty}kg harvested at dawn`);
    b.addEvent(
      "Quality Check",
      "Agrochain Inspector",
      loc,
      "Grade A, no residue flagged",
    );
    await b.save();
    await Listing.create({
      batch: b._id,
      seller: seller._id,
      pricePerKg: price,
      availableKg: qty,
    });
  }
  const ls = await Listing.find();
  for (const [i, l] of ls.entries()) {
    const q = 20 * (i + 1);
    await Order.create({
      listing: l._id,
      batch: l.batch,
      buyer: buyer._id,
      seller: seller._id,
      quantityKg: q,
      total: q * l.pricePerKg,
      address: "12 Marina Road, Lagos Island",
      contactName: buyer.name,
      contactPhone: "08098765432",
      status: ["delivered", "shipped", "placed"][i],
    });
    l.availableKg -= q;
    await l.save();
  }
  console.log(
    "Seeded. seller@demo.com / buyer@demo.com / admin@demo.com  password: demo1234",
  );
  process.exit(0);
})();
