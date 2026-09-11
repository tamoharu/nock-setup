import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// A failed read never overwrites the existing file. Requests are flushed before
// network I/O so an app crash cannot silently turn an uncertain send into a new one.
export class JsonStore {
  constructor(path) {
    this.path = path;
    try {
      this.value = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT")
        throw new Error(
          "保存データを読み取れません。既存ファイルは保持されています。",
        );
      this.value = {};
    }
  }
  set(key, value) {
    this.value[key] = value;
    this.flush();
  }
  flush() {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temp = this.path + ".tmp";
    writeFileSync(temp, JSON.stringify(this.value), {
      mode: 0o600,
      flush: true,
    });
    renameSync(temp, this.path);
  }
}
