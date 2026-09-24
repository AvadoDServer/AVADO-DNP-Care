import http from "node:http";
import { CareService } from "./care.js";
import { loadConfig } from "./config.js";
import { createApp } from "./http.js";
import { createLogger, errorMessage } from "./log.js";
import { StateStore } from "./state.js";
import { WampClient } from "./wamp.js";

const config = loadConfig();
const logger = createLogger();

process.on("unhandledRejection", (reason) => {
  logger.error(`unhandled rejection: ${errorMessage(reason)}`);
});

const store = new StateStore(config.stateDir, logger);
const care = new CareService(
  config,
  logger,
  {
    openWamp: () => new WampClient({ url: config.wampUrl, realm: config.wampRealm }),
    fetch: (input, init) => fetch(input, init),
    now: () => Date.now(),
    store,
  },
  await store.load(),
);

const server = http.createServer(createApp(config, logger, care));
server.requestTimeout = 180_000; // check-now waits for a full cycle
server.headersTimeout = 30_000;
server.maxConnections = 64;

server.listen(config.port, config.host, () => {
  logger.info(`AVADO Care ${config.version} listening on ${config.host}:${config.port}; heartbeats go to ${config.backendUrl}`);
  care.start();
});

function shutdown(signal: string): void {
  logger.info(`${signal} received, shutting down`);
  care.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
