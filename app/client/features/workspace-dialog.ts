import { workspaceRows } from "@client/workspace-mark.ts";
import { savedWorkspaces, workspaceLink } from "@client/workspace-list.ts";
import { canSwitchWorkspace, exposeWorkspaceDialog, openWorkspace, shellWorkspaces } from "@client/native-shell.ts";
import type { ClientState } from "@client/client-state.ts";

export interface WorkspaceDialogDeps {
  // `workspace` stays loose: the runtime seeds it without the icon fields workspaceRows reads.
  ui: Pick<ClientState, "authenticated" | "workspaceBusy" | "workspaceChoices" | "workspaceDialog"> & { workspace: any; openWorkspaces: () => void };
  signal: AbortSignal;
}

export function createWorkspaceDialog(deps: WorkspaceDialogDeps) {
  const { ui, signal } = deps;

  // The rail and the dialog list the same rows: this workspace first, then the saved ones. A
  // browser keeps its own list; the Mac and iOS apps hand theirs over.
  function refreshWorkspaceChoices(): void {
    ui.workspaceChoices = workspaceRows(location.origin, [], ui.workspace);
    if (!canSwitchWorkspace()) { ui.workspaceChoices = workspaceRows(location.origin, savedWorkspaces(), ui.workspace); return; }
    void shellWorkspaces().then((saved) => { if (saved.length) ui.workspaceChoices = workspaceRows(location.origin, saved, ui.workspace); });
  }

  // A row in the workspace dialog. The app, or the browser, replaces this page with the workspace.
  function pickWorkspace(origin: string): void {
    if (origin === location.origin) { ui.workspaceDialog = false; return; }
    ui.workspaceBusy = true;
    const link = canSwitchWorkspace() ? undefined : workspaceLink(origin);
    void openWorkspace(origin, undefined, link).catch(() => {}).finally(() => { ui.workspaceBusy = false; ui.workspaceDialog = false; });
  }

  // Switch Workspace in the Mac app's menu opens the dialog while signed in, and its own picker otherwise.
  const hideWorkspaceDialog = exposeWorkspaceDialog(ui);

  signal.addEventListener("abort", hideWorkspaceDialog, { once: true });

  return { refreshWorkspaceChoices, pickWorkspace };
}
