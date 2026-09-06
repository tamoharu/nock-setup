import { readFileSync } from "node:fs";

// Capture at process startup so an on-disk upgrade cannot disguise an old daemon.
export const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
