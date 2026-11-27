// Copies what the Mac app's workspace picker (Slirc/Picker/picker.html) and the iOS shell's picker
// (native/www/picker.js) share with the web client: the workspace marks from app/client/workspace-mark.ts
// and the typed-text matcher from app/shared/match.ts, as plain scripts, and the Slirc mark. Run
// `bun desktop/picker-assets.ts` after changing any of them; app/test/desktop-picker.test.ts fails while
// the copies are stale.
const root = new URL("../", import.meta.url);

// A module as plain script text: types gone, its imports dropped (the pieces are concatenated in
// dependency order) and its exports made local.
async function plain(path: string): Promise<{ body: string; names: string[] }> {
  const source = await Bun.file(new URL(path, root)).text();
  const names = [...source.matchAll(/^export (?:const|function) (\w+)/gm)].map((match) => match[1]!);
  const body = new Bun.Transpiler({ loader: "ts" }).transformSync(source).replace(/^import .*$/gm, "").replace(/^export /gm, "");
  return { body: body.trim(), names };
}

const matcher = async () => [await plain("app/shared/fold.ts"), await plain("app/shared/match.ts")];

export async function workspaceMarkScript(): Promise<string> {
  const mark = await plain("app/client/workspace-mark.ts");
  return `// Generated from app/client/workspace-mark.ts by desktop/picker-assets.ts. Do not edit.
(() => {
${(await matcher()).map((part) => part.body).join("\n")}
${mark.body}
globalThis.slircWorkspaceMark = { ${mark.names.join(", ")} };
})();
`;
}

export async function matchScript(): Promise<string> {
  return `// Generated from app/shared/match.ts by desktop/picker-assets.ts. Do not edit.
(() => {
${(await matcher()).map((part) => part.body).join("\n")}
globalThis.slircMatch = { matchRank, rankMatches };
})();
`;
}

export const assets = {
  "workspace-mark.js": workspaceMarkScript,
  "slirc.svg": () => Bun.file(new URL("app/public/icons/slirc.svg", root)).text(),
};

// Copies that live outside the Mac app's folder.
export const nativeAssets = {
  "native/www/match.js": matchScript,
};

if (import.meta.main) {
  for (const [name, make] of Object.entries(assets)) await Bun.write(new URL(`desktop/Slirc/Picker/${name}`, root), await make());
  for (const [path, make] of Object.entries(nativeAssets)) await Bun.write(new URL(path, root), await make());
}
