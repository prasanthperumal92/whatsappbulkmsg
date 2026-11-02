import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { del, get, issueSignedToken, list, presignUrl, put } from '@vercel/blob';
import { generateClientTokenFromReadWriteToken } from '@vercel/blob/client';
import { getEnvironment } from '@/lib/env';

// §3.4 private storage. Deployments use Vercel Blob. Local dev and tests have no store, so a directory
// stands in; `getEnvironment` makes that impossible on a deployment.

export type BlobEntry = { pathname: string; uploadedAt: Date; size: number };
export type UploadAuthorisation = { mode: 'blob'; clientToken: string } | { mode: 'local' };

export interface BlobStore {
  readonly driver: 'vercel' | 'local';
  put(pathname: string, body: Uint8Array | string, contentType: string): Promise<void>;
  /** Null when the file doesn't exist. */
  read(pathname: string): Promise<Uint8Array | null>;
  remove(pathnames: string[]): Promise<void>;
  list(prefix: string): Promise<BlobEntry[]>;
  /** A short-lived URL for one file, or null if this store can't sign and the caller must serve the file itself. */
  signedDownloadUrl(pathname: string, ttlSeconds: number): Promise<string | null>;
  authoriseUpload(pathname: string, limits: { maxBytes: number; contentTypes: string[] }): Promise<UploadAuthorisation>;
}

class VercelBlobStore implements BlobStore {
  readonly driver = 'vercel';
  constructor(private readonly token: string) {}

  async put(pathname: string, body: Uint8Array | string, contentType: string) {
    const data = typeof body === 'string' ? body : Buffer.from(body);
    await put(pathname, data, { access: 'private', addRandomSuffix: false, allowOverwrite: true, contentType, token: this.token });
  }

  async read(pathname: string) {
    const result = await get(pathname, { access: 'private', useCache: false, token: this.token });
    if (!result || result.statusCode !== 200 || !result.stream) return null;
    return new Uint8Array(await new Response(result.stream).arrayBuffer());
  }

  async remove(pathnames: string[]) {
    if (pathnames.length) await del(pathnames, { token: this.token });
  }

  async list(prefix: string) {
    const entries: BlobEntry[] = [];
    let cursor: string | undefined;
    do {
      const page = await list({ prefix, cursor, limit: 1000, token: this.token });
      entries.push(...page.blobs.map((b) => ({ pathname: b.pathname, uploadedAt: new Date(b.uploadedAt), size: b.size })));
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
    return entries;
  }

  async signedDownloadUrl(pathname: string, ttlSeconds: number) {
    const validUntil = Date.now() + ttlSeconds * 1000;
    const signed = await issueSignedToken({ pathname, operations: ['get'], validUntil, token: this.token });
    const { presignedUrl } = await presignUrl(signed, { operation: 'get', pathname, access: 'private', validUntil });
    return presignedUrl;
  }

  async authoriseUpload(pathname: string, { maxBytes, contentTypes }: { maxBytes: number; contentTypes: string[] }) {
    const clientToken = await generateClientTokenFromReadWriteToken({
      token: this.token,
      pathname,
      maximumSizeInBytes: maxBytes,
      allowedContentTypes: contentTypes,
      addRandomSuffix: false,
      validUntil: Date.now() + 60 * 60 * 1000,
    });
    return { mode: 'blob', clientToken } as const;
  }
}

class LocalBlobStore implements BlobStore {
  readonly driver = 'local';
  constructor(private readonly root: string) {}

  private resolve(pathname: string) {
    const full = path.resolve(/*turbopackIgnore: true*/ this.root, pathname);
    if (!full.startsWith(path.resolve(/*turbopackIgnore: true*/ this.root) + path.sep)) throw new Error('Path escapes the local blob directory');
    return full;
  }

  async put(pathname: string, body: Uint8Array | string) {
    const full = this.resolve(pathname);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, body);
  }

  async read(pathname: string) {
    try {
      return new Uint8Array(await readFile(this.resolve(pathname)));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async remove(pathnames: string[]) {
    await Promise.all(pathnames.map((p) => rm(this.resolve(p), { force: true })));
  }

  async list(prefix: string) {
    const names = (await readdir(this.root, { recursive: true }).catch(() => [] as string[])) as string[];
    const entries: BlobEntry[] = [];
    for (const name of names) {
      const pathname = name.split(path.sep).join('/');
      if (!pathname.startsWith(prefix)) continue;
      const info = await stat(path.join(this.root, name));
      if (info.isFile()) entries.push({ pathname, uploadedAt: info.mtime, size: info.size });
    }
    return entries;
  }

  async signedDownloadUrl() {
    return null;
  }

  async authoriseUpload() {
    return { mode: 'local' } as const;
  }
}

const cache = globalThis as unknown as { __appBlob?: BlobStore };

export function getBlobStore(env: Record<string, string | undefined> = process.env): BlobStore {
  if (cache.__appBlob) return cache.__appBlob;
  const token = env.BLOB_READ_WRITE_TOKEN;
  if (token) return (cache.__appBlob = new VercelBlobStore(token));
  if (getEnvironment(env) !== 'local') throw new Error('BLOB_READ_WRITE_TOKEN is not set');
  return (cache.__appBlob = new LocalBlobStore(path.resolve(/*turbopackIgnore: true*/ env.LOCAL_BLOB_DIR ?? '.local-blob')));
}
