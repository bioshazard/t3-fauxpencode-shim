import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  ensureFrpc,
  installFrpcConfig,
  prepareWorker,
  workerPaths,
} from "./worker.ts";

const source = process.env.PI_FRPC_CONFIG ?? join(homedir(), "frpc.toml");
if (!existsSync(source))
  throw new Error(`FRPC config does not exist: ${source}`);

const paths = workerPaths();
prepareWorker(paths);
installFrpcConfig(source, paths);
await ensureFrpc(paths);
