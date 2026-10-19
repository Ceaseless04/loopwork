// Architecture rules 1-10 of CONSTRAINTS.md ("### Architecture rules"); CONSTRAINTS.md wins on any drift.
// Run: `depcruise . --validate` (the `.` is required: bare `depcruise --validate` prints usage and exits 0 without checking). Proven against miniature repos by scripts/test/depcruise-rules.test.ts.
//
// Not expressible here: rule 8's "fetch only to same-origin /api" clause. dependency-cruiser sees imports, not call
// arguments, so it is deliberately not faked; it needs a lint or test check instead.
//
// Rule 10 decision: a cycle is a violation only when every edge in it is a runtime import. Cycles closed by an
// `import type` or a dynamic `import()` edge are legal (cli -> claude-integration is a dynamic edge, claude-integration
// -> cli types is type-only, so that pair legitimately loops).

// A module of `dir` (workspace-resolved source path) or, when unresolved, its specifier. `names` lists every spelling of
// the specifier: cli ships as `loopwork`, claude-integration is also filtered unscoped, ui-viewer is unscoped.
const mod = (dir, ...names) => `^${dir}/|(^|/)node_modules/(${names.join('|')})/|^(${names.join('|')})($|/)`;
const graph = mod('packages/graph', '@loopwork/graph');
const eventlog = mod('packages/eventlog', '@loopwork/eventlog');
const windows = mod('packages/windows', '@loopwork/windows');
const engine = mod('packages/engine', '@loopwork/engine');
const runtime = mod('packages/runtime', '@loopwork/runtime');
const service = mod('packages/service', '@loopwork/service');
const uiServer = mod('packages/ui-server', '@loopwork/ui-server');
const mcp = mod('packages/mcp', '@loopwork/mcp');
const cli = mod('apps/cli', '@loopwork/cli', 'loopwork');
const uiViewer = mod('apps/ui-viewer', '@loopwork/ui-viewer', 'ui-viewer');
const claude = mod('integrations/claude', '@loopwork/claude-integration', 'claude-integration');
const apps = `^apps/|^(@loopwork/cli|loopwork|@loopwork/ui-viewer|ui-viewer)($|/)`;
const integrations = '^integrations/|^(@loopwork/claude-integration|claude-integration)($|/)';
// Any workspace package other than the given module patterns.
const anyLoopworkExcept = (...except) => {
  const any = `^(packages|apps|integrations)/[^/]+/|(^|/)node_modules/@loopwork/|^@loopwork/|^(loopwork|ui-viewer|claude-integration)($|/)`;
  return { path: any, pathNot: except };
};
const src = (dir) => `^${dir}/src/`;
const frontDoors = `${src('packages/ui-server')}|${src('packages/mcp')}|${src('apps/cli')}|${src('integrations/claude')}`;
const notType = ['type-only'];

const forbid = (name, from, to) => ({ name, severity: 'error', from: { path: from }, to });

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    // 1. graph: no other @loopwork/* (value or type), no node:* (browser-loadable).
    forbid('rule-01-graph-isolated', src('packages/graph'), anyLoopworkExcept(graph)),
    forbid('rule-01-graph-isolated', src('packages/graph'), { dependencyTypes: ['core'] }),
    // 2. eventlog: `import type` from graph only.
    forbid('rule-02-eventlog-type-graph-only', src('packages/eventlog'), anyLoopworkExcept(eventlog, graph)),
    forbid('rule-02-eventlog-type-graph-only', src('packages/eventlog'), { path: graph, dependencyTypesNot: notType }),
    // 3. windows: no @loopwork/* at all.
    forbid('rule-03-windows-isolated', src('packages/windows'), anyLoopworkExcept(windows)),
    // 4. engine: never runtime, service, ui-server, mcp, apps/*.
    forbid('rule-04-engine-layering', src('packages/engine'), { path: [runtime, service, uiServer, mcp, apps].join('|') }),
    // 5. runtime: never service or a front door.
    forbid('rule-05-runtime-layering', src('packages/runtime'), { path: [service, uiServer, mcp, apps, integrations].join('|') }),
    // 6. service: never ui-server, mcp, apps/*, integrations/*.
    forbid('rule-06-service-layering', src('packages/service'), { path: [uiServer, mcp, apps, integrations].join('|') }),
    // 7. front doors: no value imports of pg, engine, runtime, eventlog.
    forbid('rule-07-front-door-no-engine-side', frontDoors, {
      path: [engine, runtime, eventlog, '^pg($|/)|(^|/)node_modules/pg/'].join('|'),
      dependencyTypesNot: notType,
    }),
    // 8. ui-viewer: value imports of graph only (type-only anything else), no node:*.
    forbid('rule-08-ui-viewer-narrow', src('apps/ui-viewer'), { ...anyLoopworkExcept(uiViewer, graph), dependencyTypesNot: notType }),
    forbid('rule-08-ui-viewer-narrow', src('apps/ui-viewer'), { dependencyTypes: ['core'] }),
    // 9. cli: dynamic import() of claude-integration only; claude-integration: cli types only.
    forbid('rule-09-cli-claude-dynamic-only', src('apps/cli'), { path: claude, dependencyTypesNot: ['dynamic-import'] }),
    forbid('rule-09-cli-claude-dynamic-only', src('integrations/claude'), { path: cli, dependencyTypesNot: notType }),
    // 10. no runtime cycles (see the decision at the top).
    {
      name: 'rule-10-no-circular',
      severity: 'error',
      from: {},
      to: { circular: true, viaOnly: { dependencyTypesNot: ['type-only', 'dynamic-import'] } },
    },
  ],
  options: {
    // Built output (dist) is never followed, so it adds no edges or cycles of its own.
    doNotFollow: { path: '(^|/)(node_modules|dist)/' },
    // Third-party packages are not architecture, except `pg` (rule 7), so their edges are dropped (this also keeps
    // dist/ paths of tool packages out of the graph). Fixtures hold deliberate violations; coverage is generated.
    exclude: { path: '^scripts/test/fixtures|^coverage/|^(?!.*node_modules/pg/).*node_modules/' },
    // `@loopwork/<pkg>` resolves through the workspace symlink to packages/<pkg>/src/index.ts, never to a built dist/ (a
    // dist leaf would hide cross-package cycles and need a build): ignore `exports`, take src/index before index.
    enhancedResolveOptions: { exportsFields: [], mainFields: ['main'], mainFiles: ['src/index', 'index'] },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
  },
};
