import pkg from "../package.json" with { type: "json" };

export const VERSION: string = pkg.version;
export const PACKAGE = pkg.name;

// Negative when a is older than b. Plain x.y.z; anything else compares as 0.0.0.
export function compareVersions(a: string, b: string): number {
  const parts = (value: string) => (value.match(/^(\d+)\.(\d+)\.(\d+)/)?.slice(1) ?? ["0", "0", "0"]).map(Number);
  const [x, y] = [parts(a), parts(b)];
  for (let index = 0; index < 3; index++) if (x[index] !== y[index]) return x[index] - y[index];
  return 0;
}
