const videoTypes: Record<string, string> = {
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime',
  webm: 'video/webm', mkv: 'video/x-matroska', avi: 'video/x-msvideo',
  mpeg: 'video/mpeg', mpg: 'video/mpeg',
};

export function videoContentType(file: File): string | null {
  if (file.type.startsWith('video/')) return file.type;
  // Browsers sometimes leave the MIME type empty for a valid video extension.
  if (file.type && file.type !== 'application/octet-stream') return null;
  return videoTypes[file.name.split('.').pop()?.toLowerCase() ?? ''] ?? null;
}

export function uploadVideo(url: string, file: File, contentType: string, onProgress: (progress: number) => void) {
  return new Promise<void>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('PUT', url);
    request.timeout = 20 * 60 * 1000;
    request.setRequestHeader('Content-Type', contentType);
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    };
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) resolve();
      else reject(new Error(`Upload failed (${request.status}). Please retry.`));
    };
    request.onerror = () => reject(new Error('Upload failed. Check your connection and retry.'));
    request.ontimeout = () => reject(new Error('The upload timed out. Check your connection and retry.'));
    request.onabort = () => reject(new Error('The upload was cancelled.'));
    request.send(file);
  });
}