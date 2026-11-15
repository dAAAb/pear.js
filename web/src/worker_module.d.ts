// What the build makes of a module asked for with "?worker&inline": the module's bundle as a text inside the
// page's one script, and a function that starts a Worker of it from a Blob URL (web/vite.config.ts).
declare module "*?worker&inline" {
  const StartWorker: new (options?: { name?: string }) => Worker;
  export default StartWorker;
}
