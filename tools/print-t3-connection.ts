import { printConnection } from "../src/connection.ts";
import { defaultWorkerHome, workerPaths } from "../src/worker.ts";

const paths = workerPaths(process.env.T3_WORKER_HOME ?? defaultWorkerHome());
await printConnection(paths);
