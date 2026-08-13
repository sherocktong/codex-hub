import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node18",
  clean: true,
  banner: {
    js: "#!/usr/bin/env node",
  },
  define: {
    "__PKG_VERSION__": `"${process.env.npm_package_version ?? "0.0.0"}"`,
  },
});
