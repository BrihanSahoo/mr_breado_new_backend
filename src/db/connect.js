const mongoose = require('mongoose');
const env = require('../config/env');
async function connectDb() {
  mongoose.set('strictQuery', true);
  await mongoose.connect(env.mongoUri, { maxPoolSize: 20, minPoolSize: 2, serverSelectionTimeoutMS: 15000 });
  require('../models');
  await require('./legacyIds')();
  return mongoose.connection;
}
module.exports = connectDb;
