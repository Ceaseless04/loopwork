// Architecture rules 1-10 of CONSTRAINTS.md ("### Architecture rules"); CONSTRAINTS.md wins on any drift.
// Run: `depcruise . --validate` (the `.` is required: bare `depcruise --validate` prints usage and exits 0 without checking). Proven against miniature repos by scripts/test/depcruise-rules.test.ts.
//
// Not expressible here: rule 8's "fetch only to same-origin /api" clause. dependency-cruiser sees imports, not call
// arguments, so it is deliberately not faked; it needs a lint or test check instead.
//
// Rule 10 decision: a cycle is a violation only when every edge in it is a runtime import. Cycles closed by an
// `import type` or a dynamic `import()` edge are legal (cli -> claude-integration is a dynamic edge, claude-integration
// -> cli types is type-only, so that pair legitimately loops).

// A module of `dir` (workspace-resolved source path) or the `@loopwork/<name>` specifier when it is not resolved.
const mod = (dir, name) => `^${dir}/|(^|/)node_modules/@loopwork/${name}/|^@loopwork/${name}($|/)`;
const graph = mod('packages/graph', 'graph');
const eventlog = mod('packages/eventlog', 'eventlog');
const windows = mod('packages/windows', 'windows');
const engine = mod('packages/engine', 'engine');
const runtime = mod('packages/runtime', 'runtime');
const service = mod('packages/service', 'service');
const uiServer = mod('packages/ui-server', 'ui-server');
const mcp = mod('packages/mcp', 'mcp');
const cli = mod('apps/cli', 'cli');
const claude = mod('integrations/claude', 'claude-integration');
const apps = '^apps/|^@loopwork/cli($|/)';
const integrations = '^integrations/|^@loopwork/claude-integration($|/)';
// Any workspace package other than the given module patterns.
const anyLoopworkExcept = (...except) => {
  const any = '^(packages|apps|integrations)/[^/]+/|(^|/)node_modules/@loopwork/|^@loopwork/';
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
    forbid('rule-08-ui-viewer-narrow', src('apps/ui-viewer'), { ...anyLoopworkExcept(graph), dependencyTypesNot: notType }),
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
    // Built output (dist) stays visible as an import target (workspace packages resolve to packages/<pkg>/dist/index.js)
    // but is never followed, so it adds no edges or cycles of its own.
    doNotFollow: { path: '(^|/)(node_modules|dist)/' },
    exclude: { path: '^scripts/test/fixtures|^coverage/' },
    // Workspace packages declare `exports`; without this they resolve as unknown and `import type` edges lose their type.
    enhancedResolveOptions: { exportsFields: ['exports'], conditionNames: ['import', 'require', 'node', 'default'] },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
  },
};
