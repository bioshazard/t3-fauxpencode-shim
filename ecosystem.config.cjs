const { existsSync } = require("node:fs");
const { homedir } = require("node:os");
const { join } = require("node:path");

const repoDir = __dirname;
// PM2 evaluates this file with Node rather than Bun, so explicitly load the
// checkout-local, gitignored configuration used by the local development stack.
const localEnvPath = join(repoDir, ".env");
if (existsSync(localEnvPath)) process.loadEnvFile?.(localEnvPath);
const allowedRoots = process.env.PI_ALLOWED_ROOTS ?? repoDir;

const apps = [
  {
    args: ["run", "dev"],
    autorestart: true,
    exec_interpreter: "none",
    name: "pi-opencode-shim",
    script: "bun",
    watch: false,
    env: {
      PI_ALLOWED_ROOTS: allowedRoots,
      PI_CWD: process.env.PI_CWD ?? repoDir,
      PI_OPENCODE_HOST: process.env.PI_OPENCODE_HOST ?? "127.0.0.1",
      PI_OPENCODE_PORT: process.env.PI_OPENCODE_PORT ?? "41874",
    },
  },
  {
    args: ["run", "t3:shim"],
    autorestart: true,
    exec_interpreter: "none",
    name: "t3-pi-shim",
    script: "bun",
    watch: false,
    env: {
      PI_OPENCODE_URL: "http://127.0.0.1:41874",
    },
  },
];

// Optional FRP tunnel for dev (dev:local:frp). The script prepares this
// binary and config from local source before PM2 reads this file.
const frpcHome = join(homedir(), ".local", "share", "t3-fauxpencode", "frp");
const frpcConfig = join(frpcHome, "frpc.toml");
if (process.env.PI_FRPC_LOCAL === "1") {
  if (!existsSync(frpcConfig)) {
    throw new Error(`Expected FRPC config at ${frpcConfig}.`);
  }
  apps.push({
    args: ["-c", frpcConfig],
    autorestart: true,
    exec_interpreter: "none",
    name: "frpc-local",
    script: join(frpcHome, "frpc"),
    watch: false,
  });
}

module.exports = { apps };
