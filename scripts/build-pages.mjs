import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = join(projectRoot, "_site");
const cartoBasemapKey = process.env.CARTO_BASEMAP_KEY;

if (!cartoBasemapKey) {
  throw new Error("CARTO_BASEMAP_KEY is required to build the GitHub Pages site.");
}

const publishablePaths = [
  ".nojekyll",
  "app.css",
  "app.js",
  "countries.css",
  "countries.html",
  "countries.js",
  "data",
  "index.html",
  "sources.css",
  "sources.html",
  "vendor"
];

rmSync(outputDirectory, { recursive: true, force: true });
mkdirSync(outputDirectory, { recursive: true });

for (const publishablePath of publishablePaths) {
  cpSync(
    join(projectRoot, publishablePath),
    join(outputDirectory, publishablePath),
    { recursive: true }
  );
}

writeFileSync(
  join(outputDirectory, "config.js"),
  `window.CARTO_BASEMAP_KEY = ${JSON.stringify(cartoBasemapKey)};\n`
);
