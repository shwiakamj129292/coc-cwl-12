const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const dist = path.join(root, "dist");
const fontAwesome = path.join(root, "node_modules", "@fortawesome", "fontawesome-free");

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });
fs.mkdirSync(path.join(dist, "assets"), { recursive: true });

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

const tailwindCss = fs.readFileSync(path.join(dist, "assets", "app.css"), "utf8");
const fontAwesomeCss = ["fontawesome.min.css", "solid.min.css", "regular.min.css"]
  .map(name => fs.readFileSync(path.join(fontAwesome, "css", name), "utf8"))
  .join("\n")
  .replace(/url\(\.\.\/webfonts\/([^/()]+\.woff2)(?:\?[^)]*)?\)/g, (_, filename) => {
    const font = fs.readFileSync(path.join(fontsDir, filename)).toString("base64");
    return `url(data:font/woff2;base64,${font})`;
  });
const bundledStyles = `<style>${tailwindCss}\n${fontAwesomeCss}</style>`;
const html = fs.readFileSync(path.join(root, "index.html"), "utf8")
  .replace('<link href="/assets/app.css" rel="stylesheet">', "")
  .replace('<link href="/vendor/fontawesome/css/all.min.css" rel="stylesheet">', "")
  .replace("</head>", `${bundledStyles}\n</head>`);
fs.writeFileSync(path.join(dist, "index.html"), html);
