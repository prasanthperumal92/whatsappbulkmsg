import { put } from '@vercel/blob/client';
import { fetchJson, RequestError } from './fetch-json';

// §5.3: the file goes straight from the browser to Blob, so it never meets the 4.5 MB function limit.
// Local dev has no Blob store and uploads through the app instead (lib/storage/blob.ts).

type Authorisation = { blob_path: string } & ({ mode: 'blob'; clientToken: string } | { mode: 'local' });
export type UploadResult = { blob_path: string; sha256: string };

function putLocal(path: string, file: File, onProgress: (percent: number) => void) {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `/api/imports/local-upload?path=${encodeURIComponent(path)}`);
    xhr.setRequestHeader('content-type', 'text/csv');
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress((e.loaded / e.total) * 100);
    xhr.onload = () => (xhr.status < 300 ? resolve() : reject(new RequestError(xhr.status, 'The upload failed. Please try again.')));
    xhr.onerror = () => reject(new Error('The upload failed. Check your connection and try again.'));
    xhr.send(file);
  });
}

async function sha256Hex(file: File) {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function uploadImportFile(file: File, onProgress: (percent: number) => void): Promise<UploadResult> {
  const auth = await fetchJson<Authorisation>('/api/imports/upload-token', {
    method: 'POST',
    body: JSON.stringify({ file_name: file.name, size: file.size, content_type: file.type }),
  });
  if (auth.mode === 'local') {
    await putLocal(auth.blob_path, file, onProgress);
  } else {
    await put(auth.blob_path, file, {
      access: 'private',
      token: auth.clientToken,
      contentType: /\.txt$/i.test(file.name) ? 'text/plain' : 'text/csv',
      multipart: true,
      onUploadProgress: ({ percentage }) => onProgress(percentage),
    });
  }
  return { blob_path: auth.blob_path, sha256: await sha256Hex(file) };
}
