/**
 * ArtifactStore service client — canonical file upload / download surface.
 * Talks to cws-core (contract-v5).
 *
 * Ported from zylos-openmax `src/cli/as.js`. The library functions
 * (uploadMedia / getMediaUrl / downloadMedia / resolveUris) become methods on
 * `AsService`; the argv/stdout CLI dispatcher stays in the runtime adapter.
 *
 * v5 endpoints:
 *   POST /api/v1/artifacts/resolve   batch-resolve artifact:// URIs → presigned URLs
 *   IM upload  : POST /conversations/{cid}/uploads/prepare → PUT bytes → POST /conversations/uploads/finalize
 *   KB upload  : POST /uploads/prepare → PUT bytes → POST /uploads/finalize
 *
 * Coupling abstracted (design §3.3 StorageProvider):
 *   - The old `~/zylos/components/openmax/media` download directory is replaced
 *     by an injected `storage.downloadDir()` (falls back to os.tmpdir()). No
 *     ~/zylos path is hardcoded in the SDK.
 *   - `uploadMedia(localPath)` still reads a caller-supplied local path via fs —
 *     that path comes from the caller, not from Zylos layout.
 *   - HTTP/auth/putBytes/getBytes all route through the injected CwsHttpClient.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const MIME_BY_KIND = {
  image:   'image/png',
  video:   'video/mp4',
  audio:   'audio/mpeg',
  voice:   'audio/ogg',
  file:    'application/octet-stream',
  sticker: 'image/webp',
};

// Real MIME inference by file extension (issue #7 fix ported verbatim): keeps
// content_type correct even when the upper layer mis-tagged the media kind.
const MIME_BY_EXT = {
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
  '.bmp':  'image/bmp',
  '.svg':  'image/svg+xml',
  '.heic': 'image/heic',
  '.mp4':  'video/mp4',
  '.mov':  'video/quicktime',
  '.webm': 'video/webm',
  '.mp3':  'audio/mpeg',
  '.ogg':  'audio/ogg',
  '.wav':  'audio/wav',
  '.m4a':  'audio/mp4',
  '.pdf':  'application/pdf',
};

function mimeFromExt(filePathOrName) {
  if (!filePathOrName) return null;
  const ext = path.extname(filePathOrName).toLowerCase();
  return MIME_BY_EXT[ext] || null;
}

/** Build an `artifact://` URI from a bare id, or return as-is if already a URI. */
function toArtifactUri(idOrUri) {
  if (typeof idOrUri !== 'string') {
    throw new Error('artifact id or URI is required');
  }
  return idOrUri.startsWith('artifact://') ? idOrUri : `artifact://${idOrUri}`;
}

export class AsService {
  /**
   * @param {import('../transport/http.js').CwsHttpClient} http
   * @param {{ downloadDir?: () => (string|Promise<string>) }} [storage]
   *        StorageProvider; downloadDir() returns the directory downloadMedia
   *        writes into. Defaults to os.tmpdir() when omitted.
   */
  constructor(http, storage = null) {
    if (!http) throw new Error('AsService requires a CwsHttpClient');
    this.http = http;
    this.storage = storage;
  }

  _p(path) { return this.http.apiPath(path); }

  async _resolveDownloadDir() {
    if (this.storage && typeof this.storage.downloadDir === 'function') {
      const dir = await this.storage.downloadDir();
      if (dir) return dir;
    }
    return os.tmpdir();
  }

