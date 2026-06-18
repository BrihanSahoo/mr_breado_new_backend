const mongoose = require('mongoose');
const env = require('../config/env');
async function connectDb() {
  mongoose.set('strictQuery', true);
  await mongoose.connect(env.mongoUri, { maxPoolSize: 20, minPoolSize: 2, serverSelectionTimeoutMS: 15000 });
  require('../models');
  await require('./legacyIds')();
  const { Outlet } = require('../models');
  const outlets = await Outlet.find({ 'location.coordinates.0': { $exists: true }, 'location.coordinates.1': { $exists: true } });
  for (const outlet of outlets) {
    const [a,b] = outlet.location.coordinates.map(Number);
    if (a >= 6 && a <= 38 && b >= 68 && b <= 98) {
      outlet.location.coordinates = [b,a];
      await outlet.save();
      console.warn(`Corrected reversed outlet coordinates for ${outlet.name}`);
    }
  }
  return mongoose.connection;
}
module.exports = connectDb;
