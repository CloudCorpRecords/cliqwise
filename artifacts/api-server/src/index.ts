import app from "./app";
import { logger } from "./lib/logger";
import { initStripeBilling } from "./lib/clipwise-billing";
import { startVideoWorker } from "./lib/video-pipeline";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

await initStripeBilling();
startVideoWorker();
const server = app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});
server.requestTimeout = 25 * 60_000;