  /**
   * Upload a local file via the v5 prepare/finalize flow.
   *   - opts.conversationId set  → IM upload (conversation-scoped)
   *   - otherwise                → KB upload (file node in a tree)
   *
   * Returns {mediaId, artifactId, fileName, mimeType, sizeBytes, instantUpload};
   * KB uploads additionally include {nodeId, treeNode}.
   */
  async uploadMedia(localPath, opts = {}) {
    if (!localPath) throw new Error('uploadMedia: localPath is required');
    const buf  = await fs.promises.readFile(localPath);
    const stat = await fs.promises.stat(localPath);

    const fileName  = opts.filename || path.basename(localPath);
    const mediaType = opts.mediaType || 'file';
    const contentType = opts.mimeType
      || opts.contentType
      || mimeFromExt(fileName)
      || mimeFromExt(localPath)
      || MIME_BY_KIND[mediaType]
      || 'application/octet-stream';
    const sizeBytes = stat.size;

    const isIm = !!opts.conversationId;

    const prepPath = isIm
      ? `/conversations/${opts.conversationId}/uploads/prepare`
      : '/uploads/prepare';

    const prepBody = isIm
      ? { filename: fileName, content_type: contentType, size_bytes: sizeBytes }
      : { parent_id: opts.parentId, filename: fileName, content_type: contentType, size_bytes: sizeBytes };

    const prep = await this.http.post(this._p(prepPath), prepBody);

    const uploadToken   = prep?.upload_token;
    const uploadUrl     = prep?.upload_url;
    const reqHeaders    = prep?.headers || {};
    const instantUpload = prep?.instant_upload === true;

    if (!uploadToken) {
      throw new Error('uploads/prepare returned no upload_token');
    }

    // Step 2: PUT bytes to the pre-signed URL (skip on instant_upload).
    if (!instantUpload) {
      if (!uploadUrl) throw new Error('uploads/prepare returned no upload_url');
      await this.http.putBytes(uploadUrl, buf, contentType, reqHeaders);
    }

    // Step 3: finalize.
    const finalizePath = isIm
      ? '/conversations/uploads/finalize'
      : '/uploads/finalize';
    const finalized = await this.http.post(this._p(finalizePath), { upload_token: uploadToken });

    if (isIm) {
      // finalized: {media_id, artifact_id}
      return {
        mediaId:       finalized?.media_id,
        artifactId:    finalized?.artifact_id,
        fileName,
        mimeType:      contentType,
        sizeBytes,
        instantUpload,
      };
    }

    // KB upload: finalized is a tree node (id, kb_id, parent_id, name, artifact_id, ...).
    return {
      mediaId:    finalized?.artifact_id,
      artifactId: finalized?.artifact_id,
      nodeId:     finalized?.id,
      treeNode:   finalized,
      fileName:   finalized?.name || fileName,
      mimeType:   contentType,
      sizeBytes,
      instantUpload,
    };
  }

  /** Resolve one artifact id or URI to a presigned URL. */
  async getMediaUrl(idOrUri, opts = {}) {
    const uri = toArtifactUri(idOrUri);
    const inline = opts.inline === true || opts.mode === 'preview';
    const res = await this.http.post(this._p('/artifacts/resolve'), { uris: [uri], inline });
    const entry = res?.resolved?.[uri];
    if (!entry || !entry.download_url) {
      const failed = res?.failed || [];
      const reason = failed.includes(uri) ? 'artifact not resolvable' : 'no download_url in response';
      throw new Error(`getMediaUrl: ${reason} (${uri})`);
    }
    return {
      url:           entry.download_url,
      expiresAt:     entry.expires_at,
      contentType:   entry.content_type,
      contentLength: entry.content_length,
      name:          entry.name,
    };
  }

  /** Batch-resolve `artifact://` URIs to short-lived download URLs. */
  async resolveUris(uris, opts = {}) {
    if (!Array.isArray(uris) || uris.length === 0) {
      throw new Error('resolveUris: uris must be a non-empty array');
    }
    return this.http.post(this._p('/artifacts/resolve'), {
      uris,
      inline: opts.inline === true,
    });
  }

  /**
   * Download an artifact's bytes to a local file under the storage download
   * directory. Returns the absolute local path.
   *   - https(s) URL → used directly
   *   - artifact://<id> or bare id → resolved first
   */
  async downloadMedia(urlOrIdOrUri, filename) {
    let url = urlOrIdOrUri;
    let resolvedName;
    if (!/^https?:\/\//i.test(urlOrIdOrUri)) {
      const meta = await this.getMediaUrl(urlOrIdOrUri);
      url = meta.url;
      resolvedName = meta.name;
    }
    const dir = await this._resolveDownloadDir();
    await fs.promises.mkdir(dir, { recursive: true });
    const safeName = (filename || resolvedName || `media-${Date.now()}`).replace(/[/\\]/g, '_');
    const localPath = path.join(dir, safeName);
    const buf = await this.http.getBytes(url);
    await fs.promises.writeFile(localPath, buf);
    return localPath;
  }
}

export function createAsService(http, storage) {
  return new AsService(http, storage);
}
