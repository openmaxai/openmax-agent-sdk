/**
 * KnowledgeBase service client — cws-core contract-v5 KB surface.
 *
 * Ported from zylos-openmax `src/cli/kb.js`. v5 flat namespaces:
 *   /api/v1/kbs/{kb_id}/tree/...   tree nodes, folders, files, download
 *   /api/v1/pages/...              pages, content, revisions, trash
 *   /api/v1/kbs[, /{kb_id}, ...]   KB collection + archive/unarchive
 *   /api/v1/search/pages           full-text search
 *
 * Org scoping is carried by the JWT principal (resolved server-side) — no
 * X-Org-Id header, no orgId path segment. Most methods require `kbId`.
 *
 * `upload()` delegates to the injected AsService (design §4.2:
 * `KbService(http, as)`); everything else is pure REST via the CwsHttpClient.
 */

export class KbService {
  /**
   * @param {import('../transport/http.js').CwsHttpClient} http
   * @param {import('./as.js').AsService} [as]  AsService for kb.upload; if
   *        omitted, an AsService bound to the same http client is created
   *        lazily on first upload().
   */
  constructor(http, as = null) {
    if (!http) throw new Error('KbService requires a CwsHttpClient');
    this.http = http;
    this.as = as;
  }

  _p(path) { return this.http.apiPath(path); }

  _requireKbId(params) {
    const id = params.kbId || params.kb_id;
    if (!id) throw new Error('kbId is required');
    return id;
  }

  async _asService() {
    if (this.as) return this.as;
    // Lazy default: bind an AsService to the same http client (no storage — KB
    // uploads don't use the download dir).
    const { AsService } = await import('./as.js');
    this.as = new AsService(this.http);
    return this.as;
  }

  // ===========================================================================
  //  KB collection
  // ===========================================================================

  init() { return this.http.post(this._p('/kbs/init')); }

  list(params = {}) {
    return this.http.get(this._p('/kbs'), { limit: params.limit, offset: params.offset });
  }

  // visibility: "open" | "closed" | "private" (required by cws-core; slug is
  // NOT accepted — server derives it from name).
  create(params = {}) {
    return this.http.post(this._p('/kbs'), {
      name:        params.name,
      visibility:  params.visibility || 'closed',
      description: params.description,
      icon:        params.icon,
    });
  }

  get(params = {}) { return this.http.get(this._p(`/kbs/${this._requireKbId(params)}`)); }

  update(params = {}) {
    return this.http.patch(this._p(`/kbs/${this._requireKbId(params)}`), {
      name:            params.name,
      description:     params.description,
      set_description: params.setDescription,
      visibility:      params.visibility,
      icon:            params.icon,
      set_icon:        params.setIcon,
    });
  }

  delete(params = {}) { return this.http.del(this._p(`/kbs/${this._requireKbId(params)}`)); }

  archive(params = {})   { return this.http.post(this._p(`/kbs/${this._requireKbId(params)}/archive`)); }
  unarchive(params = {}) { return this.http.post(this._p(`/kbs/${this._requireKbId(params)}/unarchive`)); }

  // ===========================================================================
  //  Directory tree (kb-scoped)
  // ===========================================================================

  treeRoots(params = {}) { return this.http.get(this._p(`/kbs/${this._requireKbId(params)}/tree/roots`)); }

  folderCreate(params = {}) {
    return this.http.post(this._p(`/kbs/${this._requireKbId(params)}/tree/folders`), {
      parent_id: params.parentId,
      name:      params.name || params.title,
    });
  }

  // Use after uploadMedia() returns an artifact_id to register the file node.
  fileCreate(params = {}) {
    return this.http.post(this._p(`/kbs/${this._requireKbId(params)}/tree/files`), {
      parent_id:   params.parentId,
      name:        params.name,
      artifact_id: params.artifactId,
    });
  }

  nodeGet(params = {}) {
    return this.http.get(this._p(`/kbs/${this._requireKbId(params)}/tree/nodes/${params.nodeId}`));
  }

  nodeBreadcrumb(params = {}) {
    return this.http.get(this._p(`/kbs/${this._requireKbId(params)}/tree/nodes/${params.nodeId}/breadcrumb`));
  }

  nodeChildren(params = {}) {
    return this.http.get(
      this._p(`/kbs/${this._requireKbId(params)}/tree/nodes/${params.parentId || params.nodeId}/children`),
    );
  }

  // Accept `parentId` (canonical) or `newParentId` (common-mistake alias).
  nodeMove(params = {}) {
    return this.http.post(
      this._p(`/kbs/${this._requireKbId(params)}/tree/nodes/${params.nodeId}/move`),
      { parent_id: params.parentId ?? params.newParentId },
    );
  }

