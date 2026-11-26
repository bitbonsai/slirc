// Copies what the Mac app's workspace picker (Slirc/Picker/picker.html) shares with the web
// client's workspace dialog: the workspace marks from app/client/workspace-mark.ts, as a plain
// script that sets globalThis.slircWorkspaceMark, and the Slirc mark. Run `bun desktop/picker-assets.ts`
// after changing either; app/test/desktop-picker.test.ts fails while the copies are stale.
const root = new URL("../", import.meta.url);

export async function workspaceMarkScript(): Promise<string> {
  const source = await Bun.file(new URL("app/client/workspace-mark.ts", root)).text();
  const names = [...source.matchAll(/^export (?:const|function) (\w+)/gm)].map((match) => match[1]);
  const body = new Bun.Transpiler({ loader: "ts" }).transformSync(source).replace(/^export /gm, "");
  return `// Generated from app/client/workspace-mark.ts by desktop/picker-assets.ts. Do not edit.
(() => {
${body.trim()}
globalThis.slircWorkspaceMark = { ${names.join(", ")} };
})();
`;
}

export const assets = {
  "workspace-mark.js": workspaceMarkScript,
  "slirc.svg": () => Bun.file(new URL("app/public/icons/slirc.svg", root)).text(),
};

if (import.meta.main) {
  for (const [name, make] of Object.entries(assets)) await Bun.write(new URL(`desktop/Slirc/Picker/${name}`, root), await make());
}
