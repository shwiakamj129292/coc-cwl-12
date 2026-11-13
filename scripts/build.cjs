const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const dist = path.join(root, "dist");
const fontAwesome = path.join(root, "node_modules", "@fortawesome", "fontawesome-free");

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });
fs.mkdirSync(path.join(dist, "assets"), { recursive: true });
fs.copyFileSync(path.join(root, "index.html"), path.join(dist, "index.html"));

const cssDir = path.join(dist, "vendor", "fontawesome", "css");
const fontsDir = path.join(dist, "vendor", "fontawesome", "webfonts");
fs.mkdirSync(cssDir, { recursive: true });
fs.copyFileSync(
  path.join(fontAwesome, "css", "all.min.css"),
  path.join(cssDir, "all.min.css")
);
fs.cpSync(path.join(fontAwesome, "webfonts"), fontsDir, { recursive: true });

execFileSync(process.execPath, [
  path.join(root, "node_modules", "tailwindcss", "lib", "cli.js"),
  "--input", path.join(root, "styles", "tailwind.css"),
  "--output", path.join(dist, "assets", "app.css"),
  "--minify"
], { cwd: root, stdio: "inherit" });
