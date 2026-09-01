const repoDir = __dirname;
const allowedRoots = process.env.PI_ALLOWED_ROOTS ?? repoDir;
module.exports = {
  apps: [
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
  ],
};
