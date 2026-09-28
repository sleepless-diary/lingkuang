/** 灵框 · 助手的「文件夹手」：灵框**外**文件的读写（片 1，2026-09-28）
 *
 *  用户原话：「可以写，我想要灵框成为一个功能完备的AI」。范围他只勾了**文件读写（灵框外，白名单 + 闸门）**，
 *  安全档选了「白名单目录默认只读；写灵框外一律逐次确认」。
 *
 *  ⭐ 分工（改之前先记住这条，别搞反）：
 *   · **主进程**（`main.js` 的 `fs:*` 通道）是唯一的执行者，也是唯一说了算的：白名单存在
 *     `userData/agent-roots.json`，路径 realpath 归一后必须是某个 root 的前缀。渲染层被绕过也写不出白名单。
 *   · **这一层**只做三件事：把 roots 缓存在内存里（提示词要说"你能碰哪些文件夹"）、把 IPC 包成好用的
 *     async、给失败配人话。
 *   · 本文件的 `fsRootOf()` 是**给卡片和提示词看的**（说清"这是灵框库外的，要创作者点一下"），
 *     **不是安全边界** —— 它是纯字符串前缀比较，没有 realpath。真正拦人的在主进程。
 *
 *  ⚠️ 为什么要有内存缓存：`toolsPrompt()` 是**同步**的（系统提示每次现拼），拿不到 async 的结果。
 *  所以 roots 缓存一份，`runTurn()` 每次提问前刷一次（`refreshFsRoots()`），面板打开时也刷一次。
 */

export interface FsRoot {
  path: string;
  label: string;
  /** 这个文件夹助手能不能写（内置的 vault 恒为 true；用户加的默认 false） */
  write: boolean;
  /** 内置那条 = vault（既不能从清单里去掉，也不能改成只读） */
  builtin?: boolean;
  /** 磁盘上还在不在（用户把文件夹改名/删掉之后，清单里那条会标 false） */
  exists?: boolean;
}

export interface FsEntry { name: string; dir: boolean; size: number; mtime: number; write?: boolean }
export interface FsHit { file: string; line: number; text: string }
export interface FsListData { path: string; root: { label: string; write: boolean }; entries: FsEntry[] }
export interface FsSearchData { path: string; q: string; hits: FsHit[]; scanned: number }
export interface FsReadData { path: string; size: number; text: string }
export interface FsWriteData { path: string; bytes: number; mode: string }
export interface FsRootsData { roots: FsRoot[]; existed?: boolean }

export interface FsOk<T> { ok: true; data: T }
export interface FsFail { ok: false; error: string; canceled?: boolean }
export type FsResult<T> = FsOk<T> | FsFail;

interface RawFsApi {
  roots(): Promise<Record<string, unknown>>;
  addRoot(payload?: { path: string }): Promise<Record<string, unknown>>;
  removeRoot(p: string): Promise<Record<string, unknown>>;
  setRootWrite(p: string, write: boolean): Promise<Record<string, unknown>>;
  list(p: string): Promise<Record<string, unknown>>;
  read(p: string): Promise<Record<string, unknown>>;
  search(p: string, q: string): Promise<Record<string, unknown>>;
  write(p: string, text: string, mode: 'overwrite' | 'append'): Promise<Record<string, unknown>>;
}

function api(): RawFsApi | null {
  const a = (window as unknown as { lingkuangAPI?: { fs?: RawFsApi } }).lingkuangAPI;
  return a && a.fs ? a.fs : null;
}

/** 文件通道在不在（不在 = 旧版主进程 / 测试里没打桩）—— 提示词靠它决定要不要列文件动作 */
export function fsAvailable(): boolean { return !!api(); }

const noApi = (): FsFail => ({ ok: false, error: '这个版本的灵框还没接上文件通道（升级一下主进程）' });

/* roots 缓存（见文件头那段"为什么要有缓存"） */
let roots: FsRoot[] = [];

export function fsRootsCached(): FsRoot[] { return roots; }

/** 重新问主进程要一份白名单；拿不到就沿用上次那份（**不阻塞一次提问**） */
export async function refreshFsRoots(): Promise<FsRoot[]> {
  const a = api();
  if (!a) return roots;
  try {
    const r = await a.roots();
    if (r && r.ok && Array.isArray(r.roots)) roots = r.roots as FsRoot[];
  } catch { /* 沿用上次 */ }
  return roots;
}