  nodeRename(params = {}) {
    return this.http.patch(
      this._p(`/kbs/${this._requireKbId(params)}/tree/nodes/${params.nodeId}/rename`),
      { name: params.name || params.title },
    );
  }

  nodeDelete(params = {}) {
    return this.http.del(this._p(`/kbs/${this._requireKbId(params)}/tree/nodes/${params.nodeId}`));
  }

  filePreview(params = {}) {
    return this.http.get(this._p(`/kbs/${this._requireKbId(params)}/tree/nodes/${params.nodeId}/preview`));
  }

  fileDownload(params = {}) {
    return this.http.get(
      this._p(`/kbs/${this._requireKbId(params)}/tree/nodes/${params.nodeId}/download`),
      { inline: params.inline },
    );
  }

  fileBatchDownload(params = {}) {
    return this.http.post(
      this._p(`/kbs/${this._requireKbId(params)}/tree/files/batch-download`),
      { node_ids: params.nodeIds, inline: params.inline },
    );
  }

  // ===========================================================================
  //  Pages (flat — no kb_id in path except create; resolved by page_id)
  // ===========================================================================

  pages(params = {}) {
    return this.http.get(this._p('/pages'), {
      cursor: params.cursor,
      limit:  params.limit,
      offset: params.offset,
    });
  }

  // format: "markdown" | "plain_text". Accept `parentId` (canonical) or
  // `parentNodeId` (common-mistake alias).
  pageCreate(params = {}) {
    return this.http.post(this._p(`/kbs/${this._requireKbId(params)}/pages`), {
      title:     params.title,
      format:    params.format || 'markdown',
      body:      params.body ?? params.content?.body ?? params.content ?? '',
      parent_id: params.parentId ?? params.parentNodeId,
      message:   params.message || params.commitMessage,
    });
  }

  pageGet(params = {}) { return this.http.get(this._p(`/pages/${params.pageId}`)); }

  pageUpdate(params = {}) {
    return this.http.patch(this._p(`/pages/${params.pageId}`), {
      title: params.title,
      path:  params.path,
    });
  }

  // permanent delete (use pageTrash for soft delete)
  pageDelete(params = {}) { return this.http.del(this._p(`/pages/${params.pageId}`)); }

  pageContent(params = {}) { return this.http.get(this._p(`/pages/${params.pageId}/content`)); }

  pageContentWrite(params = {}) {
    return this.http.put(this._p(`/pages/${params.pageId}/content`), {
      body:             params.body ?? params.content?.body ?? params.content,
      message:          params.message || params.commitMessage,
      base_revision_id: params.baseRevisionId,
      auto_save:        params.autoSave ?? false,
    });
  }

  pageTrash(params = {})        { return this.http.post(this._p(`/pages/${params.pageId}/trash`)); }
  pageRestoreTrash(params = {}) { return this.http.post(this._p(`/pages/${params.pageId}/restore`)); }
  pageFreeze(params = {})       { return this.http.post(this._p(`/pages/${params.pageId}/freeze`)); }
  pageReferences(params = {})   { return this.http.get(this._p(`/pages/${params.pageId}/references`)); }

  pagesTrashed(params = {}) {
    return this.http.get(this._p('/pages/trashed'), { limit: params.limit, offset: params.offset });
  }

  pageRevisions(params = {}) {
    return this.http.get(this._p(`/pages/${params.pageId}/revisions`), {
      limit:  params.limit,
      offset: params.offset,
    });
  }

  pageRevision(params = {}) {
    return this.http.get(this._p(`/pages/${params.pageId}/revisions/${params.revisionId}`));
  }

  // Server expects `from_revision` / `to_revision` WITHOUT the `_id` suffix.
  pageDiff(params = {}) {
    return this.http.get(this._p(`/pages/${params.pageId}/revisions/diff`), {
      from_revision: params.fromRevisionId ?? params.fromRevision,
      to_revision:   params.toRevisionId   ?? params.toRevision,
    });
  }

  pageRestore(params = {}) {
    return this.http.post(this._p(`/pages/${params.pageId}/revisions/${params.revisionId}/restore`));
  }

  // ===========================================================================
  //  Search (KB pages)
  // ===========================================================================

  search(params = {}) {
    return this.http.get(this._p('/search/pages'), {
      query:  params.query || params.q,
      kb_id:  params.kbId,
      limit:  params.limit,
      offset: params.offset,
      sort:   params.sort,
    });
  }

  // ===========================================================================
  //  File attachment to KB — uploadMedia(KB mode) returns the tree node
  // ===========================================================================

  async upload(params = {}) {
    if (!params.filePath) throw new Error('filePath is required');
    const as = await this._asService();
    return as.uploadMedia(params.filePath, {
      parentId: params.parentId,
      mimeType: params.contentType,
      filename: params.filename,
    });
  }
}

export function createKbService(http, as) {
  return new KbService(http, as);
}
