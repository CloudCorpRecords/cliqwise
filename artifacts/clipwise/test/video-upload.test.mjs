import assert from 'node:assert/strict';
import test from 'node:test';
import { videoContentType, uploadVideo } from '../src/lib/video-upload.ts';

test('video MIME inference handles empty browser MIME without accepting audio or empty extensions', () => {
  assert.equal(videoContentType(new File(['video'], 'sample.MP4')), 'video/mp4');
  assert.equal(videoContentType(new File(['video'], 'sample.mov', { type: 'application/octet-stream' })), 'video/quicktime');
  assert.equal(videoContentType(new File(['audio'], 'sample.mp3', { type: 'audio/mpeg' })), null);
  assert.equal(videoContentType(new File(['unknown'], 'sample.txt')), null);
});

test('upload accepts only 2xx, reports progress, and rejects connection/timeout failures', async () => {
  const original = globalThis.XMLHttpRequest;
  let request;
  globalThis.XMLHttpRequest = class {
    upload = {};
    constructor() { request = this; }
    open(method, url) { this.method = method; this.url = url; }
    setRequestHeader(name, value) { this.header = [name, value]; }
    send(file) { this.file = file; }
  };
  try {
    const file = new File(['video'], 'sample.mp4', { type: 'video/mp4' });
    let progress = 0;
    const pending = uploadVideo('https://upload.example/', file, 'video/mp4', (value) => { progress = value; });
    assert.equal(request.method, 'PUT');
    assert.deepEqual(request.header, ['Content-Type', 'video/mp4']);
    assert.equal(request.file, file);
    request.upload.onprogress({ lengthComputable: true, loaded: 1, total: 2 });
    assert.equal(progress, 0.5);
    request.status = 200;
    request.onload();
    await pending;
    for (const status of [0, 199, 300, 403]) {
      const failure = uploadVideo('https://upload.example/', file, 'video/mp4', () => {});
      request.status = status;
      request.onload();
      await assert.rejects(failure, /Upload failed/);
    }
    const timedOut = uploadVideo('https://upload.example/', file, 'video/mp4', () => {});
    request.ontimeout();
    await assert.rejects(timedOut, /timed out/);
  } finally {
    globalThis.XMLHttpRequest = original;
  }
});