/** 统一的返回值包装：主进程回 `{ok:false, error}` 就翻成人话，异常也不许漏到调用方 */
async function call<T>(fn: (a: RawFsApi) => Promise<Record<string, unknown>>): Promise<FsResult<T>> {
  const a = api();
  if (!a) return noApi();
  try {
    const r = await fn(a);
    if (!r) return { ok: false, error: '主进程没有回话' };
    if (r.ok) return { ok: true, data: r as unknown as T };
    return { ok: false, error: String(r.error || '主进程拒绝了这次操作') };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 加一个文件夹（不给 path = 弹系统对话框让创作者亲手选；给了 path 只有测试实例认） */
export async function fsAddRoot(p?: string): Promise<FsResult<FsRootsData>> {
  const a = api();
  if (!a) return noApi();
  try {
    const r = await a.addRoot(p ? { path: p } : undefined);
    if (r && r.ok) {
      roots = (r.roots as FsRoot[]) ?? roots;
      return { ok: true, data: r as unknown as FsRootsData };
    }
    if (r && r.canceled) return { ok: false, error: '（没有选文件夹）', canceled: true };
    return { ok: false, error: String((r && r.error) || '加不上这个文件夹') };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function fsRemoveRoot(p: string): Promise<FsResult<FsRootsData>> {
  const out = await call<FsRootsData>((a) => a.removeRoot(p));
  if (out.ok && out.data.roots) roots = out.data.roots;
  return out;
}

export async function fsSetRootWrite(p: string, write: boolean): Promise<FsResult<FsRootsData>> {
  const out = await call<FsRootsData>((a) => a.setRootWrite(p, write));
  if (out.ok && out.data.roots) roots = out.data.roots;
  return out;
}

export function fsList(p: string): Promise<FsResult<FsListData>> {
  return call<FsListData>((a) => a.list(p));
}

export function fsRead(p: string): Promise<FsResult<FsReadData>> {
  return call<FsReadData>((a) => a.read(p));
}

export function fsSearch(p: string, q: string): Promise<FsResult<FsSearchData>> {
  return call<FsSearchData>((a) => a.search(p, q));
}

export function fsWrite(p: string, text: string, mode: 'overwrite' | 'append'): Promise<FsResult<FsWriteData>> {
  return call<FsWriteData>((a) => a.write(p, text, mode));
}

/** 路径 → 小写正斜杠（**纯字符串**，不做 realpath —— 这里只是给卡片判"是不是灵框库外"） */
const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/** 这个路径落在哪个 root 里（嵌套时取**更具体**的那条）。认不出来 = 不在白名单里，别去写。 */
export function fsRootOf(p: string): FsRoot | null {
  if (!p) return null;
  const t = norm(p);
  let best: FsRoot | null = null;
  for (const r of roots) {
    const root = norm(r.path);
    if (t !== root && !t.startsWith(root + '/')) continue;
    if (!best || root.length > norm(best.path).length) best = r;
  }
  return best;
}

/** 文件工具的默认落点：清单里的第一条（内置的 vault 恒在）。模型没给 path 时用它。 */
export function fsDefaultPath(): string { return roots[0]?.path ?? ''; }

/** 拼进系统提示的那一段：**你能碰哪些文件夹 + 规矩**。
 *  没接上通道（旧主进程）就返回空串 —— 宁可少列动作，也不让模型对着不存在的工具空转。 */
export function fsPrompt(): string {
  if (!fsAvailable()) return '';
  const rows = roots.map((r) => `- ${r.path}（${r.write ? '可写' : '只读'}${r.builtin ? '，灵框库' : ''}${r.exists === false ? '，现在不见了' : ''}）`);
  return [
    '【你能碰的文件夹】',
    rows.length ? '创作者已经把这些文件夹交给你了：' : '除灵框库外，创作者还没给你别的文件夹。',
    ...rows,
    '看文件（list_files / read_file / search_files）随时可用，读到的是磁盘上真实的内容 —— 先看再说，别凭印象编。',
    '写文件用 write_file / append_file：**灵框库以外的每一次写，都要创作者亲手点「应用」**（就算权限是「直接执行」也一样）；标「只读」的文件夹根本写不进去（要写请让创作者在助手面板的「文件夹」里改成可写）。',
    '路径一律写**完整绝对路径**（Windows 上形如 D:\\素材\\人物表.md），不要用相对路径，也不要猜路径 —— 不确定就先 list_files 看一眼。',
  ].join('\n');
}
