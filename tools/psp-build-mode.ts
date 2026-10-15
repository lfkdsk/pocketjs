import { createHash } from "node:crypto";

export interface PspBuildModeInput {
  readonly runtime: boolean;
  readonly appArgument: string;
  readonly planPath?: string;
  readonly launcherRegistry: string;
}

export interface PspBuildMode {
  /** Generic runtimes load app.pocket beside the EBOOT instead of embedding it. */
  readonly embedApp: boolean;
  /** A runtime without an app plan uses PocketJS's generic XMB metadata. */
  readonly useGenericRuntimeMetadata: boolean;
}

/** Validate the combinations that decide whether the PSP binary embeds a guest.
 * A verified plan may still describe a generic runtime's host ABI, viewport,
 * offload slot, and product metadata without making that runtime app-specific. */
export function pspBuildMode(input: PspBuildModeInput): PspBuildMode {
  if (input.runtime && input.appArgument) {
    throw new Error("--runtime cannot be combined with an app argument");
  }
  if (input.runtime && input.launcherRegistry) {
    throw new Error("--runtime cannot be combined with --launcher-registry");
  }
  return {
    embedApp: !input.runtime,
    useGenericRuntimeMetadata: input.runtime && input.planPath === undefined,
  };
}

export function pspOffloadSlot(
  plan:
    | {
      readonly app: { readonly id: string };
      readonly features: Readonly<Record<string, boolean>>;
    }
    | undefined,
): string {
  return plan?.features["io.offload"]
    ? createHash("sha256").update(plan.app.id).digest("hex").slice(0, 16)
    : "";
}
