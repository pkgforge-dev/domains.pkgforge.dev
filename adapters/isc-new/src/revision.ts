// Called by a raw archive/repair operator that can keep the result. A live
// run uses HEAD only and has no way to publish a raw-only artifact itself.
import type { AdapterContext } from "@domains/adapter";
import { isSnapshotDigest } from "./cursor.ts";
import { fetchSnapshot, isDay, IscFault, type SnapshotFile } from "./http.ts";
import { DPK1_EPOCH_DAY, parseSnapshot } from "./snapshot.ts";

export type RevisionEvidence =
  | { readonly kind: "missing"; readonly day: string; readonly url: string }
  | { readonly kind: "same"; readonly day: string; readonly file: SnapshotFile }
  | { readonly kind: "changed"; readonly day: string; readonly previousDigest: string; readonly file: SnapshotFile; readonly rows: number }
  | { readonly kind: "unverified"; readonly day: string; readonly previousDigest: string; readonly file: SnapshotFile; readonly fault: IscFault };

export async function inspectIndexedRevision(ctx: Pick<AdapterContext, "fetch" | "userAgent">, day: string, previousDigest: string): Promise<RevisionEvidence> {
  if (!isDay(day) || day < DPK1_EPOCH_DAY) throw new IscFault("date", "ISC revision inspection needs an indexed UTC day");
  if (!isSnapshotDigest(previousDigest)) throw new IscFault("format", "ISC revision inspection needs the exact indexed gzip SHA-256");
  // Compare bytes even when a changed publisher body kept the same transport
  // validators. This GET is explicit and never a live-run request.
  const file = await fetchSnapshot(ctx, { day });
  if (file.kind !== "file") return { kind: "missing", day, url: file.url };
  if (file.sha256 === previousDigest) return { kind: "same", day, file };
  try {
    const validated = await parseSnapshot(file);
    if (validated.day === null) throw new IscFault("format", `${file.url}: the changed gzip contains an empty array`);
    return { kind: "changed", day: validated.day, previousDigest, file, rows: validated.rows };
  } catch (error) {
    if (!(error instanceof IscFault)) throw error;
    return { kind: "unverified", day, previousDigest, file, fault: error };
  }
}
