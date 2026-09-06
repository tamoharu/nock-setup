import { constants } from "node:fs";
import { open, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { check, Fault } from "./config.mjs";

export const MAX_CODE_BYTES = 1024 * 1024;
const PAGE_SIZE = 500;
const within = (root, path) => { const rel = relative(root, path); return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); };

// Files are read only, within the selected tab's working directory. No shell commands.
export class CodeBrowser {
  constructor(workspace) { this.workspace = workspace; }
  async context(id, path, expectedDirectory) {
    const recorded = this.workspace.records().find((t) => t.id === id);
    const current = this.workspace.snapshot.spaces.flatMap((s) => s.tabs).find((t) => t.id === id);
    const tab = recorded?.pathTab ? recorded : current ?? recorded;
    check(tab && !tab.archived && !recorded?.archived, "tab_missing", "タブが見つかりません。", 404);
    check(expectedDirectory === tab.directory, "stale_directory", "作業場所が変更されました。タブを開き直してください。", 409);
    check(typeof path === "string" && !isAbsolute(path) && !/[\x00-\x1f\x7f]/.test(path), "file_path", "ファイルのパスが不正です。");
    const root = await realpath(tab.directory), candidate = resolve(root, path);
    check(within(root, candidate), "file_path", "作業場所の外は開けません。", 403);
    const target = await realpath(candidate);
    check(within(root, target), "file_path", "作業場所の外へのリンクは開けません。", 403);
    return { root, target, path };
  }
  async perform(operation) {
    try { return await operation(); } catch (e) {
      if (e instanceof Fault) throw e;
      if (["ENOENT", "ENOTDIR"].includes(e.code)) throw new Fault(404, "file_missing", "ファイルまたはフォルダが見つかりません。更新してください。");
      if (["EACCES", "EPERM"].includes(e.code)) throw new Fault(403, "file_permission", "このファイルを読み取る権限がありません。");
      throw new Fault(400, "file_read", "ファイルを読み取れません。");
    }
  }
  async list(id, path = "", expectedDirectory, cursor = "0") {
    return this.perform(async () => {
      const offset = Number(cursor);
      check(Number.isSafeInteger(offset) && offset >= 0, "cursor", "取得位置が不正です。");
      const context = await this.context(id, path, expectedDirectory);
      const entries = (await readdir(context.target, { withFileTypes: true }))
        .filter((e) => !/[\x00-\x1f\x7f]/.test(e.name))
        .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name, "en", { numeric: true }));
      const data = await Promise.all(entries.slice(offset, offset + PAGE_SIZE).map(async (entry) => {
        let kind = entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "unsupported";
        if (entry.isSymbolicLink()) {
          try {
            const target = await realpath(join(context.target, entry.name));
            if (within(context.root, target)) {
              const info = await stat(target);
              kind = info.isDirectory() ? "directory" : info.isFile() ? "file" : "unsupported";
            }
          } catch {} // Broken and external links remain visible, but cannot be opened.
        }
        return { name: entry.name, path: join(path, entry.name), kind, symlink: entry.isSymbolicLink() };
      }));
      return { root: context.root, path, data, nextCursor: offset + PAGE_SIZE < entries.length ? String(offset + PAGE_SIZE) : null };
    });
  }
  async read(id, path, expectedDirectory) {
    return this.perform(async () => {
      const context = await this.context(id, path, expectedDirectory);
      const file = await open(context.target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const info = await file.stat();
        check(info.isFile(), "file_type", "通常のテキストファイルを選んでください。", 415);
        check(info.size <= MAX_CODE_BYTES, "file_size", "1 MBを超えるファイルは表示できません。", 413);
        const buffer = Buffer.alloc(MAX_CODE_BYTES + 1);
        let length = 0;
        while (length < buffer.length) {
          const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
          if (!bytesRead) break;
          length += bytesRead;
        }
        check(length <= MAX_CODE_BYTES, "file_size", "1 MBを超えるファイルは表示できません。", 413);
        const bytes = buffer.subarray(0, length);
        const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? "utf-16le" : bytes[0] === 0xfe && bytes[1] === 0xff ? "utf-16be" : "utf-8";
        let text;
        try { text = new TextDecoder(encoding, { fatal: true }).decode(bytes); }
        catch { throw new Fault(415, "file_encoding", "この文字コードは表示できません。UTF-8 / UTF-16に対応しています。"); }
        check(!text.includes("\0"), "file_binary", "バイナリファイルは表示できません。", 415);
        return { root: context.root, path, text, size: length, modifiedAt: info.mtimeMs };
      } finally { await file.close(); }
    });
  }
}
