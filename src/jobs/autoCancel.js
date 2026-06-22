const connectDb = require('../db/connect');
const { runAutoCancel } = require('../services/autoCancelService');

(async () => {
  await connectDb();
  const result = await runAutoCancel();
  console.log(`Auto-cancel processed ${result.candidates} candidates and cancelled ${result.cancelled} orders`);
  if (result.failures.length) console.error(result.failures);
  process.exit(result.failures.length ? 1 : 0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
