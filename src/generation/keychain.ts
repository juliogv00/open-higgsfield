import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/* The same two entries the VMNTe image gateway reads. The key never touches a
   file or a cookie: the studio asks the macOS Keychain on every request. */
const ID_SERVICE = "vmnte-higgsfield-id";
const SECRET_SERVICE = "vmnte-higgsfield-secret";

async function read(service: string): Promise<string | null> {
  if (process.platform !== "darwin") return null;
  try {
    const { stdout } = await run("security", ["find-generic-password", "-s", service, "-w"]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export async function readKeychainKey(): Promise<string | null> {
  const [id, secret] = await Promise.all([read(ID_SERVICE), read(SECRET_SERVICE)]);
  return id && secret ? `${id}:${secret}` : null;
}
