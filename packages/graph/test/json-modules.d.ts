// The fixtures are loaded as JSON modules (no node:fs, so the package stays browser-loadable). tsconfig has no
// resolveJsonModule, so declare them as opaque `unknown`: parseFlow takes `unknown` anyway and does the real checking.
declare module '*.flow.json' {
  const value: unknown;
  export default value;
}
