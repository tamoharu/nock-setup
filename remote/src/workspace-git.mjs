import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, realpath, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, relative, isAbsolute } from "node:path";
import { check, Fault } from "./config.mjs";

const exec = promisify(execFile);
const locks = new Map();
async function git(directory, args) {
  return (await exec("git", ["-C", directory, "--no-optional-locks", ...args],
    { encoding: "utf8", timeout: 15000, maxBuffer: 4 * 1024 * 1024 })).stdout.trimEnd();
}

// Read only. No checkout, fetch, or index refresh when displaying the header.
export async function repositoryContext(directory) {
  let root;
  try { root = await git(directory, ["rev-parse", "--show-toplevel"]); }
  catch (error) {
    if (error.code === 128 && /not a git repository/i.test(error.stderr ?? ""))
      return { isRepository: false, currentBranch: null, branches: [] };
    throw new Fault(503, "git_unavailable", "Gitの情報を取得できません。PCのGitとディレクトリを確認してください。");
  }
  const [currentBranch, refs] = await Promise.all([
    git(directory, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch((error) => {
      if (error.code === 1) return null;
      throw error;
    }),
    git(directory, ["for-each-ref", "--format=%(refname:strip=2)", "refs/heads/"]),
  ]);
  const branches = refs.split("\n").filter(Boolean);
  if (currentBranch && !branches.includes(currentBranch)) branches.unshift(currentBranch); // Unborn repository.
  return { isRepository: true, root, currentBranch, branches };
}

// Create only the ref. The new chat uses branchDirectory to open its worktree.
export async function createBranch(directory, name, baseBranch) {
  check(typeof name === "string" && name.length > 0 && name.length < 1024 && name !== "HEAD" && !name.startsWith("-"),
    "branch", "ブランチ名が不正です。");
  await git(directory, ["check-ref-format", "refs/heads/" + name])
    .catch(() => { throw new Fault(400, "branch", "ブランチ名が不正です。"); });
  const context = await repositoryContext(directory);
  check(context.isRepository, "branch", "Gitリポジトリを選んでください。");
  check(!context.branches.includes(name), "branch_exists", "同じ名前のブランチが既にあります。", 409);
  check(baseBranch == null || context.branches.includes(baseBranch), "branch_base", "作成元のブランチが見つかりません。", 409);
  const base = await git(directory, ["rev-parse", "--verify", "--end-of-options",
    (baseBranch == null ? "HEAD" : "refs/heads/" + baseBranch) + "^{commit}"])
    .catch(() => { throw new Fault(409, "branch_base", "作成元のコミットがありません。PCで最初のコミットを作成してください。"); });
  try { await git(directory, ["branch", "--no-track", "--", name, base]); }
  catch (error) {
    if (error.killed) throw new Fault(503, "branch_unknown", "ブランチの作成結果を確認できません。ブランチ一覧を確認してください。");
    throw new Fault(409, "branch_create", "ブランチを作成できません。同名のブランチやPCのGitの状態を確認してください。");
  }
  return { branch: name };
}

// A branch choice never changes a checkout used by another chat. Reuse that
// branch's worktree or create one, retaining a selected repository subdirectory.
export async function branchDirectory(directory, branch, dataDir) {
  check(typeof branch === "string" && branch.length > 0 && branch.length < 1024,
    "branch", "ブランチの指定が不正です。");
  const common = await git(directory, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
    .catch(() => { throw new Fault(400, "branch", "Gitリポジトリを選んでください。"); });
  const previous = locks.get(common) ?? Promise.resolve();
  const task = previous.catch(() => {}).then(async () => {
    const context = await repositoryContext(directory);
    check(context.branches.includes(branch), "branch_missing", "ブランチが見つかりません。作業場所を選び直してください。", 409);
    if (context.currentBranch === branch) return directory;
    const subdirectory = relative(context.root, directory);
    const worktrees = (await git(directory, ["worktree", "list", "--porcelain", "-z"]))
      .split("\0\0").map((record) => Object.fromEntries(record.split("\0").filter(Boolean).map((field) => {
        const index = field.indexOf(" ");
        return index < 0 ? [field, true] : [field.slice(0, index), field.slice(index + 1)];
      })));
    let root = worktrees.find((entry) => entry.branch === "refs/heads/" + branch && !entry.prunable)?.worktree;
    if (!root) {
      const key = createHash("sha256").update(common + "\0" + branch).digest("hex").slice(0, 24);
      const parent = join(dataDir, "worktrees");
      await mkdir(parent, { recursive: true, mode: 0o700 });
      root = join(parent, key);
      try { await git(directory, ["worktree", "add", "--", root, branch]); }
      catch { throw new Fault(409, "worktree", "ブランチの作業ディレクトリを作成できません。PCのworktreeを確認してください。"); }
    }
    const resolvedRoot = await realpath(root);
    const target = await realpath(join(root, subdirectory)).catch(() => null);
    const offset = target == null ? ".." : relative(resolvedRoot, target);
    check(target && offset !== ".." && !offset.startsWith("../") && !isAbsolute(offset) && (await stat(target)).isDirectory(),
      "branch_directory", "選んだブランチにはこのディレクトリがありません。リポジトリのルートを選んでください。", 409);
    check((await repositoryContext(target)).currentBranch === branch,
      "branch_changed", "ブランチが変更されました。選び直してください。", 409);
    return target;
  });
  locks.set(common, task);
  try { return await task; }
  finally { if (locks.get(common) === task) locks.delete(common); }
}
