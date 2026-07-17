/**
 * Service clients — programmatic REST clients for the cws-core surface,
 * extracted from the zylos-openmax `src/cli/*.js` wrappers.
 *
 * Each service takes the SDK's `CwsHttpClient` (transport/http.js) so the
 * HTTP/auth/org plumbing is reused, not reinvented. Methods are the CLI command
 * verbs camelCased (e.g. `project.list` → `projectList`); the argv/stdout CLI
 * shell that fronted them stays in the runtime adapter.
 *
 * Both a class and a `create*` factory are exported per service.
 */
export * from './tm.js';    // TmService,   createTmService
export * from './kb.js';    // KbService,   createKbService
export * from './as.js';    // AsService,   createAsService
export * from './comm.js';  // CommService, createCommService
export * from './core.js';  // CoreService, createCoreService
export * from './conn.js';  // ConnService, createConnService
