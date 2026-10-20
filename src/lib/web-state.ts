import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

const stateRoot = process.env.GBRAIN_WEB_STATE_DIR || join(process.cwd(), "data")
const writeLocks = new Map<string, Promise<void>>()

async function ensureStateRoot(): Promise<void> {
  await mkdir(stateRoot, { recursive: true })
}

export async function statePath(name: string): Promise<string> {
  await ensureStateRoot()
  return join(stateRoot, name)
}

export async function readJson<T>(name: string, fallback: T): Promise<T> {
  try {
    const path = await statePath(name)
    return JSON.parse(await readFile(path, "utf8")) as T
  } catch {
    return fallback
  }
}

export async function writeJsonAtomic<T>(name: string, value: T): Promise<void> {
  const previous = writeLocks.get(name) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => { release = resolve })
  writeLocks.set(name, current)
  await previous
  try {
    const path = await statePath(name)
    await mkdir(dirname(path), { recursive: true })
    const temp = `${path}.${process.pid}.${Date.now()}.tmp`
    await writeFile(temp, JSON.stringify(value, null, 2) + "\n", "utf8")
    await rename(temp, path)
  } finally {
    release()
    if (writeLocks.get(name) === current) writeLocks.delete(name)
  }
}

async function isProcessAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export async function acquireStateLock(name: string): Promise<boolean> {
  const lockPath = await statePath(`locks/${name}.lock`)
  try {
    await mkdir(dirname(lockPath), { recursive: true })
    await mkdir(lockPath, { recursive: false })
    await writeFile(join(lockPath, "owner"), `${process.pid}\n`, "utf8")
    return true
  } catch {
    // 自愈:锁目录被遗留进程占用时,读取 owner PID 并检查其是否存活。
    // 进程被 kill/超时中断后 releaseStateLock 永远等不到,锁永久残留,
    // 导致该 source 再也无法重试。若 owner 进程已死,回收锁并重试一次。
    try {
      const ownerRaw = await readFile(join(lockPath, "owner"), "utf8")
      const owner = Number(ownerRaw.trim())
      if (Number.isInteger(owner) && owner > 0 && !(await isProcessAlive(owner))) {
        await rm(lockPath, { recursive: true, force: true })
        await mkdir(dirname(lockPath), { recursive: true })
        await mkdir(lockPath, { recursive: false })
        await writeFile(join(lockPath, "owner"), `${process.pid}\n`, "utf8")
        return true
      }
    } catch {
      // owner 不可读/异常 — 保守起见维持被占用。
    }
    return false
  }
}

export async function releaseStateLock(name: string): Promise<void> {
  try {
    await rm(await statePath(`locks/${name}.lock`), { recursive: true, force: true })
  } catch {
    // Best effort: the gbrain source lock remains the correctness backstop.
  }
}
